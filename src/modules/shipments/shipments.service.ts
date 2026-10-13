import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination, type PaginationMeta } from '../../core/pagination';
import { withTransaction } from '../../db/transaction';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { auditService } from '../../shared/audit.service';
import { CourierError, resolveCourier, trackingUrlFor, type CourierStatus } from '../shipping/courier';
import { shipmentsRepository, type ShipmentRow } from './shipments.repository';
import { eventBus } from '../../platform/events/eventBus';
import { onInboundEvent } from '../../platform/integrations/inbound';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId?: string;
}

const SORTABLE: Record<string, string> = {
  created: 's.created_at DESC, s.id DESC',
  oldest: 's.created_at ASC, s.id ASC',
  shipped: 's.shipped_at DESC, s.id DESC',
  status: 's.status ASC, s.created_at DESC',
};

/**
 * Which shipment statuses may follow which.
 *
 * The forward path and the RTO path are separate branches off the same trunk,
 * and NDR can happen repeatedly before either resolves — a parcel nobody was
 * home for goes back out for delivery rather than moving on.
 */
const TRANSITIONS: Record<string, CourierStatus[]> = {
  created: ['label_generated', 'pickup_scheduled', 'cancelled'],
  label_generated: ['pickup_scheduled', 'picked_up', 'cancelled'],
  pickup_scheduled: ['picked_up', 'cancelled'],
  picked_up: ['in_transit', 'lost', 'damaged'],
  in_transit: ['out_for_delivery', 'ndr', 'lost', 'damaged', 'rto_initiated'],
  out_for_delivery: ['delivered', 'ndr', 'rto_initiated'],
  ndr: ['out_for_delivery', 'rto_initiated', 'lost'],
  rto_initiated: ['rto_in_transit'],
  rto_in_transit: ['rto_delivered', 'lost'],
  delivered: [],
  rto_delivered: [],
  cancelled: [],
  lost: [],
  damaged: [],
};

/** Statuses where the parcel is with the carrier and cannot be cancelled. */
const IN_CARRIER_HANDS = new Set([
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'ndr',
  'rto_initiated',
  'rto_in_transit',
]);

function money(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

function present(row: ShipmentRow) {
  return {
    id: row.id,
    shipment_number: row.shipment_number,
    order: { id: row.order_id, order_number: row.order_number, status: row.order_status },
    customer: { name: row.customer_name?.trim() || null, phone: row.contact_phone },
    destination: row.city ? { city: row.city, state: row.state, pincode: row.pincode } : null,
    carrier: row.carrier_id
      ? {
          id: row.carrier_id,
          name: row.carrier_name,
          code: row.carrier_code,
          /**
           * Whether this carrier is really connected. The dummy provider is
           * deliberately visible here — an operator who thinks a parcel was
           * booked with Blue Dart when nothing left the building is how a
           * customer gets told their order shipped and it never arrives.
           */
          is_live: row.carrier_api_provider !== null && !['dummy', 'manual'].includes(row.carrier_api_provider),
        }
      : null,
    awb_number: row.awb_number,
    tracking_url: row.tracking_url ?? trackingUrlFor(row.tracking_url_template, row.awb_number),
    status: row.status,
    shipping_mode: row.shipping_mode,
    weight_grams: row.weight_grams,
    shipping_charge: row.shipping_charge === null ? null : money(row.shipping_charge),
    cod_amount: money(row.cod_amount),
    cod_remitted_at: row.cod_remitted_at ? row.cod_remitted_at.toISOString() : null,
    ndr_reason: row.ndr_reason,
    ndr_attempts: row.ndr_attempts,
    rto_reason: row.rto_reason,
    item_count: Number(row.item_count ?? 0),
    shipped_at: row.shipped_at ? row.shipped_at.toISOString() : null,
    estimated_delivery_at: row.estimated_delivery_at ? row.estimated_delivery_at.toISOString() : null,
    delivered_at: row.delivered_at ? row.delivered_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    /** The transitions this shipment can legally make right now. */
    next_statuses: TRANSITIONS[row.status] ?? [],
    can_cancel: !IN_CARRIER_HANDS.has(row.status) && !['delivered', 'cancelled', 'rto_delivered'].includes(row.status),
  };
}

export const shipmentsService = {
  async list(queryParams: Record<string, unknown>): Promise<{ shipments: unknown[]; pagination: PaginationMeta }> {
    const page = parsePagination(queryParams);
    const sortKey = typeof queryParams.sort === 'string' ? queryParams.sort : '';
    const orderBy = SORTABLE[sortKey] ?? SORTABLE.created;

    const filters = {
      search: queryParams.q as string | undefined,
      status: queryParams.status as string | undefined,
      carrierId: queryParams.carrier_id as number | undefined,
      orderId: queryParams.order_id as number | undefined,
      openOnly: queryParams.open as boolean | undefined,
      shippedFrom: queryParams.from as string | undefined,
      shippedTo: queryParams.to as string | undefined,
    };

    const [rows, total] = await Promise.all([
      shipmentsRepository.list(filters, orderBy, page.limit, page.offset),
      shipmentsRepository.count(filters),
    ]);

    return { shipments: rows.map(present), pagination: buildMeta(total, page) };
  },

  async statusCounts() {
    return { counts: await shipmentsRepository.statusCounts() };
  },

  async carriers() {
    const rows = await shipmentsRepository.carriers(false);
    return {
      carriers: rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        supports_cod: row.supports_cod === 1,
        supports_reverse_pickup: row.supports_reverse_pickup === 1,
        is_active: row.is_active === 1,
        // Named rather than inferred, so the admin can say "Blue Dart (not
        // connected — using the stand-in)" instead of implying a live booking.
        provider: row.api_provider,
        is_live: row.api_provider !== null && !['dummy', 'manual'].includes(row.api_provider),
      })),
    };
  },

  async get(id: number) {
    const row = await shipmentsRepository.findById(id);
    if (!row) throw ApiError.notFound('Shipment');

    const [items, events] = await Promise.all([
      shipmentsRepository.itemsFor(id),
      shipmentsRepository.trackingEvents(id),
    ]);

    return {
      shipment: {
        ...present(row),
        items: items.map((item) => ({
          id: item.id,
          order_item_id: item.order_item_id,
          quantity: item.quantity,
          sku: item.sku,
          name: item.product_name,
          variant_title: item.variant_title,
          image_url: item.image_url,
        })),
        tracking: events.map((event) => ({
          id: event.id,
          status: event.status_code,
          label: event.status_label,
          description: event.description,
          location: event.location,
          at: event.event_at.toISOString(),
        })),
      },
    };
  },

  /**
   * Pulls the latest trail from the carrier and stores what is new.
   *
   * The carrier is the authority on where a parcel is, so its status wins —
   * but only forward. A carrier that briefly reports an older event (they do)
   * must not walk a delivered shipment back to in-transit.
   */
  async refreshTracking(id: number, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const row = await shipmentsRepository.findById(id);
    if (!row) throw ApiError.notFound('Shipment');
    if (!row.awb_number) {
      throw ApiError.conflict('This shipment has no waybill to track yet.', 'INVALID_TRANSITION');
    }

    const carrier = row.carrier_id ? await shipmentsRepository.findCarrier(row.carrier_id) : null;
    const provider = await resolveCourier({
      code: carrier?.code ?? 'manual',
      api_provider: carrier?.api_provider ?? 'dummy',
    });

    let result;
    try {
      result = await provider.track(row.awb_number, row.shipped_at ?? row.created_at);
    } catch (error) {
      // A courier being unreachable is upstream, not a conflict: nothing about
      // the request is wrong and retrying is the right offer to make.
      const message = error instanceof CourierError ? error.message : 'The carrier did not respond.';
      const retryable = error instanceof CourierError ? error.retryable : true;
      throw retryable ? ApiError.upstream(message) : ApiError.badRequest(message);
    }

    await withTransaction(async (tx) => {
      await shipmentsRepository.addTrackingEvents(id, result.events, tx);

      const fields: Record<string, unknown> = {};
      // Only move forward through the graph. Reachability is checked against
      // the whole remaining path, not just one hop, because a poll can skip
      // states we never saw.
      if (result.status !== row.status && isReachable(row.status, result.status)) {
        fields.status = result.status;
      }
      if (result.deliveredAt && !row.delivered_at) fields.delivered_at = result.deliveredAt;
      if (result.estimatedDeliveryAt) fields.estimated_delivery_at = result.estimatedDeliveryAt;

      if (Object.keys(fields).length > 0) await shipmentsRepository.update(id, fields, tx);
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'shipment.tracking_refreshed',
      entityType: 'shipment',
      entityId: id,
      summary: `Refreshed tracking for ${row.shipment_number} (${result.status})`,
      context: { request_id: meta.requestId, awb: row.awb_number },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.get(id);
  },

  async changeStatus(
    id: number,
    status: string,
    input: { note?: string | null; reason?: string | null },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const row = await shipmentsRepository.findById(id);
    if (!row) throw ApiError.notFound('Shipment');

    const allowed = TRANSITIONS[row.status] ?? [];
    if (!allowed.includes(status as CourierStatus)) {
      throw ApiError.conflict(
        `A shipment that is "${row.status}" cannot become "${status}".`,
        'INVALID_TRANSITION',
      );
    }

    await withTransaction(async (tx) => {
      const fields: Record<string, unknown> = { status };
      if (status === 'picked_up' && !row.shipped_at) fields.shipped_at = new Date();
      if (status === 'delivered') fields.delivered_at = new Date();
      if (status === 'ndr') {
        fields.ndr_reason = input.reason ?? input.note ?? 'Delivery attempt failed';
        // Counted here rather than by the carrier, because the count is what
        // decides when a parcel goes RTO and that decision must be ours.
        fields.ndr_attempts = row.ndr_attempts + 1;
      }
      if (status === 'rto_initiated') fields.rto_reason = input.reason ?? input.note ?? 'Returned to origin';

      await shipmentsRepository.update(id, fields, tx);
      await shipmentsRepository.addTrackingEvents(
        id,
        [
          {
            status,
            description: input.note ?? input.reason ?? `Marked ${status.replace(/_/g, ' ')} by staff`,
            location: null,
            at: new Date(),
          },
        ],
        tx,
      );

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'shipment.status_changed',
          entityType: 'shipment',
          entityId: id,
          summary: `${row.shipment_number}: ${row.status} → ${status}`,
          context: { request_id: meta.requestId, note: input.note ?? null },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  async cancel(id: number, reason: string, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const row = await shipmentsRepository.findById(id);
    if (!row) throw ApiError.notFound('Shipment');

    if (IN_CARRIER_HANDS.has(row.status)) {
      throw ApiError.conflict(
        'The carrier already has this parcel — it has to be returned to origin rather than cancelled.',
        'INVALID_TRANSITION',
      );
    }
    if (['delivered', 'cancelled', 'rto_delivered'].includes(row.status)) {
      throw ApiError.conflict(`A shipment that is "${row.status}" cannot be cancelled.`, 'INVALID_TRANSITION');
    }

    const carrier = row.carrier_id ? await shipmentsRepository.findCarrier(row.carrier_id) : null;
    if (row.awb_number && carrier) {
      const provider = await resolveCourier({ code: carrier.code, api_provider: carrier.api_provider });
      try {
        await provider.cancelShipment(row.provider_shipment_id ?? '', row.awb_number);
      } catch (error) {
        // A carrier that will not release the waybill is a real blocker: leaving
        // our row cancelled while theirs is live means a parcel we think is
        // stopped still moving.
        const message = error instanceof CourierError ? error.message : 'The carrier refused the cancellation.';
        throw ApiError.conflict(message, 'INVALID_TRANSITION');
      }
    }

    await withTransaction(async (tx) => {
      await shipmentsRepository.update(id, { status: 'cancelled' }, tx);
      await shipmentsRepository.addTrackingEvents(
        id,
        [{ status: 'cancelled', description: reason, location: null, at: new Date() }],
        tx,
      );
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'shipment.cancelled',
          entityType: 'shipment',
          entityId: id,
          summary: `Cancelled ${row.shipment_number}: ${reason}`,
          context: { request_id: meta.requestId, awb: row.awb_number },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },
};

/** Can `to` still be reached from `from` by following the transition graph? */
function isReachable(from: string, to: string): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of TRANSITIONS[current] ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/**
 * A carrier's tracking webhook, through the integrations pipeline.
 *
 * The same forward-only rule as `refreshTracking`: the event is always kept in
 * the trail, but the shipment's status only moves if the new one is still
 * reachable from where it is — a late "in transit" never un-delivers a parcel.
 */
onInboundEvent('shipment.status', async ({ data }) => {
  const awb = typeof data.awb === 'string' ? data.awb : null;
  if (!awb) return 'ignored';
  const row = await shipmentsRepository.findByAwb(awb);
  if (!row) return 'ignored';

  const status = String(data.status ?? '') as CourierStatus;
  const at = new Date(String(data.at ?? ''));
  const when = Number.isNaN(at.getTime()) ? new Date() : at;

  const moved = await withTransaction(async (tx) => {
    await shipmentsRepository.addTrackingEvents(
      row.id,
      [
        {
          status,
          description: typeof data.description === 'string' ? data.description : status.replace(/_/g, ' '),
          location: typeof data.location === 'string' ? data.location : null,
          at: when,
        },
      ],
      tx,
    );
    const fields: Record<string, unknown> = {};
    if (status !== row.status && isReachable(row.status, status)) fields.status = status;
    if (status === 'picked_up' && !row.shipped_at) fields.shipped_at = when;
    if (status === 'delivered' && !row.delivered_at) fields.delivered_at = when;
    if (Object.keys(fields).length === 0) return false;
    await shipmentsRepository.update(row.id, fields, tx);
    await eventBus.publish(
      'fulfillments/update',
      { shipment_id: row.id, shipment_number: row.shipment_number, order_id: row.order_id, status, awb },
      { resourceType: 'shipment', resourceId: row.id, actorType: 'system', tx },
    );
    return true;
  });
  return moved ? 'processed' : 'ignored';
});
