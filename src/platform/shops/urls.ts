import { env } from '../../config/env';
import { tenancy } from '../tenancy/context';

/**
 * Where the current shop's storefront lives, for links that leave the
 * platform: cart recovery, product links in messages, order tracking.
 *
 * The single-shop code used STOREFRONT_URL for every link, which in a
 * multi-shop platform sends every shop's customers to the same site. Now:
 *
 *   1. the shop's primary domain (a verified custom domain, or its platform
 *      subdomain `handle.myveylog.com`);
 *   2. STOREFRONT_URL, for the founding shop only — it is how an installation
 *      that predates shops is configured, and local development points it at
 *      the dev server rather than at a domain that does not resolve.
 */
export function storefrontUrl(): string {
  const shop = tenancy.current();
  const legacyShopId = Number(process.env.LEGACY_STOREFRONT_SHOP_ID ?? 1);
  if (shop.id === legacyShopId && process.env.STOREFRONT_URL) return env.storefrontUrl;
  if (shop.primaryDomain) return `https://${shop.primaryDomain}`;
  return `https://${shop.handle}.${env.platform.storefrontDomain}`;
}

/** An absolute storefront link for a path such as `/product/serum`. */
export function storefrontLink(path: string): string {
  return `${storefrontUrl()}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The Online Store (the server-rendered theme) of the current shop. In
 * development there is no DNS for shop domains, so it is served on
 * `<handle>.localhost:<port>` — browsers resolve *.localhost to this machine.
 * ONLINE_STORE_URL_TEMPLATE overrides both ("http://{handle}.lvh.me:4000").
 */
export function onlineStoreUrl(): string {
  return onlineStoreUrlFor(tenancy.current());
}

/** The same, for a shop other than the one in context (the admin's list of stores). */
export function onlineStoreUrlFor(shop: { handle: string; primaryDomain: string | null }): string {
  const template = process.env.ONLINE_STORE_URL_TEMPLATE;
  if (template) return template.replace('{handle}', shop.handle).replace(/\/$/, '');
  if (env.nodeEnv !== 'production') return `http://${shop.handle}.localhost:${env.port}`;
  if (shop.primaryDomain) return `https://${shop.primaryDomain}`;
  return `https://${shop.handle}.${env.platform.storefrontDomain}`;
}
