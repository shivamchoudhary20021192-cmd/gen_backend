import { execute, insert, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { shopId } from '../tenancy/context';

/**
 * The signed-in shopper's own records, as the Online Store's account pages
 * read and change them: their profile, their address book and their orders.
 *
 * Every query is keyed on the customer as well as the shop. An order or
 * address id in a URL is never trusted on its own — someone else's order
 * number simply is not found.
 */

export interface AccountCustomerRow extends RowDataPacket {
  id: number;
  public_id: string;
  country_code: string;
  phone: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  status: string;
  accepts_email_marketing: number;
  accepts_sms_marketing: number;
  accepts_whatsapp_marketing: number;
  orders_count: number;
  total_spent: string;
  preferred_language: string;
  created_at: Date;
}

export interface AddressRow extends RowDataPacket {
  id: number;
  label: string;
  first_name: string;
  last_name: string | null;
  phone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  state_code: string | null;
  pincode: string;
  country: string;
  is_default_shipping: number;
}

export interface AccountOrderRow extends RowDataPacket {
  id: number;
  public_id: string;
  order_number: string;
  currency: string;
  order_status: string;
  payment_status: string;
  fulfillment_status: string;
  payment_method: string | null;
  subtotal: string;
  discount_total: string;
  coupon_code: string | null;
  shipping_total: string;
  cod_fee: string;
  tax_total: string;
  grand_total: string;
  customer_note: string | null;
  cancel_reason: string | null;
  estimated_delivery_from: Date | null;
  estimated_delivery_to: Date | null;
  placed_at: Date | null;
  cancelled_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
  item_count: number;
}

export interface AccountOrderItemRow extends RowDataPacket {
  id: number;
  product_id: number | null;
  variant_id: number | null;
  sku: string | null;
  product_name: string;
  variant_title: string | null;
  product_slug: string | null;
  image_url: string | null;
  unit_mrp: string;
  unit_price: string;
  quantity: number;
  discount_amount: string;
  line_total: string;
  fulfilled_quantity: number;
}

export interface OrderAddressRow extends RowDataPacket {
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
}

export interface OrderShipmentRow extends RowDataPacket {
  shipment_number: string;
  awb_number: string | null;
  tracking_url: string | null;
  status: string;
  shipped_at: Date | null;
  delivered_at: Date | null;
  carrier_name: string | null;
}

export interface OrderEventRow extends RowDataPacket {
  status_type: string;
  to_status: string;
  note: string | null;
  created_at: Date;
}

export interface AddressInput {
  first_name: string;
  last_name: string | null;
  phone: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  state_code: string | null;
  pincode: string;
  country: string;
  label?: string | null;
}

const ORDER_COLUMNS = `o.id, o.public_id, o.order_number, o.currency, o.order_status, o.payment_status, o.fulfillment_status,
  o.payment_method, o.subtotal, o.discount_total, o.coupon_code, o.shipping_total, o.cod_fee, o.tax_total, o.grand_total,
  o.customer_note, o.cancel_reason, o.estimated_delivery_from, o.estimated_delivery_to, o.placed_at, o.cancelled_at,
  o.delivered_at, o.created_at,
  (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
    WHERE oi.shop_id = o.shop_id AND oi.order_id = o.id AND oi.line_type IN ('product', 'bundle', 'gift')) AS item_count`;

export const customerAccountRepository = {
  async customer(customerId: number, exec: Executor = pool): Promise<AccountCustomerRow | null> {
    return queryOne<AccountCustomerRow>(
      `SELECT id, public_id, country_code, phone, email, first_name, last_name, status, accepts_email_marketing,
              accepts_sms_marketing, accepts_whatsapp_marketing, orders_count, total_spent, preferred_language, created_at
         FROM customers WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1`,
      [shopId(), customerId],
      exec,
    );
  },

  /** Is this email someone else's? The column is unique per shop. */
  async emailTaken(email: string, customerId: number, exec: Executor = pool): Promise<boolean> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      'SELECT id FROM customers WHERE shop_id = ? AND email = ? AND id <> ? LIMIT 1',
      [shopId(), email, customerId],
      exec,
    );
    return Boolean(row);
  },

  async updateProfile(
    customerId: number,
    fields: { first_name?: string | null; last_name?: string | null; email?: string | null; accepts_email_marketing?: boolean },
    exec: Executor = pool,
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of ['first_name', 'last_name', 'email'] as const) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }
    if (fields.accepts_email_marketing !== undefined) {
      sets.push('accepts_email_marketing = ?');
      values.push(fields.accepts_email_marketing ? 1 : 0);
    }
    if (sets.length === 0) return;
    if (fields.first_name !== undefined || fields.email !== undefined) sets.push('profile_completed_at = COALESCE(profile_completed_at, NOW())');
    await execute(`UPDATE customers SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`, [...values, shopId(), customerId], exec);
  },

  // ── addresses ───────────────────────────────────────────────────────────

  async addresses(customerId: number, exec: Executor = pool): Promise<AddressRow[]> {
    return query<AddressRow>(
      `SELECT id, label, first_name, last_name, phone, line1, line2, landmark, city, state, state_code, pincode, country, is_default_shipping
         FROM customer_addresses
        WHERE shop_id = ? AND customer_id = ? AND deleted_at IS NULL
        ORDER BY is_default_shipping DESC, updated_at DESC, id DESC
        LIMIT 50`,
      [shopId(), customerId],
      exec,
    );
  },

  async countAddresses(customerId: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { n: number }>(
      'SELECT COUNT(*) AS n FROM customer_addresses WHERE shop_id = ? AND customer_id = ? AND deleted_at IS NULL',
      [shopId(), customerId],
      exec,
    );
    return Number(row?.n ?? 0);
  },

  /**
   * Adds an address. The first one becomes the default, and so does any the
   * shopper ticks "default" on — clearing the flag from the others in the same
   * transaction, so there is never more than one.
   */
  async addAddress(customerId: number, input: AddressInput, makeDefault: boolean): Promise<number> {
    return withTransaction(async (tx) => {
      const existing = await this.countAddresses(customerId, tx);
      const isDefault = makeDefault || existing === 0;
      if (isDefault) await this.clearDefault(customerId, tx);
      return insert(
        `INSERT INTO customer_addresses
           (shop_id, customer_id, label, first_name, last_name, phone, line1, line2, landmark, city, state, state_code, pincode,
            country, is_default_shipping, is_default_billing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          shopId(),
          customerId,
          (input.label ?? 'Home').slice(0, 40),
          input.first_name,
          input.last_name,
          input.phone,
          input.line1,
          input.line2,
          input.landmark,
          input.city,
          input.state,
          input.state_code,
          input.pincode,
          input.country,
          isDefault ? 1 : 0,
          isDefault ? 1 : 0,
        ],
        tx,
      );
    });
  },

  async updateAddress(customerId: number, addressId: number, input: AddressInput, makeDefault: boolean): Promise<boolean> {
    return withTransaction(async (tx) => {
      if (makeDefault) await this.clearDefault(customerId, tx);
      const result = await execute(
        `UPDATE customer_addresses
            SET first_name = ?, last_name = ?, phone = ?, line1 = ?, line2 = ?, landmark = ?, city = ?, state = ?, state_code = ?,
                pincode = ?, country = ?${makeDefault ? ', is_default_shipping = 1, is_default_billing = 1' : ''}
          WHERE shop_id = ? AND customer_id = ? AND id = ? AND deleted_at IS NULL`,
        [
          input.first_name,
          input.last_name,
          input.phone,
          input.line1,
          input.line2,
          input.landmark,
          input.city,
          input.state,
          input.state_code,
          input.pincode,
          input.country,
          shopId(),
          customerId,
          addressId,
        ],
        tx,
      );
      return result.affectedRows > 0;
    });
  },

  /** Soft-deleted: past orders keep their own copy, but support may still ask "which address was that?". */
  async removeAddress(customerId: number, addressId: number): Promise<boolean> {
    return withTransaction(async (tx) => {
      const row = await queryOne<RowDataPacket & { is_default_shipping: number }>(
        'SELECT is_default_shipping FROM customer_addresses WHERE shop_id = ? AND customer_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
        [shopId(), customerId, addressId],
        tx,
      );
      if (!row) return false;
      await execute(
        'UPDATE customer_addresses SET deleted_at = NOW(), is_default_shipping = 0, is_default_billing = 0 WHERE shop_id = ? AND id = ?',
        [shopId(), addressId],
        tx,
      );
      // The default went with it: the most recent remaining address takes over.
      if (row.is_default_shipping === 1) {
        await execute(
          `UPDATE customer_addresses SET is_default_shipping = 1, is_default_billing = 1
            WHERE shop_id = ? AND customer_id = ? AND deleted_at IS NULL
            ORDER BY updated_at DESC, id DESC LIMIT 1`,
          [shopId(), customerId],
          tx,
        );
      }
      return true;
    });
  },

  async clearDefault(customerId: number, exec: Executor): Promise<void> {
    await execute(
      'UPDATE customer_addresses SET is_default_shipping = 0, is_default_billing = 0 WHERE shop_id = ? AND customer_id = ? AND deleted_at IS NULL',
      [shopId(), customerId],
      exec,
    );
  },

  // ── orders ──────────────────────────────────────────────────────────────

  async orders(customerId: number, limit: number, offset: number, exec: Executor = pool): Promise<AccountOrderRow[]> {
    return query<AccountOrderRow>(
      `SELECT ${ORDER_COLUMNS}
         FROM orders o
        WHERE o.shop_id = ? AND o.customer_id = ? AND o.placed_at IS NOT NULL
        ORDER BY o.placed_at DESC, o.id DESC
        LIMIT ? OFFSET ?`,
      [shopId(), customerId, limit, offset],
      exec,
    );
  },

  async countOrders(customerId: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { n: number }>(
      'SELECT COUNT(*) AS n FROM orders WHERE shop_id = ? AND customer_id = ? AND placed_at IS NOT NULL',
      [shopId(), customerId],
      exec,
    );
    return Number(row?.n ?? 0);
  },

  /** One of this customer's orders, by its public id or its order number. */
  async order(customerId: number, reference: string, exec: Executor = pool): Promise<AccountOrderRow | null> {
    return queryOne<AccountOrderRow>(
      `SELECT ${ORDER_COLUMNS}
         FROM orders o
        WHERE o.shop_id = ? AND o.customer_id = ? AND (o.public_id = ? OR o.order_number = ?) AND o.placed_at IS NOT NULL
        LIMIT 1`,
      [shopId(), customerId, reference, reference],
      exec,
    );
  },

  async orderItems(orderIds: number[], exec: Executor = pool): Promise<(AccountOrderItemRow & { order_id: number })[]> {
    if (orderIds.length === 0) return [];
    return query<AccountOrderItemRow & { order_id: number }>(
      `SELECT id, order_id, product_id, variant_id, sku, product_name, variant_title, product_slug, image_url, unit_mrp, unit_price,
              quantity, discount_amount, line_total, fulfilled_quantity
         FROM order_items
        WHERE shop_id = ? AND order_id IN (?) AND line_type IN ('product', 'bundle', 'gift')
        ORDER BY id`,
      [shopId(), orderIds],
      exec,
    );
  },

  async orderAddresses(orderId: number, exec: Executor = pool): Promise<OrderAddressRow[]> {
    return query<OrderAddressRow>(
      `SELECT address_type, first_name, last_name, phone, email, line1, line2, landmark, city, state, state_code, pincode, country
         FROM order_addresses WHERE shop_id = ? AND order_id = ?`,
      [shopId(), orderId],
      exec,
    );
  },

  async orderShipments(orderId: number, exec: Executor = pool): Promise<OrderShipmentRow[]> {
    return query<OrderShipmentRow>(
      `SELECT s.shipment_number, s.awb_number, s.tracking_url, s.status, s.shipped_at, s.delivered_at, c.name AS carrier_name
         FROM shipments s
         LEFT JOIN shipping_carriers c ON c.id = s.carrier_id AND c.shop_id = s.shop_id
        WHERE s.shop_id = ? AND s.order_id = ?
        ORDER BY s.created_at`,
      [shopId(), orderId],
      exec,
    );
  },

  /** What the shopper may see of the order's history. */
  async orderEvents(orderId: number, exec: Executor = pool): Promise<OrderEventRow[]> {
    return query<OrderEventRow>(
      `SELECT status_type, to_status, note, created_at
         FROM order_status_history
        WHERE shop_id = ? AND order_id = ? AND is_customer_visible = 1
        ORDER BY created_at, id`,
      [shopId(), orderId],
      exec,
    );
  },
};
