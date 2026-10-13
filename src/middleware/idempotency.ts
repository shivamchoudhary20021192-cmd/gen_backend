import type { NextFunction, Request, Response } from 'express';
import { logger } from '../core/logger';

interface CachedResponse {
  status: number;
  body: unknown;
  storedAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, CachedResponse | 'in-flight'>();

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, value] of cache) {
    if (value !== 'in-flight' && value.storedAt < cutoff) cache.delete(key);
  }
}, 60_000).unref();

/**
 * Honours the `Idempotency-Key` header on POST, the way Stripe and Shopify do.
 *
 * The admin UI double-submitting "Create product" is not hypothetical — it is
 * what happens on a slow connection when someone clicks twice. With a key, the
 * second request returns the first one's response instead of creating a second
 * product.
 *
 * In-process only: fine for a single instance. Behind more than one node, move
 * the map to Redis or a small `idempotency_keys` table — the interface here
 * does not change.
 */
export function idempotency(req: Request, res: Response, next: NextFunction): void {
  const key = req.header('Idempotency-Key');
  if (!key || req.method !== 'POST') {
    next();
    return;
  }

  const scopedKey = `${req.shop?.id ?? 'platform'}:${req.admin?.id ?? req.customer?.id ?? 'anon'}:${req.method}:${req.path}:${key}`;
  const existing = cache.get(scopedKey);

  if (existing === 'in-flight') {
    res.status(409).json({
      error: {
        code: 'CONFLICT',
        message: 'A request with this Idempotency-Key is still in progress.',
        request_id: req.requestId,
      },
    });
    return;
  }

  if (existing) {
    res.setHeader('Idempotent-Replay', 'true');
    res.status(existing.status).json(existing.body);
    return;
  }

  cache.set(scopedKey, 'in-flight');

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      cache.set(scopedKey, { status: res.statusCode, body, storedAt: Date.now() });
    } else {
      cache.delete(scopedKey);
    }
    return originalJson(body);
  };

  res.on('close', () => {
    if (cache.get(scopedKey) === 'in-flight') {
      cache.delete(scopedKey);
      logger.debug('idempotency.released', { key: scopedKey });
    }
  });

  next();
}
