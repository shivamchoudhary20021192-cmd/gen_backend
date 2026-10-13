import { query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../tenancy/context';

/**
 * What an event says about the thing it is about.
 *
 * Read inside the transaction that made the change, so a webhook describes the
 * resource exactly as it was committed — not as it happens to be when the
 * delivery job runs minutes later. Deliberately a stable, documented subset of
 * each resource (the fields an app or an automation acts on), not the row:
 * internal columns change shape between releases, and a webhook payload is an
 * API contract.
 */

type Snapshot = Record<string, unknown>;
type Builder = (id: number, exec: Executor) => Promise<Snapshot | null>;

const money = (value: unknown) => (value === null || value === undefined ? null : Number(value));

const builders: Record<string, Builder> = {
  async order(id, exec) {
    const order = await queryOne<RowDataPacket>(
      `SELECT id, public_id, order_number, customer_id, is_guest, contact_email, contact_phone, customer_name,
              currency, shop_currency, exchange_rate, order_status, payment_status, fulfillment_status, payment_method,
              subtotal, discount_total, shipping_total, shipping_tax, cod_fee, tax_total, tax_lines, grand_total, amount_paid, amount_due,
              pincode, source_channel, placed_at, updated_at
         FROM orders WHERE shop_id = ? AND id = ?`,
      [shopId(), id],
      exec,
    );
    if (!order) return null;
    const items = await query<RowDataPacket>(
      `SELECT id, product_id, variant_id, sku, product_name, variant_title, quantity, unit_price, discount_amount,
              tax_amount, line_total
         FROM order_items WHERE shop_id = ? AND order_id = ? ORDER BY id`,
      [shopId(), id],
      exec,
    );
    const shipments = await query<RowDataPacket>(
      `SELECT s.id, s.shipment_number, s.status, s.awb_number, c.code AS carrier, c.tracking_url_template,
              s.shipped_at, s.delivered_at
         FROM shipments s LEFT JOIN shipping_carriers c ON c.id = s.carrier_id AND c.shop_id = s.shop_id
        WHERE s.shop_id = ? AND s.order_id = ? ORDER BY s.id`,
      [shopId(), id],
      exec,
    );
    return {
      id: Number(order.id),
      admin_graphql_id: order.public_id,
      name: order.order_number,
      order_number: order.order_number,
      customer: order.customer_id ? { id: Number(order.customer_id), name: order.customer_name, email: order.contact_email, phone: order.contact_phone } : null,
      email: order.contact_email,
      phone: order.contact_phone,
      // Amounts are in the currency the customer paid in; `shop_currency` and
      // `exchange_rate` (store units per unit paid) give the store's view.
      currency: order.currency,
      presentment_currency: order.currency,
      shop_currency: order.shop_currency ?? order.currency,
      exchange_rate: Number(order.exchange_rate ?? 1),
      status: order.order_status,
      financial_status: order.payment_status,
      fulfillment_status: order.fulfillment_status,
      payment_method: order.payment_method,
      subtotal_price: money(order.subtotal),
      total_discounts: money(order.discount_total),
      total_shipping: money(order.shipping_total),
      total_tax: money(order.tax_total),
      total_shipping_tax: money(order.shipping_tax),
      // Shopify's shape: a title, the rate as a fraction, and the amount.
      tax_lines: (Array.isArray(order.tax_lines) ? (order.tax_lines as { name?: string; rate?: number; amount?: number }[]) : []).map((line) => ({
        title: line.name ?? 'Tax',
        rate: Number(line.rate ?? 0) / 100,
        price: money(line.amount ?? 0),
      })),
      total_price: money(order.grand_total),
      total_paid: money(order.amount_paid),
      total_outstanding: money(order.amount_due),
      postal_code: order.pincode,
      source_name: order.source_channel,
      created_at: order.placed_at,
      updated_at: order.updated_at,
      line_items: items.map((item) => ({
        id: Number(item.id),
        product_id: item.product_id ? Number(item.product_id) : null,
        variant_id: item.variant_id ? Number(item.variant_id) : null,
        sku: item.sku,
        title: item.product_name,
        variant_title: item.variant_title,
        quantity: Number(item.quantity),
        price: money(item.unit_price),
        total_discount: money(item.discount_amount),
        total_tax: money(item.tax_amount),
        total: money(item.line_total),
      })),
      fulfillments: shipments.map((shipment) => ({
        id: Number(shipment.id),
        name: shipment.shipment_number,
        status: shipment.status,
        tracking_number: shipment.awb_number,
        tracking_company: shipment.carrier,
        tracking_url:
          shipment.tracking_url_template && shipment.awb_number
            ? String(shipment.tracking_url_template).replace('{awb}', encodeURIComponent(shipment.awb_number))
            : null,
        shipped_at: shipment.shipped_at,
        delivered_at: shipment.delivered_at,
      })),
    };
  },

  async product(id, exec) {
    const product = await queryOne<RowDataPacket>(
      `SELECT id, public_id, slug, name, subtitle, product_type, status, visibility, category_id, created_at, updated_at, deleted_at
         FROM products WHERE shop_id = ? AND id = ?`,
      [shopId(), id],
      exec,
    );
    if (!product) return { id, deleted: true };
    const variants = await query<RowDataPacket>(
      `SELECT id, public_id, sku, barcode, variant_title, price, mrp, weight_grams, status, position
         FROM product_variants WHERE shop_id = ? AND product_id = ? AND deleted_at IS NULL ORDER BY position, id`,
      [shopId(), id],
      exec,
    );
    return {
      id: Number(product.id),
      admin_graphql_id: product.public_id,
      handle: product.slug,
      title: product.name,
      subtitle: product.subtitle,
      product_type: product.product_type,
      status: product.status,
      published: product.status === 'active' && product.visibility !== 'hidden',
      category_id: product.category_id ? Number(product.category_id) : null,
      created_at: product.created_at,
      updated_at: product.updated_at,
      deleted: product.deleted_at !== null,
      variants: variants.map((variant) => ({
        id: Number(variant.id),
        admin_graphql_id: variant.public_id,
        sku: variant.sku,
        barcode: variant.barcode,
        title: variant.variant_title,
        price: money(variant.price),
        compare_at_price: money(variant.mrp),
        grams: variant.weight_grams,
        status: variant.status,
        position: variant.position,
      })),
    };
  },

  async product_variant(id, exec) {
    const variant = await queryOne<RowDataPacket>(
      `SELECT v.id, v.product_id, v.sku, v.price,
              COALESCE((SELECT SUM(ii.quantity_available) FROM inventory_items ii WHERE ii.shop_id = v.shop_id AND ii.variant_id = v.id), 0) AS available
         FROM product_variants v WHERE v.shop_id = ? AND v.id = ?`,
      [shopId(), id],
      exec,
    );
    if (!variant) return null;
    return {
      inventory_item_id: Number(variant.id),
      variant_id: Number(variant.id),
      product_id: Number(variant.product_id),
      sku: variant.sku,
      available: Number(variant.available),
    };
  },

  async customer(id, exec) {
    const customer = await queryOne<RowDataPacket>(
      `SELECT id, public_id, first_name, last_name, email, phone, country_code, status,
              accepts_email_marketing, accepts_sms_marketing, accepts_whatsapp_marketing,
              orders_count, total_spent, created_at, updated_at, deleted_at
         FROM customers WHERE shop_id = ? AND id = ?`,
      [shopId(), id],
      exec,
    );
    if (!customer) return { id, deleted: true };
    return {
      id: Number(customer.id),
      admin_graphql_id: customer.public_id,
      first_name: customer.first_name,
      last_name: customer.last_name,
      email: customer.email,
      phone: customer.phone ? `${customer.country_code ?? ''}${customer.phone}` : null,
      state: customer.status,
      email_marketing_consent: customer.accepts_email_marketing === 1,
      sms_marketing_consent: customer.accepts_sms_marketing === 1,
      whatsapp_marketing_consent: customer.accepts_whatsapp_marketing === 1,
      orders_count: Number(customer.orders_count),
      total_spent: money(customer.total_spent),
      created_at: customer.created_at,
      updated_at: customer.updated_at,
      deleted: customer.deleted_at !== null,
    };
  },

  async collection(id, exec) {
    const collection = await queryOne<RowDataPacket>(
      `SELECT id, slug, title, collection_type, sort_type, is_active, product_count, published_at, updated_at, deleted_at
         FROM collections WHERE shop_id = ? AND id = ?`,
      [shopId(), id],
      exec,
    );
    if (!collection) return { id, deleted: true };
    return {
      id: Number(collection.id),
      handle: collection.slug,
      title: collection.title,
      collection_type: collection.collection_type,
      sort_order: collection.sort_type,
      published: collection.is_active === 1,
      products_count: Number(collection.product_count),
      published_at: collection.published_at,
      updated_at: collection.updated_at,
      deleted: collection.deleted_at !== null,
    };
  },

  async coupon(id, exec) {
    const coupon = await queryOne<RowDataPacket>(
      'SELECT id, code, title, discount_type, value, min_order_amount, is_active, starts_at, ends_at, updated_at FROM coupons WHERE shop_id = ? AND id = ?',
      [shopId(), id],
      exec,
    );
    if (!coupon) return { id, deleted: true };
    return {
      id: Number(coupon.id),
      code: coupon.code,
      title: coupon.title,
      value_type: coupon.discount_type,
      value: money(coupon.value),
      minimum_subtotal: money(coupon.min_order_amount),
      active: coupon.is_active === 1,
      starts_at: coupon.starts_at,
      ends_at: coupon.ends_at,
      updated_at: coupon.updated_at,
    };
  },

  async shipment(id, exec) {
    const shipment = await queryOne<RowDataPacket>(
      `SELECT s.id, s.shipment_number, s.order_id, s.status, s.awb_number, c.code AS carrier, s.shipped_at, s.delivered_at
         FROM shipments s LEFT JOIN shipping_carriers c ON c.id = s.carrier_id AND c.shop_id = s.shop_id
        WHERE s.shop_id = ? AND s.id = ?`,
      [shopId(), id],
      exec,
    );
    if (!shipment) return null;
    return {
      id: Number(shipment.id),
      name: shipment.shipment_number,
      order_id: Number(shipment.order_id),
      status: shipment.status,
      tracking_number: shipment.awb_number,
      tracking_company: shipment.carrier,
      shipped_at: shipment.shipped_at,
      delivered_at: shipment.delivered_at,
    };
  },

  async return_request(id, exec) {
    const request = await queryOne<RowDataPacket>(
      'SELECT id, rma_number, order_id, customer_id, reason, status, requested_amount, requested_at FROM return_requests WHERE shop_id = ? AND id = ?',
      [shopId(), id],
      exec,
    );
    if (!request) return null;
    return {
      id: Number(request.id),
      name: request.rma_number,
      order_id: Number(request.order_id),
      customer_id: request.customer_id ? Number(request.customer_id) : null,
      reason: request.reason,
      status: request.status,
      requested_amount: money(request.requested_amount),
      requested_at: request.requested_at,
    };
  },
};

export async function resourceSnapshot(resourceType: string, id: number, exec: Executor): Promise<Snapshot | null> {
  const build = builders[resourceType];
  return build ? build(id, exec) : null;
}
