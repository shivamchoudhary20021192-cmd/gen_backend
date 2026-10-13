import { hashToken } from '../../core/crypto';
import { controlPlane, queryOne, type RowDataPacket } from '../../db/pool';
import { shopDirectory } from '../shops/shopDirectory';
import type { ShopContext } from './context';

/**
 * Storefront access tokens: how a headless storefront, a mobile app or a
 * third-party sales channel says which shop it is reading.
 *
 * Like Shopify's, these are public by design — they ship inside browser
 * bundles — so they grant only what the storefront API already shows anyone.
 * What they add is identity: which shop, and which channel, so a token can be
 * revoked without touching the others. Stored hashed like every other token.
 */

export const STOREFRONT_TOKEN_PREFIX = 'vlst_';

interface TokenRow extends RowDataPacket {
  id: number;
  shop_id: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, { shopId: number | null; at: number }>();

export const storefrontTokenResolver = {
  async resolve(token: string): Promise<ShopContext | null> {
    if (!token.startsWith(STOREFRONT_TOKEN_PREFIX)) return null;
    const hash = hashToken(token);
    const hit = cache.get(hash);
    let shopId: number | null;
    if (hit && Date.now() - hit.at < TTL_MS) {
      shopId = hit.shopId;
    } else {
      const row = await queryOne<TokenRow>(
        'SELECT id, shop_id FROM storefront_access_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1',
        [hash],
        controlPlane,
      );
      shopId = row ? Number(row.shop_id) : null;
      if (cache.size > 10_000) cache.clear();
      cache.set(hash, { shopId, at: Date.now() });
      if (row) {
        void controlPlane
          .query('UPDATE storefront_access_tokens SET last_used_at = NOW() WHERE id = ?', [row.id])
          .catch(() => undefined);
      }
    }
    return shopId === null ? null : shopDirectory.byId(shopId);
  },

  forget(tokenHash?: string): void {
    if (tokenHash) cache.delete(tokenHash);
    else cache.clear();
  },
};
