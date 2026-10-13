import { query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { ApiError } from '../../core/ApiError';
import { shopId } from '../../platform/tenancy/context';
import { callingCodeFor } from '../../platform/geo/phone';
import { tenancy } from '../../platform/tenancy/context';

/**
 * Who a campaign goes to.
 *
 * Three ways to say it, all ending in the same SQL:
 *
 *   segment   a saved `customer_segments` row. A manual segment uses its
 *             members; an automatic one has rules, and those rules are
 *             evaluated here — which is also the first time anything in this
 *             codebase has actually evaluated them.
 *   rules     the same rule language, typed on the campaign and not saved as a
 *             segment. This is what "everyone who bought in the last 30 days
 *             and has not been messaged this week" looks like when nobody wants
 *             a permanent segment for it.
 *   manual    a chosen list of customer ids.
 *
 * On top of whichever one it is, the channel's own eligibility always applies:
 * an email campaign cannot reach a customer with no email address, and a
 * marketing campaign cannot reach anyone who has not opted in — not as a policy
 * this file is being polite about, but because the send would be refused one
 * layer down and the only difference would be four thousand rows of
 * "skipped: no consent" instead of an honest count before the send.
 *
 * ── the security-critical part ──────────────────────────────────────────────
 *
 * A rule is {field, operator, value} arriving from a browser and ending up in a
 * WHERE clause. Fields and operators are looked up in the tables below and
 * anything not found is refused; values are always bound as parameters. There
 * is no path in this file where a string from the request reaches the SQL text.
 */

export type RuleOperator =
  | '=' | '!=' | '>' | '>=' | '<' | '<='
  | 'contains' | 'starts_with'
  | 'is_set' | 'is_not_set'
  | 'in_last_days' | 'not_in_last_days';

export interface AudienceRule {
  field: string;
  operator: RuleOperator;
  value?: unknown;
}

type FieldType = 'number' | 'money' | 'string' | 'date' | 'boolean' | 'enum';

interface FieldDefinition {
  column: string;
  type: FieldType;
  label: string;
  group: string;
  options?: { value: string; label: string }[];
  help?: string;
}

/**
 * The fields a rule may name.
 *
 * Exported as a catalogue for the same reason the page builder exports its
 * section schema: the admin builds its rule rows from this, so adding a field
 * is one entry here rather than an entry here and a dropdown there.
 */
export const AUDIENCE_FIELDS: Record<string, FieldDefinition> = {
  total_spent: { column: 'c.total_spent', type: 'money', label: 'Lifetime spend', group: 'Value' },
  orders_count: { column: 'c.orders_count', type: 'number', label: 'Orders placed', group: 'Value' },
  average_order_value: { column: 'c.average_order_value', type: 'money', label: 'Average order value', group: 'Value' },

  last_order_at: { column: 'c.last_order_at', type: 'date', label: 'Last ordered', group: 'Activity' },
  first_order_at: { column: 'c.first_order_at', type: 'date', label: 'First ordered', group: 'Activity' },
  last_seen_at: { column: 'c.last_seen_at', type: 'date', label: 'Last seen', group: 'Activity' },
  created_at: { column: 'c.created_at', type: 'date', label: 'Signed up', group: 'Activity' },

  accepts_email_marketing: { column: 'c.accepts_email_marketing', type: 'boolean', label: 'Opted in to email', group: 'Consent' },
  accepts_sms_marketing: { column: 'c.accepts_sms_marketing', type: 'boolean', label: 'Opted in to SMS', group: 'Consent' },
  accepts_whatsapp_marketing: { column: 'c.accepts_whatsapp_marketing', type: 'boolean', label: 'Opted in to WhatsApp', group: 'Consent' },

  email: { column: 'c.email', type: 'string', label: 'Email', group: 'Identity' },
  phone: { column: 'c.phone', type: 'string', label: 'Phone', group: 'Identity' },
  gender: {
    column: 'c.gender',
    type: 'enum',
    label: 'Gender',
    group: 'Identity',
    options: [
      { value: 'female', label: 'Female' },
      { value: 'male', label: 'Male' },
      { value: 'other', label: 'Other' },
      { value: 'undisclosed', label: 'Undisclosed' },
    ],
  },
  signup_source: {
    column: 'c.signup_source',
    type: 'enum',
    label: 'Signed up through',
    group: 'Identity',
    options: [
      { value: 'web', label: 'Website' },
      { value: 'mobile_web', label: 'Mobile web' },
      { value: 'whatsapp', label: 'WhatsApp' },
      { value: 'import', label: 'Import' },
      { value: 'admin', label: 'Admin' },
      { value: 'app', label: 'App' },
    ],
  },
  preferred_language: { column: 'c.preferred_language', type: 'string', label: 'Language', group: 'Identity' },

  skin_type_id: { column: 'c.skin_type_id', type: 'number', label: 'Skin type', group: 'Skin', help: 'The lookup id from the customer’s profile.' },
  primary_concern_id: { column: 'c.primary_concern_id', type: 'number', label: 'Primary concern', group: 'Skin' },

  cod_blocked: { column: 'c.cod_blocked', type: 'boolean', label: 'Blocked from cash on delivery', group: 'Risk' },
  rto_count: { column: 'c.rto_count', type: 'number', label: 'Returns to origin', group: 'Risk' },
  phone_verified_at: { column: 'c.phone_verified_at', type: 'date', label: 'Phone verified', group: 'Identity' },
};

const OPERATORS: Record<RuleOperator, { label: string; needsValue: boolean; types: FieldType[] }> = {
  '=': { label: 'is', needsValue: true, types: ['number', 'money', 'string', 'boolean', 'enum', 'date'] },
  '!=': { label: 'is not', needsValue: true, types: ['number', 'money', 'string', 'boolean', 'enum', 'date'] },
  '>': { label: 'is more than', needsValue: true, types: ['number', 'money', 'date'] },
  '>=': { label: 'is at least', needsValue: true, types: ['number', 'money', 'date'] },
  '<': { label: 'is less than', needsValue: true, types: ['number', 'money', 'date'] },
  '<=': { label: 'is at most', needsValue: true, types: ['number', 'money', 'date'] },
  contains: { label: 'contains', needsValue: true, types: ['string'] },
  starts_with: { label: 'starts with', needsValue: true, types: ['string'] },
  is_set: { label: 'is set', needsValue: false, types: ['number', 'money', 'string', 'date', 'enum'] },
  is_not_set: { label: 'is not set', needsValue: false, types: ['number', 'money', 'string', 'date', 'enum'] },
  in_last_days: { label: 'in the last (days)', needsValue: true, types: ['date'] },
  not_in_last_days: { label: 'not in the last (days)', needsValue: true, types: ['date'] },
};

export function audienceCatalogue() {
  return {
    fields: Object.entries(AUDIENCE_FIELDS).map(([key, field]) => ({
      key,
      label: field.label,
      type: field.type,
      group: field.group,
      options: field.options ?? null,
      help: field.help ?? null,
      operators: Object.entries(OPERATORS)
        .filter(([, operator]) => operator.types.includes(field.type))
        .map(([key_, operator]) => ({ value: key_, label: operator.label, needs_value: operator.needsValue })),
    })),
  };
}

/** "90_days_ago" is what the seeded segments already use, so it keeps working. */
function normaliseValue(field: FieldDefinition, value: unknown): unknown {
  if (field.type === 'boolean') return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
  if (field.type === 'date' && typeof value === 'string') {
    const relative = /^(\d+)_days_ago$/.exec(value);
    if (relative) {
      const date = new Date(Date.now() - Number(relative[1]) * 86_400_000);
      return date.toISOString().slice(0, 19).replace('T', ' ');
    }
  }
  return value;
}

export interface WhereClause {
  sql: string;
  params: unknown[];
}

/** One rule → one condition, or a refusal naming the field it did not recognise. */
function conditionFor(rule: AudienceRule): WhereClause {
  const field = AUDIENCE_FIELDS[rule.field];
  if (!field) throw ApiError.badRequest(`"${rule.field}" is not a field a rule can use.`);

  const operator = OPERATORS[rule.operator];
  if (!operator) throw ApiError.badRequest(`"${rule.operator}" is not an operator.`);
  if (!operator.types.includes(field.type)) {
    throw ApiError.badRequest(`"${operator.label}" cannot be used with ${field.label.toLowerCase()}.`);
  }

  switch (rule.operator) {
    case 'is_set':
      return { sql: `(${field.column} IS NOT NULL AND ${field.column} <> '')`, params: [] };
    case 'is_not_set':
      return { sql: `(${field.column} IS NULL OR ${field.column} = '')`, params: [] };
    case 'contains':
      return { sql: `${field.column} LIKE ?`, params: [`%${String(rule.value ?? '')}%`] };
    case 'starts_with':
      return { sql: `${field.column} LIKE ?`, params: [`${String(rule.value ?? '')}%`] };
    case 'in_last_days':
      return { sql: `${field.column} >= NOW() - INTERVAL ? DAY`, params: [Number(rule.value ?? 0)] };
    case 'not_in_last_days':
      return {
        sql: `(${field.column} IS NULL OR ${field.column} < NOW() - INTERVAL ? DAY)`,
        params: [Number(rule.value ?? 0)],
      };
    default:
      return { sql: `${field.column} ${rule.operator} ?`, params: [normaliseValue(field, rule.value)] };
  }
}

export function buildRuleWhere(rules: AudienceRule[], operator: 'all' | 'any'): WhereClause {
  if (!Array.isArray(rules) || rules.length === 0) return { sql: '1 = 1', params: [] };
  const parts = rules.map(conditionFor);
  return {
    sql: `(${parts.map((part) => part.sql).join(operator === 'any' ? ' OR ' : ' AND ')})`,
    params: parts.flatMap((part) => part.params),
  };
}

// ── the query the whole module is for ────────────────────────────────────────

export interface AudienceSpec {
  channel: 'email' | 'sms' | 'whatsapp' | 'push';
  /** Marketing audiences are narrowed by consent; the others are not. */
  marketing: boolean;
  audienceType: 'segment' | 'rules' | 'manual' | 'all';
  segmentId?: number | null;
  rules?: AudienceRule[] | null;
  rulesOperator?: 'all' | 'any';
  customerIds?: number[] | null;
  /** Skip anyone messaged on this channel within this many hours. */
  excludeRecentHours?: number | null;
}

const CONSENT_PURPOSE: Record<string, string> = {
  email: 'marketing_email',
  sms: 'marketing_sms',
  whatsapp: 'marketing_whatsapp',
};

const CONSENT_FLAG: Record<string, string> = {
  email: 'accepts_email_marketing',
  sms: 'accepts_sms_marketing',
  whatsapp: 'accepts_whatsapp_marketing',
};

/** The address column for this channel, and the condition that it exists. */
function addressFor(channel: string): { select: string; condition: string } {
  if (channel === 'email') {
    return { select: 'c.email', condition: "c.email IS NOT NULL AND c.email <> ''" };
  }
  // The shop's own calling code for customers stored without one. Digits
  // only, from our own table, so it is safe to write into the statement.
  const fallback = (callingCodeFor(tenancy.currentOrNull()?.countryCode) ?? '91').replace(/\D/g, '');
  return {
    select: `CONCAT(REPLACE(COALESCE(NULLIF(c.country_code, ''), '${fallback}'), '+', ''), c.phone)`,
    condition: "c.phone IS NOT NULL AND c.phone <> ''",
  };
}

interface BuiltQuery {
  from: string;
  where: string;
  params: unknown[];
  address: string;
}

function build(spec: AudienceSpec): BuiltQuery {
  const address = addressFor(spec.channel);
  const conditions = [
    'c.shop_id = ?',
    'c.deleted_at IS NULL',
    'c.anonymised_at IS NULL',
    "c.status = 'active'",
    address.condition,
  ];
  // FROM-clause placeholders precede WHERE ones in the SQL, so they are kept
  // apart and concatenated in that order at the end.
  const fromParams: unknown[] = [];
  const params: unknown[] = [shopId()];
  let from = 'FROM customers c';

  switch (spec.audienceType) {
    case 'segment': {
      if (!spec.segmentId) throw ApiError.badRequest('This campaign has no segment chosen.');
      // A manual segment is its membership list; an automatic one is its rules.
      // Handled by the caller, which passes the rules through when they exist.
      from += ' JOIN customer_segment_members m ON m.customer_id = c.id AND m.shop_id = c.shop_id AND m.segment_id = ?';
      fromParams.push(spec.segmentId);
      break;
    }
    case 'manual': {
      const ids = (spec.customerIds ?? []).filter((id) => Number.isInteger(id) && id > 0);
      if (ids.length === 0) throw ApiError.badRequest('No customers were chosen.');
      conditions.push(`c.id IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
      break;
    }
    case 'rules':
    case 'all':
    default:
      break;
  }

  if (spec.rules && spec.rules.length > 0) {
    const rule = buildRuleWhere(spec.rules, spec.rulesOperator ?? 'all');
    conditions.push(rule.sql);
    params.push(...rule.params);
  }

  // ── consent, for marketing only ──────────────────────────────────────────
  //
  // The denormalised flag is the fast path and is kept in step by
  // `setMarketingConsent`. The append-only consent log is the truth, so a
  // withdrawal that arrived without the flag being updated still excludes the
  // customer. Both, rather than either.
  if (spec.marketing) {
    const flag = CONSENT_FLAG[spec.channel];
    const purpose = CONSENT_PURPOSE[spec.channel];
    if (flag && purpose) {
      conditions.push(`c.${flag} = 1`);
      conditions.push(
        `NOT EXISTS (
           SELECT 1 FROM customer_consents cc
            WHERE cc.shop_id = c.shop_id AND cc.customer_id = c.id AND cc.purpose = ?
              AND cc.status = 'withdrawn'
              AND cc.id > COALESCE((
                    SELECT MAX(g.id) FROM customer_consents g
                     WHERE g.shop_id = c.shop_id AND g.customer_id = c.id AND g.purpose = ? AND g.status = 'granted'
                  ), 0)
         )`,
      );
      params.push(purpose, purpose);
    }
  }

  if (spec.excludeRecentHours && spec.excludeRecentHours > 0) {
    conditions.push(
      `NOT EXISTS (
         SELECT 1 FROM notification_logs l
          WHERE l.shop_id = c.shop_id AND l.customer_id = c.id AND l.channel = ?
            AND l.status <> 'failed'
            AND l.queued_at >= NOW() - INTERVAL ? HOUR
       )`,
    );
    params.push(spec.channel, spec.excludeRecentHours);
  }

  return { from, where: conditions.join(' AND '), params: [...fromParams, ...params], address: address.select };
}

export interface AudienceMember extends RowDataPacket {
  id: number;
  public_id: string;
  recipient: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  orders_count: number;
  total_spent: string;
  last_order_at: Date | null;
}

export const audience = {
  /** How many people this campaign would reach, right now. */
  async count(spec: AudienceSpec, exec: Executor = pool): Promise<number> {
    const built = build(spec);
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(DISTINCT c.id) AS total ${built.from} WHERE ${built.where}`,
      built.params,
      exec,
    );
    return Number(row?.total ?? 0);
  },

  /**
   * The same audience without the consent and contactability narrowing, so the
   * review step can say "4,210 match, 2,980 can be messaged" instead of one
   * number that quietly hides the other.
   */
  async breakdown(spec: AudienceSpec, exec: Executor = pool) {
    const matched = await this.count({ ...spec, marketing: false, excludeRecentHours: null }, exec);
    const contactable = await this.count({ ...spec, marketing: spec.marketing, excludeRecentHours: null }, exec);
    const eligible = await this.count(spec, exec);
    return {
      matched,
      contactable,
      eligible,
      no_consent: Math.max(0, matched - contactable),
      messaged_recently: Math.max(0, contactable - eligible),
    };
  },

  async members(spec: AudienceSpec, limit: number, offset = 0, exec: Executor = pool): Promise<AudienceMember[]> {
    const built = build(spec);
    return query<AudienceMember>(
      `SELECT DISTINCT c.id, c.public_id, ${built.address} AS recipient, c.first_name, c.last_name, c.email, c.phone,
              c.orders_count, c.total_spent, c.last_order_at
         ${built.from}
        WHERE ${built.where}
        ORDER BY c.id
        LIMIT ? OFFSET ?`,
      [...built.params, limit, offset],
      exec,
    );
  },
};
