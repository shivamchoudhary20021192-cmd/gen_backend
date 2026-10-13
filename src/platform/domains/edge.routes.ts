import { timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { env } from '../../config/env';
import { asyncHandler } from '../../core/asyncHandler';
import { controlPlane, queryOne, type RowDataPacket } from '../../db/pool';
import { normaliseHostname, isPlatformHostname } from './hostnames';
import { resolveHost } from './hostRouting';
import { storefrontVersions } from '../cache/storefrontVersions';

/**
 * What the edge asks the platform. Never public: the edge strips /internal/
 * from outside traffic, and every call carries EDGE_SHARED_SECRET (header
 * X-Edge-Secret, or ?key= for edges like Caddy whose `ask` URL cannot set
 * headers).
 *
 *   GET /internal/edge/tls-allowed?domain=   200 if a certificate may be issued
 *        for this hostname (Caddy's on_demand_tls `ask`), 404 otherwise. Only
 *        hostnames a store has proven it owns, on a store that is not closed —
 *        so nobody can make the edge request certificates for arbitrary names.
 *   GET /internal/edge/route?host=           the routing answer an edge worker
 *        caches: shop, region/pod, primary domain, redirect. Lets the edge send
 *        redirects itself and route to the shop's region without a round trip.
 */

export const edgeRoutes = Router();

function authorised(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.EDGE_SHARED_SECRET;
  if (!secret) {
    // Without a secret configured, only development may use these.
    if (env.nodeEnv === 'production') {
      res.status(404).end();
      return;
    }
    next();
    return;
  }
  const given = String(req.header('X-Edge-Secret') ?? req.query.key ?? '');
  const ok = given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) {
    res.status(404).end();
    return;
  }
  next();
}

edgeRoutes.use('/internal/edge', authorised);

edgeRoutes.get(
  '/internal/edge/tls-allowed',
  asyncHandler(async (req: Request, res: Response) => {
    const host = normaliseHostname(String(req.query.domain ?? ''));
    if (!host) {
      res.status(400).end();
      return;
    }
    // The platform's own names are covered by its wildcard certificate.
    if (isPlatformHostname(host)) {
      res.status(404).end();
      return;
    }
    const row = await queryOne<RowDataPacket & { id: number }>(
      `SELECT d.id FROM shop_domains d JOIN shops s ON s.id = d.shop_id
        WHERE d.hostname = ? AND d.kind = 'custom' AND d.verification_status = 'verified' AND s.status <> 'closed' LIMIT 1`,
      [host],
      controlPlane,
    );
    res.status(row ? 200 : 404).end();
  }),
);

edgeRoutes.get(
  '/internal/edge/route',
  asyncHandler(async (req: Request, res: Response) => {
    const host = normaliseHostname(String(req.query.host ?? ''));
    const route = host ? await resolveHost(host) : null;
    if (!route) {
      res.status(404).json({ host, found: false });
      return;
    }
    const target = route.domain?.redirectTo ?? null;
    const redirect = target && target.hostname !== host ? `${target.https ? 'https' : 'http'}://${target.hostname}` : null;
    // The answer carries the shop's content version, which the edge keys cached pages by,
    // so it is kept only briefly (the worker holds it for ROUTE_TTL seconds).
    res.setHeader('Cache-Control', 'private, max-age=10');
    res.json({
      host,
      found: true,
      shop: { id: route.shop.publicId, handle: route.shop.handle, status: route.shop.status, pod: route.shop.podId },
      https: route.domain?.https ?? true,
      redirect,
      market_id: route.domain?.marketId ?? null,
      locale: route.domain?.locale ?? null,
      locked: route.shop.storefrontLocked,
      // Pages may be cached at the edge only while this process keeps versions current.
      version: await storefrontVersions.current(route.shop.id),
      cache_ttl: env.pageCache.maxMb > 0 && storefrontVersions.live ? env.pageCache.ttlSeconds : 0,
    });
  }),
);
