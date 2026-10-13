import { query, queryOne, type RowDataPacket } from '../../db/pool';
import { ShopScopedCache } from '../cache/shopCache';
import { formatMoney } from '../shops/format';
import { shopId } from '../tenancy/context';

/**
 * What a shop charges beyond the product price: delivery, and cash on
 * delivery. Read from the shop's own configuration — its shipping rates, its
 * COD rules, its settings — instead of the constants the single-shop code
 * compiled in (₹79 delivery, free over ₹999, ₹49 COD), which were one shop's
 * decisions applied to every shop.
 *
 * Cached per shop for a minute: the cart summary reads this on every request,
 * and these change a few times a year.
 */

export interface ShopPricing {
  shipping: {
    rate: number;
    /** Order value at or above which standard delivery is free; null: never free. */
    freeAbove: number | null;
  };
  cod: {
    enabled: boolean;
    fee: number;
    minOrder: number;
    maxOrder: number | null;
  };
  /** The region goods are dispatched from, for tax place-of-supply rules. */
  originRegion: string | null;
}

const cache = new ShopScopedCache<ShopPricing>(60_000);

function num(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(parsed) ? fallback : parsed;
}

async function load(): Promise<ShopPricing> {
  const settings = await query<RowDataPacket & { setting_key: string; value: string | null; default_value: string | null }>(
    `SELECT setting_key, value, default_value FROM settings
      WHERE shop_id = ? AND setting_key IN ('shipping.standard_cost', 'shipping.free_threshold', 'shipping.origin_state_code', 'payment.cod_enabled')`,
    [shopId()],
  );
  const setting = (key: string) => {
    const row = settings.find((candidate) => candidate.setting_key === key);
    return row ? (row.value ?? row.default_value) : null;
  };

  // The standard rate that applies everywhere: the one the cart quotes before
  // an address is known.
  const rate = await queryOne<RowDataPacket & { rate: string; free_above_amount: string | null }>(
    `SELECT rate, free_above_amount FROM shipping_rates
      WHERE shop_id = ? AND is_active = 1 AND method = 'standard' AND zone_id IS NULL
      ORDER BY zone = 'all' DESC, priority, id
      LIMIT 1`,
    [shopId()],
  );

  const codRule = await queryOne<RowDataPacket & { cod_fee: string; min_order_amount: string; max_order_amount: string | null }>(
    'SELECT cod_fee, min_order_amount, max_order_amount FROM cod_rules WHERE shop_id = ? AND is_active = 1 ORDER BY priority, id LIMIT 1',
    [shopId()],
  );
  const codSetting = setting('payment.cod_enabled');
  const codEnabled = codRule !== null && (codSetting === null || ['1', 'true', 'yes', 'on'].includes(String(codSetting).toLowerCase()));

  let origin = setting('shipping.origin_state_code');
  if (!origin) {
    const location = await queryOne<RowDataPacket & { state_code: string | null }>(
      'SELECT state_code FROM inventory_locations WHERE shop_id = ? AND is_active = 1 ORDER BY is_default DESC, priority, id LIMIT 1',
      [shopId()],
    );
    origin = location?.state_code ?? null;
  }

  return {
    shipping: rate
      ? { rate: num(rate.rate, 0), freeAbove: rate.free_above_amount === null ? null : num(rate.free_above_amount, 0) }
      : {
          rate: num(setting('shipping.standard_cost'), 0),
          freeAbove: setting('shipping.free_threshold') ? num(setting('shipping.free_threshold'), 0) : null,
        },
    cod: {
      enabled: codEnabled,
      fee: num(codRule?.cod_fee, 0),
      minOrder: num(codRule?.min_order_amount, 0),
      maxOrder: codRule?.max_order_amount === null || codRule?.max_order_amount === undefined ? null : num(codRule.max_order_amount, 0),
    },
    originRegion: origin ? origin.toUpperCase() : null,
  };
}

export const shopPricing = {
  get(): Promise<ShopPricing> {
    return cache.get('pricing', load);
  },

  /** For the settings screens that change rates, COD rules or the origin. */
  invalidate(): void {
    cache.clear();
  },

  /** Whether cash on delivery can be offered for this order value, and why not. */
  codEligibility(pricing: ShopPricing, subtotal: number): { available: boolean; reason: string | null } {
    if (!pricing.cod.enabled) return { available: false, reason: 'Cash on delivery is not offered by this store.' };
    if (subtotal < pricing.cod.minOrder) return { available: false, reason: `Cash on delivery needs an order of at least ${formatMoney(pricing.cod.minOrder)}.` };
    if (pricing.cod.maxOrder !== null && subtotal > pricing.cod.maxOrder) {
      return { available: false, reason: `Cash on delivery is available on orders up to ${formatMoney(pricing.cod.maxOrder)}.` };
    }
    return { available: true, reason: null };
  },
};
