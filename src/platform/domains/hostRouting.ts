import { env } from '../../config/env';
import { controlPlane, query, type RowDataPacket } from '../../db/pool';
import { storefrontVersions } from '../cache/storefrontVersions';
import { shopDirectory } from '../shops/shopDirectory';
import type { ShopContext } from '../tenancy/context';
import { normaliseHostname } from './hostnames';

/**
 * What a hostname means, for every storefront request and for the edge:
 * which shop, which of its domains, where that domain should redirect, and
 * which market and language it serves.
 *
 * Cached in memory for 30 seconds per shop (the domain list) and invalidated
 * by every change through `forgetHostRouting`. At global scale the same
 * answer is published to the edge (GET /internal/edge/route) so edge nodes
 * can cache it close to shoppers and route to the shop's region.
 */

export interface DomainRoute {
  id: number;
  hostname: string;
  kind: 'platform' | 'custom';
  isPrimary: boolean;
  redirectToPrimary: boolean;
  marketId: number | null;
  locale: string | null;
  status: string;
  https: boolean;
  /**
   * Where a request on this domain goes instead: the primary domain, or — for
   * the www/apex partner of a market's domain — that market's main domain.
   * Null when this domain serves the store itself.
   */
  redirectTo: { hostname: string; https: boolean } | null;
}

export interface HostRoute {
  shop: ShopContext;
  /** The domain the request came in on; null for development hosts (<handle>.localhost). */
  domain: DomainRoute | null;
  /** The address the store answers on; null when it is the platform address and this is it. */
  primary: DomainRoute | null;
  /** Domains that serve one market (and maybe language) each. */
  marketDomains: DomainRoute[];
  /** Domains that serve one language for every market — fr.example.com in French. */
  languageDomains: DomainRoute[];
}

/** Where a language lives for a shopper on this host: an origin, and the path prefix under it. */
export interface LanguageHome {
  origin: string;
  prefix: string;
}

interface DomainRouteRow extends RowDataPacket {
  id: number;
  hostname: string;
  kind: 'platform' | 'custom';
  is_primary: number;
  redirect_to_primary: number;
  market_id: number | null;
  locale: string | null;
  status: string;
  certificate_status: string;
  verification_status: string;
  edge_provider: string | null;
  pair_id: number | null;
}

const TTL_MS = 30_000;
const byShop = new Map<number, { at: number; domains: DomainRoute[] }>();

async function domainsOf(shopId: number): Promise<DomainRoute[]> {
  const cached = byShop.get(shopId);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.domains;
  const rows = await query<DomainRouteRow>(
    `SELECT id, hostname, kind, is_primary, redirect_to_primary, market_id, locale, status, certificate_status, verification_status, edge_provider, pair_id
       FROM shop_domains WHERE shop_id = ? AND verification_status = 'verified'`,
    [shopId],
    controlPlane,
  );
  const domains: DomainRoute[] = rows.map((row) => ({
    id: Number(row.id),
    hostname: row.hostname,
    kind: row.kind,
    isPrimary: row.is_primary === 1,
    redirectToPrimary: row.redirect_to_primary === 1 && row.is_primary !== 1 && !row.market_id,
    marketId: row.market_id === null ? null : Number(row.market_id),
    locale: row.locale,
    status: row.kind === 'platform' ? 'active' : row.status,
    // A redirect to https:// only once the certificate is live — never to a broken padlock.
    // (The platform's names use its wildcard certificate; the local edge serves plain HTTP.)
    https: row.kind === 'platform' ? env.nodeEnv === 'production' : row.certificate_status === 'active' && row.edge_provider !== 'local',
    redirectTo: null,
  }));
  const primary = domains.find((domain) => domain.isPrimary && domain.status === 'active');
  const rowOf = (domain: DomainRoute) => rows.find((candidate) => Number(candidate.id) === domain.id)!;
  for (const domain of domains) {
    if (domain.isPrimary) continue;
    const row = rowOf(domain);
    // The www/apex partner of a language domain (www.example.fr → example.fr) goes there, not to the primary.
    const partner = row.pair_id ? domains.find((other) => other.id === Number(row.pair_id)) : undefined;
    const languageHome = partner && !partner.isPrimary && partner.marketId === null && partner.locale && rowOf(partner).redirect_to_primary === 0 && partner.status === 'active' ? partner : undefined;
    if (domain.marketId !== null) {
      // A market has one main domain (the one not set to redirect); its partner sends visitors there.
      const main = domains.find((other) => other.marketId === domain.marketId && other.id !== domain.id && rows.find((candidate) => Number(candidate.id) === other.id)!.redirect_to_primary === 0 && other.status === 'active');
      if (row.redirect_to_primary === 1 && main) domain.redirectTo = { hostname: main.hostname, https: main.https };
    } else if (domain.redirectToPrimary && languageHome) {
      domain.redirectTo = { hostname: languageHome.hostname, https: languageHome.https };
    } else if ((domain.kind === 'platform' || domain.redirectToPrimary) && primary) {
      domain.redirectTo = { hostname: primary.hostname, https: primary.https };
    }
  }
  byShop.set(shopId, { at: Date.now(), domains });
  return domains;
}

export async function routeForShop(shop: ShopContext, hostname: string | null): Promise<HostRoute> {
  const domains = await domainsOf(shop.id);
  const host = hostname ? normaliseHostname(hostname) : null;
  const domain = host ? (domains.find((candidate) => candidate.hostname === host) ?? null) : null;
  const primary = domains.find((candidate) => candidate.isPrimary) ?? null;
  const serving = (candidate: DomainRoute) => candidate.status === 'active' && candidate.redirectTo === null && !candidate.isPrimary;
  return {
    shop,
    domain,
    primary,
    // Each market's main domain (its partner only redirects there).
    marketDomains: domains.filter((candidate) => serving(candidate) && candidate.marketId !== null),
    languageDomains: domains.filter((candidate) => serving(candidate) && candidate.marketId === null && candidate.kind === 'custom' && candidate.locale !== null),
  };
}

const originOf = (domain: DomainRoute) => `${domain.https ? 'https' : 'http'}://${domain.hostname}`;

/**
 * Where each language lives for a shopper who is on `route.domain` (reached at
 * `currentOrigin`), as Shopify's language domains work:
 *
 *   * on a market's domain, every language stays on that domain — its own
 *     language at the root, the others under /<code>;
 *   * a language with a domain of its own (fr.example.com) lives there, at the root;
 *   * every other language lives on the primary domain (or, on a development
 *     host, this one): the store's language at the root, the others under /<code>.
 */
export function languageHomes(route: HostRoute, currentOrigin: string, codes: string[], storeLanguage: string, hostDefault: string): Map<string, LanguageHome> {
  const homes = new Map<string, LanguageHome>();
  const current = route.domain;
  if (current?.marketId) {
    for (const code of codes) homes.set(code, { origin: currentOrigin, prefix: code === hostDefault ? '' : `/${code}` });
    return homes;
  }
  // Off a language domain, the rest are where this host is; on one, they are on the primary domain.
  const onLanguageDomain = Boolean(current && route.languageDomains.some((candidate) => candidate.id === current.id));
  const base = onLanguageDomain && route.primary ? originOf(route.primary) : currentOrigin;
  for (const code of codes) {
    const own = route.languageDomains.find((candidate) => candidate.locale === code);
    if (own) homes.set(code, { origin: own.id === current?.id ? currentOrigin : originOf(own), prefix: '' });
    else homes.set(code, { origin: base, prefix: code === storeLanguage ? '' : `/${code}` });
  }
  return homes;
}

/** The route for a verified hostname, or null if no store answers there. */
export async function resolveHost(hostname: string): Promise<HostRoute | null> {
  const shop = await shopDirectory.byHostname(hostname);
  return shop ? routeForShop(shop, hostname) : null;
}

export function forgetHostRouting(shopId?: number): void {
  if (shopId === undefined) byShop.clear();
  else byShop.delete(shopId);
}

// A domain change made on another pod reaches this one with the shop's storefront version.
storefrontVersions.onChange((shopId) => forgetHostRouting(shopId));
