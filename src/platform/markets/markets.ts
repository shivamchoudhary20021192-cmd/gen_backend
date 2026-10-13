import { AsyncLocalStorage } from 'node:async_hooks';
import { query, type RowDataPacket } from '../../db/pool';
import { ShopScopedCache } from '../cache/shopCache';
import { roundMoney } from '../money/currency';
import { shopId, tenancy } from '../tenancy/context';
import { convertAmount, exchangeRate, presentmentPrice, type Rounding } from './fx';
import { listPrice, loadPriceList, type LoadedPriceList } from '../pricing/priceLists';

/**
 * Where a shopper is buying from, and what that means for prices.
 *
 * A market is resolved from a country: the country's market, if the store
 * sells there. Prices are stored in the store's currency; everything a
 * shopper sees and pays is `present()`-ed into the market's — converted,
 * adjusted and rounded by the market's rule. The store's own country is the
 * primary market, whose rate is 1: a domestic shopper's prices are the
 * stored prices, untouched.
 *
 * A sale outside the store's country is an export: no domestic sales tax or
 * VAT is due, cash on delivery is not offered, and it ships only where an
 * international zone has rates.
 */

export interface MarketRow extends RowDataPacket {
  id: number;
  name: string;
  currency: string;
  price_adjustment_percent: string;
  rounding: Rounding;
  is_primary: number;
  is_active: number;
  price_list_id: number | null;
}

export interface Market {
  id: number;
  name: string;
  /** The shopper's country. */
  country: string;
  currency: string;
  /** Market-currency units per store-currency unit. */
  rate: number;
  adjustmentPercent: number;
  rounding: Rounding;
  isPrimary: boolean;
  /** Delivered outside the store's own country. */
  isExport: boolean;
  /** Prices set by hand for this market (or a B2B company buying in it), in its currency. */
  priceList?: LoadedPriceList | null;
}

interface CountryRow extends RowDataPacket {
  market_id: number;
  country_code: string;
}

const cache = new ShopScopedCache<{ markets: MarketRow[]; countries: CountryRow[] }>(60_000);

async function load() {
  return cache.get('markets', async () => ({
    markets: await query<MarketRow>(
      'SELECT id, name, currency, price_adjustment_percent, rounding, is_primary, is_active, price_list_id FROM markets WHERE shop_id = ?',
      [shopId()],
    ),
    countries: await query<CountryRow>('SELECT market_id, country_code FROM market_countries WHERE shop_id = ?', [shopId()]),
  }));
}

function domestic(): Market {
  const shop = tenancy.current();
  return {
    id: 0,
    name: 'Domestic',
    country: shop.countryCode,
    currency: shop.currency,
    rate: 1,
    adjustmentPercent: 0,
    rounding: 'none',
    isPrimary: true,
    isExport: false,
  };
}

async function toMarket(row: MarketRow, country: string): Promise<Market> {
  const shop = tenancy.current();
  const list = row.price_list_id ? await loadPriceList(Number(row.price_list_id)) : null;
  return {
    id: row.id,
    name: row.name,
    country,
    currency: row.currency,
    rate: await exchangeRate(shop.currency, row.currency),
    adjustmentPercent: row.is_primary === 1 ? 0 : Number(row.price_adjustment_percent),
    rounding: row.is_primary === 1 ? 'none' : row.rounding,
    isPrimary: row.is_primary === 1,
    isExport: country !== shop.countryCode,
    // Only a list in the market's own currency can price it.
    priceList: list && list.currency === row.currency ? list : null,
  };
}

export const markets = {
  /**
   * The market for a country, or null when the store does not sell there.
   * No country: the store's own.
   */
  async forCountry(country: string | null | undefined): Promise<Market | null> {
    const shop = tenancy.current();
    const code = (country ?? shop.countryCode).trim().toUpperCase();
    const { markets: rows, countries } = await load();
    const link = countries.find((row) => row.country_code === code);
    const row = link ? rows.find((market) => market.id === Number(link.market_id) && market.is_active === 1) : null;
    if (row) return toMarket(row, code);
    // A store that has never touched markets still sells at home.
    return code === shop.countryCode ? domestic() : null;
  },

  /** Every country the store sells to, with its currency: the storefront's country picker. */
  async catalogue(): Promise<{ country: string; currency: string; market: string; primary: boolean }[]> {
    const { markets: rows, countries } = await load();
    const shop = tenancy.current();
    const listed = countries
      .map((link) => ({ link, market: rows.find((row) => row.id === Number(link.market_id) && row.is_active === 1) }))
      .filter((entry): entry is { link: CountryRow; market: MarketRow } => Boolean(entry.market))
      .map(({ link, market }) => ({ country: link.country_code, currency: market.currency, market: market.name, primary: market.is_primary === 1 }));
    if (!listed.some((entry) => entry.country === shop.countryCode)) {
      listed.unshift({ country: shop.countryCode, currency: shop.currency, market: 'Domestic', primary: true });
    }
    return listed.sort((a, b) => Number(b.primary) - Number(a.primary) || a.country.localeCompare(b.country));
  },

  /** The countries a market covers, in the order they were added: a market domain's default is the first. */
  async countriesOf(marketId: number): Promise<string[]> {
    const { countries } = await load();
    return countries.filter((row) => Number(row.market_id) === marketId).map((row) => row.country_code);
  },

  invalidate(): void {
    cache.clear();
  },
};

// ── the market a request is priced in ──────────────────────────────────────

const store = new AsyncLocalStorage<Market>();

export const marketContext = {
  run<T>(market: Market, fn: () => T): T {
    return store.run(market, fn);
  },

  /** The market in context; the store's own when none was chosen. */
  current(): Market {
    return store.getStore() ?? domestic();
  },
};

/** A catalogue price as the shopper in context sees it. */
export function present(amount: number | null): number | null {
  if (amount === null) return null;
  const market = marketContext.current();
  if (market.rate === 1 && market.adjustmentPercent === 0 && market.rounding === 'none') return amount;
  return presentmentPrice(amount, market);
}

/**
 * A variant's price and compare-at price in a market: its fixed price where
 * the market's price list has one, else the store's price as the market
 * shows it (converted, adjusted, rounded, then the list's adjustment).
 */
export function variantPriceIn(market: Market, variantId: number, storePrice: number, storeMrp: number | null): { price: number; mrp: number | null; fixed: boolean } {
  const presented = { price: priceIn(market, storePrice), mrp: storeMrp === null ? null : priceIn(market, storeMrp) };
  return listPrice(market.priceList, variantId, presented);
}

/** The same, for the market in context (catalogue pages). */
export function presentVariant(variantId: number, storePrice: number, storeMrp: number | null): { price: number; mrp: number | null } {
  const market = marketContext.current();
  if (!market.priceList) {
    const price = present(storePrice) as number;
    return { price, mrp: storeMrp === null ? null : present(storeMrp) };
  }
  const { price, mrp } = variantPriceIn(market, variantId, storePrice, storeMrp);
  return { price, mrp };
}

/** A price in a given market (carts and checkout, which carry their market explicitly). */
export function priceIn(market: Market, amount: number): number {
  if (market.rate === 1 && market.adjustmentPercent === 0 && market.rounding === 'none') return roundMoney(amount, market.currency);
  return presentmentPrice(amount, market);
}

/** An amount that is not a price — delivery, a fixed discount, a threshold — in a market. */
export function amountIn(market: Market, amount: number): number {
  return market.rate === 1 ? roundMoney(amount, market.currency) : convertAmount(amount, market.rate, market.currency);
}
