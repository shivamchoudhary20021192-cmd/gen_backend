import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination, parseSort, type PaginationMeta } from '../../core/pagination';
import { withTransaction } from '../../db/transaction';
import { courierFor, CourierError, trackingUrlFor } from '../shipping/courier';
import { shipmentsRepository } from '../shipments/shipments.repository';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { customersRepository } from '../customers/customers.repository';
import { onlinePaymentsService } from '../payments/onlinePayments.service';
import {
  ordersRepository,
  type OrderAddressRow,
  type OrderHistoryRow,
  type OrderItemRow,
  type OrderRow,
  type PaymentRow,
  type RefundRow,
  type ShipmentRow,
} from './orders.repository';
import { formatMoney } from '../../platform/shops/format';
import { giftCardsService } from '../giftCards/giftCards.service';
import { tenancy } from '../../platform/tenancy/context';

const SORTABLE: Record<string, string> = {
  placed_at: 'o.placed_at',
  created_at: 'o.created_at',
  grand_total: 'o.grand_total',
  order_number: 'o.order_number',
  updated_at: 'o.updated_at',
};

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

/**
 * The order lifecycle, as a graph rather than a list.
 *
 * Every transition the admin API allows is written here once. Without it the
 * rules end up scattered across handlers, and the day someone marks a cancelled
 * order "delivered" nobody can say which line was supposed to stop it.
 *
 * Note what is absent: nothing leads back out of `delivered`, `cancelled`,
 * `returned` or `rto`. Those are terminal — a mistake there is corrected with a
 * refund or a return, both of which leave their own trail, not by editing the
 * status back.
 */
const TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'packed', 'cancelled'],
  processing: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['out_for_delivery', 'delivered', 'rto'],
  out_for_delivery: ['delivered', 'rto'],
  delivered: ['returned'],
  cancelled: [],
  returned: [],
  rto: [],
};

/** Statuses after which stock has left the building and must be restocked to come back. */
const STOCK_COMMITTED = new Set(['confirmed', 'processing', 'packed', 'shipped', 'out_for_delivery', 'delivered']);

function assertTransition(from: string, to: string): void {
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw ApiError.conflict(
      allowed.length === 0
        ? `An order that is "${from}" is finished — it cannot become "${to}".`
        : `An order that is "${from}" can only become: ${allowed.join(', ')}.`,
      'INVALID_TRANSITION',
    );
  }
}

function money(value: string | number): number {
  return Number(Number(value).toFixed(2));
}

/**
 * A shipping weight when the operator did not enter one.
 *
 * Couriers price in slabs and refuse a zero-weight booking, so a missing weight
 * cannot simply be passed through. This estimates from the variants' recorded
 * weights and falls back to a per-unit figure, plus packaging — deliberately a
 * little generous, because under-declaring is what gets a parcel reweighed and
 * surcharged at the hub.
 */
function estimateWeight(
  lines: { id: number; quantity: number }[],
  items: { id: number; weight_grams?: number | null }[],
): number {
  const PACKAGING_GRAMS = 120;
  const ASSUMED_UNIT_GRAMS = 180;
  const contents = lines.reduce((sum, line) => {
    const item = items.find((candidate) => candidate.id === line.id);
    const unit = item?.weight_grams && item.weight_grams > 0 ? item.weight_grams : ASSUMED_UNIT_GRAMS;
    return sum + unit * line.quantity;
  }, 0);
  return Math.max(100, contents + PACKAGING_GRAMS);
}

/** The order's named taxes, read from its JSON column whatever shape the driver returns. */
function taxLines(raw: unknown): { name: string; rate: number; amount: number }[] {
  const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) as unknown; } catch { return null; } })() : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((line): line is Record<string, unknown> => Boolean(line) && typeof line === 'object')
    .map((line) => ({ name: String(line.name ?? 'Tax'), rate: Number(line.rate ?? 0), amount: money(line.amount as string | number) }));
}

function presentItem(row: OrderItemRow) {
  return {
    id: row.id,
    product_id: row.product_id,
    variant_id: row.variant_id,
    line_type: row.line_type,
    sku: row.sku,
    name: row.product_name,
    variant_title: row.variant_title,
    image_url: row.image_url,
    hsn_code: row.hsn_code,
    unit_mrp: money(row.unit_mrp),
    unit_price: money(row.unit_price),
    quantity: row.quantity,
    discount_amount: money(row.discount_amount),
    tax_rate: money(row.tax_rate),
    tax_amount: money(row.tax_amount),
    line_total: money(row.line_total),
    fulfilled_quantity: row.fulfilled_quantity,
    cancelled_quantity: row.cancelled_quantity,
    returned_quantity: row.returned_quantity,
    refunded_amount: money(row.refunded_amount),
    /** What is still owed to the customer physically. */
    outstanding_quantity: row.quantity - row.fulfilled_quantity - row.cancelled_quantity,
  };
}

function presentAddress(row: OrderAddressRow) {
  return {
    type: row.address_type,
    name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    phone: row.phone,
    email: row.email,
    line1: row.line1,
    line2: row.line2,
    landmark: row.landmark,
    city: row.city,
    state: row.state,
    state_code: row.state_code,
    pincode: row.pincode,
    country: row.country,
    gstin: row.gstin,
    delivery_notes: row.delivery_notes,
  };
}

function presentHistory(row: OrderHistoryRow) {
  return {
    id: row.id,
    type: row.status_type,
    from: row.from_status,
    to: row.to_status,
    note: row.note,
    actor_type: row.actor_type,
    actor: row.actor_name?.trim() || null,
    customer_visible: row.is_customer_visible === 1,
    at: row.created_at.toISOString(),
  };
}

function presentPayment(row: PaymentRow) {
  return {
    id: row.id,
    gateway: row.gateway,
    gateway_payment_id: row.gateway_payment_id,
    // Never expose the signature itself — only whether it checked out.
    signature_verified: row.signature_verified === 1,
    method: row.method,
    amount: money(row.amount),
    status: row.status,
    instrument: row.card_last4 ? `•••• ${row.card_last4}` : (row.upi_vpa ?? row.bank ?? null),
    error: row.error_description,
    captured_at: row.captured_at ? row.captured_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

function presentRefund(row: RefundRow) {
  return {
    id: row.id,
    payment_id: row.payment_id,
    gateway_refund_id: row.gateway_refund_id,
    amount: money(row.amount),
    refund_type: row.refund_type,
    reason: row.reason,
    status: row.status,
    processed_at: row.processed_at ? row.processed_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

function presentShipment(row: ShipmentRow) {
  return {
    id: row.id,
    shipment_number: row.shipment_number,
    carrier: row.carrier_name,
    awb_number: row.awb_number,
    tracking_url: row.tracking_url,
    status: row.status,
    shipping_mode: row.shipping_mode,
    weight_grams: row.weight_grams,
    cod_amount: row.cod_amount === null ? null : money(row.cod_amount),
    shipped_at: row.shipped_at ? row.shipped_at.toISOString() : null,
    estimated_delivery_at: row.estimated_delivery_at ? row.estimated_delivery_at.toISOString() : null,
    delivered_at: row.delivered_at ? row.delivered_at.toISOString() : null,
  };
}

function presentSummary(row: OrderRow) {
  return {
    id: row.id,
    order_number: row.order_number,
    public_id: row.public_id,
    customer: {
      id: row.customer_id,
      name: row.customer_name,
      phone: row.contact_phone,
      email: row.contact_email,
      is_guest: row.is_guest === 1,
    },
    order_status: row.order_status,
    payment_status: row.payment_status,
    fulfillment_status: row.fulfillment_status,
    payment_method: row.payment_method,
    currency: row.currency,
    // Paid in a market's currency: what the order is worth in the store's own
    // money, which is what reports and payouts count.
    presentment:
      row.shop_currency && row.shop_currency !== row.currency
        ? {
            market_id: row.market_id,
            shop_currency: row.shop_currency,
            exchange_rate: Number(row.exchange_rate),
            shop_grand_total: Math.round(money(row.grand_total) * Number(row.exchange_rate) * 100) / 100,
          }
        : null,
    grand_total: money(row.grand_total),
    amount_paid: money(row.amount_paid),
    amount_refunded: money(row.amount_refunded),
    amount_due: money(row.amount_due),
    item_count: Number(row.item_count ?? 0),
    pincode: row.pincode,
    shipping_method: row.shipping_method,
    coupon_code: row.coupon_code,
    risk_score: row.risk_score,
    source_channel: row.source_channel,
    placed_at: row.placed_at ? row.placed_at.toISOString() : null,
    delivered_at: row.delivered_at ? row.delivered_at.toISOString() : null,
    /** The transitions this order can legally make right now. */
    next_statuses: TRANSITIONS[row.order_status] ?? [],
  };
}

export const ordersService = {
  async list(queryParams: Record<string, unknown>): Promise<{ orders: unknown[]; pagination: PaginationMeta }> {
    const page = parsePagination(queryParams);
    const orderBy = parseSort(queryParams.sort, SORTABLE, 'o.placed_at DESC, o.id DESC');
    const filters = {
      search: queryParams.q as string | undefined,
      orderStatus: queryParams.order_status as string | undefined,
      paymentStatus: queryParams.payment_status as string | undefined,
      fulfillmentStatus: queryParams.fulfillment_status as string | undefined,
      paymentMethod: queryParams.payment_method as string | undefined,
      customerId: queryParams.customer_id as number | undefined,
      placedFrom: queryParams.placed_from as string | undefined,
      placedTo: queryParams.placed_to as string | undefined,
      unfulfilledOnly: queryParams.unfulfilled as boolean | undefined,
    };

    const [rows, total] = await Promise.all([
      ordersRepository.list(filters, orderBy, page.limit, page.offset),
      ordersRepository.count(filters),
    ]);

    return { orders: rows.map(presentSummary), pagination: buildMeta(total, page) };
  },

  async statusCounts() {
    return { counts: await ordersRepository.statusCounts() };
  },

  async get(id: number) {
    const row = await ordersRepository.findById(id);
    if (!row) throw ApiError.notFound('Order');

    const [items, addresses, history, payments, refunds, shipments] = await Promise.all([
      ordersRepository.items(id),
      ordersRepository.addresses(id),
      ordersRepository.history(id),
      ordersRepository.payments(id),
      ordersRepository.refunds(id),
      ordersRepository.shipments(id),
    ]);

    const shipping = addresses.find((a) => a.address_type === 'shipping');
    const billing = addresses.find((a) => a.address_type === 'billing');

    return {
      order: {
        ...presentSummary(row),
        totals: {
          subtotal: money(row.subtotal),
          discount_total: money(row.discount_total),
          coupon_discount: money(row.coupon_discount),
          loyalty_discount: money(row.loyalty_discount),
          shipping_total: money(row.shipping_total),
          shipping_tax: money(row.shipping_tax),
          cod_fee: money(row.cod_fee),
          tax_total: money(row.tax_total),
          /** The named taxes charged: "CGST 9%", "California sales tax 7.25%". */
          tax_lines: taxLines(row.tax_lines),
          cgst_total: money(row.cgst_total),
          sgst_total: money(row.sgst_total),
          igst_total: money(row.igst_total),
          grand_total: money(row.grand_total),
          amount_paid: money(row.amount_paid),
          amount_refunded: money(row.amount_refunded),
          amount_due: money(row.amount_due),
          /** Paid with gift cards; refunds of it go back onto the cards. */
          gift_card_total: money(row.gift_card_total ?? 0),
          /** What could still be refunded without going negative. */
          refundable: Math.max(0, money(row.amount_paid) - money(row.amount_refunded)),
        },
        items: items.map(presentItem),
        shipping_address: shipping ? presentAddress(shipping) : null,
        billing_address: billing ? presentAddress(billing) : null,
        notes: {
          customer: row.customer_note,
          admin: row.admin_note,
        },
        cancellation:
          row.order_status === 'cancelled'
            ? { reason: row.cancel_reason, by: row.cancelled_by, at: row.cancelled_at?.toISOString() ?? null }
            : null,
        estimated_delivery: {
          from: row.estimated_delivery_from ? row.estimated_delivery_from.toISOString().slice(0, 10) : null,
          to: row.estimated_delivery_to ? row.estimated_delivery_to.toISOString().slice(0, 10) : null,
        },
        payments: payments.map(presentPayment),
        refunds: refunds.map(presentRefund),
        shipments: shipments.map(presentShipment),
        timeline: history.map(presentHistory),
      },
    };
  },

  /** Free-text admin note. Deliberately not part of any status change. */
  async setAdminNote(id: number, note: string | null, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = await ordersRepository.findById(id);
    if (!existing) throw ApiError.notFound('Order');

    await withTransaction(async (tx) => {
      await ordersRepository.update(id, { admin_note: note }, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'order.note_updated',
          entityType: 'order',
          entityId: id,
          summary: `Updated the internal note on ${existing.order_number}`,
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  /**
   * Move an order along its lifecycle.
   *
   * The transition table decides what is legal; this decides what else has to
   * happen when it is. Timestamps are written here rather than by a trigger so
   * the whole change is one transaction and one audit entry.
   */
  async changeStatus(
    id: number,
    to: string,
    input: { note?: string | null; notify_customer?: boolean },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const existing = await ordersRepository.findById(id);
    if (!existing) throw ApiError.notFound('Order');
    assertTransition(existing.order_status, to);

    const fields: Record<string, unknown> = { order_status: to };
    const now = new Date();

    if (to === 'confirmed') fields.confirmed_at = now;
    if (to === 'packed') fields.packed_at = now;
    if (to === 'shipped') fields.shipped_at = now;
    if (to === 'delivered') {
      fields.delivered_at = now;
      fields.fulfillment_status = 'fulfilled';
      // Cash on delivery is collected at the door, so delivery is also the
      // moment the money is real.
      if (existing.payment_method === 'cod' && existing.payment_status === 'cod_pending') {
        fields.payment_status = 'cod_collected';
        fields.amount_paid = existing.grand_total;
        fields.amount_due = 0;
      }
    }
    if (to === 'rto') fields.fulfillment_status = 'rto';
    if (to === 'returned') fields.fulfillment_status = 'returned';

    await withTransaction(async (tx) => {
      await ordersRepository.update(id, fields, tx);
      await ordersRepository.addHistory(
        {
          orderId: id,
          statusType: 'order',
          fromStatus: existing.order_status,
          toStatus: to,
          note: input.note ?? null,
          actorType: 'admin',
          actorId: actor.id,
          isCustomerVisible: input.notify_customer ?? true,
        },
        tx,
      );
      if (to === 'delivered') await ordersRepository.setShipmentsDelivered(id, tx);

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: `order.${to}`,
          entityType: 'order',
          entityId: id,
          summary: `${existing.order_number}: ${existing.order_status} → ${to}`,
          changes: { order_status: { from: existing.order_status, to } },
          context: { request_id: meta.requestId, note: input.note ?? null },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      if (existing.customer_id) await customersRepository.refreshStats(existing.customer_id, tx);
    });

    return this.get(id);
  },

  /**
   * Ship all or part of an order.
   *
   * Shipping partially is normal — two of three items in stock today, the third
   * next week — so this takes a line-by-line quantity and only marks the order
   * `shipped` once nothing is outstanding.
   */
  async ship(
    id: number,
    input: {
      carrier_id?: number | null;
      awb_number?: string | null;
      tracking_url?: string | null;
      shipping_mode?: string;
      weight_grams?: number | null;
      items?: { order_item_id: number; quantity: number }[];
      note?: string | null;
    },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const existing = await ordersRepository.findById(id);
    if (!existing) throw ApiError.notFound('Order');
    if (!['confirmed', 'processing', 'packed', 'shipped'].includes(existing.order_status)) {
      throw ApiError.conflict(
        `An order that is "${existing.order_status}" cannot be shipped.`,
        'INVALID_TRANSITION',
      );
    }

    const orderItems = await ordersRepository.items(id);
    const shippable = orderItems.filter(
      (item) => item.line_type !== 'shipping' && item.quantity - item.fulfilled_quantity - item.cancelled_quantity > 0,
    );
    if (shippable.length === 0) {
      throw ApiError.conflict('Every item on this order has already been shipped or cancelled.');
    }

    // Default to shipping everything still outstanding.
    const requested =
      input.items && input.items.length > 0
        ? input.items
        : shippable.map((item) => ({
            order_item_id: item.id,
            quantity: item.quantity - item.fulfilled_quantity - item.cancelled_quantity,
          }));

    const lines: { id: number; quantity: number }[] = [];
    for (const line of requested) {
      const item = orderItems.find((candidate) => candidate.id === line.order_item_id);
      if (!item) throw ApiError.validation({ items: [`Item ${line.order_item_id} is not on this order.`] });
      const outstanding = item.quantity - item.fulfilled_quantity - item.cancelled_quantity;
      if (line.quantity < 1 || line.quantity > outstanding) {
        throw ApiError.validation({
          items: [`"${item.product_name}" has ${outstanding} left to ship; you asked for ${line.quantity}.`],
        });
      }
      lines.push({ id: item.id, quantity: line.quantity });
    }

    // ── book with the carrier ────────────────────────────────────────────────
    // The waybill comes back from the courier rather than being typed, so the
    // number on our record is the number the carrier will actually recognise.
    // An operator can still override it — self-ship carriers exist — but the
    // default path is a real booking.
    const carrier = input.carrier_id
      ? await shipmentsRepository.findCarrier(input.carrier_id)
      : await shipmentsRepository.defaultCarrier();
    if (input.carrier_id && !carrier) {
      throw ApiError.validation({ carrier_id: ['That carrier does not exist.'] });
    }

    const location = await shipmentsRepository.defaultLocation();
    const addresses = await ordersRepository.addresses(id);
    const shipTo = addresses.find((address) => address.address_type === 'shipping');
    if (!shipTo) throw ApiError.conflict('This order has no delivery address to ship to.');

    const codAmount = existing.payment_method === 'cod' ? Number(existing.amount_due) : 0;
    const weightGrams = input.weight_grams ?? estimateWeight(lines, orderItems);

    let booking: { awb: string | null; providerId: string | null; trackingUrl: string | null; eta: Date | null; charge: number | null } = {
      awb: input.awb_number ?? null,
      providerId: null,
      trackingUrl: input.tracking_url ?? null,
      eta: null,
      charge: null,
    };

    // Only book when the operator did not bring their own waybill. Someone who
    // typed an AWB has already booked it themselves, and booking again would
    // produce a second parcel nobody is expecting.
    if (carrier && !input.awb_number) {
      const provider = courierFor({ code: carrier.code, api_provider: carrier.api_provider });
      try {
        const result = await provider.createShipment({
          reference: `${existing.order_number}-${Date.now()}`,
          orderNumber: existing.order_number,
          mode: (input.shipping_mode ?? 'surface') as 'surface' | 'air' | 'express',
          codAmount,
          declaredValue: Number(existing.grand_total),
          pickup: {
            // The store's own name when the pickup location has no contact.
          name: location?.contact_name ?? location?.name ?? tenancy.current().name,
            phone: location?.contact_phone ?? null,
            email: null,
            line1: location?.line1 ?? '',
            line2: location?.line2 ?? null,
            landmark: null,
            city: location?.city ?? '',
            state: location?.state ?? '',
            pincode: location?.pincode ?? '',
            country: location?.country ?? 'IN',
          },
          delivery: {
            name: [shipTo.first_name, shipTo.last_name].filter(Boolean).join(' '),
            phone: shipTo.phone,
            email: shipTo.email,
            line1: shipTo.line1,
            line2: shipTo.line2,
            landmark: shipTo.landmark,
            city: shipTo.city,
            state: shipTo.state,
            pincode: shipTo.pincode,
            country: shipTo.country ?? 'IN',
          },
          parcel: { weightGrams, lengthMm: null, widthMm: null, heightMm: null },
          items: lines.map((line) => {
            const item = orderItems.find((candidate) => candidate.id === line.id)!;
            return {
              name: item.product_name,
              sku: item.sku,
              quantity: line.quantity,
              unitPrice: Number(item.unit_price),
              hsnCode: item.hsn_code,
            };
          }),
        });
        booking = {
          awb: result.awbNumber,
          providerId: result.providerShipmentId,
          trackingUrl: result.trackingUrl ?? trackingUrlFor(carrier.tracking_url_template, result.awbNumber),
          eta: result.estimatedDeliveryAt,
          charge: result.shippingCharge,
        };
      } catch (error) {
        // Nothing is written if the carrier refuses, so the order stays packed
        // and the operator can retry or pick another carrier. Half-shipping an
        // order because a courier timed out is the outcome worth avoiding.
        const message = error instanceof CourierError ? error.message : 'The carrier could not book this shipment.';
        const retryable = error instanceof CourierError ? error.retryable : true;
        throw retryable ? ApiError.upstream(message) : ApiError.badRequest(message);
      }
    }

    const shipmentNumber = await shipmentsRepository.nextNumber('shipment');

    await withTransaction(async (tx) => {
      const shipmentId = await shipmentsRepository.createShipment(
        {
          shipmentNumber,
          orderId: id,
          carrierId: carrier?.id ?? null,
          locationId: location?.id ?? null,
          awbNumber: booking.awb,
          trackingUrl: booking.trackingUrl,
          providerShipmentId: booking.providerId,
          // A booked parcel is not yet picked up; it is with us until the
          // courier collects it, and the shipments screen is where that moves on.
          status: booking.awb ? 'label_generated' : 'created',
          shippingMode: input.shipping_mode ?? 'surface',
          weightGrams,
          shippingCharge: booking.charge,
          // `shipments.cod_amount` is NOT NULL with a 0.00 default: a prepaid
          // shipment carries zero cash, not "unknown cash".
          codAmount: codAmount.toFixed(2),
          estimatedDeliveryAt: booking.eta,
          shippedAt: new Date(),
        },
        tx,
      );

      await shipmentsRepository.addTrackingEvents(
        shipmentId,
        [
          {
            status: booking.awb ? 'label_generated' : 'created',
            description: booking.awb
              ? `Booked with ${carrier?.name ?? 'carrier'} · AWB ${booking.awb}`
              : 'Shipment created',
            location: location?.city ?? null,
            at: new Date(),
          },
        ],
        tx,
      );
      for (const line of lines) await shipmentsRepository.addItem(shipmentId, line.id, line.quantity, tx);
      await ordersRepository.markItemsFulfilled(lines, tx);

      // Re-read to decide partial vs full, rather than trusting arithmetic on
      // rows we just changed.
      const after = await ordersRepository.items(id, tx);
      const stillOutstanding = after
        .filter((item) => item.line_type !== 'shipping')
        .reduce((sum, item) => sum + (item.quantity - item.fulfilled_quantity - item.cancelled_quantity), 0);

      const fulfillmentStatus = stillOutstanding === 0 ? 'fulfilled' : 'partially_fulfilled';
      const fields: Record<string, unknown> = { fulfillment_status: fulfillmentStatus };
      if (stillOutstanding === 0 && existing.order_status !== 'shipped') {
        fields.order_status = 'shipped';
        fields.shipped_at = new Date();
      }
      await ordersRepository.update(id, fields, tx);

      await ordersRepository.addHistory(
        {
          orderId: id,
          statusType: 'fulfillment',
          fromStatus: existing.fulfillment_status,
          toStatus: fulfillmentStatus,
          note: input.note ?? `Shipment ${shipmentNumber}${input.awb_number ? ` · AWB ${input.awb_number}` : ''}`,
          actorType: 'admin',
          actorId: actor.id,
          isCustomerVisible: true,
        },
        tx,
      );

      // The order status moved too, and that needs its own row. Writing only
      // the fulfilment row left the timeline jumping from "packed" to
      // "shipped → delivered" with nothing in between, so the one question
      // support is actually asked — when did this ship? — had no answer on the
      // screen built to answer it.
      if (fields.order_status === 'shipped') {
        await ordersRepository.addHistory(
          {
            orderId: id,
            statusType: 'order',
            fromStatus: existing.order_status,
            toStatus: 'shipped',
            note: input.awb_number ? `AWB ${input.awb_number}` : null,
            actorType: 'admin',
            actorId: actor.id,
            isCustomerVisible: true,
          },
          tx,
        );
      }

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'order.shipped',
          entityType: 'order',
          entityId: id,
          summary: `${existing.order_number}: created shipment ${shipmentNumber} (${lines.length} line(s))`,
          context: { request_id: meta.requestId, awb: input.awb_number ?? null },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  /**
   * Cancel an order and put the stock back.
   *
   * Restocking only happens for statuses that took stock in the first place —
   * cancelling a `pending` order that never reserved anything must not invent
   * inventory. Money is not touched here: refunding is a separate, deliberate
   * act, because cancelling an unpaid COD order should not create a refund.
   */
  async cancel(
    id: number,
    input: { reason: string; restock?: boolean; note?: string | null },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const existing = await ordersRepository.findById(id);
    if (!existing) throw ApiError.notFound('Order');
    assertTransition(existing.order_status, 'cancelled');

    const shouldRestock = input.restock ?? STOCK_COMMITTED.has(existing.order_status);
    const items = await ordersRepository.items(id);

    await withTransaction(async (tx) => {
      await ordersRepository.update(
        id,
        {
          order_status: 'cancelled',
          cancelled_at: new Date(),
          cancel_reason: input.reason,
          cancelled_by: 'admin',
          fulfillment_status: 'unfulfilled',
          // A cancelled COD order was never going to be paid.
          ...(existing.payment_status === 'cod_pending' ? { payment_status: 'cancelled', amount_due: 0 } : {}),
        },
        tx,
      );

      // What gift cards paid goes back onto them (and stops counting as paid, so it is never refunded twice).
      const credited = await giftCardsService.creditOrder(id, `Order ${existing.order_number} cancelled`, tx);
      if (credited > 0) {
        await ordersRepository.addHistory(
          {
            orderId: id,
            statusType: 'payment',
            fromStatus: existing.payment_status,
            toStatus: existing.payment_status,
            note: `${formatMoney(credited, { currency: existing.currency })} returned to the gift card it was paid with.`,
            actorType: 'admin',
            actorId: actor.id,
            isCustomerVisible: true,
          },
          tx,
        );
      }

      if (shouldRestock) {
        for (const item of items) {
          if (!item.variant_id || item.line_type === 'shipping') continue;
          if (item.line_type === 'gift' && !(await ordersRepository.soldFromStock(id, item.variant_id, tx))) continue;
          const quantity = item.quantity - item.cancelled_quantity;
          if (quantity <= 0) continue;
          await ordersRepository.restock(
            item.variant_id,
            quantity,
            {
              movementType: 'cancellation',
              referenceType: 'order',
              referenceId: id,
              adminUserId: actor.id,
              note: `Cancelled ${existing.order_number}: ${input.reason}`,
            },
            tx,
          );
        }
      }

      await ordersRepository.addHistory(
        {
          orderId: id,
          statusType: 'order',
          fromStatus: existing.order_status,
          toStatus: 'cancelled',
          note: input.note ?? input.reason,
          actorType: 'admin',
          actorId: actor.id,
          isCustomerVisible: true,
        },
        tx,
      );

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'order.cancelled',
          entityType: 'order',
          entityId: id,
          summary: `Cancelled ${existing.order_number}: ${input.reason}`,
          context: { request_id: meta.requestId, restocked: shouldRestock },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      if (existing.customer_id) await customersRepository.refreshStats(existing.customer_id, tx);
    });

    return this.get(id);
  },

  /**
   * Refund.
   *
   * The row is written and the order's totals moved inside a transaction, and
   * only then is the gateway called — outside it, so a slow gateway does not
   * hold row locks, and so a refund that moves money is never missing from our
   * records. A gateway refusal reverses the totals and leaves the row `failed`.
   *
   * The row reaches `processed` only when Razorpay's webhook says the money has
   * landed. Marking it processed here would tell a customer their money is back
   * before the bank has it.
   */
  async refund(
    id: number,
    input: { amount?: number; reason: string; internal_note?: string | null; restock?: boolean },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const existing = await ordersRepository.findById(id);
    if (!existing) throw ApiError.notFound('Order');

    const paid = money(existing.amount_paid);
    if (paid <= 0) {
      throw ApiError.conflict('Nothing has been paid on this order, so there is nothing to refund.');
    }

    const alreadyRefunded = await ordersRepository.refundedTotal(id);
    const refundable = money(paid - alreadyRefunded);
    if (refundable <= 0) {
      throw ApiError.conflict('This order has already been refunded in full.');
    }

    const amount = money(input.amount ?? refundable);
    if (amount <= 0) {
      throw ApiError.validation({ amount: ['A refund must be greater than zero.'] });
    }
    if (amount > refundable) {
      throw ApiError.validation({
        amount: [`At most ${formatMoney(refundable, { currency: existing.currency })} can still be refunded on this order.`],
      });
    }

    const payment = await ordersRepository.capturedPayment(id);
    const totalRefunded = money(alreadyRefunded + amount);
    const isFull = totalRefunded >= paid;
    // Money goes back the way it came: the gateway's share first, then what gift cards paid, back onto them.
    const onCards = money((await giftCardsService.outstandingOnOrder(id)) ?? 0);
    const toGateway = money(Math.min(amount, Math.max(0, refundable - onCards)));
    const toCards = money(amount - toGateway);

    const refundId = await withTransaction(async (tx) => {
      const newRefundId = await ordersRepository.createRefund(
        {
          orderId: id,
          paymentId: payment?.id ?? null,
          amount,
          refundType: isFull ? 'full' : 'partial',
          reason: input.reason,
          internalNote: input.internal_note ?? null,
          adminUserId: actor.id,
        },
        tx,
      );

      await ordersRepository.update(
        id,
        {
          amount_refunded: totalRefunded,
          payment_status: isFull ? 'refunded' : 'partially_refunded',
        },
        tx,
      );

      await ordersRepository.addHistory(
        {
          orderId: id,
          statusType: 'payment',
          fromStatus: existing.payment_status,
          toStatus: isFull ? 'refunded' : 'partially_refunded',
          note: `${formatMoney(amount, { currency: existing.currency })} — ${input.reason}`,
          actorType: 'admin',
          actorId: actor.id,
          isCustomerVisible: true,
        },
        tx,
      );

      if (toCards > 0) {
        await giftCardsService.refundToCards(id, toCards, `Refund on ${existing.order_number}: ${input.reason}`, tx);
        await ordersRepository.addHistory(
          {
            orderId: id,
            statusType: 'payment',
            fromStatus: existing.payment_status,
            toStatus: isFull ? 'refunded' : 'partially_refunded',
            note: `${formatMoney(toCards, { currency: existing.currency })} returned to the gift card it was paid with.`,
            actorType: 'admin',
            actorId: actor.id,
            isCustomerVisible: true,
          },
          tx,
        );
      }

      if (input.restock) {
        const items = await ordersRepository.items(id, tx);
        for (const item of items) {
          if (!item.variant_id || item.line_type === 'shipping') continue;
          if (item.line_type === 'gift' && !(await ordersRepository.soldFromStock(id, item.variant_id, tx))) continue;
          await ordersRepository.restock(
            item.variant_id,
            item.quantity - item.cancelled_quantity,
            {
              movementType: 'return_restock',
              referenceType: 'order',
              referenceId: id,
              adminUserId: actor.id,
              note: `Refund on ${existing.order_number}: ${input.reason}`,
            },
            tx,
          );
        }
      }

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'order.refunded',
          entityType: 'order',
          entityId: id,
          summary: `Refunded ${formatMoney(amount, { currency: existing.currency })} on ${existing.order_number}: ${input.reason}`,
          changes: { amount_refunded: { from: alreadyRefunded, to: totalRefunded } },
          context: { request_id: meta.requestId, full: isFull, gateway_pending: true },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      if (existing.customer_id) await customersRepository.refreshStats(existing.customer_id, tx);
      return newRefundId;
    });

    // Outside the transaction, deliberately — see the note above. Only the gateway's share goes to it.
    const sent = toGateway <= 0
      ? { moved: false, gatewayRefundId: null, reason: 'Returned to the gift card it was paid with.' }
      : await onlinePaymentsService.sendRefund({
      refundId,
      orderId: id,
      amount: toGateway,
      gatewayPaymentId: payment?.gateway_payment_id ?? null,
      gateway: payment?.gateway ?? 'manual',
      connectionId: payment?.connection_id ?? null,
      currency: payment?.currency ?? existing.currency,
      restorePaymentStatus: existing.payment_status,
      orderNumber: existing.order_number,
    });

    const order = await this.get(id);
    return {
      ...order,
      /**
       * What actually happened to the money, so the screen can say it.
       *
       * A refund dialog that closes with a tick regardless is how a customer
       * gets told their money is on the way when the gateway declined it.
       */
      refund: {
        id: refundId,
        amount,
        sent_to_gateway: sent.moved,
        gateway_refund_id: sent.gatewayRefundId,
        message: sent.moved
          ? 'Sent to the gateway. It usually reaches the customer’s account in 5–7 working days, and this will show as refunded once the bank confirms it.'
          : (sent.reason ?? 'Recorded, but not sent to any gateway.'),
      },
    };
  },
};
