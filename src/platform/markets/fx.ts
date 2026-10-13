import { logger } from '../../core/logger';
import { controlPlane, execute, query, type RowDataPacket } from '../../db/pool';
import { providerFetch } from '../integrations/http';
import { defineJob } from '../jobs/registry';
import { minorUnitDigits, roundMoney } from '../money/currency';

/**
 * Exchange rates and presentment prices.
 *
 * Rates are stored as units of each currency per US dollar, refreshed from
 * the European Central Bank's daily reference rates (about thirty currencies)
 * and settable by an operator for the rest. A rate an operator set is theirs:
 * the refresh never overwrites it. Nothing here invents a rate — a currency
 * with none cannot be sold in until one exists.
 */

export type Rounding = 'none' | 'whole' | 'ninety_nine';

export class MissingRateError extends Error {
  constructor(readonly currency: string) {
    super(`No exchange rate for ${currency} yet.`);
    this.name = 'MissingRateError';
  }
}

const TTL_MS = 10 * 60_000;
let cached: { at: number; rates: Map<string, number> } | null = null;

async function rates(): Promise<Map<string, number>> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.rates;
  const rows = await query<RowDataPacket & { currency: string; per_usd: string }>('SELECT currency, per_usd FROM exchange_rates', [], controlPlane);
  cached = { at: Date.now(), rates: new Map(rows.map((row) => [row.currency, Number(row.per_usd)])) };
  return cached.rates;
}

/** Units of `to` for one unit of `from`. */
export async function exchangeRate(from: string, to: string): Promise<number> {
  if (from === to) return 1;
  const table = await rates();
  const fromRate = table.get(from);
  const toRate = table.get(to);
  if (!fromRate) throw new MissingRateError(from);
  if (!toRate) throw new MissingRateError(to);
  return toRate / fromRate;
}

export async function hasRate(currency: string): Promise<boolean> {
  return (await rates()).has(currency.toUpperCase());
}

/**
 * A store price in a market: converted, adjusted, then rounded by the
 * market's rule — up to a whole unit, or up to .99 — so a converted price
 * reads like a price someone chose.
 */
export function presentmentPrice(amount: number, market: { rate: number; currency: string; adjustmentPercent: number; rounding: Rounding }): number {
  const raw = amount * market.rate * (1 + market.adjustmentPercent / 100);
  const value = roundMoney(raw, market.currency);
  if (value <= 0 || market.rounding === 'none') return value;
  const whole = Math.ceil(value - 1e-9);
  if (market.rounding === 'whole' || minorUnitDigits(market.currency) === 0) return whole;
  return roundMoney(Math.floor(value + 1e-9) + 0.99, market.currency);
}

/**
 * The store-currency price behind a price a shopper typed in their market's
 * currency — a "from ₹500 to ₹2,000" filter for a shopper paying in dollars.
 * The inverse of presentmentPrice without its rounding, so a band's edges are
 * right to within the market's rounding step.
 */
export function storeAmount(presented: number, market: { rate: number; adjustmentPercent: number }): number {
  const factor = market.rate * (1 + market.adjustmentPercent / 100);
  return factor > 0 ? presented / factor : presented;
}

/** A converted amount with no rounding rule: delivery, discounts, thresholds. */
export function convertAmount(amount: number, rate: number, currency: string): number {
  return roundMoney(amount * rate, currency);
}

/**
 * The ECB's daily XML, as units of each currency per euro:
 * `<Cube currency='USD' rate='1.0876'/>`.
 */
export function parseEcbRates(xml: string): Map<string, number> {
  const perEur = new Map<string, number>([['EUR', 1]]);
  for (const match of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    const rate = Number(match[2]);
    if (Number.isFinite(rate) && rate > 0) perEur.set(match[1], rate);
  }
  return perEur;
}

/** Rebases rates per euro onto the dollar. */
export function perUsdFromPerEur(perEur: Map<string, number>): Map<string, number> {
  const usd = perEur.get('USD');
  if (!usd) throw new Error('The ECB rates carry no US dollar rate.');
  return new Map([...perEur.entries()].map(([currency, rate]) => [currency, rate / usd]));
}

const ECB_DAILY = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

export const fx = {
  async refreshFromEcb(): Promise<number> {
    const { data } = await providerFetch<string>({ provider: 'ecb', url: ECB_DAILY, headers: { Accept: 'application/xml' }, timeoutMs: 15_000 });
    const perUsd = perUsdFromPerEur(parseEcbRates(String(data)));
    let updated = 0;
    for (const [currency, rate] of perUsd) {
      const result = await execute(
        `INSERT INTO exchange_rates (currency, per_usd, source) VALUES (?, ?, 'ecb')
         ON DUPLICATE KEY UPDATE per_usd = IF(source = 'manual', per_usd, VALUES(per_usd))`,
        [currency, rate],
        controlPlane,
      );
      if (result.affectedRows > 0) updated += 1;
    }
    cached = null;
    return updated;
  },

  /** An operator's rate, kept until they clear it. */
  async setManual(currency: string, perUsd: number): Promise<void> {
    await execute(
      `INSERT INTO exchange_rates (currency, per_usd, source) VALUES (?, ?, 'manual')
       ON DUPLICATE KEY UPDATE per_usd = VALUES(per_usd), source = 'manual'`,
      [currency.toUpperCase(), perUsd],
      controlPlane,
    );
    cached = null;
  },

  /** Hands a currency back to the ECB refresh. */
  async clearManual(currency: string): Promise<void> {
    await execute("UPDATE exchange_rates SET source = 'ecb' WHERE currency = ? AND source = 'manual'", [currency.toUpperCase()], controlPlane);
    cached = null;
  },

  async list() {
    return query<RowDataPacket & { currency: string; per_usd: string; source: string; updated_at: Date }>(
      'SELECT currency, per_usd, source, updated_at FROM exchange_rates ORDER BY currency',
      [],
      controlPlane,
    );
  },

  invalidate(): void {
    cached = null;
  },
};

defineJob({
  type: 'markets.fx_refresh',
  shopScoped: false,
  maxAttempts: 3,
  handler: async () => {
    const updated = await fx.refreshFromEcb();
    logger.info('markets.fx_refreshed', { currencies: updated });
  },
});
