/**
 * Tax on the platform's own bills — what the platform, as a seller of a
 * service, charges its merchants on top of the plan, fees and domains.
 *
 * Configured for where the platform itself is registered:
 *
 *   PLATFORM_TAX_COUNTRY=IN        the platform's country (empty: no tax, as before)
 *   PLATFORM_TAX_REGION=KA         its state, where the tax is split by state (India)
 *   PLATFORM_TAX_RATE=18           percent
 *   PLATFORM_TAX_NAME=GST          what the bill calls it
 *   PLATFORM_TAX_ID=29ABCDE1234F1Z5  printed on every bill
 *
 * A merchant in the same country pays it: in India as CGST + SGST (half each)
 * when their state is the platform's, IGST otherwise — the place of supply
 * of a B2B service is where the registered recipient is. A merchant in
 * another country buys an export of services: nothing is added, and the bill
 * says why. The merchant's tax ID and state come from Settings → Billing;
 * without a state, the store's own (its main stock location) is used.
 */

export interface PlatformTaxConfig {
  country: string | null;
  region: string | null;
  rate: number;
  name: string;
  taxId: string | null;
}

export interface TaxBuyer {
  country: string;
  region: string | null;
  taxId: string | null;
}

export interface PlatformTaxLine {
  name: string;
  rate: number;
  amount: number;
}

export interface PlatformTax {
  lines: PlatformTaxLine[];
  /** What the bill says about the tax — or its absence. */
  note: string | null;
}

export function platformTaxConfig(source: NodeJS.ProcessEnv = process.env): PlatformTaxConfig {
  const country = (source.PLATFORM_TAX_COUNTRY ?? '').trim().toUpperCase() || null;
  const rate = Number(source.PLATFORM_TAX_RATE ?? 0);
  return {
    country,
    region: (source.PLATFORM_TAX_REGION ?? '').trim().toUpperCase() || null,
    rate: Number.isFinite(rate) && rate > 0 ? rate : 0,
    name: (source.PLATFORM_TAX_NAME ?? '').trim() || (country === 'IN' ? 'GST' : 'VAT'),
    taxId: (source.PLATFORM_TAX_ID ?? '').trim() || null,
  };
}

function round(amount: number, currency: string): number {
  const digits = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX'].includes(currency.toUpperCase()) ? 0 : 2;
  const factor = 10 ** digits;
  return Math.round(amount * factor) / factor;
}

/** The tax on a bill of `amount` (before tax) to `buyer`. */
export function platformTax(config: PlatformTaxConfig, buyer: TaxBuyer, amount: number, currency: string): PlatformTax {
  if (!config.country || config.rate <= 0 || amount <= 0) return { lines: [], note: null };
  const buyerCountry = buyer.country.toUpperCase();
  if (buyerCountry !== config.country) {
    return { lines: [], note: `Export of services — no ${config.name} charged${buyer.taxId ? ` (your tax ID ${buyer.taxId})` : ''}.` };
  }
  const note = buyer.taxId ? `Your ${config.name} number: ${buyer.taxId}` : null;
  if (config.country === 'IN') {
    const sameState = Boolean(config.region && buyer.region && config.region === buyer.region.toUpperCase());
    if (sameState) {
      const half = config.rate / 2;
      const cgst = round((amount * half) / 100, currency);
      const sgst = round((amount * half) / 100, currency);
      return { lines: [{ name: `CGST ${half}%`, rate: half, amount: cgst }, { name: `SGST ${half}%`, rate: half, amount: sgst }], note };
    }
    return { lines: [{ name: `IGST ${config.rate}%`, rate: config.rate, amount: round((amount * config.rate) / 100, currency) }], note };
  }
  return { lines: [{ name: `${config.name} ${config.rate}%`, rate: config.rate, amount: round((amount * config.rate) / 100, currency) }], note };
}
