import { controlPlane, query, queryOne, type RowDataPacket } from '../../db/pool';
import type { ShopContext, ShopStatus } from '../tenancy/context';

/**
 * Hostname / handle / id → shop, for the resolvers that run on every request.
 *
 * Reads the control plane only, and caches for a short while: a storefront
 * serving a thousand requests a minute must not make a thousand identical
 * lookups, and a shop's handle or domain changes rarely enough that a
 * thirty-second lag is invisible. Anything that changes a shop calls
 * `invalidate` so the person who made the change sees it at once.
 */

interface ShopRow extends RowDataPacket {
  id: number;
  public_id: string;
  handle: string;
  name: string;
  pod_id: number;
  status: ShopStatus;
  plan_id: number | null;
  vertical: string;
  country_code: string;
  currency: string;
  timezone: string;
  locale: string;
  tax_engine: string;
  tax_shipping?: number;
  storefront_password_enabled: number;
  primary_domain: string | null;
}

const SELECT = `
  SELECT s.id, s.public_id, s.handle, s.name, s.pod_id, s.status, s.plan_id, s.vertical,
         s.country_code, s.currency, s.timezone, s.locale, s.tax_engine, s.tax_shipping, s.storefront_password_enabled,
         (SELECT d.hostname FROM shop_domains d
           WHERE d.shop_id = s.id AND d.is_primary = 1 LIMIT 1) AS primary_domain
    FROM shops s`;

const TTL_MS = 30_000;

interface Entry {
  shop: ShopContext | null;
  at: number;
}

const byId = new Map<number, Entry>();
const byKey = new Map<string, Entry>();

function toContext(row: ShopRow): ShopContext {
  return {
    id: Number(row.id),
    publicId: row.public_id,
    handle: row.handle,
    name: row.name,
    podId: Number(row.pod_id),
    status: row.status,
    planId: row.plan_id === null ? null : Number(row.plan_id),
    vertical: row.vertical,
    countryCode: row.country_code,
    currency: row.currency,
    timezone: row.timezone,
    locale: row.locale,
    taxEngine: row.tax_engine,
    taxShipping: row.tax_shipping === undefined ? true : Number(row.tax_shipping) === 1,
    primaryDomain: row.primary_domain,
    storefrontLocked: Number(row.storefront_password_enabled) === 1,
  };
}

function fresh(entry: Entry | undefined): entry is Entry {
  return entry !== undefined && Date.now() - entry.at < TTL_MS;
}

function remember(key: string | null, shop: ShopContext | null): ShopContext | null {
  const entry = { shop, at: Date.now() };
  if (key) byKey.set(key, entry);
  if (shop) byId.set(shop.id, entry);
  return shop;
}

/** Lower-case, no port, no trailing dot — the form shop_domains stores. */
export function normaliseHostname(raw: string): string {
  return raw.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

export const shopDirectory = {
  async byId(id: number): Promise<ShopContext | null> {
    const cached = byId.get(id);
    if (fresh(cached)) return cached.shop;
    const row = await queryOne<ShopRow>(`${SELECT} WHERE s.id = ?`, [id], controlPlane);
    return row ? remember(null, toContext(row)) : null;
  },

  async byHandle(handle: string): Promise<ShopContext | null> {
    const key = `handle:${handle.toLowerCase()}`;
    const cached = byKey.get(key);
    if (fresh(cached)) return cached.shop;
    const row = await queryOne<ShopRow>(`${SELECT} WHERE s.handle = ?`, [handle.toLowerCase()], controlPlane);
    return remember(key, row ? toContext(row) : null);
  },

  /** A verified domain, or the platform subdomain, of any shop. */
  async byHostname(hostname: string): Promise<ShopContext | null> {
    const host = normaliseHostname(hostname);
    const key = `host:${host}`;
    const cached = byKey.get(key);
    if (fresh(cached)) return cached.shop;
    const row = await queryOne<ShopRow>(
      `${SELECT}
         JOIN shop_domains d ON d.shop_id = s.id
        WHERE d.hostname = ? AND d.verification_status = 'verified'
        LIMIT 1`,
      [host],
      controlPlane,
    );
    return remember(key, row ? toContext(row) : null);
  },

  /** The UUID the shop is known by outside the platform (webhook URLs, app installs). */
  async byPublicId(publicId: string): Promise<ShopContext | null> {
    const key = `public:${publicId.toLowerCase()}`;
    const cached = byKey.get(key);
    if (fresh(cached)) return cached.shop;
    const row = await queryOne<ShopRow>(`${SELECT} WHERE s.public_id = ?`, [publicId.toLowerCase()], controlPlane);
    return remember(key, row ? toContext(row) : null);
  },

  /** Accepts whatever a client put in X-Veylog-Shop: an id, a public id, a handle or a hostname. */
  async byReference(reference: string): Promise<ShopContext | null> {
    const value = reference.trim();
    if (/^\d+$/.test(value)) return this.byId(Number(value));
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return this.byPublicId(value);
    if (value.includes('.')) return this.byHostname(value);
    return this.byHandle(value);
  },

  /**
   * The only shop, when there is exactly one that is not closed. Lets a
   * single-shop installation keep serving on localhost or an unregistered
   * host; stops applying the moment a second shop exists.
   */
  async soleShop(): Promise<ShopContext | null> {
    const key = 'sole';
    const cached = byKey.get(key);
    if (fresh(cached)) return cached.shop;
    const rows = await query<ShopRow>(`${SELECT} WHERE s.status <> 'closed' LIMIT 2`, [], controlPlane);
    return remember(key, rows.length === 1 ? toContext(rows[0]) : null);
  },

  invalidate(shopId?: number): void {
    if (shopId === undefined) {
      byId.clear();
      byKey.clear();
      return;
    }
    byId.delete(shopId);
    for (const [key, entry] of byKey) {
      if (entry.shop?.id === shopId || key === 'sole') byKey.delete(key);
    }
  },
};
