import { shopId } from '../tenancy/context';

/**
 * A small in-process TTL cache partitioned by shop.
 *
 * Several read paths (resolved page layouts, merchandising shelves) used to
 * keep a module-level `Map` keyed by something like `page:home`. With many
 * shops in one process that key is shared by all of them, so the first shop to
 * warm it would serve its home page to every other shop for a minute. Keeping
 * one map per shop makes that impossible by construction, and lets a write
 * clear only the shop that changed instead of everyone's warm entries.
 *
 * Entries are bounded per shop (oldest insertion evicted first) so a shop with
 * an unbounded key space — shelf ids, template keys — cannot grow the process.
 * Concurrent misses for the same key share one in-flight promise, so a cold
 * cache under load runs the expensive query once rather than once per request.
 *
 * Every instance is registered, so a change to a shop made on another API pod
 * — which this process learns of from the shop's storefront version (see
 * storefrontVersions.ts) — clears that shop's entries in all of them at once
 * with `ShopScopedCache.clearShopEverywhere`. The TTL is then only a backstop.
 * Caches whose keys already carry a version (a theme's files_version) opt out
 * with `{ versioned: true }`: their entries cannot go stale, and reloading them
 * would be wasted work.
 */
export class ShopScopedCache<V = unknown> {
  private static readonly instances = new Set<ShopScopedCache<unknown>>();

  private readonly shops = new Map<number, Map<string, { at: number; value: V }>>();
  private readonly inflight = new Map<string, Promise<V>>();
  /** Bumped by clear(): a value read before the clear is not stored after it. */
  private readonly generations = new Map<number, number>();
  private readonly versioned: boolean;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntriesPerShop = 500,
    options: { versioned?: boolean } = {},
  ) {
    this.versioned = options.versioned ?? false;
    ShopScopedCache.instances.add(this as ShopScopedCache<unknown>);
  }

  /** Drops one shop's entries from every (unversioned) cache in this process. */
  static clearShopEverywhere(shop: number): void {
    for (const cache of ShopScopedCache.instances) if (!cache.versioned) cache.clear(shop);
  }

  async get<T extends V>(key: string, produce: () => Promise<T>): Promise<T> {
    const shop = shopId();
    const entries = this.shops.get(shop);
    const hit = entries?.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T;

    const flightKey = `${shop}\u0000${key}`;
    const pending = this.inflight.get(flightKey);
    if (pending) return pending as Promise<T>;

    const generation = this.generations.get(shop) ?? 0;
    const promise: Promise<T> = produce()
      .then((value) => {
        if ((this.generations.get(shop) ?? 0) === generation) this.store(shop, key, value);
        return value;
      })
      .finally(() => {
        if (this.inflight.get(flightKey) === promise) this.inflight.delete(flightKey);
      });
    this.inflight.set(flightKey, promise);
    return promise;
  }

  /** Drops every entry for the current shop (or the one named). */
  clear(shop: number = shopId()): void {
    this.shops.delete(shop);
    this.generations.set(shop, (this.generations.get(shop) ?? 0) + 1);
    const prefix = `${shop}\u0000`;
    for (const key of this.inflight.keys()) if (key.startsWith(prefix)) this.inflight.delete(key);
  }

  /** Drops everything; for tests and for platform-wide changes. */
  clearAll(): void {
    for (const shop of this.shops.keys()) this.generations.set(shop, (this.generations.get(shop) ?? 0) + 1);
    this.shops.clear();
    this.inflight.clear();
  }

  private store(shop: number, key: string, value: V): void {
    let entries = this.shops.get(shop);
    if (!entries) {
      entries = new Map();
      this.shops.set(shop, entries);
    }
    entries.delete(key);
    entries.set(key, { at: Date.now(), value });
    while (entries.size > this.maxEntriesPerShop) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }
}
