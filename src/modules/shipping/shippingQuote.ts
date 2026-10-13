import { query, queryOne, type RowDataPacket } from '../../db/pool';
import { ShopScopedCache } from '../../platform/cache/shopCache';
import { shopPricing } from '../../platform/commerce/shopPricing';
import { roundMoney } from '../../platform/money/currency';
import { shopId, tenancy } from '../../platform/tenancy/context';

/**
 * What delivery costs for this basket, to this address, by each method the
 * shop offers.
 *
 * A shop's `shipping_rates` rows are its rate table: a method (standard,
 * express, pickup), a zone (everywhere, or a zone postcodes are mapped into),
 * an order-value band, a weight band, a price, and an optional "free above".
 * For each method the most specific matching row wins — a zone row over an
 * everywhere row, then the lower priority number — so a shop can say
 * "standard ₹49 in the metro zone, ₹99 elsewhere, free over ₹499" without code.
 *
 * Zones (`shipping_zones`) are named sets of states and postcode prefixes; an
 * address in a zone is offered that zone's rates and no others. The older
 * `pincode_serviceability` table (postcode → named zone, and whether the area
 * is served at all, takes COD, gets express) still refines Indian stores; a
 * postcode it does not list is served on the everywhere rates.
 *
 * A shop with no rate rows at all falls back to its flat standard cost setting,
 * which is what the single-shop checkout charged.
 */

export type ShippingMethod = 'standard' | 'express' | 'pickup';

export interface ShippingOption {
  method: ShippingMethod;
  name: string;
  price: number;
  /** What it would cost without the free-above threshold. */
  basePrice: number;
  freeAbove: number | null;
  etaMinDays: number;
  etaMaxDays: number;
}

export interface ShippingQuote {
  deliverable: boolean;
  /**
   * The shop only has rates for particular zones, and no postcode has been
   * given yet: delivery is "calculated at checkout", not refused.
   */
  needsAddress: boolean;
  reason: string | null;
  zone: string | null;
  options: ShippingOption[];
  codAvailable: boolean;
}

interface RateRow extends RowDataPacket {
  id: number;
  name: string;
  zone: string;
  zone_id: number | null;
  method: ShippingMethod;
  min_order_amount: string;
  max_order_amount: string | null;
  min_weight_grams: number;
  max_weight_grams: number | null;
  rate: string;
  free_above_amount: string | null;
  eta_min_days: number;
  eta_max_days: number;
  priority: number;
}

interface AreaRow extends RowDataPacket {
  zone: string;
  is_serviceable: number;
  cod_available: number;
  prepaid_available: number;
  express_available: number;
  standard_eta_min_days: number;
  standard_eta_max_days: number;
  express_eta_days: number | null;
}

const ratesCache = new ShopScopedCache<RateRow[]>(60_000);
const METHODS: ShippingMethod[] = ['standard', 'express', 'pickup'];

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function rates(): Promise<RateRow[]> {
  return ratesCache.get('rates', () =>
    query<RateRow>('SELECT * FROM shipping_rates WHERE shop_id = ? AND is_active = 1 ORDER BY priority, id', [shopId()]),
  );
}

/**
 * A postcode as prefixes are compared: upper-case, spaces collapsed but kept.
 * Kept because the space carries meaning in UK postcodes: "PA2 1AB" is not in
 * district PA21, though with the space removed it would start with "PA21".
 */
export function normalisePostal(value: string | null | undefined): string | null {
  const normalised = (value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  return normalised || null;
}

export interface ZoneArea {
  zone_id: number;
  zone_name: string;
  country_code: string;
  region_code: string | null;
  postal_prefix: string | null;
}

/**
 * The zone an address belongs to: the most specific area that covers it. A
 * postcode prefix beats a state, a longer prefix beats a shorter one, and a
 * prefix inside a named state beats the prefix alone. Null: no zone — the
 * store's everywhere rates apply.
 */
export function zoneFor(areas: ZoneArea[], destination: { country: string; region: string | null; postalCode: string | null }): ZoneArea | null {
  const country = destination.country.toUpperCase();
  const region = destination.region?.toUpperCase() ?? null;
  const postal = normalisePostal(destination.postalCode);
  let best: ZoneArea | null = null;
  let bestScore = -1;
  for (const area of areas) {
    if (area.country_code.toUpperCase() !== country) continue;
    if (area.region_code && area.region_code.toUpperCase() !== region) continue;
    if (area.postal_prefix && !(postal && postal.startsWith(area.postal_prefix.toUpperCase()))) continue;
    const score = (area.postal_prefix ? 100 + area.postal_prefix.length : 0) + (area.region_code ? 10 : 0) + 1;
    if (score > bestScore) {
      best = area;
      bestScore = score;
    }
  }
  return best;
}

const zonesCache = new ShopScopedCache<ZoneArea[]>(60_000);

async function zoneAreas(): Promise<ZoneArea[]> {
  return zonesCache.get('zones', () =>
    query<ZoneArea & RowDataPacket>(
      `SELECT a.zone_id, z.name AS zone_name, a.country_code, a.region_code, a.postal_prefix
         FROM shipping_zone_areas a
         JOIN shipping_zones z ON z.id = a.zone_id AND z.shop_id = a.shop_id AND z.is_active = 1
        WHERE a.shop_id = ?`,
      [shopId()],
    ),
  );
}

export const shippingQuote = {
  async quote(input: { subtotal: number; weightGrams: number; postalCode?: string | null; region?: string | null; country?: string | null }): Promise<ShippingQuote> {
    const shop = tenancy.current();
    const currency = shop.currency;
    const round = (value: number) => roundMoney(value, currency);
    const country = (input.country ?? shop.countryCode).toUpperCase();
    const abroad = country !== shop.countryCode;

    // The PIN-code table describes the store's own country only.
    const area = input.postalCode && !abroad
      ? await queryOne<AreaRow>(
          `SELECT zone, is_serviceable, cod_available, prepaid_available, express_available,
                  standard_eta_min_days, standard_eta_max_days, express_eta_days
             FROM pincode_serviceability WHERE shop_id = ? AND pincode = ? LIMIT 1`,
          [shopId(), input.postalCode.trim().toUpperCase()],
        )
      : null;

    if (area && area.is_serviceable !== 1) {
      return { deliverable: false, needsAddress: false, reason: 'We do not deliver to this postcode yet.', zone: area.zone, options: [], codAvailable: false };
    }

    const zone = zoneFor(await zoneAreas(), { country, region: input.region ?? null, postalCode: input.postalCode ?? null });
    const table = await rates();
    const options: ShippingOption[] = [];

    // Abroad, only a zone drawn for that country ships: the everywhere rates
    // (and the flat fallback) are the store's own country's.
    if (abroad && !zone) {
      return { deliverable: false, needsAddress: false, reason: 'We do not ship to this country yet.', zone: null, options: [], codAvailable: false };
    }

    if (table.length === 0) {
      // No rate table: the shop's flat standard delivery.
      const pricing = await shopPricing.get();
      const free = pricing.shipping.freeAbove !== null && input.subtotal >= pricing.shipping.freeAbove;
      options.push({
        method: 'standard',
        name: 'Standard delivery',
        price: free ? 0 : round(pricing.shipping.rate),
        basePrice: round(pricing.shipping.rate),
        freeAbove: pricing.shipping.freeAbove,
        etaMinDays: area?.standard_eta_min_days ?? 3,
        etaMaxDays: area?.standard_eta_max_days ?? 7,
      });
    } else {
      // In a zone, the zone's rates are the whole offer. Outside every zone,
      // the everywhere rates — and, for PIN-code stores, a named zone's rate
      // over the everywhere one.
      const applicable = zone
        ? table.filter((row) => row.zone_id !== null && Number(row.zone_id) === zone.zone_id)
        : table.filter((row) => row.zone_id === null && (row.zone === 'all' || (area !== null && row.zone === area.zone)));
      for (const method of METHODS) {
        if (method === 'express' && area && area.express_available !== 1) continue;
        const matching = applicable
          .filter((row) => row.method === method)
          .filter((row) => input.subtotal >= num(row.min_order_amount))
          .filter((row) => row.max_order_amount === null || input.subtotal <= num(row.max_order_amount))
          .filter((row) => input.weightGrams >= num(row.min_weight_grams))
          .filter((row) => row.max_weight_grams === null || input.weightGrams <= num(row.max_weight_grams))
          // A rate for the address's own named zone beats an everywhere rate.
          .sort((a, b) => Number(a.zone === 'all') - Number(b.zone === 'all') || a.priority - b.priority || a.id - b.id);
        const rate = matching[0];
        if (!rate) continue;
        const freeAbove = rate.free_above_amount === null ? null : num(rate.free_above_amount);
        const base = round(num(rate.rate));
        options.push({
          method,
          name: rate.name,
          price: freeAbove !== null && input.subtotal >= freeAbove ? 0 : base,
          basePrice: base,
          freeAbove,
          etaMinDays:
            method === 'standard' && area ? area.standard_eta_min_days : method === 'express' && area?.express_eta_days ? area.express_eta_days : rate.eta_min_days,
          etaMaxDays:
            method === 'standard' && area ? area.standard_eta_max_days : method === 'express' && area?.express_eta_days ? area.express_eta_days : rate.eta_max_days,
        });
      }
    }

    const zoneName = zone?.zone_name ?? area?.zone ?? null;
    if (options.length === 0 && !input.postalCode && !input.region && table.some((row) => row.zone !== 'all' || row.zone_id !== null)) {
      return { deliverable: true, needsAddress: true, reason: 'Enter a postcode to see delivery options.', zone: null, options, codAvailable: true };
    }
    if (options.length === 0) {
      return {
        deliverable: false,
        needsAddress: false,
        reason: zone && !table.some((row) => row.zone_id !== null && Number(row.zone_id) === zone.zone_id)
          ? 'We do not deliver to this area.'
          : 'No delivery option covers this order. It may be too heavy or too large for our rates.',
        zone: zoneName,
        options,
        codAvailable: false,
      };
    }

    return { deliverable: true, needsAddress: false, reason: null, zone: zoneName, options, codAvailable: abroad ? false : area ? area.cod_available === 1 : true };
  },

  invalidate(): void {
    ratesCache.clear();
    zonesCache.clear();
  },
};
