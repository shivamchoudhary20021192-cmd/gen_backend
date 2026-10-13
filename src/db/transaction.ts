import type { Pool, PoolConnection } from 'mysql2/promise';
import { pool } from './pool';
import { logger } from '../core/logger';

/**
 * The unit-of-work boundary. Services are the ONLY layer allowed to call this.
 *
 *   const id = await withTransaction(async (tx) => {
 *     const productId = await productRepo.insert(data, tx);
 *     await variantRepo.insertMany(productId, variants, tx);
 *     await auditRepo.log({ ... }, tx);          // audit rolls back too
 *     return productId;
 *   });
 *
 * Anything thrown inside rolls the whole thing back and re-throws, so the
 * caller sees the original error, not a transaction error.
 *
 * By default the transaction runs on the current shop's pod. Control-plane
 * work (identities, shops, the job queue) passes `controlPlane` explicitly,
 * because a transaction cannot span two databases.
 */
export async function withTransaction<T>(fn: (tx: PoolConnection) => Promise<T>, on: Pool = pool): Promise<T> {
  const conn = await on.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (error) {
    try {
      await conn.rollback();
    } catch (rollbackError) {
      logger.error('transaction.rollback_failed', { error: String(rollbackError) });
    }
    throw error;
  } finally {
    conn.release();
  }
}
