import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ShopScopedCache } from '../../src/platform/cache/shopCache';
import { affectsStorefront } from '../../src/platform/cache/storefrontVersions';
import { bypassReason, normaliseUrl, pageKey, PageStore, type CachedPage } from '../../src/platform/onlineStore/pageCache';
import { tenancy } from '../../src/platform/tenancy/context';
import { fakeShop } from '../helpers/shop';

// No test here writes, so storefrontVersions never reaches for a database.

describe('which writes change a storefront', () => {
  it('counts catalogue, content, theme and settings tables', () => {
    for (const table of ['products', 'product_variants', 'collections', 'collection_products', 'inventory_items', 'cms_pages', 'shop_themes', 'shop_theme_files', 'settings', 'markets', 'translations', 'shop_languages', 'shop_domains', 'reviews', 'media', '*']) {
      assert.equal(affectsStorefront(table), true, table);
    }
  });

  it('ignores carts, orders, customers, sessions and logs', () => {
    for (const table of ['carts', 'cart_items', 'orders', 'order_items', 'payments', 'customers', 'customer_sessions', 'customer_addresses', 'audit_logs', 'jobs', 'rate_limits', 'otp_throttle', 'product_views', 'search_queries', 'webhook_deliveries', 'admin_sessions', 'shop_theme_drafts', 'storefront_versions']) {
      assert.equal(affectsStorefront(table), false, table);
    }
  });
});

describe('page cache keys', () => {
  it('drops tracking parameters and sorts the rest', () => {
    assert.equal(normaliseUrl('/collections/all?utm_source=ig&sort_by=price&fbclid=x&page=2'), '/collections/all?page=2&sort_by=price');
    assert.equal(normaliseUrl('/products/tee?gclid=1'), '/products/tee');
    assert.equal(normaliseUrl('/hi/products/tee?variant=3'), '/hi/products/tee?variant=3');
    assert.equal(normaliseUrl('/search?q=a&q=b'), '/search?q=a&q=b');
  });

  it('separates everything a page depends on', () => {
    const base = { shopId: 1, version: 4, theme: '3.12', scheme: 'https', host: 'shop.example.com', market: '1.IN.INR.1', url: '/' };
    const keys = new Set([
      pageKey(base),
      pageKey({ ...base, version: 5 }),
      pageKey({ ...base, theme: '3.13' }),
      pageKey({ ...base, host: 'shop.example.fr' }),
      pageKey({ ...base, market: '2.FR.EUR.0.011' }),
      pageKey({ ...base, url: '/fr' }),
      pageKey({ ...base, scheme: 'http' }),
      pageKey({ ...base, shopId: 2 }),
    ]);
    assert.equal(keys.size, 8);
  });
});

describe('what may be served from a shared copy', () => {
  const anonymous = { method: 'GET', path: '/products/tee', query: [] as string[], previewing: false, design: false, customer: false, cart: false, authorization: false };

  it('caches anonymous catalogue, content and search pages', () => {
    for (const path of ['/', '/collections', '/collections/all', '/collections/tees/products/tee', '/products/tee', '/products/tee.js', '/pages/about', '/blogs/news', '/blogs/news/launch', '/search', '/search/suggest.json', '/recommendations/products', '/sitemap.xml', '/robots.txt']) {
      assert.equal(bypassReason({ ...anonymous, path }), null, path);
    }
    assert.equal(bypassReason({ ...anonymous, method: 'HEAD' }), null);
    assert.equal(bypassReason({ ...anonymous, query: ['sections', 'variant', 'page', 'utm_source'] }), null);
  });

  it('never shares anything personal, unpublished or a form result', () => {
    assert.equal(bypassReason({ ...anonymous, cart: true }), 'cart');
    assert.equal(bypassReason({ ...anonymous, customer: true }), 'customer');
    assert.equal(bypassReason({ ...anonymous, previewing: true }), 'preview');
    assert.equal(bypassReason({ ...anonymous, design: true }), 'preview');
    assert.equal(bypassReason({ ...anonymous, authorization: true }), 'authorization');
    assert.equal(bypassReason({ ...anonymous, method: 'POST' }), 'method');
    for (const name of ['preview_key', 'preview_theme_id', 'country', 'contact_posted', 'customer_posted']) {
      assert.equal(bypassReason({ ...anonymous, query: [name] }), 'parameter', name);
    }
    for (const path of ['/cart', '/cart.js', '/account', '/account/login', '/checkout', '/checkouts/abc', '/password', '/cdn/shop/t/1/assets/base.css', '/localization', '/apps/proxy']) {
      assert.equal(bypassReason({ ...anonymous, path }), 'path', path);
    }
  });
});

function entry(key: string, size: number, storedAt = Date.now()): CachedPage {
  return { key, shopId: 1, status: 200, headers: [['content-type', 'text/html']], body: Buffer.alloc(size), etag: 'W/"x"', storedAt };
}

describe('the page store', () => {
  it('keeps within its byte budget, dropping the least recently used', () => {
    const store = new PageStore(64 * 1024, 60_000);
    for (let index = 0; index < 20; index += 1) {
      store.set(entry(`page-${index}`, 3_500));
      if (index >= 1) store.get('page-0'); // page-0 stays in use
    }
    assert.ok(store.bytes <= 64 * 1024, `used ${store.bytes}`);
    assert.ok(store.get('page-0'), 'the page in use survived');
    assert.equal(store.get('page-1'), null, 'the oldest unused page went first');
    assert.ok(store.get('page-19'));
  });

  it('refuses a page larger than a sixteenth of the budget', () => {
    const store = new PageStore(64 * 1024, 60_000);
    assert.equal(store.set(entry('huge', 5_000)), false);
    assert.equal(store.size, 0);
  });

  it('forgets pages older than the TTL', () => {
    const store = new PageStore(64 * 1024, 1_000);
    store.set(entry('old', 100, Date.now() - 2_000));
    assert.equal(store.get('old'), null);
    assert.equal(store.bytes, 0);
  });
});

describe('per-shop caches, cleared across the process', () => {
  it('clears one shop everywhere, except caches keyed by a version', async () => {
    const plain = new ShopScopedCache<string>(60_000);
    const versioned = new ShopScopedCache<string>(60_000, 10, { versioned: true });
    const read = (cache: ShopScopedCache<string>, shop: number, value: string) => tenancy.run(fakeShop({ id: shop }), () => cache.get('k', async () => value));
    await read(plain, 1, 'one');
    await read(plain, 2, 'two');
    await read(versioned, 1, 'v1');
    ShopScopedCache.clearShopEverywhere(1);
    assert.equal(await read(plain, 1, 'one again'), 'one again', 'shop 1 re-read');
    assert.equal(await read(plain, 2, 'changed'), 'two', 'shop 2 untouched');
    assert.equal(await read(versioned, 1, 'v2'), 'v1', 'versioned entries kept');
  });

  it('does not keep a value that was being read when the shop was cleared', async () => {
    const cache = new ShopScopedCache<string>(60_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = tenancy.run(fakeShop({ id: 5 }), () =>
      cache.get('k', async () => {
        await gate;
        return 'read before the change';
      }),
    );
    cache.clear(5);
    release();
    assert.equal(await slow, 'read before the change');
    const fresh = await tenancy.run(fakeShop({ id: 5 }), () => cache.get('k', async () => 'read after the change'));
    assert.equal(fresh, 'read after the change');
  });
});
