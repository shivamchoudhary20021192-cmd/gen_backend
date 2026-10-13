import { execute, insert, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface ReturnRow extends RowDataPacket {
  id: number;
  rma_number: string;
  order_id: number;
  order_number: string;
  order_status: string;
  payment_method: string;
  amount_paid: string;
  amount_refunded: string;
  customer_id: number | null;
  customer_name: string | null;
  contact_phone: string | null;
  reason: string;
  reason_detail: string | null;
  status: string;
  refund_method: string;
  requested_amount: string | null;
  approved_amount: string | null;
  pickup_awb: string | null;
  rejection_reason: string | null;
  inspection_note: string | null;
  requested_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
  received_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  item_count: number;
  delivered_at: Date | null;
}

export interface ReturnItemRow extends RowDataPacket {
  id: number;
  order_item_id: number;
  quantity: number;
  refund_amount: string;
  item_condition: string | null;
  restock: number;
  condition_note: string | null;
  sku: string;
  product_name: string;
  variant_title: string | null;
  image_url: string | null;
  variant_id: number | null;
  ordered_quantity: number;
  already_returned: number;
  unit_price: string;
}

const RETURN_COLUMNS = `
  r.id, r.rma_number, r.order_id, r.customer_id, r.reason, r.reason_detail, r.status,
  r.refund_method, r.requested_amount, r.approved_amount, r.pickup_awb, r.rejection_reason,
  r.inspection_note, r.requested_at, r.approved_at, r.received_at, r.closed_at, r.created_at,
  o.order_number, o.order_status, o.payment_method, o.amount_paid, o.amount_refunded, o.delivered_at,
  o.contact_phone,
  TRIM(CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, ''))) AS customer_name,
  TRIM(CONCAT(COALESCE(ad.first_name, ''), ' ', COALESCE(ad.last_name, ''))) AS approved_by,
  (SELECT COALESCE(SUM(ri.quantity), 0) FROM return_items ri WHERE ri.shop_id = r.shop_id AND ri.return_request_id = r.id) AS item_count`;

const RETURN_FROM = `
  FROM return_requests r
  JOIN orders o ON o.id = r.order_id
  LEFT JOIN order_addresses a ON a.order_id = o.id AND a.address_type = 'shipping'
  LEFT JOIN admin_users ad ON ad.id = r.approved_by_admin_id`;

export interface ReturnFilters {
  search?: string;
  status?: string;
  reason?: string;
  orderId?: number;
  customerId?: number;
  /** Everything still needing a decision or a movement. */
  openOnly?: boolean;
}

const CLOSED = ['rejected', 'refunded', 'closed'];

function buildWhere(filters: ReturnFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = ['r.shop_id = ?'];
  const params: unknown[] = [shopId()];

  if (filters.search) {
    conditions.push('(r.rma_number LIKE ? OR o.order_number LIKE ? OR o.contact_phone LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  if (filters.status) {
    conditions.push('r.status = ?');
    params.push(filters.status);
  }
  if (filters.reason) {
    conditions.push('r.reason = ?');
    params.push(filters.reason);
  }
  if (filters.orderId) {
    conditions.push('r.order_id = ?');
    params.push(filters.orderId);
  }
  if (filters.customerId) {
    conditions.push('r.customer_id = ?');
    params.push(filters.customerId);
  }
  if (filters.openOnly) {
    conditions.push(`r.status NOT IN (${CLOSED.map(() => '?').join(', ')})`);
    params.push(...CLOSED);
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

export const returnsRepository = {
  async list(filters: ReturnFilters, orderBy: string, limit: number, offset: number, exec: Executor = pool) {
    const { clause, params } = buildWhere(filters);
    return query<ReturnRow>(
      `SELECT ${RETURN_COLUMNS} ${RETURN_FROM} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async count(filters: ReturnFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total ${RETURN_FROM} ${clause}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  async statusCounts(exec: Executor = pool): Promise<Record<string, number>> {
    const rows = await query<RowDataPacket & { status: string; total: number }>(
      'SELECT status, COUNT(*) AS total FROM return_requests WHERE shop_id = ? GROUP BY status',
      [shopId()],
      exec,
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
  },

  async findById(id: number, exec: Executor = pool): Promise<ReturnRow | null> {
    return queryOne<ReturnRow>(`SELECT ${RETURN_COLUMNS} ${RETURN_FROM} WHERE r.shop_id = ? AND r.id = ? LIMIT 1`, [shopId(), id], exec);
  },

  async itemsFor(returnId: number, exec: Executor = pool): Promise<ReturnItemRow[]> {
    return query<ReturnItemRow>(
      `SELECT ri.id, ri.order_item_id, ri.quantity, ri.refund_amount, ri.item_condition,
              ri.restock, ri.condition_note,
              oi.sku, oi.product_name, oi.variant_title, oi.image_url, oi.variant_id,
              oi.quantity AS ordered_quantity, oi.returned_quantity AS already_returned, oi.unit_price
         FROM return_items ri
         JOIN order_items oi ON oi.id = ri.order_item_id
        WHERE ri.shop_id = ? AND ri.return_request_id = ?
        ORDER BY ri.id`,
      [shopId(), returnId],
      exec,
    );
  },

  /**
   * How much of each line is still returnable.
   *
   * Delivered minus already-returned, not ordered minus returned: a line that
   * was cancelled before it shipped was never in the customer's hands and
   * cannot come back.
   */
  async returnableItems(orderId: number, exec: Executor = pool) {
    return query<
      RowDataPacket & {
        id: number;
        sku: string;
        product_name: string;
        variant_title: string | null;
        image_url: string | null;
        variant_id: number | null;
        quantity: number;
        fulfilled_quantity: number;
        returned_quantity: number;
        unit_price: string;
        line_total: string;
        returnable: number;
      }
    >(
      `SELECT oi.id, oi.sku, oi.product_name, oi.variant_title, oi.image_url, oi.variant_id,
              oi.quantity, oi.fulfilled_quantity, oi.returned_quantity, oi.unit_price, oi.line_total,
              GREATEST(oi.fulfilled_quantity - oi.returned_quantity, 0) AS returnable
         FROM order_items oi
        WHERE oi.shop_id = ? AND oi.order_id = ? AND oi.line_type <> 'shipping'
        ORDER BY oi.id`,
      [shopId(), orderId],
      exec,
    );
  },

  /** Open returns already claiming stock on this order, so two RMAs cannot double-count. */
  async pendingReturnedQuantities(orderId: number, excludeReturnId: number | null, exec: Executor = pool) {
    return query<RowDataPacket & { order_item_id: number; quantity: number }>(
      `SELECT ri.order_item_id, COALESCE(SUM(ri.quantity), 0) AS quantity
         FROM return_items ri
         JOIN return_requests r ON r.id = ri.return_request_id
        WHERE r.shop_id = ? AND r.order_id = ?
          AND r.status NOT IN ('rejected', 'closed')
          ${excludeReturnId ? 'AND r.id <> ?' : ''}
        GROUP BY ri.order_item_id`,
      excludeReturnId ? [shopId(), orderId, excludeReturnId] : [shopId(), orderId],
      exec,
    );
  },

  async create(
    data: {
      rmaNumber: string;
      orderId: number;
      customerId: number | null;
      reason: string;
      reasonDetail: string | null;
      refundMethod: string;
      requestedAmount: number;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO return_requests
         (shop_id, rma_number, order_id, customer_id, reason, reason_detail, status, refund_method, requested_amount)
       VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
      [
        shopId(),
        data.rmaNumber,
        data.orderId,
        data.customerId,
        data.reason,
        data.reasonDetail,
        data.refundMethod,
        data.requestedAmount,
      ],
      exec,
    );
  },

  async addItem(
    returnId: number,
    data: { orderItemId: number; quantity: number; refundAmount: number },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      'INSERT INTO return_items (shop_id, return_request_id, order_item_id, quantity, refund_amount) VALUES (?, ?, ?, ?, ?)',
      [shopId(), returnId, data.orderItemId, data.quantity, data.refundAmount],
      exec,
    );
  },

  async updateItem(itemId: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    await execute(
      `UPDATE return_items SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE shop_id = ? AND id = ?`,
      [...Object.values(fields), shopId(), itemId],
      exec,
    );
  },

  async update(id: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    await execute(
      `UPDATE return_requests SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE shop_id = ? AND id = ?`,
      [...Object.values(fields), shopId(), id],
      exec,
    );
  },

  /** Marks the order lines returned, which is what stops a second RMA on them. */
  async markItemsReturned(
    lines: { orderItemId: number; quantity: number }[],
    exec: Executor = pool,
  ): Promise<void> {
    for (const line of lines) {
      await execute(
        'UPDATE order_items SET returned_quantity = returned_quantity + ? WHERE shop_id = ? AND id = ?',
        [line.quantity, shopId(), line.orderItemId],
        exec,
      );
    }
  },

  async restock(variantId: number, quantity: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + ?
        WHERE shop_id = ? AND variant_id = ? ORDER BY id LIMIT 1`,
      [quantity, shopId(), variantId],
      exec,
    );
  },
};
