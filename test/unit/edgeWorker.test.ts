import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { edgeBypassReason, edgeCacheKey, forgetRoutes, handle, type Context, type Deps, type Env, type Route } from '../../deploy/edge/worker/storefront';
import { bypassReason } from '../../src/platform/onlineStore/pageCache';

const ENV: Env = { ORIGIN: 'https://origin.example.net', EDGE_SHARED_SECRET: 'edge-secret', ROUTE_TTL: '10', POD_ORIGINS: '{"2":"https://eu.origin.example.net"}' };

function route(overrides: Partial<Route> = {}): Route {
  return { host: 'shop.example.com', found: true, shop: { id: 'uuid', handle: 'asha', status: 'active', pod: 1 }, https: true, redirect: null, locked: false, version: 7, cache_ttl: 300, ...overrides };
}

/** The Workers runtime, played by maps: the location's cache, the origin, waitUntil. */
function runtime(routes: Record<string, Route | null>, page: (request: Request) => Response) {
  const cache = new Map<string, Response>();
  const originCalls: Request[] = [];
  const waiting: Promise<unknown>[] = [];
  const deps: Deps = {
    cache: {
      match: async (key) => cache.get(key)?.clone(),
      put: async (key, response) => {
        cache.set(key, new Response(await response.arrayBuffer(), response));
      },
    },
    fetch: async (request) => {
      originCalls.push(request);
      const url = new URL(request.url);
      if (url.pathname === '/internal/edge/route') {
        assert.equal(request.headers.get('X-Edge-Secret'), 'edge-secret');
        const found = routes[url.searchParams.get('host') ?? ''];
        return found ? Response.json(found) : new Response(JSON.stringify({ found: false }), { status: 404 });
      }
      return page(request);
    },
  };
  const ctx: Context = { waitUntil: (promise) => void waiting.push(promise) };
  return {
    cache,
    originCalls,
    pages: () => originCalls.filter((request) => !request.url.includes('/internal/edge/')),
    async get(url: string, init: RequestInit = {}) {
      const response = await handle(new Request(url, init), ENV, ctx, deps);
      await Promise.all(waiting.splice(0));
      return response;
    },
  };
}

function cacheablePage(body = '<html>page</html>') {
  return () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html', 'X-Veylog-Cacheable': '300', ETag: 'W/"abc"' } });
}

beforeEach(() => forgetRoutes());

describe('edge worker: redirects', () => {
  it('sends other addresses to the primary domain, and HTTP to HTTPS, without the origin', async () => {
    const edge = runtime({ 'www.shop.example.com': route({ host: 'www.shop.example.com', redirect: 'https://shop.example.com' }), 'shop.example.com': route() }, cacheablePage());
    const www = await edge.get('https://www.shop.example.com/collections/all?page=2');
    assert.equal(www.status, 301);
    assert.equal(www.headers.get('Location'), 'https://shop.example.com/collections/all?page=2');
    const plain = await edge.get('http://shop.example.com/products/tee');
    assert.equal(plain.status, 301);
    assert.equal(plain.headers.get('Location'), 'https://shop.example.com/products/tee');
    assert.equal(edge.pages().length, 0);
  });

  it('never exposes the platform’s edge endpoints', async () => {
    const edge = runtime({}, cacheablePage());
    assert.equal((await edge.get('https://shop.example.com/internal/edge/route?host=x')).status, 404);
    assert.equal(edge.originCalls.length, 0);
  });
});

describe('edge worker: page cache', () => {
  it('keeps a page the origin marks cacheable and answers the next request itself', async () => {
    const edge = runtime({ 'shop.example.com': route() }, cacheablePage());
    const first = await edge.get('https://shop.example.com/collections/all?utm_source=ig');
    assert.equal(first.headers.get('X-Veylog-Edge-Cache'), 'MISS');
    assert.equal(first.headers.get('X-Veylog-Cacheable'), null, 'internal signal removed');
    assert.equal(first.headers.get('Cache-Control'), 'private, no-cache');
    const second = await edge.get('https://shop.example.com/collections/all');
    assert.equal(second.headers.get('X-Veylog-Edge-Cache'), 'HIT');
    assert.equal(await second.text(), '<html>page</html>');
    assert.equal(edge.pages().length, 1, 'one trip to the origin');
    const forwarded = edge.pages()[0];
    assert.equal(forwarded.headers.get('X-Forwarded-Host'), 'shop.example.com');
    assert.equal(new URL(forwarded.url).origin, 'https://origin.example.net');
  });

  it('answers a revalidation with 304', async () => {
    const edge = runtime({ 'shop.example.com': route() }, cacheablePage());
    await edge.get('https://shop.example.com/');
    const again = await edge.get('https://shop.example.com/', { headers: { 'If-None-Match': 'W/"abc"' } });
    assert.equal(again.status, 304);
  });

  it('uses a new key when the shop’s content version moves — no purge', async () => {
    const routes = { 'shop.example.com': route({ version: 7 }) };
    let body = 'before';
    const edge = runtime(routes, () => cacheablePage(body)());
    await edge.get('https://shop.example.com/products/tee');
    body = 'after';
    routes['shop.example.com'] = route({ version: 8 });
    forgetRoutes();
    edge.cache.clear(); // the location's route entry expires with ROUTE_TTL…
    const cachedPageKey = edgeCacheKey(new URL('https://shop.example.com/products/tee'), new Request('https://shop.example.com/'), 7);
    edge.cache.set(cachedPageKey, new Response('before', { headers: { 'Content-Type': 'text/html' } })); // …the old page does not need to
    const response = await edge.get('https://shop.example.com/products/tee');
    assert.equal(response.headers.get('X-Veylog-Edge-Cache'), 'MISS');
    assert.equal(await response.text(), 'after');
  });

  it('keeps each market and language apart', async () => {
    const url = new URL('https://shop.example.com/products/tee');
    const plain = edgeCacheKey(url, new Request(url), 7);
    const france = edgeCacheKey(url, new Request(url, { headers: { Cookie: 'localization=FR' } }), 7);
    const hindi = edgeCacheKey(new URL('https://shop.example.com/hi/products/tee'), new Request(url), 7);
    assert.equal(new Set([plain, france, hindi]).size, 3);
    assert.equal(edgeCacheKey(new URL('https://shop.example.com/products/tee?gclid=1'), new Request(url), 7), plain);
  });

  it('passes personal requests straight to the origin', async () => {
    const edge = runtime({ 'shop.example.com': route(), 'locked.example.com': route({ host: 'locked.example.com', locked: true }) }, cacheablePage());
    const cases: Array<[string, RequestInit]> = [
      ['https://shop.example.com/products/tee', { headers: { Cookie: 'cart=0b5d9a36-9b7e-4b52-9b6b-2d3c0a1e7f10' } }],
      ['https://shop.example.com/products/tee', { headers: { Cookie: '_veylog_customer=abc' } }],
      ['https://shop.example.com/products/tee?preview_key=abc', {}],
      ['https://shop.example.com/cart', {}],
      ['https://shop.example.com/account', {}],
      ['https://locked.example.com/products/tee', {}],
    ];
    for (const [url, init] of cases) {
      const response = await edge.get(url, init);
      assert.equal(response.headers.get('X-Veylog-Edge-Cache'), 'BYPASS', url);
    }
    assert.equal(edge.cache.size, 2, 'only the two routes were kept');
  });

  it('does not keep what the origin did not mark, or anything setting a cookie', async () => {
    const edge = runtime({ 'shop.example.com': route() }, (request) =>
      new URL(request.url).pathname === '/pages/about'
        ? new Response('about', { headers: { 'X-Veylog-Cacheable': '300', 'Set-Cookie': 'x=1' } })
        : new Response('plain'),
    );
    await edge.get('https://shop.example.com/pages/about');
    await edge.get('https://shop.example.com/products/tee');
    assert.equal(edge.cache.size, 1, 'only the route');
  });

  it('sends a shop to its pod’s regional origin', async () => {
    const edge = runtime({ 'eu.example.com': route({ host: 'eu.example.com', shop: { id: 'u', handle: 'eu', status: 'active', pod: 2 } }) }, cacheablePage());
    await edge.get('https://eu.example.com/');
    assert.equal(new URL(edge.pages()[0].url).origin, 'https://eu.origin.example.net');
  });
});

describe('edge and origin agree on what is cacheable', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['/', {}],
    ['/collections/all?sort_by=price', {}],
    ['/products/tee?variant=3', {}],
    ['/hi/products/tee', {}],
    ['/pages/about', {}],
    ['/blogs/news/launch', {}],
    ['/search?q=soap', {}],
    ['/cart', {}],
    ['/account/orders/1001', {}],
    ['/checkouts/abc', {}],
    ['/password', {}],
    ['/products/tee?preview_key=x', {}],
    ['/products/tee?country=FR', {}],
    ['/products/tee', { Cookie: 'cart=0b5d9a36-9b7e-4b52-9b6b-2d3c0a1e7f10' }],
    ['/products/tee', { Cookie: '_veylog_customer=abc' }],
  ];
  for (const [path, headers] of cases) {
    it(path + (headers.Cookie ? ` with ${headers.Cookie.split('=')[0]}` : ''), () => {
      const url = new URL(`https://shop.example.com${path}`);
      const edge = edgeBypassReason(new Request(url, { headers }), url, route());
      const cookie = headers.Cookie ?? '';
      const origin = bypassReason({
        method: 'GET',
        path: url.pathname.replace(/^\/hi(?=\/|$)/, '') || '/',
        query: url.searchParams.keys(),
        previewing: false,
        design: false,
        customer: cookie.startsWith('_veylog_customer'),
        cart: cookie.startsWith('cart='),
        authorization: false,
      });
      assert.equal(edge === null, origin === null, `edge: ${edge}, origin: ${origin}`);
    });
  }
});
