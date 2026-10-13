/**
 * The seam between Veylor and whichever courier is actually carrying the parcel.
 *
 * Shiprocket, Blue Dart and Delhivery all do the same four things — take a
 * booking and give back a waybill, cancel it, tell you where the parcel is, and
 * arrange a reverse pickup — behind four incompatible APIs. Everything above
 * this file works in these terms, so adding a real vendor is one new class and a
 * row in `shipping_carriers`, not a change to the orders service.
 *
 * Deliberately narrow. Rate shopping, manifest generation and label PDFs are
 * vendor features we do not use yet, and an interface that promises them would
 * have to lie for every provider that cannot.
 */

export interface ShipmentAddress {
  name: string;
  phone: string | null;
  email: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
  country: string;
}

export interface ShipmentParcel {
  weightGrams: number;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

export interface CreateShipmentInput {
  /** Ours, not the carrier's — used as the client reference on their side. */
  reference: string;
  orderNumber: string;
  mode: 'surface' | 'air' | 'express';
  /** Rupees to collect on delivery; 0 for a prepaid parcel, never null. */
  codAmount: number;
  declaredValue: number;
  pickup: ShipmentAddress;
  delivery: ShipmentAddress;
  parcel: ShipmentParcel;
  items: { name: string; sku: string; quantity: number; unitPrice: number; hsnCode: string | null }[];
}

export interface CreateShipmentResult {
  awbNumber: string;
  /** The carrier's own id, kept so a later cancel or track can name it. */
  providerShipmentId: string;
  trackingUrl: string | null;
  estimatedDeliveryAt: Date | null;
  /** What the carrier says it will cost, when it says anything. */
  shippingCharge: number | null;
}

/** A carrier's own status vocabulary, mapped onto ours by the provider. */
export type CourierStatus =
  | 'created'
  | 'label_generated'
  | 'pickup_scheduled'
  | 'picked_up'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'ndr'
  | 'rto_initiated'
  | 'rto_in_transit'
  | 'rto_delivered'
  | 'lost'
  | 'damaged'
  | 'cancelled';

export interface TrackingEvent {
  status: CourierStatus;
  description: string;
  location: string | null;
  at: Date;
}

export interface TrackingResult {
  status: CourierStatus;
  events: TrackingEvent[];
  estimatedDeliveryAt: Date | null;
  deliveredAt: Date | null;
}

export interface ReversePickupInput {
  reference: string;
  /** The waybill of the forward shipment being sent back. */
  forwardAwb: string | null;
  pickup: ShipmentAddress;
  delivery: ShipmentAddress;
  parcel: ShipmentParcel;
}

export interface CourierProvider {
  /** Matches `shipping_carriers.api_provider`. */
  readonly code: string;
  /** False while a provider is a stand-in, so the UI can say so honestly. */
  readonly isLive: boolean;

  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  cancelShipment(providerShipmentId: string, awbNumber: string): Promise<void>;
  /**
   * `bookedAt` is when we created the shipment. Live carriers ignore it — they
   * know their own history — but a stand-in needs it, because a trail anchored
   * on anything else produces events dated before the parcel existed.
   */
  track(awbNumber: string, bookedAt?: Date): Promise<TrackingResult>;
  createReversePickup(input: ReversePickupInput): Promise<CreateShipmentResult>;
}

/**
 * Raised when a carrier refuses or is unreachable.
 *
 * Separate from ApiError on purpose: the service layer decides whether a courier
 * failure is a 502 the operator should retry or a 409 they should act on, and it
 * cannot decide that if the provider has already chosen a status code.
 */
export class CourierError extends Error {
  readonly provider: string;
  readonly retryable: boolean;

  constructor(provider: string, message: string, retryable = true) {
    super(message);
    this.name = 'CourierError';
    this.provider = provider;
    this.retryable = retryable;
  }
}
