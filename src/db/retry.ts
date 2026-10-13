import type { Executor } from './pool';

/**
 * Retries a statement InnoDB chose as a deadlock victim.
 *
 * MySQL's own guidance is that deadlocks are normal under concurrency and the
 * victim should simply be run again. That is only safe for a statement running
 * on its own (autocommit): inside a transaction the deadlock has already rolled
 * back everything before it, so re-running just the last statement would
 * commit half a unit of work. On a transaction's connection this runs once and
 * lets the error reach the transaction's owner, who can retry the whole thing.
 */

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

export function isLockConflict(error: unknown): boolean {
  return error instanceof Error && RETRYABLE.has((error as Error & { code?: string }).code ?? '');
}

function isPool(exec: Executor): boolean {
  return typeof (exec as { getConnection?: unknown }).getConnection === 'function';
}

export async function retryOnLockConflict<T>(exec: Executor, statement: () => Promise<T>, attempts = 3): Promise<T> {
  if (!isPool(exec)) return statement();
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await statement();
    } catch (error) {
      if (attempt >= attempts || !isLockConflict(error)) throw error;
      // A little jitter so the two sides of the deadlock do not collide again.
      await new Promise((resolve) => setTimeout(resolve, 15 * attempt + Math.random() * 25));
    }
  }
}
