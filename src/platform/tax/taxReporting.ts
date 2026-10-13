import { logger } from '../../core/logger';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { subscribe } from '../events/subscribers';
import { connectionsService } from '../integrations/connections.service';
import { roundMoney } from '../money/currency';
import { shopId, tenancy } from '../tenancy/context';
import type { TaxAddress, TaxCalculator } from './TaxCalculator';
import { DESTINATION_ENGINES, shopOrigin } from './taxService';

/**
 * Tells the shop's tax service about completed sales and refunds, so it can
 * prepare the returns the merchant files — the other half of calculating tax
 * at checkout.
 *
 * A sale is reported when the order is fulfilled (the usual tax point, and it
 * covers cash on delivery, which is paid on the doorstep); each refund after
 * that as it is issued. The `tax_reports` ledger makes each one happen once,
 * whatever retries the event pipeline makes, and a refund of a sale that was
 * never reported (cancelled before shipping) is not reported either.
 */

interface OrderRow extends RowDataPacket {
  id: number;
  order_number: string;
  currency: string;
  placed_at: Date | null;
  shipping_total: string;
  tax_total: string;
  grand_total: string;
}

interface ItemRow extends RowDataPacket {
  id: number;
  product_name: string;
  quantity: number;
  unit_price: string;
  discount_amount: string;
  tax_amount: string;
  line_total: string;
}

interface AddressRow extends RowDataPacket {
  line1: string;
  city: string;
  state_code: string | null;
  pincode: string;
  country: string;
}

async function reported(kind: 'sale' | 'refund', referenceId: number): Promise<boolean> {
  const row = await queryOne<RowDataPacket>('SELECT 1 AS hit FROM tax_reports WHERE shop_id = ? AND kind = ? AND reference_id = ? LIMIT 1', [shopId(), kind, referenceId]);
  return row !== null;
}

async function record(data: { orderId: number; kind: 'sale' | 'refund'; referenceId: number; provider: string; externalId: string; amount: number; salesTax: number }): Promise<void> {
  await execute(
    `INSERT IGNORE INTO tax_reports (shop_id, order_id, kind, reference_id, provider, external_id, amount, sales_tax)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [shopId(), data.orderId, data.kind, data.referenceId, data.provider, data.externalId, data.amount, data.salesTax],
  );
}

async function destination(orderId: number): Promise<TaxAddress | null> {
  const address = await queryOne<AddressRow>(
    "SELECT line1, city, state_code, pincode, country FROM order_addresses WHERE shop_id = ? AND order_id = ? AND address_type = 'shipping' LIMIT 1",
    [shopId(), orderId],
  );
  return address ? { country: address.country, region: address.state_code, postalCode: address.pincode, city: address.city, line1: address.line1 } : null;
}

async function reportSale(calculator: TaxCalculator, provider: string, orderId: number): Promise<void> {
  if (!calculator.recordSale || (await reported('sale', orderId))) return;
  const order = await queryOne<OrderRow>('SELECT id, order_number, currency, placed_at, shipping_total, tax_total, grand_total FROM orders WHERE shop_id = ? AND id = ?', [shopId(), orderId]);
  const to = await destination(orderId);
  if (!order || !to) return;
  const items = await query<ItemRow>(
    "SELECT id, product_name, quantity, unit_price, discount_amount, tax_amount, line_total FROM order_items WHERE shop_id = ? AND order_id = ? AND line_type IN ('product', 'gift') ORDER BY id",
    [shopId(), orderId],
  );
  const round = (value: number) => roundMoney(value, order.currency);
  const amount = round(items.reduce((sum, item) => sum + Number(item.line_total), 0));
  await calculator.recordSale({
    transactionId: order.order_number,
    date: order.placed_at ?? new Date(),
    from: await shopOrigin(),
    to,
    amount,
    shipping: Number(order.shipping_total),
    salesTax: Number(order.tax_total),
    lines: items.map((item) => ({
      id: String(item.id),
      quantity: item.quantity,
      description: item.product_name,
      unitPrice: Number(item.unit_price),
      discount: Number(item.discount_amount),
      salesTax: Number(item.tax_amount),
    })),
  });
  await record({ orderId, kind: 'sale', referenceId: orderId, provider, externalId: order.order_number, amount, salesTax: Number(order.tax_total) });
}

async function reportRefunds(calculator: TaxCalculator, provider: string, orderId: number): Promise<void> {
  // A refund refers to a reported sale; before shipping there is none.
  if (!calculator.recordRefund || !(await reported('sale', orderId))) return;
  const order = await queryOne<OrderRow>('SELECT id, order_number, currency, placed_at, shipping_total, tax_total, grand_total FROM orders WHERE shop_id = ? AND id = ?', [shopId(), orderId]);
  const to = await destination(orderId);
  if (!order || !to) return;
  const refunds = await query<RowDataPacket & { id: number; amount: string; created_at: Date }>(
    `SELECT r.id, r.amount, r.created_at FROM refunds r
      WHERE r.shop_id = ? AND r.order_id = ? AND r.status NOT IN ('failed', 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM tax_reports t WHERE t.shop_id = r.shop_id AND t.kind = 'refund' AND t.reference_id = r.id)
      ORDER BY r.id`,
    [shopId(), orderId],
  );
  const round = (value: number) => roundMoney(value, order.currency);
  // The tax share of a refund is the order's own: a partial refund of an
  // order that was 8% tax gives back 8% of it as tax.
  const taxShare = Number(order.grand_total) > 0 ? Number(order.tax_total) / Number(order.grand_total) : 0;
  for (const refund of refunds) {
    const total = Number(refund.amount);
    const salesTax = round(total * taxShare);
    const goods = round(total - salesTax);
    const externalId = `${order.order_number}-refund-${refund.id}`;
    await calculator.recordRefund({
      transactionId: externalId,
      referenceId: order.order_number,
      date: refund.created_at,
      from: await shopOrigin(),
      to,
      amount: -goods,
      shipping: 0,
      salesTax: -salesTax,
      lines: [],
    });
    await record({ orderId, kind: 'refund', referenceId: refund.id, provider, externalId, amount: -goods, salesTax: -salesTax });
  }
}

/** Exposed for tests and operator tooling. */
export const taxReporting = { reportSale, reportRefunds };

subscribe({
  name: 'tax.reporting',
  topics: ['orders/fulfilled', 'refunds/create'],
  async handle(event) {
    if (!event.resourceId || !DESTINATION_ENGINES.has(tenancy.current().taxEngine)) return;
    const connected = await connectionsService.resolveDefault('tax');
    const calculator = connected?.manifest.tax?.(connected.context);
    if (!connected || !calculator) return;
    try {
      if (event.topic === 'orders/fulfilled') await reportSale(calculator, connected.row.provider, event.resourceId);
      else await reportRefunds(calculator, connected.row.provider, event.resourceId);
      void connectionsService.recordUse(connected.row.id, null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void connectionsService.recordUse(connected.row.id, message.slice(0, 500));
      logger.warn('tax.report_failed', { topic: event.topic, order_id: event.resourceId, error: message });
      // Thrown, so the event job retries with backoff.
      throw error;
    }
  },
});
