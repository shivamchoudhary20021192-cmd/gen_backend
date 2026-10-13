import type { Response } from 'express';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { controlPlane, execute } from '../../db/pool';
import { metrics } from '../observability/metrics';
import { entitlements } from '../plans/entitlements';
import type { ShopContext } from '../tenancy/context';

/**
 * The Admin API's rate limit for apps: a leaky bucket per (shop, app), the
 * model Shopify uses.
 *
 * Each call adds one to the bucket; the bucket drains at the plan's leak rate
 * (calls per second); a call that would overflow it is refused with 429 and a
 * Retry-After of however long it takes for one slot to drain. Bursts up to the
 * bucket size are fine; sustained traffic settles at the leak rate. Every
 * response says where the bucket stands:
 *
 *   X-Veylog-Shop-Api-Call-Limit: 12/40
 *
 * Buckets live in MySQL (`api_rate_buckets`), shared by every API node, and
 * each call is one atomic statement — so the plan's rate is the rate however
 * many nodes serve the API. `APP_RATE_LIMIT_STORE=memory` keeps them in the
 * process instead, for a single node or tests.
 */

export interface TakeResult {
  accepted: boolean;
  /** The bucket's level after this call, rounded up. */
  level: number;
}

export interface BucketStore {
  take(key: string, nowMs: number, size: number, leakPerSecond: number): Promise<TakeResult>;
}

/** Accepted results are encoded above this in LAST_INSERT_ID(); the level is the remainder. */
const ACCEPTED = 1_000_000;

export class MysqlBucketStore implements BucketStore {
  async take(key: string, nowMs: number, size: number, leakPerSecond: number): Promise<TakeResult> {
    // Assignments run left to right: `result` is decided from the old level
    // and time, `level` then reads the new `result`, and `updated_ms` moves
    // last. A clock a little behind another node's never drains backwards.
    // Signed arithmetic: `updated_ms` is unsigned, and a node whose clock is
    // behind would otherwise underflow it.
    const drained = 'GREATEST(0, `level` - GREATEST(0, CAST(? AS SIGNED) - CAST(`updated_ms` AS SIGNED)) / 1000 * ?)';
    const outcome = await execute(
      `INSERT INTO api_rate_buckets (bucket_key, \`level\`, updated_ms, result) VALUES (?, 1, ?, 0)
       ON DUPLICATE KEY UPDATE
         result = LAST_INSERT_ID(IF(${drained} + 1 <= ?, ${ACCEPTED}, 0) + CEIL(${drained} + IF(${drained} + 1 <= ?, 1, 0))),
         \`level\` = ${drained} + IF(result >= ${ACCEPTED}, 1, 0),
         updated_ms = GREATEST(updated_ms, ?)`,
      [
        key,
        nowMs,
        nowMs, leakPerSecond, size,
        nowMs, leakPerSecond,
        nowMs, leakPerSecond, size,
        nowMs, leakPerSecond,
        nowMs,
      ],
      controlPlane,
    );
    // The update path always reports its code through LAST_INSERT_ID(), and
    // the code is never 0 (a rejection leaves the bucket full). 0 means a new
    // row: the first call, accepted, level 1. Not `affectedRows`: with
    // CLIENT_FOUND_ROWS a rejected call that changes nothing also reports 1.
    const code = Number(outcome.insertId);
    if (code === 0) return { accepted: true, level: 1 };
    return { accepted: code >= ACCEPTED, level: code % ACCEPTED };
  }
}

export class MemoryBucketStore implements BucketStore {
  private readonly buckets = new Map<string, { level: number; updatedAt: number }>();
  private static readonly MAX_BUCKETS = 100_000;

  async take(key: string, nowMs: number, size: number, leakPerSecond: number): Promise<TakeResult> {
    const bucket = this.buckets.get(key) ?? { level: 0, updatedAt: nowMs };
    bucket.level = Math.max(0, bucket.level - (Math.max(0, nowMs - bucket.updatedAt) / 1000) * leakPerSecond);
    bucket.updatedAt = Math.max(bucket.updatedAt, nowMs);
    const accepted = bucket.level + 1 <= size;
    if (accepted) bucket.level += 1;
    this.buckets.set(key, bucket);
    if (this.buckets.size > MemoryBucketStore.MAX_BUCKETS) this.buckets.clear();
    return { accepted, level: Math.ceil(bucket.level) };
  }
}

let store: BucketStore = env.apps.rateLimitStore === 'memory' ? new MemoryBucketStore() : new MysqlBucketStore();

export async function consumeApiCall(shop: ShopContext, appId: number, res: Response): Promise<void> {
  const { limits } = await entitlements.forShop(shop);
  const size = Math.max(1, Number(limits.api_bucket_size ?? 40));
  const leakPerSecond = Math.max(0.1, Number(limits.api_leak_rate ?? 2));

  const { accepted, level } = await store.take(`app:${shop.id}:${appId}`, Date.now(), size, leakPerSecond);
  res.setHeader('X-Veylog-Shop-Api-Call-Limit', `${Math.min(level, size)}/${size}`);
  if (!accepted) {
    const retryAfter = Math.max(1, Math.ceil((level + 1 - size) / leakPerSecond));
    metrics.counter('app_api_throttled_total', { shop: String(shop.id) }).inc();
    throw ApiError.rateLimited(retryAfter, `Exceeded ${size} calls with a drain of ${leakPerSecond}/s. Slow down and retry.`);
  }
}

/** Test hook: a fresh in-memory store. */
export function resetApiCallLimits(next: BucketStore = new MemoryBucketStore()): void {
  store = next;
}
