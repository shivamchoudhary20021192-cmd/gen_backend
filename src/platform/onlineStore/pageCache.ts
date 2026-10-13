import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env';
import { storefrontVersions } from '../cache/storefrontVersions';
import { metrics } from '../observability/metrics';
import { tenancy } from '../tenancy/context';
import { locals } from './storefrontHttp';

/**
 * Full-page caching for the Online Store: what lets one API pod serve a
 * shop's anonymous traffic — shoppers browsing, crawlers — from memory.
 *
 * A page is cached when nothing about it is personal: a GET for a catalogue,
 * content or search page, with no cart, no signed-in customer and no theme
 * preview. The key is everything the page depends on that is not in the shop's
 * data — host and scheme, the URL (language prefix included; tracking
 * parameters dropped, the rest sorted), the market with its exchange rate,
 * the theme and its saved version — plus the shop's content version
 * (storefrontVersions.ts), which every change to the shop bumps. So a change
 * never needs a purge: from the moment the version moves, the old pages are
 * not asked for again, here or at the edge.
 *
 * Memory is bounded by bytes (PAGE_CACHE_MAX_MB, least recently used goes
 * first), entries by age (PAGE_CACHE_TTL_SECONDS). Concurrent misses for one
 * page render it once and share the result, so a cold page under a traffic
 * spike costs one render, not hundreds.
 *
 * Responses say what happened in `X-Veylog-Cache` (HIT, MISS, BYPASS), and a
 * cacheable one carries `X-Veylog-Cacheable: <seconds>` for the edge worker,
 * which keeps its own copy under the same version (deploy/edge/worker).
 */

/** Pages anyone may be served from a shared copy. Paths are after the language prefix. */
const CACHEABLE_PATH =
  /^\/(?:|collections|collections\/[^/]+|collections\/[^/]+\/products\/[^/]+|products\/[^/]+|pages\/[^/]+|policies\/[^/]+|blogs\/[^/]+|blogs\/[^/]+\/[^/]+|search|search\/suggest(?:\.json)?|recommendations\/products(?:\.json)?|robots\.txt|sitemap\.xml)$/;

/** A request with any of these is someone looking at something unpublished, or acting. */
const BYPASS_PARAMS = /^(preview_key|preview_theme_id|country|contact_posted|customer_posted|comment_posted|oseid|_ab|_fd|_sc)$/;

/** Marketing parameters: the page is the same with or without them. */
const TRACKING_PARAMS = /^(utm_[a-z_]+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|yclid|twclid|ttclid|igshid|li_fat_id|mc_cid|mc_eid|_ga|_gl|_kx|_hsenc|_hsmi|srsltid)$/i;

/** Headers a cached copy is replayed with; everything else is set by this request's own middleware. */
const STORED_HEADERS = ['content-type', 'content-language', 'link'];

export interface CachedPage {
  key: string;
  shopId: number;
  status: number;
  headers: Array<[string, string]>;
  body: Buffer;
  etag: string;
  storedAt: number;
}

/** The URL as a cache key sees it: tracking parameters gone, the rest in a stable order. */
export function normaliseUrl(originalUrl: string): string {
  const url = new URL(originalUrl, 'http://page.invalid');
  const params = [...url.searchParams].filter(([name]) => !TRACKING_PARAMS.test(name));
  params.sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const query = new URLSearchParams(params).toString();
  return `${url.pathname}${query ? `?${query}` : ''}`;
}

export interface KeyParts {
  shopId: number;
  version: number;
  theme: string;
  scheme: string;
  host: string;
  market: string;
  /** The visitor's privacy rules (regions.ts): whether the banner shows, whether the sale opt-out applies. */
  privacy?: string;
  url: string;
}

export function pageKey(parts: KeyParts): string {
  return [parts.shopId, parts.version, parts.theme, parts.scheme, parts.host, parts.market, parts.privacy ?? '', parts.url].join('|');
}

/** Why a request cannot be served from, or stored in, the shared cache — or null if it can. */
export function bypassReason(input: {
  method: string;
  path: string;
  query: Iterable<string>;
  previewing: boolean;
  design: boolean;
  customer: boolean;
  cart: boolean;
  authorization: boolean;
}): string | null {
  if (input.method !== 'GET' && input.method !== 'HEAD') return 'method';
  if (input.previewing || input.design) return 'preview';
  if (input.customer) return 'customer';
  if (input.cart) return 'cart';
  if (input.authorization) return 'authorization';
  if (!CACHEABLE_PATH.test(input.path)) return 'path';
  for (const name of input.query) if (BYPASS_PARAMS.test(name)) return 'parameter';
  return null;
}

/** An LRU of rendered pages, bounded by bytes. */
export class PageStore {
  private readonly entries = new Map<string, CachedPage>();
  private used = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly ttlMs: number,
  ) {}

  get bytes(): number {
    return this.used;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string, now = Date.now()): CachedPage | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (now - entry.storedAt >= this.ttlMs) {
      this.delete(key);
      return null;
    }
    // Most recently used goes to the back of the line.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(entry: CachedPage): boolean {
    const size = sizeOf(entry);
    // One page may not take more than a sixteenth of the cache.
    if (size > this.maxBytes / 16) return false;
    this.delete(entry.key);
    this.entries.set(entry.key, entry);
    this.used += size;
    while (this.used > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    return true;
  }

  clear(): void {
    this.entries.clear();
    this.used = 0;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.used -= sizeOf(entry);
  }
}

function sizeOf(entry: CachedPage): number {
  return entry.body.length + entry.key.length * 2 + 256;
}

const store = new PageStore(Math.max(0, env.pageCache.maxMb) * 1024 * 1024, Math.max(1, env.pageCache.ttlSeconds) * 1000);
/** Renders in progress, by key: the others asking for the same page wait for this one. */
const rendering = new Map<string, Promise<CachedPage | null>>();
const COLLAPSE_WAIT_MS = 5_000;

// A shop's old pages are never dropped one by one: after a version bump nothing asks
// for their keys again, and they leave as the least recently used.
metrics.onCollect(() => {
  metrics.gauge('storefront_page_cache_bytes', {}, 'Bytes of rendered pages cached by this process').set(store.bytes);
  metrics.gauge('storefront_page_cache_entries', {}, 'Rendered pages cached by this process').set(store.size);
});

function count(result: string, reason = ''): void {
  metrics.counter('storefront_page_cache_requests_total', reason ? { result, reason } : { result }, 'Storefront page requests by cache result').inc();
}

function serve(req: Request, res: Response, page: CachedPage): void {
  res.status(page.status);
  for (const [name, value] of page.headers) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('ETag', page.etag);
  res.setHeader('Age', String(Math.max(0, Math.floor((Date.now() - page.storedAt) / 1000))));
  res.setHeader('X-Veylog-Cache', 'HIT');
  res.setHeader('X-Veylog-Cacheable', String(env.pageCache.ttlSeconds));
  if (page.status === 200 && req.fresh) {
    res.status(304).end();
    return;
  }
  res.setHeader('Content-Length', String(page.body.length));
  if (req.method === 'HEAD') res.end();
  else res.end(page.body);
}

async function waitFor(promise: Promise<CachedPage | null>): Promise<CachedPage | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), COLLAPSE_WAIT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The Online Store middleware: serves a cached copy, or renders once and keeps what may be shared. */
export async function pageCache(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (env.pageCache.maxMb <= 0 || !storefrontVersions.live) return next();
    const state = locals(res);
    const reason = bypassReason({
      method: req.method,
      path: req.path,
      query: Object.keys(req.query),
      previewing: Boolean((res.locals as { previewing?: boolean }).previewing),
      design: state.design,
      customer: state.customerId !== null,
      cart: state.cartToken !== null,
      authorization: Boolean(req.get('authorization')),
    });
    if (reason) {
      if (reason !== 'path' && reason !== 'method') {
        res.setHeader('X-Veylog-Cache', 'BYPASS');
        count('bypass', reason);
      }
      return next();
    }

    const shopId = tenancy.current().id;
    // This process changed the shop a moment ago and its version bump is still coalescing.
    if (storefrontVersions.pending(shopId)) {
      res.setHeader('X-Veylog-Cache', 'BYPASS');
      count('bypass', 'changing');
      return next();
    }
    const market = state.market;
    const key = pageKey({
      shopId,
      version: await storefrontVersions.current(shopId),
      theme: `${state.theme.id}.${state.theme.filesVersion}`,
      scheme: req.protocol,
      host: req.hostname.toLowerCase(),
      market: `${market.id}.${market.country}.${market.currency}.${market.rate}`,
      privacy: state.privacy?.key ?? '',
      url: normaliseUrl(req.originalUrl),
    });

    const hit = store.get(key);
    if (hit) {
      count('hit');
      return serve(req, res, hit);
    }
    const inProgress = rendering.get(key);
    if (inProgress) {
      const shared = await waitFor(inProgress);
      if (shared) {
        count('hit', 'collapsed');
        return serve(req, res, shared);
      }
    }

    // This request renders the page; others asking meanwhile wait for it.
    let settle!: (page: CachedPage | null) => void;
    const promise = new Promise<CachedPage | null>((resolve) => {
      settle = resolve;
    });
    const leading = !rendering.has(key);
    if (leading) rendering.set(key, promise);
    const finish = (page: CachedPage | null) => {
      settle(page);
      if (rendering.get(key) === promise) rendering.delete(key);
    };
    res.once('close', () => finish(null));
    res.once('finish', () => finish(null));

    res.setHeader('X-Veylog-Cache', 'MISS');
    count('miss');
    const send = res.send.bind(res);
    res.send = ((body?: unknown) => {
      res.send = send;
      try {
        const status = res.statusCode;
        const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.isBuffer(body) ? body : null;
        if ((status === 200 || status === 404) && payload && !res.getHeader('set-cookie')) {
          if (!res.getHeader('content-type')) res.type(typeof body === 'string' ? 'html' : 'bin');
          const headers: Array<[string, string]> = [];
          for (const name of STORED_HEADERS) {
            const value = res.getHeader(name);
            if (value !== undefined) headers.push([name, String(value)]);
          }
          const page: CachedPage = {
            key,
            shopId,
            status,
            headers,
            body: payload,
            etag: `W/"${createHash('sha1').update(payload).digest('base64url').slice(0, 27)}"`,
            storedAt: Date.now(),
          };
          if (store.set(page)) {
            res.setHeader('X-Veylog-Cacheable', String(env.pageCache.ttlSeconds));
            res.setHeader('ETag', page.etag);
          }
          finish(page);
        } else {
          finish(null);
        }
      } catch {
        finish(null);
      }
      return send(body);
    }) as Response['send'];
    next();
  } catch (error) {
    next(error);
  }
}

/** For tests and operators: forget every cached page in this process. */
export function clearPageCache(): void {
  store.clear();
}
