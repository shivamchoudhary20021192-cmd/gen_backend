import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from '../core/logger';
import { storefrontVersions } from '../platform/cache/storefrontVersions';
import { tenantGuard } from '../platform/tenancy/guard';
import { controlPlane, podRouter } from './pods';

/**
 * Anything a repository can run a query against: the shared pool, or a single
 * connection that is currently inside a transaction.
 *
 * Every repository method takes `exec: Executor = pool` as its last argument.
 * That one convention is what lets a service compose many repository calls into
 * a single atomic unit without repositories knowing that transactions exist.
 */
export type Executor = Pool | PoolConnection;

/**
 * The pool for whichever pod the current shop lives on.
 *
 * A proxy rather than a fixed pool so that the 700 call sites written as
 * `exec: Executor = pool` route by shop without changing. Outside a shop it is
 * the control plane.
 */
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, property) {
    const target = podRouter.current();
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

export { controlPlane };

export async function query<T extends RowDataPacket>(
  sql: string,
  params: unknown[] = [],
  exec: Executor = pool,
): Promise<T[]> {
  const [rows] = await exec.query<T[]>(sql, params);
  return rows;
}

export async function queryOne<T extends RowDataPacket>(
  sql: string,
  params: unknown[] = [],
  exec: Executor = pool,
): Promise<T | null> {
  const rows = await query<T>(sql, params, exec);
  return rows.length > 0 ? rows[0] : null;
}

export async function execute(
  sql: string,
  params: unknown[] = [],
  exec: Executor = pool,
): Promise<ResultSetHeader> {
  const [result] = await exec.query<ResultSetHeader>(sql, params);
  return result;
}

/** INSERT helper that returns the new id. */
export async function insert(
  sql: string,
  params: unknown[] = [],
  exec: Executor = pool,
): Promise<number> {
  const result = await execute(sql, params, exec);
  return result.insertId;
}

interface TenantTableRow extends RowDataPacket {
  table_name: string;
}

/**
 * Connects, and teaches the tenant guard which tables are shop-owned by reading
 * them from the schema. Must complete before the first request is served —
 * until it does, the guard has nothing to guard with.
 */
export async function verifyConnection(): Promise<void> {
  const conn = await controlPlane.getConnection();
  try {
    await conn.ping();
    const [rows] = await conn.query<TenantTableRow[]>(
      `SELECT table_name AS table_name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND column_name = 'shop_id'`,
    );
    tenantGuard.configure(env.tenancy.guard);
    tenantGuard.load(rows.map((row) => row.table_name));
    logger.info('database.connected', {
      database: env.db.database,
      host: env.db.host,
      pods: podRouter.configuredPods(),
      tenant_tables: rows.length,
      tenant_guard: env.tenancy.guard,
    });
  } finally {
    conn.release();
  }
}

export async function closePool(): Promise<void> {
  // Changes this process made still owe their storefront version bump.
  storefrontVersions.stop();
  await storefrontVersions.flush();
  await podRouter.closeAll();
  logger.info('database.pool_closed');
}

export type { RowDataPacket, ResultSetHeader, PoolConnection };
