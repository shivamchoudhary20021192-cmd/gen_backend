import { execute, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface AbandonedCartRow extends RowDataPacket {
  id: number;
  token: string;
  recovery_token: string | null;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  status: string;
  item_count: number;
  live_item_count: number;
  subtotal: string;
  live_subtotal: string;
  pincode: string | null;
  abandoned_at: Date | null;
  recovery_email_sent_at: Date | null;
  last_activity_at: Date;
  created_at: Date;
  converted_order_id: number | null;
  utm: unknown;
}

// tenancy: scoped by caller — every query using these columns filters c.shop_id.
const CART_COLUMNS = `
  c.id, c.token, c.recovery_token, c.customer_id, c.status, c.item_count, c.subtotal,
  c.pincode, c.abandoned_at, c.recovery_email_sent_at, c.last_activity_at, c.created_at,
  c.converted_order_id, c.utm,
  TRIM(CONCAT(COALESCE(cu.first_name, ''), ' ', COALESCE(cu.last_name, ''))) AS customer_name,
  cu.phone AS customer_phone,
  cu.email AS customer_email,
  -- Recomputed from the lines rather than read from the cached columns: a cart
  -- abandoned last week may hold items whose price has since changed, and the
  -- number staff quote on a recovery call has to be the one checkout will charge.
  (SELECT COALESCE(SUM(ci.quantity), 0) FROM cart_items ci WHERE ci.cart_id = c.id) AS live_item_count,
  (SELECT COALESCE(SUM(ci.quantity * v.price), 0)
     FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id
    WHERE ci.cart_id = c.id) AS live_subtotal`;

const CART_FROM = `
  FROM carts c
  LEFT JOIN customers cu ON cu.id = c.customer_id AND cu.shop_id = c.shop_id`;

export interface CartFilters {
  search?: string;
  /** Only carts with something in them — an empty abandoned cart is noise. */
  minValue?: number;
  hasContact?: boolean;
  from?: string;
  to?: string;
}

/**
 * The base predicate for "abandoned".
 *
 * A cart counts only if it was never converted. Status alone is not enough:
 * a cart marked abandoned by the sweep and then recovered by the customer is
 * still `abandoned` in the column but has an order attached, and chasing that
 * customer is how you apologise to someone who already bought.
 */
// tenancy: scoped by caller — buildWhere puts c.shop_id = ? in front of it.
const ABANDONED_BASE = `
  c.converted_order_id IS NULL
  AND c.status IN ('active', 'abandoned')
  AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)`;

function buildWhere(filters: CartFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = ['c.shop_id = ?', ABANDONED_BASE, "c.status = 'abandoned'"];
  const params: unknown[] = [shopId()];

  if (filters.search) {
    conditions.push('(cu.phone LIKE ? OR cu.email LIKE ? OR c.pincode LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  if (filters.hasContact) {
    // No phone and no email means nobody to reach, so the row is only clutter
    // in a queue whose whole purpose is making contact.
    conditions.push('(cu.phone IS NOT NULL OR cu.email IS NOT NULL)');
  }
  if (filters.from) {
    conditions.push('c.abandoned_at >= ?');
    params.push(`${filters.from} 00:00:00`);
  }
  if (filters.to) {
    conditions.push('c.abandoned_at <= ?');
    params.push(`${filters.to} 23:59:59`);
  }
  if (filters.minValue !== undefined) {
    conditions.push(
      `(SELECT COALESCE(SUM(ci.quantity * v.price), 0)
          FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id
         WHERE ci.cart_id = c.id) >= ?`,
    );
    params.push(filters.minValue);
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

export const cartsRepository = {
  async list(filters: CartFilters, orderBy: string, limit: number, offset: number, exec: Executor = pool) {
    const { clause, params } = buildWhere(filters);
    return query<AbandonedCartRow>(
      `SELECT ${CART_COLUMNS} ${CART_FROM} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async count(filters: CartFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total ${CART_FROM} ${clause}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  async stats(filters: CartFilters, exec: Executor = pool) {
    const { clause, params } = buildWhere(filters);
    return queryOne<RowDataPacket & { carts: number; value: string; recovered: number }>(
      `SELECT COUNT(*) AS carts,
              COALESCE(SUM((SELECT COALESCE(SUM(ci.quantity * v.price), 0)
                              FROM cart_items ci JOIN product_variants v ON v.id = ci.variant_id
                             WHERE ci.cart_id = c.id)), 0) AS value,
              0 AS recovered
         ${CART_FROM} ${clause}`,
      params,
      exec,
    );
  },

  /** Carts abandoned in a window that later converted — the recovery rate. */
  async recoveredCount(sinceDays: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM carts
        WHERE shop_id = ?
          AND abandoned_at IS NOT NULL
          AND abandoned_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          AND converted_order_id IS NOT NULL`,
      [shopId(), sinceDays],
      exec,
    );
    return row?.total ?? 0;
  },

  async findById(id: number, exec: Executor = pool): Promise<AbandonedCartRow | null> {
    return queryOne<AbandonedCartRow>(`SELECT ${CART_COLUMNS} ${CART_FROM} WHERE c.shop_id = ? AND c.id = ? LIMIT 1`, [shopId(), id], exec);
  },

  async itemsFor(cartId: number, exec: Executor = pool) {
    return query<
      RowDataPacket & {
        id: number;
        variant_id: number;
        quantity: number;
        sku: string;
        product_name: string;
        product_slug: string;
        variant_title: string | null;
        price: string;
        available: number;
        track_inventory: number;
      }
    >(
      `SELECT ci.id, ci.variant_id, ci.quantity,
              v.sku, v.variant_title, v.price, v.track_inventory,
              p.name AS product_name, p.slug AS product_slug,
              COALESCE((SELECT SUM(ii.quantity_available) FROM inventory_items ii
                         WHERE ii.shop_id = v.shop_id AND ii.variant_id = v.id), 0) AS available
         FROM cart_items ci
         JOIN product_variants v ON v.id = ci.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE ci.shop_id = ? AND ci.cart_id = ?
        ORDER BY ci.id`,
      [shopId(), cartId],
      exec,
    );
  },

  /**
   * Marks stale carts abandoned.
   *
   * Runs on demand from the admin rather than on a schedule, because there is
   * no job runner yet and a queue that only fills when someone opens it is
   * better than one that silently never fills at all.
   */
  async markStaleAbandoned(idleHours: number, exec: Executor = pool): Promise<number> {
    const result = await execute(
      `UPDATE carts c
          SET c.status = 'abandoned', c.abandoned_at = COALESCE(c.abandoned_at, c.last_activity_at)
        WHERE c.shop_id = ?
          AND c.status = 'active'
          AND c.converted_order_id IS NULL
          AND c.last_activity_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
          AND EXISTS (SELECT 1 FROM cart_items ci WHERE ci.cart_id = c.id)`,
      [shopId(), idleHours],
      exec,
    );
    return result.affectedRows;
  },

  async setRecoveryToken(id: number, token: string, exec: Executor = pool): Promise<void> {
    await execute('UPDATE carts SET recovery_token = ? WHERE shop_id = ? AND id = ?', [token, shopId(), id], exec);
  },

  async markContacted(id: number, exec: Executor = pool): Promise<void> {
    await execute('UPDATE carts SET recovery_email_sent_at = NOW() WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async dismiss(id: number, exec: Executor = pool): Promise<void> {
    // 'expired' rather than a delete: the cart is evidence of intent, and the
    // conversion numbers need it even once nobody will chase it.
    await execute("UPDATE carts SET status = 'expired' WHERE shop_id = ? AND id = ?", [shopId(), id], exec);
  },

  async findByRecoveryToken(token: string, exec: Executor = pool): Promise<AbandonedCartRow | null> {
    return queryOne<AbandonedCartRow>(
      `SELECT ${CART_COLUMNS} ${CART_FROM}
        WHERE c.shop_id = ? AND c.recovery_token = ? AND c.converted_order_id IS NULL
        LIMIT 1`,
      [shopId(), token],
      exec,
    );
  },

  async reactivate(id: number, exec: Executor = pool): Promise<void> {
    await execute(
      "UPDATE carts SET status = 'active', last_activity_at = NOW() WHERE shop_id = ? AND id = ? AND converted_order_id IS NULL",
      [shopId(), id],
      exec,
    );
  },
};
