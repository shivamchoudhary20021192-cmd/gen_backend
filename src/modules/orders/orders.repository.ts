import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface OrderRow extends RowDataPacket {
  id: number;
  order_number: string;
  public_id: string;
  customer_id: number | null;
  is_guest: number;
  contact_phone: string;
  contact_email: string | null;
  customer_name: string | null;
  currency: string;
  /** Set when the order was placed in a market abroad. */
  market_id: number | null;
  /** The store's own currency when the order was placed, and its units per unit of `currency`. */
  shop_currency: string | null;
  exchange_rate: string;
  order_status: string;
  payment_status: string;
  fulfillment_status: string;
  payment_method: string;
  subtotal: string;
  discount_total: string;
  coupon_discount: string;
  loyalty_discount: string;
  shipping_total: string;
  shipping_tax: string;
  cod_fee: string;
  tax_total: string;
  cgst_total: string;
  sgst_total: string;
  igst_total: string;
  tax_lines: unknown;
  grand_total: string;
  amount_paid: string;
  amount_refunded: string;
  amount_due: string;
  /** What gift cards paid (and still hold) on the order. */
  gift_card_total?: string;
  coupon_code: string | null;
  pincode: string | null;
  shipping_method: string;
  estimated_delivery_from: Date | null;
  estimated_delivery_to: Date | null;
  customer_note: string | null;
  admin_note: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  risk_score: number | null;
  source_channel: string;
  placed_at: Date | null;
  confirmed_at: Date | null;
  packed_at: Date | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
  item_count?: number;
}

export interface OrderItemRow extends RowDataPacket {
  id: number;
  order_id: number;
  product_id: number | null;
  variant_id: number | null;
  line_type: string;
  sku: string;
  product_name: string;
  variant_title: string | null;
  product_slug: string | null;
  image_url: string | null;
  hsn_code: string | null;
  unit_mrp: string;
  unit_price: string;
  quantity: number;
  discount_amount: string;
  taxable_amount: string;
  tax_rate: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  tax_amount: string;
  line_total: string;
  fulfilled_quantity: number;
  cancelled_quantity: number;
  returned_quantity: number;
  refunded_amount: string;
  /** Joined from the variant, not stored on the line — see `items()`. */
  weight_grams?: number | null;
}

export interface OrderAddressRow extends RowDataPacket {
  id: number;
  address_type: 'shipping' | 'billing';
  first_name: string;
  last_name: string | null;
  phone: string;
  email: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  state_code: string | null;
  pincode: string;
  country: string;
  gstin: string | null;
  delivery_notes: string | null;
}

export interface OrderHistoryRow extends RowDataPacket {
  id: number;
  status_type: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  actor_type: string;
  actor_id: number | null;
  is_customer_visible: number;
  created_at: Date;
  actor_name: string | null;
}

export interface PaymentRow extends RowDataPacket {
  id: number;
  gateway: string;
  connection_id: number | null;
  currency: string;
  gateway_payment_id: string | null;
  signature_verified: number;
  method: string | null;
  amount: string;
  status: string;
  card_last4: string | null;
  upi_vpa: string | null;
  bank: string | null;
  error_description: string | null;
  captured_at: Date | null;
  created_at: Date;
}

export interface RefundRow extends RowDataPacket {
  id: number;
  payment_id: number | null;
  gateway_refund_id: string | null;
  amount: string;
  refund_type: string;
  reason: string | null;
  status: string;
  initiated_by_admin_id: number | null;
  processed_at: Date | null;
  created_at: Date;
}

export interface ShipmentRow extends RowDataPacket {
  id: number;
  shipment_number: string;
  awb_number: string | null;
  tracking_url: string | null;
  status: string;
  shipping_mode: string | null;
  weight_grams: number | null;
  cod_amount: string | null;
  shipped_at: Date | null;
  estimated_delivery_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
  carrier_name: string | null;
}

export interface OrderFilters {
  search?: string;
  orderStatus?: string;
  paymentStatus?: string;
  fulfillmentStatus?: string;
  paymentMethod?: string;
  customerId?: number;
  placedFrom?: string;
  placedTo?: string;
  unfulfilledOnly?: boolean;
}

function buildWhere(filters: OrderFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = ['o.shop_id = ?'];
  const params: unknown[] = [shopId()];

  if (filters.search) {
    // Support finds an order from whatever the customer read out: the order
    // number, their phone, or their email.
    conditions.push('(o.order_number LIKE ? OR o.contact_phone LIKE ? OR o.contact_email LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  if (filters.orderStatus) {
    conditions.push('o.order_status = ?');
    params.push(filters.orderStatus);
  }
  if (filters.paymentStatus) {
    conditions.push('o.payment_status = ?');
    params.push(filters.paymentStatus);
  }
  if (filters.fulfillmentStatus) {
    conditions.push('o.fulfillment_status = ?');
    params.push(filters.fulfillmentStatus);
  }
  if (filters.paymentMethod) {
    conditions.push('o.payment_method = ?');
    params.push(filters.paymentMethod);
  }
  if (filters.customerId) {
    conditions.push('o.customer_id = ?');
    params.push(filters.customerId);
  }
  if (filters.placedFrom) {
    conditions.push('o.placed_at >= ?');
    params.push(filters.placedFrom);
  }
  if (filters.placedTo) {
    // Inclusive of the whole end day — a date filter that silently drops
    // today's orders is the classic support complaint.
    conditions.push('o.placed_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(filters.placedTo);
  }
  if (filters.unfulfilledOnly) {
    conditions.push("o.fulfillment_status IN ('unfulfilled','partially_fulfilled')");
    conditions.push("o.order_status NOT IN ('cancelled','returned','rto')");
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

export const ordersRepository = {
  async list(
    filters: OrderFilters,
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<OrderRow[]> {
    const { clause, params } = buildWhere(filters);
    return query<OrderRow>(
      `SELECT o.*,
              (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
                WHERE oi.shop_id = o.shop_id AND oi.order_id = o.id AND oi.line_type <> 'shipping') AS item_count
         FROM orders o ${clause}
        ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async count(filters: OrderFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM orders o ${clause}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  /** Counts per status, for the list's tab badges — one pass, not one query per tab. */
  async statusCounts(exec: Executor = pool): Promise<Record<string, number>> {
    const rows = await query<RowDataPacket & { order_status: string; total: number }>(
      'SELECT order_status, COUNT(*) AS total FROM orders WHERE shop_id = ? GROUP BY order_status',
      [shopId()],
      exec,
    );
    return Object.fromEntries(rows.map((r) => [r.order_status, Number(r.total)]));
  },

  async findById(id: number, exec: Executor = pool): Promise<OrderRow | null> {
    return queryOne<OrderRow>('SELECT * FROM orders WHERE shop_id = ? AND id = ? LIMIT 1', [shopId(), id], exec);
  },

  async findByNumber(orderNumber: string, exec: Executor = pool): Promise<OrderRow | null> {
    return queryOne<OrderRow>('SELECT * FROM orders WHERE shop_id = ? AND order_number = ? LIMIT 1', [shopId(), orderNumber], exec);
  },

  async items(orderId: number, exec: Executor = pool): Promise<OrderItemRow[]> {
    // The variant's weight rides along because shipping needs it and the order
    // line does not carry one — a courier refuses a zero-weight booking, and
    // guessing per unit when the real figure is one join away is worse.
    return query<OrderItemRow>(
      `SELECT oi.*, v.weight_grams
         FROM order_items oi
         LEFT JOIN product_variants v ON v.id = oi.variant_id AND v.shop_id = oi.shop_id
        WHERE oi.shop_id = ? AND oi.order_id = ?
        ORDER BY oi.id`,
      [shopId(), orderId],
      exec,
    );
  },

  async addresses(orderId: number, exec: Executor = pool): Promise<OrderAddressRow[]> {
    return query<OrderAddressRow>('SELECT * FROM order_addresses WHERE shop_id = ? AND order_id = ?', [shopId(), orderId], exec);
  },

  async history(orderId: number, exec: Executor = pool): Promise<OrderHistoryRow[]> {
    return query<OrderHistoryRow>(
      `SELECT h.*, CONCAT_WS(' ', a.first_name, a.last_name) AS actor_name
         FROM order_status_history h
         LEFT JOIN admin_users a ON a.id = h.actor_id AND h.actor_type = 'admin'
        WHERE h.shop_id = ? AND h.order_id = ?
        ORDER BY h.created_at DESC, h.id DESC`,
      [shopId(), orderId],
      exec,
    );
  },

  async payments(orderId: number, exec: Executor = pool): Promise<PaymentRow[]> {
    return query<PaymentRow>(
      'SELECT * FROM payments WHERE shop_id = ? AND order_id = ? ORDER BY created_at DESC',
      [shopId(), orderId],
      exec,
    );
  },

  async refunds(orderId: number, exec: Executor = pool): Promise<RefundRow[]> {
    return query<RefundRow>('SELECT * FROM refunds WHERE shop_id = ? AND order_id = ? ORDER BY created_at DESC', [shopId(), orderId], exec);
  },

  async shipments(orderId: number, exec: Executor = pool): Promise<ShipmentRow[]> {
    return query<ShipmentRow>(
      `SELECT s.*, c.name AS carrier_name
         FROM shipments s
         LEFT JOIN shipping_carriers c ON c.id = s.carrier_id AND c.shop_id = s.shop_id
        WHERE s.shop_id = ? AND s.order_id = ?
        ORDER BY s.created_at DESC`,
      [shopId(), orderId],
      exec,
    );
  },

  async update(id: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `\`${k}\` = ?`).join(', ');
    await execute(`UPDATE orders SET ${assignments} WHERE shop_id = ? AND id = ?`, [...Object.values(fields), shopId(), id], exec);
  },

  async addHistory(
    entry: {
      orderId: number;
      statusType: 'order' | 'payment' | 'fulfillment';
      fromStatus: string | null;
      toStatus: string;
      note: string | null;
      actorType: 'admin' | 'system' | 'customer' | 'webhook' | 'courier';
      actorId: number | null;
      isCustomerVisible: boolean;
    },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `INSERT INTO order_status_history
         (shop_id, order_id, status_type, from_status, to_status, note, actor_type, actor_id, is_customer_visible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        entry.orderId,
        entry.statusType,
        entry.fromStatus,
        entry.toStatus,
        entry.note,
        entry.actorType,
        entry.actorId,
        entry.isCustomerVisible ? 1 : 0,
      ],
      exec,
    );
  },

  // ── fulfilment ─────────────────────────────────────────────────────────────

  async createShipment(
    data: {
      shipmentNumber: string;
      orderId: number;
      carrierId: number | null;
      awbNumber: string | null;
      trackingUrl: string | null;
      shippingMode: string;
      weightGrams: number | null;
      codAmount: string;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO shipments
         (shop_id, shipment_number, order_id, carrier_id, awb_number, tracking_url, status,
          shipping_mode, weight_grams, cod_amount, shipped_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in_transit', ?, ?, ?, NOW())`,
      [
        shopId(),
        data.shipmentNumber,
        data.orderId,
        data.carrierId,
        data.awbNumber,
        data.trackingUrl,
        data.shippingMode,
        data.weightGrams,
        data.codAmount,
      ],
      exec,
    );
  },

  async addShipmentItem(shipmentId: number, orderItemId: number, quantity: number, exec: Executor = pool) {
    await execute(
      'INSERT INTO shipment_items (shop_id, shipment_id, order_item_id, quantity) VALUES (?, ?, ?, ?)',
      [shopId(), shipmentId, orderItemId, quantity],
      exec,
    );
  },

  async markItemsFulfilled(items: { id: number; quantity: number }[], exec: Executor = pool): Promise<void> {
    for (const item of items) {
      await execute(
        'UPDATE order_items SET fulfilled_quantity = LEAST(quantity, fulfilled_quantity + ?) WHERE shop_id = ? AND id = ?',
        [item.quantity, shopId(), item.id],
        exec,
      );
    }
  },

  async setShipmentsDelivered(orderId: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE shipments SET status = 'delivered', delivered_at = NOW()
        WHERE shop_id = ? AND order_id = ? AND status NOT IN ('delivered','cancelled','rto_delivered')`,
      [shopId(), orderId],
      exec,
    );
  },

  // ── stock ──────────────────────────────────────────────────────────────────

  /**
   * Return goods to stock and write the ledger row that explains why.
   *
   * `quantity_available` is a generated column (`on_hand - reserved`), so it is
   * never written directly — only `quantity_on_hand` moves here.
   */
  /**
   * Whether checkout took this variant out of stock for this order. A free
   * gift is only taken from stock when its offer says so, and putting back a
   * unit that never left would invent inventory.
   */
  async soldFromStock(orderId: number, variantId: number, exec: Executor = pool): Promise<boolean> {
    const row = await queryOne<RowDataPacket>(
      `SELECT 1 AS hit FROM inventory_movements
        WHERE shop_id = ? AND reference_type = 'order' AND reference_id = ? AND variant_id = ? AND movement_type = 'sale'
        LIMIT 1`,
      [shopId(), orderId, variantId],
      exec,
    );
    return row !== null;
  },

  async restock(
    variantId: number,
    quantity: number,
    reason: { movementType: string; referenceType: string; referenceId: number; adminUserId: number; note: string },
    exec: Executor = pool,
  ): Promise<void> {
    const inventory = await queryOne<RowDataPacket & { id: number; location_id: number; quantity_on_hand: number }>(
      'SELECT id, location_id, quantity_on_hand FROM inventory_items WHERE shop_id = ? AND variant_id = ? ORDER BY id LIMIT 1',
      [shopId(), variantId],
      exec,
    );
    if (!inventory) return;

    await execute(
      'UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + ? WHERE shop_id = ? AND id = ?',
      [quantity, shopId(), inventory.id],
      exec,
    );
    await execute(
      `INSERT INTO inventory_movements
         (shop_id, variant_id, location_id, movement_type, quantity_delta, quantity_after,
          reference_type, reference_id, reason, admin_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        variantId,
        inventory.location_id,
        reason.movementType,
        quantity,
        inventory.quantity_on_hand + quantity,
        reason.referenceType,
        reason.referenceId,
        reason.note,
        reason.adminUserId,
      ],
      exec,
    );
  },

  // ── money ──────────────────────────────────────────────────────────────────

  async capturedPayment(orderId: number, exec: Executor = pool): Promise<PaymentRow | null> {
    return queryOne<PaymentRow>(
      `SELECT * FROM payments
        WHERE shop_id = ? AND order_id = ? AND status IN ('captured','authorized')
        ORDER BY created_at DESC LIMIT 1`,
      [shopId(), orderId],
      exec,
    );
  },

  async createRefund(
    data: {
      orderId: number;
      paymentId: number | null;
      amount: number;
      refundType: 'full' | 'partial';
      reason: string | null;
      internalNote: string | null;
      adminUserId: number;
    },
    exec: Executor = pool,
  ): Promise<number> {
    // 'pending' rather than 'processed': nothing has left the gateway yet. The
    // Razorpay call and its webhook flip it, and until then the order must not
    // claim the customer has their money back.
    return insert(
      `INSERT INTO refunds
         (shop_id, order_id, payment_id, amount, refund_type, reason, internal_note, status, initiated_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        shopId(),
        data.orderId,
        data.paymentId,
        data.amount,
        data.refundType,
        data.reason,
        data.internalNote,
        data.adminUserId,
      ],
      exec,
    );
  },

  async refundedTotal(orderId: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM refunds
        WHERE shop_id = ? AND order_id = ? AND status IN ('pending','processing','processed')`,
      [shopId(), orderId],
      exec,
    );
    return Number(row?.total ?? 0);
  },

  async addItemRefund(orderItemId: number, amount: number, exec: Executor = pool): Promise<void> {
    await execute(
      'UPDATE order_items SET refunded_amount = refunded_amount + ? WHERE shop_id = ? AND id = ?',
      [amount, shopId(), orderItemId],
      exec,
    );
  },

  async nextSequence(prefix: string, table: 'orders' | 'shipments', exec: Executor = pool): Promise<string> {
    const column = table === 'orders' ? 'order_number' : 'shipment_number';
    const row = await queryOne<RowDataPacket & { last: string | null }>(
      `SELECT MAX(${column}) AS last FROM ${table} WHERE shop_id = ? AND ${column} LIKE ?`,
      [shopId(), `${prefix}%`],
      exec,
    );
    const lastNumber = row?.last ? Number(row.last.slice(prefix.length)) : 0;
    return `${prefix}${String(lastNumber + 1).padStart(6, '0')}`;
  },
};
