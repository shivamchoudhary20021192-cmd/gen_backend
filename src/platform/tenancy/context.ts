import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which shop the current unit of work belongs to.
 *
 * Set once where a request or job enters the system — the storefront resolver,
 * the admin authenticator, the job worker — and read by every repository
 * through `shopId()`. Carried by AsyncLocalStorage, so it follows the work
 * across every `await` without being threaded through 700 function signatures.
 *
 * Reading it outside a shop throws. That is the point: a repository that runs
 * without a shop has no business running, and "no shop" must never quietly
 * mean "every shop".
 */

export type ShopStatus = 'provisioning' | 'active' | 'paused' | 'frozen' | 'suspended' | 'closed';

export interface ShopContext {
  id: number;
  publicId: string;
  handle: string;
  name: string;
  podId: number;
  status: ShopStatus;
  planId: number | null;
  vertical: string;
  countryCode: string;
  currency: string;
  timezone: string;
  locale: string;
  taxEngine: string;
  /** Class-rate regimes: whether delivery is taxed like the goods (absent: yes). */
  taxShipping?: boolean;
  primaryDomain: string | null;
  /** "Opening soon": anonymous storefront reads need the store password. */
  storefrontLocked: boolean;
}

interface TenantStore {
  shop: ShopContext | null;
  /**
   * Set only by `tenancy.unscoped()`: the one sanctioned way to run a query on
   * tenant tables without a shop — resolving an inbound webhook to its shop,
   * or a platform job that sweeps every shop. Always carries a reason, which is
   * what makes these grep-able and reviewable.
   */
  unscopedReason: string | null;
}

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

const storage = new AsyncLocalStorage<TenantStore>();

export const tenancy = {
  /** Runs `fn` as the given shop. Nested calls replace the shop for their subtree. */
  run<T>(shop: ShopContext, fn: () => T): T {
    return storage.run({ shop, unscopedReason: null }, fn);
  },

  /**
   * Runs `fn` with the tenant guard relaxed. For entry-point lookups that find
   * the shop, and for platform jobs that deliberately cross shops. Queries in
   * here must still be written with care: nothing is checking them.
   */
  unscoped<T>(reason: string, fn: () => T): T {
    const shop = storage.getStore()?.shop ?? null;
    return storage.run({ shop, unscopedReason: reason }, fn);
  },

  current(): ShopContext {
    const shop = storage.getStore()?.shop;
    if (!shop) {
      throw new TenantContextError(
        'No shop in context. Tenant data can only be read inside tenancy.run() — ' +
          'a request that passed shop resolution, or a job the worker started for a shop.',
      );
    }
    return shop;
  },

  currentOrNull(): ShopContext | null {
    return storage.getStore()?.shop ?? null;
  },

  unscopedReason(): string | null {
    return storage.getStore()?.unscopedReason ?? null;
  },
};

/** The current shop's id. The call every repository makes. */
export function shopId(): number {
  return tenancy.current().id;
}

/**
 * The current shop's id as a SQL integer literal, for shared predicate
 * fragments (`publicWhere()`) that are spliced into queries whose placeholders
 * the fragment cannot know the position of. Safe to interpolate: it comes from
 * the context, never from a request, and is asserted to be a positive integer.
 * Prefer `shop_id = ?` with `shopId()` everywhere a bound parameter fits.
 */
export function shopIdSql(): string {
  const id = shopId();
  if (!Number.isSafeInteger(id) || id <= 0) throw new TenantContextError(`Invalid shop id in context: ${id}`);
  return String(id);
}
