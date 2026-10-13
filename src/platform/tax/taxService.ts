import { logger } from '../../core/logger';
import { query, queryOne, type RowDataPacket } from '../../db/pool';
import { ShopScopedCache } from '../cache/shopCache';
import { connectionsService } from '../integrations/connections.service';
import { roundMoney } from '../money/currency';
import { shopId, tenancy } from '../tenancy/context';
import { computeTax, type TaxedLine, type TaxResult } from './taxEngine';
import type { NamedTax, TaxAddress } from './TaxCalculator';

/**
 * Tax for a basket, by the shop's regime.
 *
 *   - **Class-rate regimes** (GST, VAT): each product's own rate, wherever it
 *     is delivered — `computeTax`, with the named lines (CGST 9%, VAT 20%)
 *     added for receipts.
 *   - **Destination regimes** (US sales tax, Canadian GST/HST/PST): the rate
 *     of the delivery address, and only where the shop is registered to
 *     collect. A connected tax service (TaxJar) answers if there is one;
 *     otherwise the shop's own registrations do, the most specific first
 *     (California over the United States). An exempt product is not taxed;
 *     delivery is taxed where the registration says so.
 *
 * A tax service that fails does not stop checkout: the registrations answer
 * instead, and the fallback is logged.
 */

export const DESTINATION_ENGINES: ReadonlySet<string> = new Set(['us_sales_tax', 'ca_gst']);

export interface TaxQuoteLine {
  id: string;
  /** What the line sells for after discounts, quantity included. */
  amount: number;
  quantity: number;
  unitPrice: number;
  discount: number;
  /** The class rate (class-rate regimes only). */
  rate: number;
  inclusive: boolean;
  exempt: boolean;
}

export interface TaxQuote extends TaxResult {
  shippingTax: number;
  taxLines: NamedTax[];
  /** Who decided: 'classes', 'registrations', or the tax service's name. */
  source: string;
  /** A destination regime with no address yet: tax is worked out at checkout. */
  needsAddress: boolean;
}

interface RegistrationRow extends RowDataPacket {
  id: number;
  country_code: string;
  region_code: string | null;
  name: string;
  rate: string;
  shipping_taxable: number;
}

interface OriginRow extends RowDataPacket {
  line1: string | null;
  city: string | null;
  state_code: string | null;
  pincode: string | null;
  country: string | null;
}

const registrationsCache = new ShopScopedCache<RegistrationRow[]>(60_000);
const originCache = new ShopScopedCache<TaxAddress>(300_000);

async function registrations(): Promise<RegistrationRow[]> {
  return registrationsCache.get('registrations', () =>
    query<RegistrationRow>(
      'SELECT id, country_code, region_code, name, rate, shipping_taxable FROM tax_registrations WHERE shop_id = ? AND is_active = 1',
      [shopId()],
    ),
  );
}

/** Where the shop ships from: its default fulfilment location. */
export async function shopOrigin(): Promise<TaxAddress> {
  return originCache.get('origin', async () => {
    const row = await queryOne<OriginRow>(
      `SELECT line1, city, state_code, pincode, country FROM inventory_locations
        WHERE shop_id = ? AND is_active = 1 ORDER BY is_default DESC, priority, id LIMIT 1`,
      [shopId()],
    );
    return {
      country: (row?.country ?? tenancy.current().countryCode).toUpperCase().slice(0, 2),
      region: row?.state_code ?? null,
      postalCode: row?.pincode ?? null,
      city: row?.city ?? null,
      line1: row?.line1 ?? null,
    };
  });
}

/** The registration that applies to an address: region first, then the whole country. */
export function registrationFor<T extends { country_code: string; region_code: string | null }>(rows: T[], country: string, region: string | null): T | null {
  const upperCountry = country.toUpperCase();
  const upperRegion = region?.toUpperCase() ?? null;
  return (
    rows.find((row) => row.country_code === upperCountry && upperRegion !== null && row.region_code?.toUpperCase() === upperRegion) ??
    rows.find((row) => row.country_code === upperCountry && row.region_code === null) ??
    null
  );
}

/**
 * Delivery under VAT and GST is taxed like the goods it carries: at their
 * rate, or — when the order mixes rates — split across them in proportion to
 * what each rate's goods cost. Exempt goods take their share untaxed. Each
 * share follows its goods' "prices include tax" setting, so where prices
 * include tax the delivery charge does too and the total does not move.
 */
export function apportionShipping(shipping: number, lines: Pick<TaxQuoteLine, 'amount' | 'rate' | 'inclusive' | 'exempt'>[], currency: string): { amount: number; rate: number; inclusive: boolean }[] {
  const base = lines.reduce((sum, line) => sum + Math.max(0, line.amount), 0);
  if (shipping <= 0 || base <= 0) return [];
  const groups = new Map<string, { rate: number; inclusive: boolean; amount: number }>();
  for (const line of lines) {
    if (line.amount <= 0) continue;
    const rate = line.exempt ? 0 : Math.max(0, line.rate);
    const key = `${rate}|${line.inclusive}`;
    const group = groups.get(key) ?? { rate, inclusive: line.inclusive, amount: 0 };
    group.amount += line.amount;
    groups.set(key, group);
  }
  const shares = [...groups.values()].sort((a, b) => b.amount - a.amount);
  const out: { amount: number; rate: number; inclusive: boolean }[] = [];
  let given = 0;
  shares.forEach((share, index) => {
    // The last share takes the rounding remainder, so the parts add up to the charge.
    const amount = index === shares.length - 1 ? roundMoney(shipping - given, currency) : roundMoney((shipping * share.amount) / base, currency);
    given += amount;
    if (amount > 0 && share.rate > 0) out.push({ amount, rate: share.rate, inclusive: share.inclusive });
  });
  return out;
}

function classRateNames(engine: string, result: TaxResult, lines: { rate: number }[], currency: string): NamedTax[] {
  const round = (value: number) => roundMoney(value, currency);
  const byRate = new Map<number, { tax: number; cgst: number; sgst: number; igst: number }>();
  result.lines.forEach((line, index) => {
    if (line.tax <= 0) return;
    const rate = lines[index].rate;
    const entry = byRate.get(rate) ?? { tax: 0, cgst: 0, sgst: 0, igst: 0 };
    entry.tax += line.tax;
    entry.cgst += line.cgst;
    entry.sgst += line.sgst;
    entry.igst += line.igst;
    byRate.set(rate, entry);
  });
  const label = engine === 'in_gst' || engine.endsWith('_gst') ? 'GST' : engine === 'manual' ? 'Tax' : 'VAT';
  const named: NamedTax[] = [];
  for (const [rate, entry] of [...byRate.entries()].sort((a, b) => b[0] - a[0])) {
    if (engine === 'in_gst') {
      if (entry.igst > 0) named.push({ name: `IGST ${rate}%`, rate, amount: round(entry.igst) });
      if (entry.cgst > 0) named.push({ name: `CGST ${rate / 2}%`, rate: rate / 2, amount: round(entry.cgst) });
      if (entry.sgst > 0) named.push({ name: `SGST ${rate / 2}%`, rate: rate / 2, amount: round(entry.sgst) });
    } else {
      named.push({ name: `${label} ${rate}%`, rate, amount: round(entry.tax) });
    }
  }
  return named;
}

function zeroResult(lines: TaxQuoteLine[], destinationRegion: string | null): TaxResult {
  return {
    lines: lines.map((line) => ({ taxable: line.amount, tax: 0, rate: 0, cgst: 0, sgst: 0, igst: 0 })),
    taxable: lines.reduce((sum, line) => sum + line.amount, 0),
    tax: 0,
    cgst: 0,
    sgst: 0,
    igst: 0,
    addedToTotal: 0,
    placeOfSupply: destinationRegion,
    interstate: false,
  };
}

function assemble(
  lines: TaxedLine[],
  shippingTax: number,
  taxLines: NamedTax[],
  destinationRegion: string | null,
  currency: string,
  source: string,
): TaxQuote {
  const round = (value: number) => roundMoney(value, currency);
  const lineTax = round(lines.reduce((sum, line) => sum + line.tax, 0));
  const tax = round(lineTax + shippingTax);
  return {
    lines,
    taxable: round(lines.reduce((sum, line) => sum + line.taxable, 0)),
    tax,
    cgst: 0,
    sgst: 0,
    igst: 0,
    // Destination regimes quote prices before tax: all of it is added.
    addedToTotal: tax,
    placeOfSupply: destinationRegion,
    interstate: false,
    shippingTax,
    taxLines,
    source,
    needsAddress: false,
  };
}

export const taxService = {
  async quote(input: {
    lines: TaxQuoteLine[];
    shipping: number;
    /** Null until the shopper has given an address. */
    destination: TaxAddress | null;
    /** Region the shop ships from, for place-of-supply rules. */
    originRegion: string | null;
    /** The basket's currency, when it is not the store's (another market). */
    currency?: string;
    /**
     * Delivered outside the store's country: an export, which no domestic
     * sales tax, GST or VAT applies to. Import duties and taxes, if any, are
     * the buyer's to pay on delivery.
     */
    exportSale?: boolean;
  }): Promise<TaxQuote> {
    const shop = tenancy.current();
    const currency = input.currency ?? shop.currency;
    const round = (value: number) => roundMoney(value, currency);
    const destinationRegion = input.destination?.region?.toUpperCase() ?? null;

    if (input.exportSale) {
      return { ...zeroResult(input.lines, destinationRegion), shippingTax: 0, taxLines: [], source: 'export', needsAddress: false };
    }

    if (!DESTINATION_ENGINES.has(shop.taxEngine)) {
      const goods = input.lines.map((line) => ({ amount: line.amount, rate: line.exempt ? 0 : line.rate, inclusive: line.inclusive }));
      // Delivery joins the calculation as extra lines, so it is split into
      // CGST/SGST or IGST (and named) exactly like the goods.
      const delivery = shop.taxShipping === false ? [] : apportionShipping(input.shipping, input.lines, currency);
      const all = computeTax([...goods, ...delivery], { engine: shop.taxEngine, currency, origin: input.originRegion, destination: destinationRegion });
      const shippingTax = round(all.lines.slice(goods.length).reduce((sum, line) => sum + line.tax, 0));
      return {
        ...all,
        // One taxed line per item, as callers index them; delivery is reported on its own.
        lines: all.lines.slice(0, goods.length),
        shippingTax,
        taxLines: classRateNames(shop.taxEngine, all, [...goods, ...delivery], currency),
        source: 'classes',
        needsAddress: false,
      };
    }

    if (!input.destination || (!input.destination.region && !input.destination.postalCode)) {
      return { ...zeroResult(input.lines, destinationRegion), shippingTax: 0, taxLines: [], source: 'pending', needsAddress: true };
    }

    // A connected tax service first.
    const connected = await connectionsService.resolveDefault('tax').catch(() => null);
    const calculator = connected?.manifest.tax?.(connected.context);
    if (calculator) {
      try {
        const calculated = await calculator.calculate({
          from: await shopOrigin(),
          to: input.destination,
          currency,
          lines: input.lines.map((line) => ({
            id: line.id,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discount: line.discount,
            exempt: line.exempt,
            productTaxCode: null,
          })),
          shipping: input.shipping,
        });
        void connectionsService.recordUse(connected!.row.id, null);
        const lines: TaxedLine[] = input.lines.map((line, index) => {
          const found = calculated.lines[index];
          return { taxable: found?.taxable ?? line.amount, tax: found?.tax ?? 0, rate: found?.rate ?? 0, cgst: 0, sgst: 0, igst: 0 };
        });
        return assemble(lines, round(calculated.shippingTax), calculated.taxLines, destinationRegion, currency, calculator.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void connectionsService.recordUse(connected!.row.id, message.slice(0, 500));
        logger.warn('tax.provider_failed_using_registrations', { provider: calculator.name, error: message });
      }
    }

    // The shop's own registrations.
    const registered = await registrations();
    if (!input.destination.region && registered.some((row) => row.region_code !== null)) {
      // A postcode alone does not say which state's rate applies: shown as
      // "calculated at checkout" until the address is complete.
      return { ...zeroResult(input.lines, null), shippingTax: 0, taxLines: [], source: 'pending', needsAddress: true };
    }
    const registration = registrationFor(registered, input.destination.country, input.destination.region);
    if (!registration) {
      // Not registered there: nothing to collect.
      return assemble(zeroResult(input.lines, destinationRegion).lines, 0, [], destinationRegion, currency, 'registrations');
    }
    const rate = Number(registration.rate);
    const lines: TaxedLine[] = input.lines.map((line) => {
      if (line.exempt || rate <= 0) return { taxable: line.amount, tax: 0, rate: 0, cgst: 0, sgst: 0, igst: 0 };
      const taxable = line.inclusive ? round(line.amount / (1 + rate / 100)) : line.amount;
      const tax = line.inclusive ? round(line.amount - taxable) : round((line.amount * rate) / 100);
      return { taxable, tax, rate, cgst: 0, sgst: 0, igst: 0 };
    });
    const shippingTax = registration.shipping_taxable === 1 ? round((input.shipping * rate) / 100) : 0;
    const quote = assemble(lines, shippingTax, [], destinationRegion, currency, 'registrations');
    // An inclusive line's tax is already in its price.
    quote.addedToTotal = round(
      lines.reduce((sum, line, index) => sum + (input.lines[index].inclusive ? 0 : line.tax), 0) + shippingTax,
    );
    quote.taxLines = quote.tax > 0 ? [{ name: registration.name, rate, amount: quote.tax }] : [];
    return quote;
  },

  invalidate(): void {
    registrationsCache.clear();
    originCache.clear();
  },
};
