import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { logger } from '../core/logger';
import { metrics } from '../platform/observability/metrics';

/**
 * Assigns (or adopts) a request id, echoes it on the response, and logs one
 * line per completed request. The same id lands in `audit_logs.context`, so a
 * row in the audit trail can be tied back to the exact HTTP call.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('X-Request-Id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const route = routeLabel(req);
    metrics.counter('http_requests_total', { method: req.method, route, status: `${Math.floor(res.statusCode / 100)}xx` }).inc();
    metrics.histogram('http_request_duration_seconds', { method: req.method, route }).observe(durationMs / 1000);
    logger.info('http.request', {
      request_id: req.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
      admin_id: req.admin?.id ?? null,
      shop_id: req.shop?.id ?? null,
    });
  });

  next();
}

export function clientIp(req: Request): string | null {
  const forwarded = req.header('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? null;
}

/**
 * The matched route template — `/admin/api/:version/orders/:id` — never the
 * raw path, so metric cardinality stays bounded by the number of routes
 * rather than growing with every order id and every scanner's probe.
 */
function routeLabel(req: Request): string {
  const template = req.route?.path;
  if (typeof template !== 'string') return 'unmatched';
  const base = req.baseUrl.replace(/^\/admin\/api\/[^/]+/, '/admin/api/:version');
  return `${base}${template === '/' ? '' : template}` || '/';
}

