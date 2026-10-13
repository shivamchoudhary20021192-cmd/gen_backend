import { logger } from '../../core/logger';
import { ShopScopedCache } from '../../platform/cache/shopCache';
import { shopId, tenancy } from '../../platform/tenancy/context';
import { shipmentsRepository } from '../shipments/shipments.repository';
import { resolveCourier, type RateQuote } from './courier';

/**
 * Live prices from a courier, for carrier-calculated rate rows.
 *
 * Checkout must never wait long on, or fail because of, somebody else's API.
 * So a quote is asked for at most once per basket shape and address every ten
 * minutes (which also keeps the price on the cart and at checkout the same),
 * the standard and express rows share one call, the caller stops waiting after
 * a few seconds and charges the row's flat fallback instead, and a carrier that
 * just failed is left alone for half a minute. A quote that arrives after the
 * caller gave up is still cached for the next request.
 */

const QUOTE_TTL_MS = 10 * 60_000;
const FAILURE_BACKOFF_MS = 30_000;
const timeoutMs = () => Number(process.env.SHIPPING_QUOTE_TIMEOUT_MS ?? 3_000);

const quotes = new ShopScopedCache<RateQuote[] | null>(QUOTE_TTL_MS);
const recentFailures = new Map<string, number>();

export interface CarrierParcel {
  destination: { postalCode: string; country: string; region: string | null };
  weightGrams: number;
  declaredValue: number;
}

export interface CarrierMarkup {
  carrier_markup_percent: string | number | null;
  carrier_markup_amount: string | number | null;
}

/** The value, or null if it takes longer than `ms` (or fails). Exported for tests. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Every service the carrier offers for this parcel, or null when it cannot
 * say: no such carrier, no pickup location to quote from, a provider that
 * does not quote, an error, or no answer in time. Null means "use the
 * fallback", never "not deliverable".
 */
export async function carrierQuotes(carrierId: number, parcel: CarrierParcel): Promise<RateQuote[] | null> {
  const carrier = await shipmentsRepository.findCarrier(carrierId);
  if (!carrier || carrier.is_active !== 1) return null;
  const origin = await shipmentsRepository.defaultLocation();
  if (!origin?.pincode) return null;

  const failureKey = `${shopId()}:${carrierId}`;
  if ((recentFailures.get(failureKey) ?? 0) > Date.now()) return null;

  const key = [
    carrierId,
    origin.pincode,
    parcel.destination.country,
    parcel.destination.postalCode,
    parcel.weightGrams,
    Math.round(parcel.declaredValue),
  ].join('|');

  const currency = tenancy.current().currency;
  const pending = quotes.get(key, async () => {
    try {
      const provider = await resolveCourier({ code: carrier.code, api_provider: carrier.api_provider });
      if (!provider.quoteRates) return null;
      const offered = await provider.quoteRates({
        origin: { postalCode: origin.pincode!, country: (origin.country ?? 'IN').toUpperCase() },
        destination: parcel.destination,
        weightGrams: parcel.weightGrams,
        declaredValue: parcel.declaredValue,
        cod: false,
      });
      return offered.filter((quote) => quote.currency.toUpperCase() === currency.toUpperCase());
    } catch (error) {
      recentFailures.set(failureKey, Date.now() + FAILURE_BACKOFF_MS);
      logger.warn('shipping.carrier_quote_failed', {
        carrier: carrier.code,
        provider: carrier.api_provider,
        error: error instanceof Error ? error.message : String(error),
      });
      // Thrown so the cache does not keep the failure for ten minutes.
      throw error;
    }
  });
  return within(pending, timeoutMs());
}

/**
 * The quote a rate row's method should charge: the cheapest surface service
 * for standard delivery (any service, when the carrier only flies), the
 * cheapest express or air service for express. Null when nothing fits —
 * an express row on a carrier that only does surface uses its fallback.
 */
export function pickQuote(offered: RateQuote[], method: 'standard' | 'express'): RateQuote | null {
  const fits = offered.filter((quote) => (method === 'express' ? quote.mode === 'express' || quote.mode === 'air' : quote.mode === 'surface'));
  const candidates = fits.length > 0 ? fits : method === 'standard' ? offered : [];
  let best: RateQuote | null = null;
  for (const quote of candidates) if (!best || quote.amount < best.amount) best = quote;
  return best;
}

/** The carrier's price with the row's markup: a percentage first, then a fixed amount. */
export function withMarkup(amount: number, row: CarrierMarkup): number {
  const percent = Number(row.carrier_markup_percent ?? 0) || 0;
  const fixed = Number(row.carrier_markup_amount ?? 0) || 0;
  return Math.max(0, amount * (1 + percent / 100) + fixed);
}

export const carrierRates = {
  /** Forgets cached quotes and back-offs (after a carrier or rate changes). */
  invalidate(): void {
    quotes.clear();
    const prefix = `${shopId()}:`;
    for (const key of recentFailures.keys()) if (key.startsWith(prefix)) recentFailures.delete(key);
  },
};
