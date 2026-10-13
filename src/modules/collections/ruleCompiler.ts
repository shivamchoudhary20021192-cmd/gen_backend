import { ApiError } from '../../core/ApiError';

/**
 * Compiles automatic-collection rules into a parameterised WHERE fragment.
 *
 * Every subquery is pinned to the outer product's shop (`x.shop_id =
 * p.shop_id`). The caller scopes `p` itself; the fragments must not reach past
 * it into another shop's tags or categories that happen to share a slug.
 *
 * Both the field and the operator are looked up in fixed maps and never
 * interpolated from user input — the only thing that reaches SQL from the
 * request is a bound `?` parameter. That is what keeps a feature whose entire
 * purpose is "let admins write query conditions" from being an injection hole.
 */

type SqlBuilder = (operator: string, value: string | null) => { sql: string; params: unknown[] };

const NUMERIC_OPS: Record<string, string> = {
  equals: '=',
  not_equals: '<>',
  greater_than: '>',
  less_than: '<',
};

const TEXT_OPS = new Set(['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with']);

function textCondition(column: string, operator: string, value: string | null): { sql: string; params: unknown[] } {
  if (!TEXT_OPS.has(operator)) throw ApiError.validation({ rules: [`Operator "${operator}" is not valid for text fields.`] });
  const v = value ?? '';
  switch (operator) {
    case 'equals':
      return { sql: `${column} = ?`, params: [v] };
    case 'not_equals':
      return { sql: `${column} <> ?`, params: [v] };
    case 'contains':
      return { sql: `${column} LIKE ?`, params: [`%${v}%`] };
    case 'not_contains':
      return { sql: `${column} NOT LIKE ?`, params: [`%${v}%`] };
    case 'starts_with':
      return { sql: `${column} LIKE ?`, params: [`${v}%`] };
    default:
      return { sql: `${column} LIKE ?`, params: [`%${v}`] };
  }
}

function numericCondition(column: string, operator: string, value: string | null): { sql: string; params: unknown[] } {
  const op = NUMERIC_OPS[operator];
  if (!op) throw ApiError.validation({ rules: [`Operator "${operator}" is not valid for numeric fields.`] });
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw ApiError.validation({ rules: [`"${value}" is not a number.`] });
  return { sql: `${column} ${op} ?`, params: [numeric] };
}

function existsCondition(
  subquery: string,
  operator: string,
  value: string | null,
): { sql: string; params: unknown[] } {
  const negate = operator === 'not_equals' || operator === 'not_contains';
  return { sql: `${negate ? 'NOT ' : ''}EXISTS (${subquery})`, params: [value] };
}

const FIELDS: Record<string, SqlBuilder> = {
  title: (op, v) => textCondition('p.name', op, v),

  tag: (op, v) =>
    existsCondition(
      `SELECT 1 FROM taggables tg JOIN tags t ON t.id = tg.tag_id AND t.shop_id = tg.shop_id
        WHERE tg.shop_id = p.shop_id AND tg.taggable_type = 'product' AND tg.taggable_id = p.id AND t.slug = ?`,
      op,
      v,
    ),

  category: (op, v) =>
    existsCondition(
      `SELECT 1 FROM categories c WHERE c.shop_id = p.shop_id AND c.id = p.category_id AND c.slug = ?`,
      op,
      v,
    ),

  brand: (op, v) =>
    existsCondition(`SELECT 1 FROM brands b WHERE b.shop_id = p.shop_id AND b.id = p.brand_id AND b.slug = ?`, op, v),

  skin_type: (op, v) =>
    existsCondition(
      `SELECT 1 FROM product_skin_types pst JOIN skin_types st ON st.id = pst.skin_type_id AND st.shop_id = pst.shop_id
        WHERE pst.shop_id = p.shop_id AND pst.product_id = p.id AND st.slug = ?`,
      op,
      v,
    ),

  concern: (op, v) =>
    existsCondition(
      `SELECT 1 FROM product_concerns pc JOIN skin_concerns sc ON sc.id = pc.concern_id AND sc.shop_id = pc.shop_id
        WHERE pc.shop_id = p.shop_id AND pc.product_id = p.id AND sc.slug = ?`,
      op,
      v,
    ),

  price: (op, v) => numericCondition('p.min_price', op, v),
  rating: (op, v) => numericCondition('p.rating_average', op, v),

  is_new: (_op, v) => ({ sql: 'p.is_new = ?', params: [v === 'true' || v === '1' ? 1 : 0] }),
  is_bestseller: (_op, v) => ({ sql: 'p.is_bestseller = ?', params: [v === 'true' || v === '1' ? 1 : 0] }),

  inventory_quantity: (op, v) => {
    const numeric = Number(v);
    if (!Number.isFinite(numeric)) throw ApiError.validation({ rules: [`"${v}" is not a number.`] });
    const sqlOp = NUMERIC_OPS[op];
    if (!sqlOp) throw ApiError.validation({ rules: [`Operator "${op}" is not valid for inventory.`] });
    return {
      sql: `(SELECT COALESCE(SUM(ii.quantity_available), 0)
               FROM inventory_items ii
               JOIN product_variants pv ON pv.id = ii.variant_id AND pv.shop_id = ii.shop_id
              WHERE ii.shop_id = p.shop_id AND pv.product_id = p.id) ${sqlOp} ?`,
      params: [numeric],
    };
  },

  created_at: (op, v) => {
    const sqlOp = NUMERIC_OPS[op];
    if (!sqlOp) throw ApiError.validation({ rules: [`Operator "${op}" is not valid for dates.`] });
    return { sql: `p.created_at ${sqlOp} ?`, params: [v] };
  },
};

export interface CompiledRules {
  sql: string;
  params: unknown[];
}

export function compileRules(
  rules: { field: string; operator: string; value: string | null }[],
  matchCondition: 'all' | 'any',
): CompiledRules {
  if (rules.length === 0) {
    // No rules means no members, not "every product" — a misconfigured
    // automatic collection should be empty, not accidentally the whole catalog.
    return { sql: '1 = 0', params: [] };
  }

  const parts: string[] = [];
  const params: unknown[] = [];

  for (const rule of rules) {
    const builder = FIELDS[rule.field];
    if (!builder) throw ApiError.validation({ rules: [`Unknown rule field "${rule.field}".`] });
    const { sql, params: ruleParams } = builder(rule.operator, rule.value);
    parts.push(`(${sql})`);
    params.push(...ruleParams);
  }

  return { sql: parts.join(matchCondition === 'all' ? ' AND ' : ' OR '), params };
}

export const RULE_FIELDS = Object.keys(FIELDS);
