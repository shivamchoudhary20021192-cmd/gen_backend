import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination, type PaginationMeta } from '../../core/pagination';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { ordersRepository } from '../orders/orders.repository';
import { ordersService } from '../orders/orders.service';
import { shipmentsRepository } from '../shipments/shipments.repository';
import { CourierError, resolveCourier } from '../shipping/courier';
import { returnsRepository, type ReturnItemRow, type ReturnRow } from './returns.repository';
import { tenancy } from '../../platform/tenancy/context';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId?: string;
}

const SORTABLE: Record<string, string> = {
  newest: 'r.requested_at DESC, r.id DESC',
  oldest: 'r.requested_at ASC, r.id ASC',
  status: 'r.status ASC, r.requested_at DESC',
  amount: 'COALESCE(r.approved_amount, r.requested_amount) DESC',
};

/**
 * The RMA lifecycle.
 *
 * Rejection is available right up to inspection, because what the parcel turns
 * out to contain is often not what was described. After a refund there is
 * nothing left to decide, so `refunded` leads only to `closed`.
 */
const TRANSITIONS: Record<string, string[]> = {
  requested: ['approved', 'rejected'],
  approved: ['pickup_scheduled', 'received', 'rejected'],
  pickup_scheduled: ['picked_up', 'rejected'],
  picked_up: ['received'],
  received: ['inspected', 'rejected'],
  inspected: ['refunded', 'rejected', 'closed'],
  refunded: ['closed'],
  rejected: ['closed'],
  closed: [],
};

/** How long after delivery a return can still be raised. */
const RETURN_WINDOW_DAYS = 7;

function money(value: string | number | null): number {
  return value === null ? 0 : Number(Number(value).toFixed(2));
}

function present(row: ReturnRow) {
  const deliveredAt = row.delivered_at ? new Date(row.delivered_at) : null;
  return {
    id: row.id,
    rma_number: row.rma_number,
    order: {
      id: row.order_id,
      order_number: row.order_number,
      status: row.order_status,
      payment_method: row.payment_method,
      delivered_at: deliveredAt ? deliveredAt.toISOString() : null,
      amount_paid: money(row.amount_paid),
      amount_refunded: money(row.amount_refunded),
      refundable: Math.max(0, money(row.amount_paid) - money(row.amount_refunded)),
    },
    customer: { id: row.customer_id, name: row.customer_name?.trim() || null, phone: row.contact_phone },
    reason: row.reason,
    reason_detail: row.reason_detail,
    status: row.status,
    refund_method: row.refund_method,
    requested_amount: money(row.requested_amount),
    approved_amount: row.approved_amount === null ? null : money(row.approved_amount),
    pickup_awb: row.pickup_awb,
    rejection_reason: row.rejection_reason,
    inspection_note: row.inspection_note,
    item_count: Number(row.item_count ?? 0),
    requested_at: row.requested_at.toISOString(),
    approved_at: row.approved_at ? row.approved_at.toISOString() : null,
    approved_by: row.approved_by?.trim() || null,
    received_at: row.received_at ? row.received_at.toISOString() : null,
    closed_at: row.closed_at ? row.closed_at.toISOString() : null,
    next_statuses: TRANSITIONS[row.status] ?? [],
  };
}

function presentItem(row: ReturnItemRow) {
  return {
    id: row.id,
    order_item_id: row.order_item_id,
    sku: row.sku,
    name: row.product_name,
    variant_title: row.variant_title,
    image_url: row.image_url,
    quantity: row.quantity,
    unit_price: money(row.unit_price),
    refund_amount: money(row.refund_amount),
    condition: row.item_condition,
    restock: row.restock === 1,
    condition_note: row.condition_note,
  };
}

function assertTransition(from: string, to: string): void {
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw ApiError.conflict(
      allowed.length === 0
        ? `A return that is "${from}" is finished — it cannot become "${to}".`
        : `A return that is "${from}" can only become: ${allowed.join(', ')}.`,
      'INVALID_TRANSITION',
    );
  }
}

export const returnsService = {
  async list(queryParams: Record<string, unknown>): Promise<{ returns: unknown[]; pagination: PaginationMeta }> {
    const page = parsePagination(queryParams);
    const sortKey = typeof queryParams.sort === 'string' ? queryParams.sort : '';
    const orderBy = SORTABLE[sortKey] ?? SORTABLE.newest;

    const filters = {
      search: queryParams.q as string | undefined,
      status: queryParams.status as string | undefined,
      reason: queryParams.reason as string | undefined,
      orderId: queryParams.order_id as number | undefined,
      customerId: queryParams.customer_id as number | undefined,
      openOnly: queryParams.open as boolean | undefined,
    };

    const [rows, total] = await Promise.all([
      returnsRepository.list(filters, orderBy, page.limit, page.offset),
      returnsRepository.count(filters),
    ]);

    return { returns: rows.map(present), pagination: buildMeta(total, page) };
  },

  async statusCounts() {
    return { counts: await returnsRepository.statusCounts() };
  },

  async get(id: number) {
    const row = await returnsRepository.findById(id);
    if (!row) throw ApiError.notFound('Return');
    const items = await returnsRepository.itemsFor(id);
    return { return: { ...present(row), items: items.map(presentItem) } };
  },

  /**
   * What of an order could still come back, and whether it is in window.
   *
   * The screen needs this before it can offer a return, and it is the same
   * arithmetic `create` enforces — kept in one place so the form cannot offer a
   * quantity the create path will then refuse.
   */
  async returnableFor(orderId: number) {
    const order = await ordersRepository.findById(orderId);
    if (!order) throw ApiError.notFound('Order');

    const [items, pending] = await Promise.all([
      returnsRepository.returnableItems(orderId),
      returnsRepository.pendingReturnedQuantities(orderId, null),
    ]);
    const claimed = new Map(pending.map((row) => [row.order_item_id, Number(row.quantity)]));

    const deliveredAt = order.delivered_at ? new Date(order.delivered_at) : null;
    const daysSinceDelivery = deliveredAt
      ? Math.floor((Date.now() - deliveredAt.getTime()) / 86_400_000)
      : null;

    return {
      order: {
        id: order.id,
        order_number: order.order_number,
        status: order.order_status,
        delivered_at: deliveredAt ? deliveredAt.toISOString() : null,
      },
      window: {
        days: RETURN_WINDOW_DAYS,
        days_since_delivery: daysSinceDelivery,
        // Out of window is a warning, not a block: staff override it every day
        // for a damaged parcel, and a system that refuses outright just gets
        // worked around with a manual refund that leaves no trail.
        in_window: daysSinceDelivery === null ? false : daysSinceDelivery <= RETURN_WINDOW_DAYS,
        delivered: order.order_status === 'delivered',
      },
      items: items.map((item) => {
        const alreadyClaimed = claimed.get(item.id) ?? 0;
        return {
          order_item_id: item.id,
          sku: item.sku,
          name: item.product_name,
          variant_title: item.variant_title,
          image_url: item.image_url,
          unit_price: money(item.unit_price),
          delivered_quantity: item.fulfilled_quantity,
          returned_quantity: item.returned_quantity,
          /** Open RMAs already claim stock, so two cannot return the same unit. */
          pending_return_quantity: alreadyClaimed,
          returnable: Math.max(0, Number(item.returnable) - alreadyClaimed),
        };
      }),
    };
  },

  async create(
    input: {
      order_id: number;
      reason: string;
      reason_detail?: string | null;
      refund_method?: string;
      items: { order_item_id: number; quantity: number }[];
    },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const order = await ordersRepository.findById(input.order_id);
    if (!order) throw ApiError.notFound('Order');
    if (order.order_status !== 'delivered') {
      throw ApiError.conflict(
        `Only a delivered order can be returned; this one is "${order.order_status}".`,
        'INVALID_TRANSITION',
      );
    }

    const [orderItems, pending] = await Promise.all([
      returnsRepository.returnableItems(input.order_id),
      returnsRepository.pendingReturnedQuantities(input.order_id, null),
    ]);
    const claimed = new Map(pending.map((row) => [row.order_item_id, Number(row.quantity)]));

    const lines: { orderItemId: number; quantity: number; refundAmount: number }[] = [];
    for (const line of input.items) {
      const item = orderItems.find((candidate) => candidate.id === line.order_item_id);
      if (!item) throw ApiError.validation({ items: [`Item ${line.order_item_id} is not on this order.`] });

      const available = Math.max(0, Number(item.returnable) - (claimed.get(item.id) ?? 0));
      if (line.quantity < 1 || line.quantity > available) {
        throw ApiError.validation({
          items: [
            available === 0
              ? `"${item.product_name}" has already been returned in full.`
              : `"${item.product_name}" has ${available} eligible to return; you asked for ${line.quantity}.`,
          ],
        });
      }
      // Refunded at what was actually paid per unit, not at MRP — the discount
      // the customer received is not theirs to keep on a return.
      lines.push({
        orderItemId: item.id,
        quantity: line.quantity,
        // line_total is the line after its share of any order discount.
        refundAmount: money((Number(item.line_total) / Math.max(1, item.quantity)) * line.quantity),
      });
    }

    if (lines.length === 0) throw ApiError.validation({ items: ['Choose at least one item to return.'] });

    const requestedAmount = money(lines.reduce((sum, line) => sum + line.refundAmount, 0));
    const rmaNumber = await shipmentsRepository.nextNumber('rma');

    const id = await withTransaction(async (tx) => {
      const returnId = await returnsRepository.create(
        {
          rmaNumber,
          orderId: input.order_id,
          customerId: order.customer_id,
          reason: input.reason,
          reasonDetail: input.reason_detail ?? null,
          refundMethod: input.refund_method ?? 'original',
          requestedAmount,
        },
        tx,
      );
      for (const line of lines) await returnsRepository.addItem(returnId, line, tx);

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'return.created',
          entityType: 'return_request',
          entityId: returnId,
          summary: `Raised ${rmaNumber} on ${order.order_number} for ${requestedAmount}`,
          context: { request_id: meta.requestId, reason: input.reason },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return returnId;
    });

    return this.get(id);
  },

  async changeStatus(
    id: number,
    status: string,
    input: { note?: string | null; reason?: string | null; approved_amount?: number },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const row = await returnsRepository.findById(id);
    if (!row) throw ApiError.notFound('Return');
    assertTransition(row.status, status);

    await withTransaction(async (tx) => {
      const fields: Record<string, unknown> = { status };

      if (status === 'approved') {
        fields.approved_at = new Date();
        fields.approved_by_admin_id = actor.id;
        fields.approved_amount = input.approved_amount ?? money(row.requested_amount);
      }
      if (status === 'rejected') {
        if (!input.reason) {
          throw ApiError.validation({ reason: ['Say why it was rejected — the customer sees this.'] });
        }
        fields.rejection_reason = input.reason;
        fields.closed_at = new Date();
      }
      if (status === 'received') fields.received_at = new Date();
      if (status === 'inspected' && input.note) fields.inspection_note = input.note;
      if (status === 'closed') fields.closed_at = new Date();

      await returnsRepository.update(id, fields, tx);

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'return.status_changed',
          entityType: 'return_request',
          entityId: id,
          summary: `${row.rma_number}: ${row.status} → ${status}`,
          context: { request_id: meta.requestId, note: input.note ?? null },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  /**
   * Books a reverse pickup with the carrier.
   *
   * Separate from the status change because it can fail on the carrier's side,
   * and a return that says "pickup scheduled" with no waybill is worse than one
   * still sitting at approved.
   */
  async schedulePickup(id: number, carrierId: number | null, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const row = await returnsRepository.findById(id);
    if (!row) throw ApiError.notFound('Return');
    assertTransition(row.status, 'pickup_scheduled');

    const carrier = carrierId
      ? await shipmentsRepository.findCarrier(carrierId)
      : await shipmentsRepository.defaultCarrier();
    if (!carrier) throw ApiError.conflict('No carrier is configured to collect this return.');
    if (carrier.supports_reverse_pickup !== 1) {
      throw ApiError.conflict(`${carrier.name} does not do reverse pickups.`, 'INVALID_TRANSITION');
    }

    const [location, addresses] = await Promise.all([
      shipmentsRepository.defaultLocation(),
      ordersRepository.addresses(row.order_id),
    ]);
    const from = addresses.find((address) => address.address_type === 'shipping');
    if (!from) throw ApiError.conflict('This order has no address to collect from.');

    const provider = await resolveCourier({ code: carrier.code, api_provider: carrier.api_provider });
    let awb: string;
    try {
      const result = await provider.createReversePickup({
        reference: row.rma_number,
        forwardAwb: null,
        // Reversed on purpose: the customer's address is the pickup and the
        // warehouse is the destination.
        pickup: {
          name: [from.first_name, from.last_name].filter(Boolean).join(' '),
          phone: from.phone,
          email: from.email,
          line1: from.line1,
          line2: from.line2,
          landmark: from.landmark,
          city: from.city,
          state: from.state,
          pincode: from.pincode,
          country: from.country ?? 'IN',
        },
        delivery: {
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
        parcel: { weightGrams: 400, lengthMm: null, widthMm: null, heightMm: null },
      });
      awb = result.awbNumber;
    } catch (error) {
      const message = error instanceof CourierError ? error.message : 'The carrier could not schedule a pickup.';
      const retryable = error instanceof CourierError ? error.retryable : true;
      throw retryable ? ApiError.upstream(message) : ApiError.badRequest(message);
    }

    await withTransaction(async (tx) => {
      await returnsRepository.update(id, { status: 'pickup_scheduled', pickup_awb: awb }, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'return.pickup_scheduled',
          entityType: 'return_request',
          entityId: id,
          summary: `${row.rma_number}: reverse pickup booked with ${carrier.name} · AWB ${awb}`,
          context: { request_id: meta.requestId, awb },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  /**
   * Records what came back and in what condition, and restocks what is sellable.
   *
   * This is the step that touches inventory, and it does so from the inspected
   * condition rather than from the request — a customer saying "unopened" and a
   * warehouse finding a used bottle are different facts, and only the second one
   * should put stock back on the shelf.
   */
  async inspect(
    id: number,
    input: {
      note?: string | null;
      items: { id: number; condition: string; restock: boolean; condition_note?: string | null }[];
    },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const row = await returnsRepository.findById(id);
    if (!row) throw ApiError.notFound('Return');
    if (row.status !== 'received') {
      throw ApiError.conflict(
        `A return has to be received before it can be inspected; this one is "${row.status}".`,
        'INVALID_TRANSITION',
      );
    }

    const items = await returnsRepository.itemsFor(id);

    await withTransaction(async (tx) => {
      for (const decision of input.items) {
        const item = items.find((candidate) => candidate.id === decision.id);
        if (!item) throw ApiError.validation({ items: [`Line ${decision.id} is not on this return.`] });

        await returnsRepository.updateItem(
          decision.id,
          {
            item_condition: decision.condition,
            restock: decision.restock ? 1 : 0,
            condition_note: decision.condition_note ?? null,
          },
          tx,
        );

        if (decision.restock && item.variant_id) {
          await returnsRepository.restock(item.variant_id, item.quantity, tx);
        }
      }

      // The order lines are marked returned here, not at request time, because
      // until the parcel is in the building nothing has actually come back.
      await returnsRepository.markItemsReturned(
        items.map((item) => ({ orderItemId: item.order_item_id, quantity: item.quantity })),
        tx,
      );

      await returnsRepository.update(id, { status: 'inspected', inspection_note: input.note ?? null }, tx);

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'return.inspected',
          entityType: 'return_request',
          entityId: id,
          summary: `${row.rma_number}: inspected, ${input.items.filter((i) => i.restock).length} line(s) restocked`,
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
   * Refunds the return through the order's own refund path.
   *
   * Deliberately not a second money route. Everything about how much can still
   * be refunded, how the payment record is written and how the order's payment
   * status moves already lives in the orders service; duplicating it here is how
   * the two drift and a customer gets paid twice.
   */
  async refund(id: number, input: { amount?: number; note?: string | null }, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const row = await returnsRepository.findById(id);
    if (!row) throw ApiError.notFound('Return');
    assertTransition(row.status, 'refunded');

    const amount = input.amount ?? money(row.approved_amount ?? row.requested_amount);
    if (amount <= 0) throw ApiError.validation({ amount: ['There is nothing to refund on this return.'] });

    const items = await returnsRepository.itemsFor(id);
    // Restocking already happened at inspection; asking the refund path to do it
    // again would double the stock.
    await ordersService.refund(
      row.order_id,
      {
        amount,
        reason: `Return ${row.rma_number} — ${row.reason.replace(/_/g, ' ')}`,
        internal_note: input.note ?? row.inspection_note ?? null,
        restock: false,
      },
      actor,
      { ...meta, requestId: meta.requestId ?? '' },
    );

    await withTransaction(async (tx) => {
      await returnsRepository.update(id, { status: 'refunded', approved_amount: amount, closed_at: null }, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'return.refunded',
          entityType: 'return_request',
          entityId: id,
          summary: `${row.rma_number}: refunded ${amount} across ${items.length} line(s)`,
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },
};
