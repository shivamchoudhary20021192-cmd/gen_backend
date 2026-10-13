import { execute, insert, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface ShipmentRow extends RowDataPacket {
  id: number;
  shipment_number: string;
  order_id: number;
  order_number: string;
  order_status: string;
  customer_name: string | null;
  contact_phone: string | null;
  carrier_id: number | null;
  carrier_name: string | null;
  carrier_code: string | null;
  carrier_api_provider: string | null;
  tracking_url_template: string | null;
  location_id: number | null;
  awb_number: string | null;
  tracking_url: string | null;
  provider_shipment_id: string | null;
  status: string;
  shipping_mode: string;
  weight_grams: number | null;
  length_mm: number | null;
  width_mm: number | null;
  height_mm: number | null;
  shipping_charge: string | null;
  cod_amount: string;
  cod_remitted_at: Date | null;
  ndr_reason: string | null;
  ndr_attempts: number;
  rto_reason: string | null;
  shipped_at: Date | null;
  estimated_delivery_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
  item_count: number;
  city: string | null;
  state: string | null;
  pincode: string | null;
}

export interface TrackingEventRow extends RowDataPacket {
  id: number;
  status_code: string;
  status_label: string | null;
  description: string | null;
  location: string | null;
  event_at: Date;
  is_customer_visible: number;
}

export interface CarrierRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  tracking_url_template: string | null;
  api_provider: string | null;
  supports_cod: number;
  supports_reverse_pickup: number;
  is_active: number;
  priority: number;
}

const SHIPMENT_COLUMNS = `
  s.id, s.shipment_number, s.order_id, s.carrier_id, s.location_id, s.awb_number,
  s.tracking_url, s.provider_shipment_id, s.status, s.shipping_mode, s.weight_grams,
  s.length_mm, s.width_mm, s.height_mm, s.shipping_charge, s.cod_amount, s.cod_remitted_at,
  s.ndr_reason, s.ndr_attempts, s.rto_reason, s.shipped_at, s.estimated_delivery_at,
  s.delivered_at, s.created_at,
  o.order_number, o.order_status,
  TRIM(CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, ''))) AS customer_name,
  o.contact_phone,
  a.city, a.state, a.pincode,
  c.name AS carrier_name, c.code AS carrier_code, c.api_provider AS carrier_api_provider,
  c.tracking_url_template,
  (SELECT COALESCE(SUM(si.quantity), 0) FROM shipment_items si WHERE si.shop_id = s.shop_id AND si.shipment_id = s.id) AS item_count`;

const SHIPMENT_FROM = `
  FROM shipments s
  JOIN orders o ON o.id = s.order_id
  LEFT JOIN order_addresses a ON a.order_id = o.id AND a.address_type = 'shipping'
  LEFT JOIN shipping_carriers c ON c.id = s.carrier_id AND c.shop_id = s.shop_id`;

export interface ShipmentFilters {
  search?: string;
  status?: string;
  carrierId?: number;
  orderId?: number;
  /** Everything not yet delivered, returned or cancelled — the working queue. */
  openOnly?: boolean;
  shippedFrom?: string;
  shippedTo?: string;
}

const CLOSED = ['delivered', 'rto_delivered', 'cancelled', 'lost'];

function buildWhere(filters: ShipmentFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = ['s.shop_id = ?'];
  const params: unknown[] = [shopId()];

  if (filters.search) {
    conditions.push(
      '(s.shipment_number LIKE ? OR s.awb_number LIKE ? OR o.order_number LIKE ? OR o.contact_phone LIKE ?)',
    );
    const like = `%${filters.search}%`;
    params.push(like, like, like, like);
  }
  if (filters.status) {
    conditions.push('s.status = ?');
    params.push(filters.status);
  }
  if (filters.carrierId) {
    conditions.push('s.carrier_id = ?');
    params.push(filters.carrierId);
  }
  if (filters.orderId) {
    conditions.push('s.order_id = ?');
    params.push(filters.orderId);
  }
  if (filters.openOnly) {
    conditions.push(`s.status NOT IN (${CLOSED.map(() => '?').join(', ')})`);
    params.push(...CLOSED);
  }
  if (filters.shippedFrom) {
    conditions.push('s.created_at >= ?');
    params.push(`${filters.shippedFrom} 00:00:00`);
  }
  if (filters.shippedTo) {
    conditions.push('s.created_at <= ?');
    params.push(`${filters.shippedTo} 23:59:59`);
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

export const shipmentsRepository = {
  async list(
    filters: ShipmentFilters,
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<ShipmentRow[]> {
    const { clause, params } = buildWhere(filters);
    return query<ShipmentRow>(
      `SELECT ${SHIPMENT_COLUMNS} ${SHIPMENT_FROM} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async count(filters: ShipmentFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total ${SHIPMENT_FROM} ${clause}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  async statusCounts(exec: Executor = pool): Promise<Record<string, number>> {
    const rows = await query<RowDataPacket & { status: string; total: number }>(
      'SELECT status, COUNT(*) AS total FROM shipments WHERE shop_id = ? GROUP BY status',
      [shopId()],
      exec,
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
  },

  async findById(id: number, exec: Executor = pool): Promise<ShipmentRow | null> {
    return queryOne<ShipmentRow>(`SELECT ${SHIPMENT_COLUMNS} ${SHIPMENT_FROM} WHERE s.shop_id = ? AND s.id = ? LIMIT 1`, [shopId(), id], exec);
  },

  /** The shipment a carrier's tracking webhook is about. */
  async findByAwb(awb: string, exec: Executor = pool): Promise<ShipmentRow | null> {
    return queryOne<ShipmentRow>(
      `SELECT ${SHIPMENT_COLUMNS} ${SHIPMENT_FROM} WHERE s.shop_id = ? AND s.awb_number = ? ORDER BY s.id DESC LIMIT 1`,
      [shopId(), awb],
      exec,
    );
  },

  async itemsFor(shipmentId: number, exec: Executor = pool) {
    return query<
      RowDataPacket & {
        id: number;
        order_item_id: number;
        quantity: number;
        sku: string;
        product_name: string;
        variant_title: string | null;
        image_url: string | null;
      }
    >(
      `SELECT si.id, si.order_item_id, si.quantity,
              oi.sku, oi.product_name, oi.variant_title, oi.image_url
         FROM shipment_items si
         JOIN order_items oi ON oi.id = si.order_item_id
        WHERE si.shop_id = ? AND si.shipment_id = ?
        ORDER BY si.id`,
      [shopId(), shipmentId],
      exec,
    );
  },

  async trackingEvents(shipmentId: number, exec: Executor = pool): Promise<TrackingEventRow[]> {
    return query<TrackingEventRow>(
      `SELECT id, status_code, status_label, description, location, event_at, is_customer_visible
         FROM shipment_tracking_events
        WHERE shop_id = ? AND shipment_id = ?
        ORDER BY event_at ASC, id ASC`,
      [shopId(), shipmentId],
      exec,
    );
  },

  /**
   * Records tracking events, skipping ones already stored.
   *
   * Polling a carrier returns the whole trail every time, so without this the
   * event list doubles on every refresh. Deduped on (status, timestamp) because
   * that pair is what a carrier actually guarantees to be stable — event ids
   * are not, and several vendors reuse them.
   */
  async addTrackingEvents(
    shipmentId: number,
    events: { status: string; description: string; location: string | null; at: Date }[],
    exec: Executor = pool,
  ): Promise<number> {
    if (events.length === 0) return 0;

    const existing = await query<RowDataPacket & { status_code: string; event_at: Date }>(
      'SELECT status_code, event_at FROM shipment_tracking_events WHERE shop_id = ? AND shipment_id = ?',
      [shopId(), shipmentId],
      exec,
    );
    const seen = new Set(existing.map((row) => `${row.status_code}@${new Date(row.event_at).getTime()}`));

    let added = 0;
    for (const event of events) {
      const key = `${event.status}@${event.at.getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await execute(
        `INSERT INTO shipment_tracking_events
           (shop_id, shipment_id, status_code, status_label, description, location, event_at, is_customer_visible)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
        [shopId(), shipmentId, event.status, event.status.replace(/_/g, ' '), event.description, event.location, event.at],
        exec,
      );
      added += 1;
    }
    return added;
  },

  async update(id: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    await execute(
      `UPDATE shipments SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE shop_id = ? AND id = ?`,
      [...Object.values(fields), shopId(), id],
      exec,
    );
  },

  async carriers(activeOnly = true, exec: Executor = pool): Promise<CarrierRow[]> {
    return query<CarrierRow>(
      `SELECT id, code, name, tracking_url_template, api_provider, supports_cod,
              supports_reverse_pickup, is_active, priority
         FROM shipping_carriers
        WHERE shop_id = ? ${activeOnly ? 'AND is_active = 1' : ''}
        ORDER BY priority ASC, name ASC`,
      [shopId()],
      exec,
    );
  },

  async findCarrier(id: number, exec: Executor = pool): Promise<CarrierRow | null> {
    return queryOne<CarrierRow>('SELECT * FROM shipping_carriers WHERE shop_id = ? AND id = ? LIMIT 1', [shopId(), id], exec);
  },

  async defaultCarrier(exec: Executor = pool): Promise<CarrierRow | null> {
    return queryOne<CarrierRow>(
      'SELECT * FROM shipping_carriers WHERE shop_id = ? AND is_active = 1 ORDER BY priority ASC, id ASC LIMIT 1',
      [shopId()],
      exec,
    );
  },

  async defaultLocation(exec: Executor = pool) {
    return queryOne<
      RowDataPacket & {
        id: number;
        name: string;
        line1: string | null;
        line2: string | null;
        city: string | null;
        state: string | null;
        state_code: string | null;
        pincode: string | null;
        country: string | null;
        gstin: string | null;
        contact_name: string | null;
        contact_phone: string | null;
      }
    >(
      `SELECT id, name, line1, line2, city, state, state_code, pincode, country, gstin,
              contact_name, contact_phone
         FROM inventory_locations
        WHERE shop_id = ? AND is_active = 1
        ORDER BY is_default DESC, priority ASC, id ASC
        LIMIT 1`,
      [shopId()],
      exec,
    );
  },

  async createShipment(
    data: {
      shipmentNumber: string;
      orderId: number;
      carrierId: number | null;
      locationId: number | null;
      awbNumber: string | null;
      trackingUrl: string | null;
      providerShipmentId: string | null;
      status: string;
      shippingMode: string;
      weightGrams: number | null;
      shippingCharge: number | null;
      codAmount: string;
      estimatedDeliveryAt: Date | null;
      shippedAt: Date | null;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO shipments
         (shop_id, shipment_number, order_id, carrier_id, location_id, awb_number, tracking_url,
          provider_shipment_id, status, shipping_mode, weight_grams, shipping_charge,
          cod_amount, estimated_delivery_at, shipped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.shipmentNumber,
        data.orderId,
        data.carrierId,
        data.locationId,
        data.awbNumber,
        data.trackingUrl,
        data.providerShipmentId,
        data.status,
        data.shippingMode,
        data.weightGrams,
        // NOT NULL DEFAULT 0.00. A self-shipped parcel has no carrier quote, and
        // zero is the honest value: nothing was quoted, so nothing is owed to a
        // carrier we did not book with. The actual cost, when there is one, is
        // recorded against the courier invoice rather than guessed here.
        data.shippingCharge ?? 0,
        data.codAmount,
        data.estimatedDeliveryAt,
        data.shippedAt,
      ],
      exec,
    );
  },

  async addItem(shipmentId: number, orderItemId: number, quantity: number, exec: Executor = pool): Promise<void> {
    await execute(
      'INSERT INTO shipment_items (shop_id, shipment_id, order_item_id, quantity) VALUES (?, ?, ?, ?)',
      [shopId(), shipmentId, orderItemId, quantity],
      exec,
    );
  },

  /**
   * Draws the next number from the shop's counter — never MAX(), see migration
   * 17. Each shop counts from its own 1: shop B's first shipment is SHP000001
   * whatever shop A has shipped.
   */
  async nextNumber(sequence: string, exec: Executor = pool): Promise<string> {
    await execute(
      'UPDATE number_sequences SET current_value = LAST_INSERT_ID(current_value + 1) WHERE shop_id = ? AND name = ?',
      [shopId(), sequence],
      exec,
    );
    const row = await queryOne<RowDataPacket & { value: number; prefix: string; padding: number }>(
      'SELECT LAST_INSERT_ID() AS value, prefix, padding FROM number_sequences WHERE shop_id = ? AND name = ?',
      [shopId(), sequence],
      exec,
    );
    if (!row || !row.value) {
      throw new Error(`number_sequences row "${sequence}" is missing — run database/19_fulfilment_setup.sql`);
    }
    return `${row.prefix}${String(row.value).padStart(row.padding, '0')}`;
  },
};
