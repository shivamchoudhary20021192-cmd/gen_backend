/**
 * The Online Store's edge worker — a Cloudflare Worker in front of every
 * storefront hostname (Cloudflare for SaaS custom hostnames and the platform's
 * *.myveylog.com), in every Cloudflare location.
 *
 * What it does for each request, without the origin whenever it can:
 *
 *   1. Route      Which shop the hostname belongs to, where that shop's origin
 *                 is (its pod's region), its content version and lock state —
 *                 from GET /internal/edge/route, kept per location for
 *                 ROUTE_TTL seconds (default 10).
 *   2. Redirect   Non-primary domains (www ↔ apex, old domains, the platform
 *                 subdomain) 301 to the primary, and HTTP to HTTPS, right here.
 *   3. Cache      Anonymous catalogue and content pages are cached here under a
 *                 key that includes the shop's content version. Any change to
 *                 the shop bumps the version, so the next request uses a new
 *                 key: no purge API calls, whatever the number of shops. Only
 *                 responses the origin marks `X-Veylog-Cacheable` are stored.
 *   4. Forward    Everything else goes to the shop's regional origin with the
 *                 shopper's host in X-Forwarded-Host.
 *
 * The rules for what may be cached mirror src/platform/onlineStore/pageCache.ts
 * (the origin's own page cache); test/unit/edgeWorker.test.ts checks the two
 * agree. Deploy with wrangler (wrangler.toml.example); see
 * deploy/edge/CLOUDFLARE_FOR_SAAS.md.
 */

export interface Env {
  /** The origin storefront requests go to, e.g. https://origin.myveylog.com */
  ORIGIN: string;
  /** Optional regional origins by pod: {"1":"https://ap-south-1.origin.myveylog.com","2":"https://eu-west-1.origin.myveylog.com"} */
  POD_ORIGINS?: string;
  /** The platform's EDGE_SHARED_SECRET, for /internal/edge/route. */
  EDGE_SHARED_SECRET: string;
  /** Seconds a hostname's route — and so the content version pages are keyed by — is reused. */
  ROUTE_TTL?: string;
}

export interface Route {
  host: string;
  found: boolean;
  shop?: { id: string; handle: string; status: string; pod: number };
  https?: boolean;
  redirect?: string | null;
  locked?: boolean;
  version?: number;
  cache_ttl?: number;
}

/** The parts of the Workers runtime this uses, so tests can stand in for them. */
export interface EdgeCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}
export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
export interface Deps {
  cache: EdgeCache;
  fetch: (request: Request) => Promise<Response>;
  now?: () => number;
}

// Keep in step with pageCache.ts (which sees paths after the language prefix; here it is still on).
const CACHEABLE_PATH =
  /^\/(?:[a-z]{2}(?:-[a-z]{2})?|(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:|collections|collections\/[^/]+|collections\/[^/]+\/products\/[^/]+|products\/[^/]+|pages\/[^/]+|policies\/[^/]+|blogs\/[^/]+|blogs\/[^/]+\/[^/]+|search|search\/suggest(?:\.json)?|recommendations\/products(?:\.json)?|robots\.txt|sitemap\.xml))$/i;
const BYPASS_PARAMS = /^(preview_key|preview_theme_id|country|contact_posted|customer_posted|comment_posted|oseid|_ab|_fd|_sc)$/;
const TRACKING_PARAMS = /^(utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|twclid|ttclid|igshid|li_fat_id|mc_cid|mc_eid|_ga|_gl|_kx|_hsenc|_hsmi|srsltid)$/i;
/** Cookies that make a page personal: a cart, a signed-in customer, a preview, an unlocked store. */
const PERSONAL_COOKIES = ['cart', '_veylog_customer', '_veylog_login', 'veylog_preview', 'storefront_digest'];

const DEFAULT_ROUTE_TTL = 10;
/** Routes held by this isolate, on top of the location's cache. */
const routes = new Map<string, { at: number; route: Route | null }>();

function cookieNames(request: Request): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return jar;
}

/** Why this request must go to the origin uncached — or null if a shared copy may answer it. */
export function edgeBypassReason(request: Request, url: URL, route: Route): string | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return 'method';
  if (!route.found || typeof route.version !== 'number') return 'route';
  if (!route.cache_ttl) return 'disabled';
  if (route.locked) return 'locked';
  if (request.headers.has('Authorization')) return 'authorization';
  const jar = cookieNames(request);
  for (const name of PERSONAL_COOKIES) if (jar.get(name)) return name === 'cart' ? 'cart' : name === '_veylog_customer' || name === '_veylog_login' ? 'customer' : 'preview';
  if (!CACHEABLE_PATH.test(url.pathname)) return 'path';
  for (const name of url.searchParams.keys()) if (BYPASS_PARAMS.test(name)) return 'parameter';
  return null;
}

/** The cache key: the page's URL without tracking parameters, sorted, plus the version, the shopper's market cookie and their country. */
export function edgeCacheKey(url: URL, request: Request, version: number): string {
  const params = [...url.searchParams].filter(([name]) => !TRACKING_PARAMS.test(name));
  params.sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const country = (cookieNames(request).get('localization') ?? '').toUpperCase();
  // Where the visitor is: the origin decides the cookie banner and the US sale opt-out by it (privacy/regions.ts).
  const geo = String((request as { cf?: { country?: string } }).cf?.country ?? request.headers.get('cf-ipcountry') ?? '').toUpperCase();
  params.push(
    ['__v', String(version)],
    ['__c', /^[A-Z]{2}$/.test(country) ? country : ''],
    ['__g', /^[A-Z]{2}$/.test(geo) ? geo : ''],
    ['__s', url.protocol.replace(':', '')],
  );
  return `https://${url.hostname.toLowerCase()}${url.pathname}?${new URLSearchParams(params).toString()}`;
}

function routeTtl(env: Env): number {
  const value = Number(env.ROUTE_TTL);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ROUTE_TTL;
}

export async function routeFor(host: string, env: Env, ctx: Context, deps: Deps): Promise<Route | null> {
  const now = deps.now?.() ?? Date.now();
  const ttl = routeTtl(env) * 1000;
  const held = routes.get(host);
  if (held && now - held.at < ttl) return held.route;

  const cacheKey = `https://edge-route.internal/${encodeURIComponent(host)}`;
  const cached = await deps.cache.match(cacheKey);
  if (cached) {
    const route = cached.status === 200 ? ((await cached.json()) as Route) : null;
    routes.set(host, { at: now, route });
    return route;
  }

  let response: Response;
  try {
    response = await deps.fetch(
      new Request(`${env.ORIGIN.replace(/\/$/, '')}/internal/edge/route?host=${encodeURIComponent(host)}`, {
        headers: { 'X-Edge-Secret': env.EDGE_SHARED_SECRET, Accept: 'application/json' },
      }),
    );
  } catch {
    // The origin is unreachable: keep using what this isolate last knew.
    return held?.route ?? null;
  }
  if (response.status !== 200 && response.status !== 404) return held?.route ?? null;
  const route = response.status === 200 ? ((await response.json()) as Route) : null;
  routes.set(host, { at: now, route });
  if (routes.size > 10_000) routes.delete(routes.keys().next().value!);
  ctx.waitUntil(
    deps.cache.put(
      cacheKey,
      new Response(route ? JSON.stringify(route) : null, { status: route ? 200 : 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${routeTtl(env)}` } }),
    ),
  );
  return route;
}

function originFor(route: Route | null, env: Env): string {
  if (route?.shop && env.POD_ORIGINS) {
    try {
      const byPod = JSON.parse(env.POD_ORIGINS) as Record<string, string>;
      const regional = byPod[String(route.shop.pod)];
      if (regional) return regional.replace(/\/$/, '');
    } catch {
      /* a malformed map falls back to the default origin */
    }
  }
  return env.ORIGIN.replace(/\/$/, '');
}

function forwardTo(origin: string, request: Request, url: URL): Request {
  const headers = new Headers(request.headers);
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(`${origin}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);
}

/** What the shopper gets: internal signals removed, how the edge answered added. */
function toShopper(response: Response, how: string, request: Request): Response {
  const out = new Response(request.method === 'HEAD' ? null : response.body, response);
  out.headers.delete('X-Veylog-Cacheable');
  out.headers.set('X-Veylog-Edge-Cache', how);
  if (how === 'HIT' || how === 'MISS') out.headers.set('Cache-Control', 'private, no-cache');
  return out;
}

export async function handle(request: Request, env: Env, ctx: Context, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  // The platform's edge endpoints are for the edge, never for the outside.
  if (url.pathname.startsWith('/internal/')) return new Response('Not found', { status: 404 });
  const host = url.hostname.toLowerCase();
  const route = await routeFor(host, env, ctx, deps);
  const readOnly = request.method === 'GET' || request.method === 'HEAD';
  const previewing = url.searchParams.has('preview_key') || Boolean(cookieNames(request).get('veylog_preview'));

  if (route?.found && readOnly && !previewing) {
    if (route.redirect) return Response.redirect(`${route.redirect}${url.pathname}${url.search}`, 301);
    if (route.https && url.protocol === 'http:') return Response.redirect(`https://${url.host}${url.pathname}${url.search}`, 301);
  }

  const forward = forwardTo(originFor(route, env), request, url);
  const reason = route ? edgeBypassReason(request, url, route) : 'route';
  if (reason) return toShopper(await deps.fetch(forward), 'BYPASS', request);

  const key = edgeCacheKey(url, request, route!.version!);
  const hit = await deps.cache.match(key);
  if (hit) {
    const etag = hit.headers.get('ETag');
    if (etag && hit.status === 200 && request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'X-Veylog-Edge-Cache': 'HIT', 'Cache-Control': 'private, no-cache' } });
    }
    return toShopper(hit, 'HIT', request);
  }

  // Always ask the origin for the whole page, so the copy kept here is complete.
  const conditional = new Headers(forward.headers);
  conditional.delete('If-None-Match');
  conditional.delete('If-Modified-Since');
  const response = await deps.fetch(new Request(forward, { headers: conditional, method: 'GET' }));
  const storable = Number(response.headers.get('X-Veylog-Cacheable') ?? 0);
  if (storable > 0 && (response.status === 200 || response.status === 404) && !response.headers.has('Set-Cookie')) {
    const copy = new Response(response.clone().body, response);
    copy.headers.set('Cache-Control', `public, max-age=${Math.min(storable, route!.cache_ttl!)}`);
    copy.headers.delete('X-Veylog-Cache');
    ctx.waitUntil(deps.cache.put(key, copy));
  }
  return toShopper(response, 'MISS', request);
}

/** For tests: forget the routes this isolate holds. */
export function forgetRoutes(): void {
  routes.clear();
}

export default {
  fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const cache = (globalThis as unknown as { caches: { default: EdgeCache } }).caches.default;
    return handle(request, env, ctx, { cache, fetch: (forwarded) => fetch(forwarded) });
  },
};
