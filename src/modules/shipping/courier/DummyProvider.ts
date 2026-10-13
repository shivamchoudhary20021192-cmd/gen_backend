import { randomInt } from 'node:crypto';
import type {
  CourierProvider,
  CourierStatus,
  CreateShipmentInput,
  CreateShipmentResult,
  ReversePickupInput,
  TrackingEvent,
  TrackingResult,
} from './CourierProvider';
import { CourierError } from './CourierProvider';
import { isValidPostalCode } from '../../../platform/geo/postalCodes';

/**
 * A stand-in courier, until Shiprocket and Blue Dart are wired up.
 *
 * It behaves like a carrier rather than like a stub: waybills follow each
 * vendor's real format, delivery estimates respect the metro/non-metro split
 * Indian couriers actually quote, and tracking returns a plausible event trail
 * derived from how long the parcel has been in the system. That matters because
 * the screens above it are built against this shape — if the fake returns three
 * tidy events and the real one returns nineteen, the UI is wrong on the day the
 * real one lands.
 *
 * What it does NOT do is pretend to be live: `isLive` is false, and the admin
 * says so wherever a shipment shows tracking. A dummy that presented itself as
 * real is how someone ends up telling a customer their parcel is out for
 * delivery when nothing was ever booked.
 */

/** Metro pincode prefixes get the faster estimate, like every Indian courier. */
const METRO_PREFIXES = ['110', '400', '560', '600', '700', '500', '411', '380'];

function isMetro(pincode: string): boolean {
  return METRO_PREFIXES.some((prefix) => pincode.startsWith(prefix));
}

function digits(count: number): string {
  let out = '';
  for (let i = 0; i < count; i += 1) out += String(randomInt(0, 10));
  return out;
}

function addDays(from: Date, days: number): Date {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return date;
}

function hoursAgo(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * 3600_000);
}

export class DummyProvider implements CourierProvider {
  readonly code: string;
  readonly isLive = false;

  /** The carrier this is standing in for, so waybills look like theirs. */
  private readonly carrierCode: string;

  constructor(carrierCode = 'dummy') {
    this.carrierCode = carrierCode;
    this.code = 'dummy';
  }

  /** Blue Dart uses 11 digits, Delhivery 14, Shiprocket a longer numeric run. */
  private awb(): string {
    switch (this.carrierCode) {
      case 'bluedart':
        return digits(11);
      case 'delhivery':
        return digits(14);
      case 'shiprocket':
        return `SR${digits(12)}`;
      default:
        return `DUMMY${digits(10)}`;
    }
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    if (!isValidPostalCode(input.delivery.pincode, input.delivery.country)) {
      // A real carrier refuses a malformed pincode before it books, and the
      // caller needs to handle that path — so this one does too.
      throw new CourierError(this.code, `${input.delivery.pincode} is not a serviceable PIN code.`, false);
    }
    if (input.parcel.weightGrams <= 0) {
      throw new CourierError(this.code, 'A shipment needs a weight before it can be booked.', false);
    }

    const days = isMetro(input.delivery.pincode) ? 3 : 6;
    const base = input.mode === 'express' ? 149 : input.mode === 'air' ? 119 : 79;
    // Couriers price in 500 g slabs, so the second slab costs the same as the
    // first plus a bit — worth modelling, because it is what makes shipping
    // cost look right on the shipments list.
    const slabs = Math.max(1, Math.ceil(input.parcel.weightGrams / 500));
    const codSurcharge = input.codAmount > 0 ? 35 : 0;

    return {
      awbNumber: this.awb(),
      providerShipmentId: `dummy_${Date.now()}_${digits(4)}`,
      trackingUrl: null, // filled from the carrier's template by the service
      estimatedDeliveryAt: addDays(new Date(), days),
      shippingCharge: base + (slabs - 1) * 30 + codSurcharge,
    };
  }

  async cancelShipment(providerShipmentId: string, awbNumber: string): Promise<void> {
    if (!providerShipmentId && !awbNumber) {
      throw new CourierError(this.code, 'Nothing to cancel — this shipment has no waybill.', false);
    }
    // A real provider would refuse once the parcel is picked up; the service
    // enforces that from our own status before it ever calls this.
  }

  /**
   * A tracking trail derived from how long ago the parcel shipped.
   *
   * Deterministic rather than random, so a screen refreshed twice does not tell
   * the operator two different stories about the same parcel.
   */
  async track(awbNumber: string, bookedAt?: Date): Promise<TrackingResult> {
    if (!awbNumber) throw new CourierError(this.code, 'No waybill to track.', false);

    // Anchored on when the shipment was actually booked. Deriving it from the
    // waybill instead produced a trail that started before the parcel existed,
    // which reads as corrupt data rather than as a parcel in transit.
    const shippedAt = bookedAt ?? new Date();
    const elapsedHours = Math.max(0, (Date.now() - shippedAt.getTime()) / 3600_000);

    const trail: { at: number; status: CourierStatus; description: string; location: string | null }[] = [
      { at: 0, status: 'created', description: 'Shipment booked', location: 'Solan, HP' },
      { at: 2, status: 'label_generated', description: 'Waybill generated', location: 'Solan, HP' },
      { at: 6, status: 'picked_up', description: 'Picked up from seller', location: 'Solan, HP' },
      { at: 14, status: 'in_transit', description: 'In transit to destination hub', location: 'Chandigarh, PB' },
      { at: 38, status: 'in_transit', description: 'Arrived at destination hub', location: 'Bengaluru, KA' },
      { at: 54, status: 'out_for_delivery', description: 'Out for delivery', location: 'Bengaluru, KA' },
      { at: 62, status: 'delivered', description: 'Delivered', location: 'Bengaluru, KA' },
    ];

    const events: TrackingEvent[] = trail
      .filter((step) => step.at <= elapsedHours)
      .map((step) => ({
        status: step.status,
        description: step.description,
        location: step.location,
        at: hoursAgo(shippedAt, step.at),
      }));

    if (events.length === 0) {
      events.push({ status: 'created', description: 'Shipment booked', location: null, at: shippedAt });
    }

    const latest = events[events.length - 1];
    return {
      status: latest.status,
      events,
      estimatedDeliveryAt: addDays(shippedAt, 3),
      deliveredAt: latest.status === 'delivered' ? latest.at : null,
    };
  }

  async createReversePickup(input: ReversePickupInput): Promise<CreateShipmentResult> {
    if (!isValidPostalCode(input.pickup.pincode, input.pickup.country)) {
      throw new CourierError(this.code, `${input.pickup.pincode} is not serviceable for reverse pickup.`, false);
    }
    return {
      awbNumber: this.awb(),
      providerShipmentId: `dummy_rev_${Date.now()}_${digits(4)}`,
      trackingUrl: null,
      estimatedDeliveryAt: addDays(new Date(), 7),
      shippingCharge: 89,
    };
  }
}
