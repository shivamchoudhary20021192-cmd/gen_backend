import type { NextFunction, Request, Response } from 'express';
import { execute, queryOne, type RowDataPacket } from '../db/pool';
import { ApiError } from '../core/ApiError';
import { clientIp } from './requestContext';
import { tenancy } from '../platform/tenancy/context';

interface RateRow extends RowDataPacket {
  id: number;
  hits: number;
  blocked_until: Date | null;
}

export interface RateLimitOptions {
  /** Logical bucket, e.g. 'admin.login'. Stored in rate_limits.bucket_key. */
  bucket: string;
  /** Requests allowed inside the window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** How long to block once the limit is breached. Defaults to the window. */
  blockSeconds?: number;
  /** Derives the subject being limited. Defaults to client IP. */
  identify?: (req: Request) => string;
}

/**
 * Durable, database-backed rate limiting. Slower than Redis, but it survives a
 * restart and leaves an inspectable trail — which is what you want for login
 * and OTP endpoints where the attacker is patient and the cost is real.
 *
 * The window is fixed, not sliding: `window_start` is truncated to the window
 * size so the UNIQUE key does the bucketing for us in a single upsert.
 */
export function rateLimit(options: RateLimitOptions) {
  const blockSeconds = options.blockSeconds ?? options.windowSeconds;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Per shop: one shop's OTP traffic must never throttle another's
      // customers who happen to share a phone number or an office IP.
      const shop = req.shop ?? tenancy.currentOrNull();
      const subject = options.identify?.(req) ?? clientIp(req) ?? 'unknown';
      const identifier = (shop ? `${shop.id}:${subject}` : subject).slice(0, 120);
      const windowMs = options.windowSeconds * 1000;
      const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
      const expiresAt = new Date(windowStart.getTime() + windowMs);

      await execute(
        `INSERT INTO rate_limits (bucket_key, identifier, hits, window_start, expires_at)
         VALUES (?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE hits = hits + 1`,
        [options.bucket, identifier, windowStart, expiresAt],
      );

      const row = await queryOne<RateRow>(
        `SELECT id, hits, blocked_until FROM rate_limits
         WHERE bucket_key = ? AND identifier = ? AND window_start = ?`,
        [options.bucket, identifier, windowStart],
      );

      if (!row) {
        next();
        return;
      }

      if (row.blocked_until && row.blocked_until.getTime() > Date.now()) {
        const retryAfter = Math.ceil((row.blocked_until.getTime() - Date.now()) / 1000);
        next(ApiError.rateLimited(retryAfter));
        return;
      }

      if (row.hits > options.max) {
        const blockedUntil = new Date(Date.now() + blockSeconds * 1000);
        await execute('UPDATE rate_limits SET blocked_until = ? WHERE id = ?', [blockedUntil, row.id]);
        next(ApiError.rateLimited(blockSeconds));
        return;
      }

      res.setHeader('X-RateLimit-Limit', String(options.max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, options.max - row.hits)));
      res.setHeader('X-RateLimit-Reset', String(Math.floor(expiresAt.getTime() / 1000)));
      next();
    } catch (error) {
      // A rate-limiter outage must not take the API down with it.
      next();
    }
  };
}

/** Housekeeping: called from a scheduled job. */
export async function purgeExpiredRateLimits(): Promise<number> {
  const result = await execute('DELETE FROM rate_limits WHERE expires_at < NOW() AND (blocked_until IS NULL OR blocked_until < NOW())');
  return result.affectedRows;
}
