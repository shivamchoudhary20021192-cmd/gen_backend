import { controlPlane, execute, query, type Executor, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { tenancy } from '../tenancy/context';

/**
 * The job queue, on MySQL.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`: each worker locks the rows it takes
 * and every other worker's SELECT silently steps over them, so N workers pull
 * from one table without contention or a broker. That is enough for tens of
 * thousands of jobs a minute; when it is not, this file is the seam a Redis or
 * Kafka-backed queue replaces — nothing above it knows which is underneath.
 *
 * Delivery is at least once. A worker that dies mid-job leaves its lock to
 * expire, and the reaper hands the job to someone else. Handlers are therefore
 * written to be idempotent.
 */

export interface EnqueueOptions {
  /** The shop the job acts for. Defaults to the shop in context, if any. */
  shopId?: number | null;
  queue?: string;
  priority?: number;
  maxAttempts?: number;
  /** Absolute time, or milliseconds from now. */
  runAt?: Date;
  delayMs?: number;
  /** A second enqueue with the same key is a no-op. */
  uniqueKey?: string;
  /**
   * The connection to write through. Pass the transaction a change is being
   * made in and the job exists only if the change commits — but only when that
   * transaction is on the control-plane database, which is where jobs live.
   */
  tx?: Executor;
}

export interface JobRow extends RowDataPacket {
  id: number;
  queue: string;
  type: string;
  shop_id: number | null;
  payload: unknown;
  status: 'pending' | 'running' | 'succeeded' | 'dead' | 'cancelled';
  priority: number;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  locked_by: string | null;
  lock_expires_at: Date | null;
  unique_key: string | null;
  last_error: string | null;
  created_at: Date;
}

export const jobQueue = {
  async enqueue(type: string, payload: unknown, options: EnqueueOptions = {}): Promise<boolean> {
    const shopId = options.shopId === undefined ? (tenancy.currentOrNull()?.id ?? null) : options.shopId;
    const runAt = options.runAt ?? new Date(Date.now() + (options.delayMs ?? 0));
    const result = await execute(
      `INSERT IGNORE INTO jobs (queue, type, shop_id, payload, priority, max_attempts, run_at, unique_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        options.queue ?? 'default',
        type,
        shopId,
        JSON.stringify(payload ?? {}),
        options.priority ?? 5,
        options.maxAttempts ?? 10,
        runAt,
        options.uniqueKey ?? null,
      ],
      options.tx ?? controlPlane,
    );
    return result.affectedRows === 1;
  },

  /**
   * Takes up to `limit` due jobs from the given queues for this worker, marking
   * them running and counting the attempt. The lock is a lease: a worker that
   * does not finish or extend it by `lockSeconds` loses the job.
   */
  async claim(workerId: string, queues: string[], limit: number, lockSeconds: number): Promise<JobRow[]> {
    if (limit <= 0 || queues.length === 0) return [];
    return withTransaction(async (tx) => {
      const due = await query<RowDataPacket>(
        `SELECT id FROM jobs
          WHERE status = 'pending' AND queue IN (?) AND run_at <= NOW(3)
          ORDER BY priority, run_at, id
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [queues, limit],
        tx,
      );
      if (due.length === 0) return [];
      const ids = due.map((row) => Number(row.id));
      await execute(
        `UPDATE jobs
            SET status = 'running', attempts = attempts + 1, locked_by = ?,
                lock_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND),
                started_at = COALESCE(started_at, NOW(3))
          WHERE id IN (?)`,
        [workerId, lockSeconds, ids],
        tx,
      );
      return query<JobRow>('SELECT * FROM jobs WHERE id IN (?) ORDER BY priority, run_at, id', [ids], tx);
    }, controlPlane);
  },

  async extendLock(jobId: number, workerId: string, lockSeconds: number): Promise<void> {
    await execute(
      `UPDATE jobs SET lock_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND)
        WHERE id = ? AND locked_by = ? AND status = 'running'`,
      [lockSeconds, jobId, workerId],
      controlPlane,
    );
  },

  async complete(jobId: number, workerId: string): Promise<void> {
    await execute(
      `UPDATE jobs SET status = 'succeeded', finished_at = NOW(3), locked_by = NULL, lock_expires_at = NULL, last_error = NULL
        WHERE id = ? AND locked_by = ?`,
      [jobId, workerId],
      controlPlane,
    );
  },

  /** Schedules a retry, or dead-letters the job when `retryAt` is null. */
  async fail(jobId: number, workerId: string, error: string, retryAt: Date | null): Promise<void> {
    await execute(
      `UPDATE jobs
          SET status = ?, run_at = COALESCE(?, run_at), last_error = ?,
              finished_at = IF(? IS NULL, NOW(3), NULL), locked_by = NULL, lock_expires_at = NULL
        WHERE id = ? AND locked_by = ?`,
      [retryAt ? 'pending' : 'dead', retryAt, error.slice(0, 4000), retryAt, jobId, workerId],
      controlPlane,
    );
  },

  /**
   * Hands back jobs whose worker vanished. Their attempt was already counted
   * at claim time, so a job that kills its worker every time still ends up
   * dead-lettered instead of looping forever.
   */
  async reapExpiredLocks(): Promise<number> {
    const dead = await execute(
      `UPDATE jobs SET status = 'dead', finished_at = NOW(3), locked_by = NULL, lock_expires_at = NULL,
              last_error = CONCAT(COALESCE(last_error, ''), ' [lock expired on final attempt]')
        WHERE status = 'running' AND lock_expires_at < NOW(3) AND attempts >= max_attempts`,
      [],
      controlPlane,
    );
    const revived = await execute(
      `UPDATE jobs SET status = 'pending', locked_by = NULL, lock_expires_at = NULL,
              last_error = 'Lock expired before the job finished (worker stopped or timed out).'
        WHERE status = 'running' AND lock_expires_at < NOW(3)`,
      [],
      controlPlane,
    );
    return dead.affectedRows + revived.affectedRows;
  },

  /** Housekeeping: finished jobs are kept for a week, dead ones for a month. */
  async purgeFinished(): Promise<number> {
    const result = await execute(
      `DELETE FROM jobs
        WHERE (status IN ('succeeded','cancelled') AND finished_at < DATE_SUB(NOW(3), INTERVAL 7 DAY))
           OR (status = 'dead' AND finished_at < DATE_SUB(NOW(3), INTERVAL 30 DAY))
        LIMIT 5000`,
      [],
      controlPlane,
    );
    return result.affectedRows;
  },

  async retry(jobId: number): Promise<boolean> {
    const result = await execute(
      `UPDATE jobs SET status = 'pending', run_at = NOW(3), attempts = 0, finished_at = NULL, last_error = NULL
        WHERE id = ? AND status IN ('dead','cancelled')`,
      [jobId],
      controlPlane,
    );
    return result.affectedRows === 1;
  },

  async stats(): Promise<{ queue: string; status: string; count: number; oldest: Date | null }[]> {
    const rows = await query<RowDataPacket>(
      `SELECT queue, status, COUNT(*) AS count, MIN(run_at) AS oldest
         FROM jobs WHERE status IN ('pending','running','dead')
        GROUP BY queue, status`,
      [],
      controlPlane,
    );
    return rows.map((row) => ({ queue: row.queue, status: row.status, count: Number(row.count), oldest: row.oldest }));
  },
};
