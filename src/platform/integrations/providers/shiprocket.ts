import crypto from 'node:crypto';
import {
  CourierError,
  type CourierProvider,
  type CourierStatus,
  type CreateShipmentInput,
  type CreateShipmentResult,
  type RateQuote,
  type RateQuoteInput,
  type ReversePickupInput,
  type ShipmentAddress,
  type TrackingEvent,
  type TrackingResult,
} from '../../../modules/shipping/courier/CourierProvider';
import { commonErrorMessage, providerFetch, ProviderHttpError } from '../http';
import { InboundSignatureError, type ConnectionContext, type InboundEvent, type ProviderManifest } from '../types';

/**
 * Shiprocket: one account, many Indian couriers.
 *
 * A booking is two calls — create the order, then assign a waybill (Shiprocket
 * picks the courier by the merchant's rules unless one is configured) — and a
 * pickup request. `providerShipmentId` stores both Shiprocket ids as
 * "<order id>:<shipment id>", because cancelling needs the first and tracking
 * the waybill.
 *
 * Tracking webhooks carry no signature; Shiprocket sends the token the
 * merchant typed into its webhook settings in `x-api-key`, and that token is
 * compared in constant time with the one stored on this connection.
 */

interface ShiprocketCredentials {
  email: string;
  password: string;
  webhook_token?: string;
}

const API = 'https://apiv2.shiprocket.in/v1/external';
const tokens = new Map<string, { token: string; expiresAt: number }>();

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Shiprocket's status words onto ours. Exported for tests. */
export function mapShiprocketStatus(raw: string): CourierStatus {
  const status = raw.trim().toUpperCase().replace(/[_-]+/g, ' ');
  if (status.includes('RTO')) {
    if (status.includes('DELIVERED')) return 'rto_delivered';
    if (status.includes('TRANSIT')) return 'rto_in_transit';
    return 'rto_initiated';
  }
  if (status.includes('OUT FOR DELIVERY')) return 'out_for_delivery';
  if (status.includes('UNDELIVERED') || status.includes('NDR')) return 'ndr';
  if (status.includes('DELIVERED')) return 'delivered';
  if (status.includes('CANCEL')) return 'cancelled';
  if (status.includes('LOST')) return 'lost';
  if (status.includes('DAMAGE') || status.includes('DESTROY')) return 'damaged';
  if (status.includes('PICKED UP') || status === 'SHIPPED') return 'picked_up';
  if (status.includes('PICKUP')) return 'pickup_scheduled';
  if (status.includes('AWB') || status.includes('LABEL') || status.includes('MANIFEST')) return 'label_generated';
  if (status.includes('TRANSIT') || status.includes('REACHED') || status.includes('HUB')) return 'in_transit';
  if (status === 'NEW' || status.includes('CREATED')) return 'created';
  return 'in_transit';
}

function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  return { first: parts[0] ?? name, last: parts.slice(1).join(' ') };
}

function dimensionsCm(parcel: CreateShipmentInput['parcel']) {
  const cm = (mm: number | null, fallback: number) => Math.max(1, Math.round((mm ?? fallback * 10) / 10));
  return {
    length: cm(parcel.lengthMm, 20),
    breadth: cm(parcel.widthMm, 15),
    height: cm(parcel.heightMm, 10),
    weight: Math.max(0.05, Math.round(parcel.weightGrams) / 1000),
  };
}

class ShiprocketCourier implements CourierProvider {
  readonly isLive = true;

  constructor(
    private readonly context: ConnectionContext<ShiprocketCredentials>,
    readonly code: string,
  ) {}

  private async token(): Promise<string> {
    const key = `${this.context.connectionId}:${this.context.credentials.email}`;
    const cached = tokens.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const { data } = await providerFetch<{ token?: string }>({
      provider: 'shiprocket',
      url: `${API}/auth/login`,
      json: { email: this.context.credentials.email, password: this.context.credentials.password },
      errorMessage: commonErrorMessage,
    });
    if (!data.token) throw new CourierError(this.code, 'Shiprocket did not return a session token.', true);
    // Tokens last ten days; renew a day early.
    tokens.set(key, { token: data.token, expiresAt: Date.now() + 9 * 24 * 3_600_000 });
    return data.token;
  }

  private async call<T = Record<string, unknown>>(path: string, init: { method?: 'GET' | 'POST'; json?: unknown; timeoutMs?: number } = {}): Promise<T> {
    try {
      const { data } = await providerFetch<T>({
        provider: 'shiprocket',
        method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
        url: `${API}${path}`,
        headers: { Authorization: `Bearer ${await this.token()}` },
        json: init.json,
        timeoutMs: init.timeoutMs ?? 25_000,
        errorMessage: commonErrorMessage,
      });
      return data;
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        if (error.status === 401) tokens.delete(`${this.context.connectionId}:${this.context.credentials.email}`);
        throw new CourierError(this.code, error.message, error.retryable);
      }
      throw error;
    }
  }

  private addressFields(prefix: 'billing' | 'shipping' | 'pickup', address: ShipmentAddress): Record<string, unknown> {
    const { first, last } = splitName(address.name);
    return {
      [`${prefix}_customer_name`]: first,
      [`${prefix}_last_name`]: last,
      [`${prefix}_address`]: address.line1,
      [`${prefix}_address_2`]: [address.line2, address.landmark].filter(Boolean).join(', '),
      [`${prefix}_city`]: address.city,
      [`${prefix}_pincode`]: address.pincode,
      [`${prefix}_state`]: address.state,
      [`${prefix}_country`]: address.country === 'IN' ? 'India' : address.country,
      [`${prefix}_email`]: address.email ?? '',
      [`${prefix}_phone`]: address.phone ?? '',
    };
  }

  private trackingUrl(awb: string): string {
    return `https://shiprocket.co/tracking/${encodeURIComponent(awb)}`;
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    const order = await this.call<Record<string, unknown>>('/orders/create/adhoc', {
      json: {
        order_id: input.reference,
        order_date: formatDate(new Date()),
        pickup_location: String(this.context.config.pickup_location ?? 'Primary'),
        ...this.addressFields('billing', input.delivery),
        shipping_is_billing: true,
        order_items: input.items.map((item) => ({
          name: item.name,
          sku: item.sku,
          units: item.quantity,
          selling_price: item.unitPrice,
          hsn: item.hsnCode ?? '',
        })),
        payment_method: input.codAmount > 0 ? 'COD' : 'Prepaid',
        sub_total: input.codAmount > 0 ? input.codAmount : input.declaredValue,
        ...dimensionsCm(input.parcel),
      },
    });
    const orderId = String(order.order_id ?? '');
    const shipmentId = String(order.shipment_id ?? '');
    if (!orderId || !shipmentId) throw new CourierError(this.code, 'Shiprocket did not create the order.', false);

    const courierId = this.context.config.courier_company_id ? Number(this.context.config.courier_company_id) : undefined;
    const assigned = await this.call<{ awb_assign_status?: number; response?: { data?: Record<string, unknown> }; message?: string }>(
      '/courier/assign/awb',
      { json: { shipment_id: Number(shipmentId), ...(courierId ? { courier_id: courierId } : {}) } },
    );
    const awb = String(assigned.response?.data?.awb_code ?? '');
    if (!awb) {
      throw new CourierError(this.code, assigned.message ?? 'No courier could take this shipment.', false);
    }

    // Asking for the pickup is best-effort: the waybill exists either way, and
    // the merchant can request pickup from the Shiprocket panel.
    await this.call('/courier/generate/pickup', { json: { shipment_id: [Number(shipmentId)] } }).catch(() => undefined);

    const charge = Number(assigned.response?.data?.freight_charges ?? assigned.response?.data?.applied_weight_amount ?? NaN);
    return {
      awbNumber: awb,
      providerShipmentId: `${orderId}:${shipmentId}`,
      trackingUrl: this.trackingUrl(awb),
      estimatedDeliveryAt: null,
      shippingCharge: Number.isFinite(charge) ? charge : null,
    };
  }

  async cancelShipment(providerShipmentId: string): Promise<void> {
    const [orderId] = providerShipmentId.split(':');
    if (!orderId) throw new CourierError(this.code, 'This shipment has no Shiprocket order to cancel.', false);
    await this.call('/orders/cancel', { json: { ids: [Number(orderId)] } });
  }

  async track(awbNumber: string): Promise<TrackingResult> {
    const body = await this.call<{ tracking_data?: Record<string, unknown> }>(`/courier/track/awb/${encodeURIComponent(awbNumber)}`);
    const data = body.tracking_data ?? {};
    const track = ((data.shipment_track as Record<string, unknown>[] | undefined) ?? [])[0] ?? {};
    const activities = (data.shipment_track_activities as Record<string, unknown>[] | undefined) ?? [];

    const events: TrackingEvent[] = activities
      .map((activity) => ({
        status: mapShiprocketStatus(String(activity['sr-status-label'] ?? activity.status ?? activity.activity ?? '')),
        description: String(activity.activity ?? activity.status ?? ''),
        location: typeof activity.location === 'string' ? activity.location : null,
        at: new Date(String(activity.date ?? '')),
      }))
      .filter((event) => !Number.isNaN(event.at.getTime()))
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    const current = mapShiprocketStatus(String(track.current_status ?? events[events.length - 1]?.status ?? 'in_transit'));
    const edd = track.edd ? new Date(String(track.edd)) : data.etd ? new Date(String(data.etd)) : null;
    const delivered = track.delivered_date ? new Date(String(track.delivered_date)) : null;

    return {
      status: current,
      events,
      estimatedDeliveryAt: edd && !Number.isNaN(edd.getTime()) ? edd : null,
      deliveredAt: current === 'delivered' && delivered && !Number.isNaN(delivered.getTime()) ? delivered : null,
    };
  }

  /**
   * Courier serviceability: every courier on the account that serves this
   * route, with its price and delivery estimate. Weight goes in kilograms.
   * With a preferred courier configured, only that courier's price counts —
   * it is the one the parcel will be booked with.
   */
  async quoteRates(input: RateQuoteInput): Promise<RateQuote[]> {
    if (input.origin.country !== 'IN' || input.destination.country !== 'IN') return [];
    const params = new URLSearchParams({
      pickup_postcode: input.origin.postalCode,
      delivery_postcode: input.destination.postalCode,
      weight: String(Math.max(0.1, input.weightGrams / 1000)),
      cod: input.cod ? '1' : '0',
      declared_value: String(Math.round(input.declaredValue)),
    });
    const data = await this.call<{ data?: { available_courier_companies?: Record<string, unknown>[] } }>(
      `/courier/serviceability/?${params.toString()}`,
      { method: 'GET', timeoutMs: 5_000 },
    );
    const preferred = Number(this.context.config.courier_company_id ?? 0) || null;
    const quotes: RateQuote[] = [];
    for (const company of data.data?.available_courier_companies ?? []) {
      if (preferred !== null && Number(company.courier_company_id) !== preferred) continue;
      const amount = Number(company.rate ?? company.freight_charge);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const days = Number(company.estimated_delivery_days);
      quotes.push({
        mode: company.is_surface === true || company.is_surface === 1 ? 'surface' : 'air',
        service: String(company.courier_name ?? 'Shiprocket'),
        amount,
        currency: 'INR',
        etaMinDays: Number.isFinite(days) && days > 0 ? days : null,
        etaMaxDays: Number.isFinite(days) && days > 0 ? days : null,
      });
    }
    return quotes;
  }

  async createReversePickup(input: ReversePickupInput): Promise<CreateShipmentResult> {
    const created = await this.call<Record<string, unknown>>('/orders/create/return', {
      json: {
        order_id: input.reference,
        order_date: formatDate(new Date()),
        ...this.addressFields('pickup', input.pickup),
        ...this.addressFields('shipping', input.delivery),
        order_items: [{ name: 'Return', sku: input.reference, units: 1, selling_price: 0 }],
        payment_method: 'Prepaid',
        sub_total: 0,
        ...dimensionsCm(input.parcel),
      },
    });
    const orderId = String(created.order_id ?? '');
    const shipmentId = String(created.shipment_id ?? '');
    if (!orderId || !shipmentId) throw new CourierError(this.code, 'Shiprocket did not create the return.', false);

    const assigned = await this.call<{ response?: { data?: Record<string, unknown> } }>('/courier/assign/awb', {
      json: { shipment_id: Number(shipmentId), is_return: 1 },
    });
    const awb = String(assigned.response?.data?.awb_code ?? '');
    return {
      awbNumber: awb || `SR-RET-${shipmentId}`,
      providerShipmentId: `${orderId}:${shipmentId}`,
      trackingUrl: awb ? this.trackingUrl(awb) : null,
      estimatedDeliveryAt: null,
      shippingCharge: null,
    };
  }
}

export const shiprocketProvider: ProviderManifest<ShiprocketCredentials> = {
  key: 'shiprocket',
  name: 'Shiprocket',
  category: 'shipping',
  description: 'Book, track and return parcels with 25+ Indian couriers from one account.',
  docsUrl: 'https://apidocs.shiprocket.in/',
  countries: ['IN'],
  credentialFields: [
    { key: 'email', label: 'API user email', secret: false, required: true, help: 'Create an API user under Settings → API in Shiprocket.' },
    { key: 'password', label: 'API user password', secret: true, required: true },
    { key: 'webhook_token', label: 'Webhook token', secret: true, required: false, help: 'Enter the same token in Shiprocket’s webhook settings for live tracking.' },
  ],
  configFields: [
    { key: 'pickup_location', label: 'Pickup location name', type: 'string', required: true, default: 'Primary', help: 'Exactly as named in Shiprocket.' },
    { key: 'courier_company_id', label: 'Preferred courier id', type: 'number', help: 'Leave empty to let Shiprocket choose.' },
  ],
  hint: (credentials) => credentials.email,

  async verify(context) {
    const { data } = await providerFetch<{ token?: string; first_name?: string; company_id?: number }>({
      provider: 'shiprocket',
      url: `${API}/auth/login`,
      json: { email: context.credentials.email, password: context.credentials.password },
      errorMessage: commonErrorMessage,
    });
    if (!data.token) return { ok: false, message: 'Shiprocket did not accept this API user.' };
    return { ok: true, accountLabel: data.company_id ? `company ${data.company_id}` : null, mode: 'live' };
  },

  shipping: (context, carrierCode) => new ShiprocketCourier(context, carrierCode),

  inbound: {
    verify(request, context): InboundEvent[] {
      const expected = context.credentials.webhook_token;
      const presented = request.headers['x-api-key'] ?? '';
      if (!expected || !presented || !safeEqual(presented, expected)) throw new InboundSignatureError();

      const body = JSON.parse(request.rawBody.toString('utf8')) as Record<string, unknown>;
      const awb = String(body.awb ?? '');
      if (!awb) return [];
      const current = String(body.current_status ?? body.shipment_status ?? '');
      const at = String(body.current_timestamp ?? body.timestamp ?? '');
      return [
        {
          externalId: `${awb}:${current}:${at || crypto.createHash('sha256').update(request.rawBody).digest('hex').slice(0, 16)}`,
          type: 'shipment.status',
          providerType: current,
          data: {
            awb,
            status: mapShiprocketStatus(current),
            description: current,
            location: typeof body.location === 'string' ? body.location : null,
            at: at || new Date().toISOString(),
            etd: body.etd ?? null,
          },
        },
      ];
    },
  },
};
