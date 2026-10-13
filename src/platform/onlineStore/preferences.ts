import { execute, query, type RowDataPacket } from '../../db/pool';
import { ShopScopedCache } from '../cache/shopCache';
import { shopId } from '../tenancy/context';

/**
 * The Online Store's own switches, kept in the shop's `settings` rows:
 *
 *   online_store.customer_accounts   'optional' | 'disabled'
 *       Shopify's Settings → Customer accounts: whether the store shows
 *       sign-in links and serves /account at all. Signing in is never
 *       required to check out.
 */

export type CustomerAccountsMode = 'optional' | 'disabled';

export interface OnlineStorePreferences {
  customer_accounts: CustomerAccountsMode;
}

const DEFAULTS: OnlineStorePreferences = { customer_accounts: 'optional' };
const KEYS: Record<keyof OnlineStorePreferences, { key: string; label: string }> = {
  customer_accounts: { key: 'online_store.customer_accounts', label: 'Customer accounts on the online store' },
};

// Read on every storefront request; a change shows within seconds everywhere.
const cache = new ShopScopedCache<OnlineStorePreferences>(15_000);

export const onlineStorePreferences = {
  async get(): Promise<OnlineStorePreferences> {
    return cache.get('preferences', async () => {
      const rows = await query<RowDataPacket & { setting_key: string; value: string | null }>(
        `SELECT setting_key, value FROM settings WHERE shop_id = ? AND setting_key IN (?)`,
        [shopId(), Object.values(KEYS).map((entry) => entry.key)],
      );
      const value = (key: string) => rows.find((row) => row.setting_key === key)?.value ?? null;
      const accounts = value(KEYS.customer_accounts.key);
      return { customer_accounts: accounts === 'disabled' ? 'disabled' : DEFAULTS.customer_accounts };
    });
  },

  async update(changes: Partial<OnlineStorePreferences>): Promise<OnlineStorePreferences> {
    for (const [name, value] of Object.entries(changes) as [keyof OnlineStorePreferences, string][]) {
      if (value === undefined) continue;
      const { key, label } = KEYS[name];
      await execute(
        `INSERT INTO settings (shop_id, group_key, setting_key, label, value, default_value, value_type, description, is_public, sort_order)
         VALUES (?, 'online_store', ?, ?, ?, ?, 'string', NULL, 0, 0)
         ON DUPLICATE KEY UPDATE value = VALUES(value)`,
        [shopId(), key, label, value, DEFAULTS[name]],
      );
    }
    cache.clear();
    return this.get();
  },
};
