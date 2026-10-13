import type { NextFunction, Request, Response } from 'express';
import { sha256 } from '../core/crypto';
import { logger } from '../core/logger';
import { controlPlane, execute, queryOne, type RowDataPacket } from '../db/pool';

/** How long a completed request's response is replayed for. */
const TTL_SECONDS = 10 * 60;
/**
 * How long an in-flight claim holds before it counts as abandoned. Only a
 * node dying mid-request leaves a claim behind (every other path settles it),
 * so this is how long such a key answers 409 before a retry may run.
 */
const LEASE_SECONDS = 5 * 60;

interface KeyRow extends RowDataPacket {
  state: 'in_flight' | 'completed';
  response_status: number | null;
  response_body: string | null;
}

type Claim = { kind: 'owned' } | { kind: 'busy' } | { kind: 'replay'; status: number; body: unknown };

function isDuplicate(error: unknown): boolean {
  return (error as { code?: string })?.code === 'ER_DUP_ENTRY';
}

/**
 * Takes the key for this request, or says why not. The INSERT is the lock:
 * of two nodes racing with the same key, exactly one inserts and the other
 * hits the primary key. A row that has expired, or whose in-flight lease has
 * run out, is taken over by a conditional UPDATE — again exactly one winner.
 */
async function claim(keyHash: string): Promise<Claim> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await execute(
        `INSERT INTO idempotency_keys (key_hash, state, lease_expires_at, expires_at)
         VALUES (?, 'in_flight', NOW(3) + INTERVAL ${LEASE_SECONDS} SECOND, NOW(3) + INTERVAL ${TTL_SECONDS} SECOND)`,
        [keyHash],
        controlPlane,
      );
      return { kind: 'owned' };
    } catch (error) {
      if (!isDuplicate(error)) throw error;
    }

    const takenOver = await execute(
      `UPDATE idempotency_keys
          SET state = 'in_flight', response_status = NULL, response_body = NULL,
              lease_expires_at = NOW(3) + INTERVAL ${LEASE_SECONDS} SECOND,
              expires_at = NOW(3) + INTERVAL ${TTL_SECONDS} SECOND
        WHERE key_hash = ?
          AND (expires_at <= NOW(3) OR (state = 'in_flight' AND lease_expires_at <= NOW(3)))`,
      [keyHash],
      controlPlane,
    );
    if (takenOver.affectedRows === 1) return { kind: 'owned' };

    const row = await queryOne<KeyRow>(
      `SELECT state, response_status, response_body FROM idempotency_keys WHERE key_hash = ?`,
      [keyHash],
      controlPlane,
    );
    // Gone between the INSERT and the SELECT: the first request failed and
    // released it. Go round again and claim it.
    if (!row) continue;
    if (row.state === 'in_flight') return { kind: 'busy' };
    return { kind: 'replay', status: Number(row.response_status), body: row.response_body === null ? null : JSON.parse(row.response_body) };
  }
  return { kind: 'busy' };
}

async function complete(keyHash: string, status: number, body: unknown): Promise<void> {
  await execute(
    `UPDATE idempotency_keys
        SET state = 'completed', response_status = ?, response_body = ?
      WHERE key_hash = ? AND state = 'in_flight'`,
    [status, JSON.stringify(body ?? null), keyHash],
    controlPlane,
  );
}

async function release(keyHash: string): Promise<void> {
  await execute(`DELETE FROM idempotency_keys WHERE key_hash = ? AND state = 'in_flight'`, [keyHash], controlPlane);
}

/**
 * Honours the `Idempotency-Key` header on POST, the way Stripe and Shopify do.
 *
 * The admin UI double-submitting "Create product" is not hypothetical — it is
 * what happens on a slow connection when someone clicks twice. With a key, the
 * second request returns the first one's response instead of creating a second
 * product.
 *
 * Keys live in `idempotency_keys` on the control plane, so they hold across
 * every API node and survive a restart. A 2xx response is stored before it is
 * sent: once a client has seen the answer, any retry sees it too. Anything
 * else releases the key, so a corrected retry runs.
 */
export function idempotency(req: Request, res: Response, next: NextFunction): void {
  const key = req.header('Idempotency-Key');
  if (!key || req.method !== 'POST') {
    next();
    return;
  }

  const scopedKey = `${req.shop?.id ?? 'platform'}:${req.admin?.id ?? req.customer?.id ?? 'anon'}:${req.method}:${req.path}:${key}`;
  const keyHash = sha256(scopedKey);

  claim(keyHash)
    .then((outcome) => {
      if (outcome.kind === 'busy') {
        res.status(409).json({
          error: {
            code: 'CONFLICT',
            message: 'A request with this Idempotency-Key is still in progress.',
            request_id: req.requestId,
          },
        });
        return;
      }

      if (outcome.kind === 'replay') {
        res.setHeader('Idempotent-Replay', 'true');
        res.status(outcome.status).json(outcome.body);
        return;
      }

      let settled = false;
      const originalJson = res.json.bind(res);
      res.json = (body: unknown) => {
        if (settled) return originalJson(body);
        settled = true;
        const status = res.statusCode;
        const write = status >= 200 && status < 300 ? complete(keyHash, status, body) : release(keyHash);
        write
          .catch((error: unknown) => {
            // The work is done either way; the client still gets its answer.
            // A claim left in flight here frees itself when the lease runs out.
            logger.error('idempotency.store_failed', { error: error instanceof Error ? error.message : String(error), status });
          })
          .finally(() => originalJson(body));
        return res;
      };

      // A response that was not JSON (a file, a 204) stores nothing: let the
      // key go once it is sent. A client that hangs up is NOT a reason to let
      // go — the handler is still running, and its retry must wait for it
      // (409) and then replay, not run the work a second time. If the
      // handler's answer then never settles the key, the lease frees it.
      res.on('finish', () => {
        if (settled) return;
        settled = true;
        release(keyHash)
          .then(() => logger.debug('idempotency.released', { key_hash: keyHash }))
          .catch(() => undefined);
      });

      next();
    })
    .catch(next);
}
