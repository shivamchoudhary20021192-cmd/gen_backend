import type { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { shopDirectory } from '../shops/shopDirectory';
import { storefrontTokenResolver } from './storefrontTokens';
import { tenancy, type ShopContext } from './context';

/**
 * Finds the shop a storefront request is for, and runs the rest of the request
 * as that shop.
 *
 * In order, the first that answers wins:
 *
 *   1. X-Veylog-Storefront-Access-Token — a headless storefront or app,
 *      identified by a token the merchant issued (Shopify's Storefront API).
 *   2. X-Veylog-Shop-Domain — the shop's handle or one of its domains, for a
 *      storefront that calls the API from a different origin.
 *   3. The Host header — handle.myveylog.com, or a verified custom domain.
 *   4. DEFAULT_SHOP — single-shop compatibility.
 *   5. The only shop, when the platform has exactly one.
 *
 * A host nobody has claimed gets 404, never somebody else's shop.
 */

const SERVABLE: ReadonlySet<string> = new Set(['active', 'paused']);

async function locate(req: Request): Promise<ShopContext | null> {
  const token = req.header('X-Veylog-Storefront-Access-Token');
  if (token) {
    const shop = await storefrontTokenResolver.resolve(token.trim());
    if (!shop) throw ApiError.unauthenticated('The storefront access token is not valid.');
    return shop;
  }

  const declared = req.header('X-Veylog-Shop-Domain');
  if (declared) return shopDirectory.byReference(declared);

  const host = req.hostname;
  if (host) {
    const byHost = await shopDirectory.byHostname(host);
    if (byHost) return byHost;
  }

  if (env.platform.defaultShopHandle) return shopDirectory.byHandle(env.platform.defaultShopHandle);
  return shopDirectory.soleShop();
}

/**
 * Status gate for customer-facing traffic. A paused shop still shows its
 * catalogue (Shopify's "pause and build"); checkout refuses separately.
 */
export function assertServable(shop: ShopContext): void {
  if (SERVABLE.has(shop.status)) return;
  if (shop.status === 'provisioning') {
    throw new ApiError(503, 'SHOP_UNAVAILABLE', 'This store is being set up. Please try again in a moment.', undefined, 5);
  }
  throw ApiError.shopUnavailable('This store is not available right now.', { status: shop.status });
}

export async function resolveStorefrontShop(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const shop = await locate(req);
    if (!shop) throw ApiError.shopNotFound();
    assertServable(shop);
    req.shop = shop;
    tenancy.run(shop, () => next());
  } catch (error) {
    next(error);
  }
}

/**
 * For inbound calls that name their shop in the URL — provider webhooks and
 * OAuth callbacks — rather than in the host.
 */
export async function runAsShop(req: Request, shop: ShopContext, next: NextFunction): Promise<void> {
  req.shop = shop;
  tenancy.run(shop, () => next());
}
