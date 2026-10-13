import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

/**
 * Discounts are the `coupons` tables. Shopify's "Discounts" section covers both
 * code discounts and automatic ones, and the schema already models that with
 * `is_automatic` — so there is no second table, just a different presentation.
 */
export interface CouponRow extends RowDataPacket {
  id: number;
  code: string;
  title: string | null;
  description: string | null;
  discount_type: 'percentage' | 'fixed_amount' | 'free_shipping' | 'buy_x_get_y' | 'free_gift';
  value: string;
  max_discount_amount: string | null;
  min_order_amount: string;
  min_quantity: number;
  applies_to: 'all' | 'products' | 'categories' | 'collections';
  customer_eligibility: 'all' | 'new_customers' | 'returning' | 'specific';
  buy_quantity: number | null;
  get_quantity: number | null;
  get_variant_id: number | null;
  gift_variant_id: number | null;
  gift_reserves_inventory: number;
  usage_limit_total: number | null;
  usage_limit_per_customer: number;
  used_count: number;
  is_stackable: number;
  is_automatic: number;
  is_visible: number;
  priority: number;
  starts_at: Date | null;
  ends_at: Date | null;
  is_active: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  product_count?: number;
  redemption_count?: number;
}

interface CountRow extends RowDataPacket {
  total: number;
}

export interface DiscountFilters {
  search?: string;
  discountType?: string;
  isAutomatic?: boolean;
  state?: 'active' | 'scheduled' | 'expired' | 'disabled';
}

function buildWhere(filters: DiscountFilters): { clause: string; params: unknown[] } {
  const conditions = ['c.shop_id = ?', 'c.deleted_at IS NULL'];
  const params: unknown[] = [shopId()];

  if (filters.search) {
    conditions.push('(c.code LIKE ? OR c.title LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.discountType) {
    conditions.push('c.discount_type = ?');
    params.push(filters.discountType);
  }
  if (filters.isAutomatic !== undefined) {
    conditions.push('c.is_automatic = ?');
    params.push(filters.isAutomatic ? 1 : 0);
  }

  // "State" is derived from three columns plus the clock; expressing it in SQL
  // keeps the list filter and the badge on each row telling the same story.
  switch (filters.state) {
    case 'disabled':
      conditions.push('c.is_active = 0');
      break;
    case 'scheduled':
      conditions.push('c.is_active = 1 AND c.starts_at IS NOT NULL AND c.starts_at > NOW()');
      break;
    case 'expired':
      conditions.push('c.is_active = 1 AND c.ends_at IS NOT NULL AND c.ends_at < NOW()');
      break;
    case 'active':
      conditions.push(
        `c.is_active = 1
         AND (c.starts_at IS NULL OR c.starts_at <= NOW())
         AND (c.ends_at IS NULL OR c.ends_at >= NOW())`,
      );
      break;
    default:
      break;
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

const SELECT = `
  SELECT c.*,
         (SELECT COUNT(*) FROM coupon_products cp WHERE cp.shop_id = c.shop_id AND cp.coupon_id = c.id AND cp.is_excluded = 0) AS product_count,
         (SELECT COUNT(*) FROM coupon_redemptions cr WHERE cr.shop_id = c.shop_id AND cr.coupon_id = c.id) AS redemption_count
    FROM coupons c`;

export const discountsRepository = {
  async list(
    filters: DiscountFilters,
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<CouponRow[]> {
    const { clause, params } = buildWhere(filters);
    return query<CouponRow>(`${SELECT} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, limit, offset], exec);
  },

  async count(filters: DiscountFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<CountRow>(`SELECT COUNT(*) AS total FROM coupons c ${clause}`, params, exec);
    return row?.total ?? 0;
  },

  async findById(id: number, exec: Executor = pool): Promise<CouponRow | null> {
    return queryOne<CouponRow>(`${SELECT} WHERE c.shop_id = ? AND c.id = ? AND c.deleted_at IS NULL LIMIT 1`, [shopId(), id], exec);
  },

  async codeExists(code: string, excludeId?: number, exec: Executor = pool): Promise<boolean> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      excludeId
        ? 'SELECT id FROM coupons WHERE shop_id = ? AND code = ? AND id <> ? LIMIT 1'
        : 'SELECT id FROM coupons WHERE shop_id = ? AND code = ? LIMIT 1',
      excludeId ? [shopId(), code, excludeId] : [shopId(), code],
      exec,
    );
    return row !== null;
  },

  async variantExists(variantId: number, exec: Executor = pool): Promise<boolean> {
    const row = await queryOne<RowDataPacket>(
      'SELECT 1 AS hit FROM product_variants WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
      [shopId(), variantId],
      exec,
    );
    return row !== null;
  },

  async create(data: Record<string, unknown>, exec: Executor = pool): Promise<number> {
    const row = { ...data, shop_id: shopId() };
    const keys = Object.keys(row);
    const columns = keys.map((k) => `\`${k}\``).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    return insert(`INSERT INTO coupons (${columns}) VALUES (${placeholders})`, Object.values(row), exec);
  },

  async update(id: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `\`${k}\` = ?`).join(', ');
    await execute(`UPDATE coupons SET ${assignments} WHERE shop_id = ? AND id = ?`, [...Object.values(fields), shopId(), id], exec);
  },

  async softDelete(id: number, exec: Executor = pool): Promise<void> {
    // The code is released on delete so it can be reused, but redemption
    // history keeps pointing at this row — an order's discount must stay
    // explainable years later.
    await execute(
      `UPDATE coupons
          SET deleted_at = NOW(), is_active = 0,
              code = CONCAT(code, '-DELETED-', UNIX_TIMESTAMP())
        WHERE shop_id = ? AND id = ? AND deleted_at IS NULL`,
      [shopId(), id],
      exec,
    );
  },

  // ── targeting ──────────────────────────────────────────────────────────────
  async setProducts(couponId: number, productIds: number[], exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM coupon_products WHERE shop_id = ? AND coupon_id = ?', [shopId(), couponId], exec);
    if (productIds.length === 0) return;
    const values = productIds.map(() => '(?, ?, ?, 0)').join(', ');
    await execute(
      `INSERT INTO coupon_products (shop_id, coupon_id, product_id, is_excluded) VALUES ${values}`,
      productIds.flatMap((productId) => [shopId(), couponId, productId]),
      exec,
    );
  },

  async setCollections(couponId: number, collectionIds: number[], exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM coupon_collections WHERE shop_id = ? AND coupon_id = ?', [shopId(), couponId], exec);
    if (collectionIds.length === 0) return;
    const values = collectionIds.map(() => '(?, ?, ?, 0)').join(', ');
    await execute(
      `INSERT INTO coupon_collections (shop_id, coupon_id, collection_id, is_excluded) VALUES ${values}`,
      collectionIds.flatMap((collectionId) => [shopId(), couponId, collectionId]),
      exec,
    );
  },

  async setCategories(couponId: number, categoryIds: number[], exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM coupon_categories WHERE shop_id = ? AND coupon_id = ?', [shopId(), couponId], exec);
    if (categoryIds.length === 0) return;
    const values = categoryIds.map(() => '(?, ?, ?, 0)').join(', ');
    await execute(
      `INSERT INTO coupon_categories (shop_id, coupon_id, category_id, is_excluded) VALUES ${values}`,
      categoryIds.flatMap((categoryId) => [shopId(), couponId, categoryId]),
      exec,
    );
  },

  async targetsFor(
    couponId: number,
    exec: Executor = pool,
  ): Promise<{
    products: { id: number; name: string; slug: string }[];
    collections: { id: number; title: string }[];
    categories: { id: number; name: string }[];
  }> {
    const [products, collections, categories] = await Promise.all([
      query<RowDataPacket & { id: number; name: string; slug: string }>(
        `SELECT p.id, p.name, p.slug FROM coupon_products cp
           JOIN products p ON p.id = cp.product_id AND p.deleted_at IS NULL
          WHERE cp.shop_id = ? AND cp.coupon_id = ? AND cp.is_excluded = 0
          ORDER BY p.name`,
        [shopId(), couponId],
        exec,
      ),
      query<RowDataPacket & { id: number; title: string }>(
        `SELECT c.id, c.title FROM coupon_collections cc
           JOIN collections c ON c.id = cc.collection_id AND c.deleted_at IS NULL
          WHERE cc.shop_id = ? AND cc.coupon_id = ? AND cc.is_excluded = 0
          ORDER BY c.title`,
        [shopId(), couponId],
        exec,
      ),
      query<RowDataPacket & { id: number; name: string }>(
        `SELECT cat.id, cat.name FROM coupon_categories cc
           JOIN categories cat ON cat.id = cc.category_id AND cat.deleted_at IS NULL
          WHERE cc.shop_id = ? AND cc.coupon_id = ? AND cc.is_excluded = 0
          ORDER BY cat.name`,
        [shopId(), couponId],
        exec,
      ),
    ]);
    return {
      products: products.map((r) => ({ id: r.id, name: r.name, slug: r.slug })),
      collections: collections.map((r) => ({ id: r.id, title: r.title })),
      categories: categories.map((r) => ({ id: r.id, name: r.name })),
    };
  },

  // ── product side ───────────────────────────────────────────────────────────
  /**
   * Every discount that reaches this product: directly attached, via one of its
   * collections, via its category, or store-wide. The `source` column is what
   * lets the product form show "via collection" instead of pretending the
   * merchandiser attached it there.
   */
  async forProduct(productId: number, exec: Executor = pool): Promise<(CouponRow & { source: string })[]> {
    return query<CouponRow & { source: string }>(
      `SELECT c.*, 'product' AS source
         FROM coupons c
         JOIN coupon_products cp ON cp.coupon_id = c.id AND cp.is_excluded = 0
        WHERE c.shop_id = ? AND cp.product_id = ? AND c.deleted_at IS NULL
       UNION
       SELECT c.*, 'collection' AS source
         FROM coupons c
         JOIN coupon_collections cc ON cc.coupon_id = c.id AND cc.is_excluded = 0
         JOIN collection_products cprod ON cprod.collection_id = cc.collection_id
        WHERE c.shop_id = ? AND cprod.product_id = ? AND c.deleted_at IS NULL
       UNION
       SELECT c.*, 'category' AS source
         FROM coupons c
         JOIN coupon_categories ccat ON ccat.coupon_id = c.id AND ccat.is_excluded = 0
         JOIN products p ON p.category_id = ccat.category_id AND p.shop_id = c.shop_id
        WHERE c.shop_id = ? AND p.id = ? AND c.deleted_at IS NULL
       UNION
       SELECT c.*, 'all_products' AS source
         FROM coupons c
        WHERE c.shop_id = ? AND c.deleted_at IS NULL AND c.applies_to = 'all'
        ORDER BY priority, code`,
      [shopId(), productId, shopId(), productId, shopId(), productId, shopId()],
      exec,
    );
  },

  /** Directly attached only — what the product-form dropdown owns. */
  async directCouponIdsForProduct(productId: number, exec: Executor = pool): Promise<number[]> {
    const rows = await query<RowDataPacket & { coupon_id: number }>(
      `SELECT cp.coupon_id FROM coupon_products cp
         JOIN coupons c ON c.id = cp.coupon_id AND c.deleted_at IS NULL
        WHERE cp.shop_id = ? AND cp.product_id = ? AND cp.is_excluded = 0`,
      [shopId(), productId],
      exec,
    );
    return rows.map((r) => r.coupon_id);
  },

  /**
   * Replaces this product's direct attachments only. Collection- and
   * category-derived discounts are untouched, because they are not this
   * product's to remove.
   */
  async setProductCoupons(productId: number, couponIds: number[], exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM coupon_products WHERE shop_id = ? AND product_id = ?', [shopId(), productId], exec);
    if (couponIds.length === 0) return;
    const values = couponIds.map(() => '(?, ?, ?, 0)').join(', ');
    await execute(
      `INSERT INTO coupon_products (shop_id, coupon_id, product_id, is_excluded) VALUES ${values}`,
      couponIds.flatMap((couponId) => [shopId(), couponId, productId]),
      exec,
    );
    // Attaching a discount to specific products only means anything if the
    // discount is actually scoped to products.
    const placeholders = couponIds.map(() => '?').join(',');
    await execute(
      `UPDATE coupons SET applies_to = 'products' WHERE shop_id = ? AND id IN (${placeholders}) AND applies_to = 'all'`,
      [shopId(), ...couponIds],
      exec,
    );
  },

  async validateProductIds(productIds: number[], exec: Executor = pool): Promise<number[]> {
    if (productIds.length === 0) return [];
    const placeholders = productIds.map(() => '?').join(',');
    const rows = await query<RowDataPacket & { id: number }>(
      `SELECT id FROM products WHERE shop_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`,
      [shopId(), ...productIds],
      exec,
    );
    return rows.map((r) => r.id);
  },

  async validateCouponIds(couponIds: number[], exec: Executor = pool): Promise<number[]> {
    if (couponIds.length === 0) return [];
    const placeholders = couponIds.map(() => '?').join(',');
    const rows = await query<RowDataPacket & { id: number }>(
      `SELECT id FROM coupons WHERE shop_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`,
      [shopId(), ...couponIds],
      exec,
    );
    return rows.map((r) => r.id);
  },
};
