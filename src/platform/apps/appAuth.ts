import type { Request } from 'express';
import { ApiError } from '../../core/ApiError';
import { hashToken } from '../../core/crypto';
import type { AuthenticatedAdmin } from '../../modules/auth/auth.types';
import { shopDirectory } from '../shops/shopDirectory';
import { appsRepository, jsonList, type AppRow } from './apps.repository';
import { permissionsForScopes } from './scopes';

/**
 * An app's offline access token → the same principal shape a signed-in staff
 * member resolves to, with its scopes compiled into permissions.
 *
 * Sent as `X-Veylog-Access-Token: vlat_…` (Shopify's X-Shopify-Access-Token),
 * or as a Bearer token with the vlat_ prefix. The token alone names the shop,
 * so an app never has to — and cannot — pick a different one.
 */

const PREFIX = 'vlat_';
const TTL_MS = 30_000;

interface Resolved {
  tokenId: number;
  shopId: number;
  installationId: number;
  scopes: string[];
  app: AppRow;
  at: number;
}

const cache = new Map<string, Resolved | null>();
const cacheTimes = new Map<string, number>();

export const appTokenCache = {
  clear(): void {
    cache.clear();
    cacheTimes.clear();
  },
};

export function extractAppToken(req: Request): string | null {
  const header = req.header('X-Veylog-Access-Token');
  if (header) return header.trim();
  const authorization = req.header('Authorization');
  if (authorization?.startsWith(`Bearer ${PREFIX}`)) return authorization.slice(7).trim();
  return null;
}

async function lookup(token: string): Promise<Resolved | null> {
  const hash = hashToken(token);
  const at = cacheTimes.get(hash);
  if (at !== undefined && Date.now() - at < TTL_MS) return cache.get(hash) ?? null;

  const row = await appsRepository.findLiveAccessToken(hash);
  const app = row ? await appsRepository.findById(Number(row.app_id)) : null;
  const resolved: Resolved | null =
    row && app
      ? {
          tokenId: Number(row.id),
          shopId: Number(row.shop_id),
          installationId: Number(row.installation_id),
          scopes: jsonList(row.scopes),
          app,
          at: Date.now(),
        }
      : null;

  if (cache.size > 10_000) appTokenCache.clear();
  cache.set(hash, resolved);
  cacheTimes.set(hash, Date.now());
  if (resolved) void appsRepository.touchAccessToken(resolved.tokenId).catch(() => undefined);
  return resolved;
}

export const appAuthenticator = {
  async resolve(token: string, req: Request): Promise<AuthenticatedAdmin> {
    if (!token.startsWith(PREFIX)) throw ApiError.unauthenticated('That is not an app access token.');
    const resolved = await lookup(token);
    if (!resolved) throw ApiError.unauthenticated('The access token is invalid or has been revoked.');

    const shop = await shopDirectory.byId(resolved.shopId);
    if (!shop || shop.status === 'closed') throw ApiError.shopUnavailable('This store is no longer available.');
    if ((shop.status === 'frozen' || shop.status === 'suspended') && req.method !== 'GET') {
      throw ApiError.shopUnavailable(`The store is ${shop.status}; apps have read-only access until it is reactivated.`, {
        status: shop.status,
      });
    }
    if (resolved.app.deleted_at || resolved.app.status === 'delisted') {
      throw ApiError.unauthenticated('This app has been removed from the platform.');
    }

    return {
      kind: 'app',
      id: Number(resolved.app.bot_admin_user_id ?? 0),
      publicId: resolved.app.public_id,
      email: `app+${resolved.app.handle}`,
      firstName: resolved.app.name,
      lastName: null,
      isSuperAdmin: false,
      isShopOwner: false,
      platformRole: 'none',
      sessionId: 0,
      permissions: permissionsForScopes(resolved.scopes),
      shop,
      app: {
        appId: Number(resolved.app.id),
        installationId: resolved.installationId,
        name: resolved.app.name,
        scopes: resolved.scopes,
      },
    };
  },
};
