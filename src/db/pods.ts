import mysql, { type Pool, type PoolConnection } from 'mysql2/promise';
import { env } from '../config/env';
import { logger } from '../core/logger';
import { tenancy } from '../platform/tenancy/context';
import { sqlTextOf, tenantGuard } from '../platform/tenancy/guard';
import { bookkeepingOnly, writeObserver, writtenTables } from './writeObserver';

/**
 * Pods: the unit Shopify scales by.
 *
 * A pod is one MySQL database holding a subset of shops. Every shop row names
 * its pod, and every tenant query goes to that pod's pool — so adding capacity
 * is a new database, a line in PODS and moving some shops, not a rewrite.
 *
 * Pod 1 is the database in DB_*, and it also holds the control plane (shops,
 * domains, identities, jobs). Further pods come from PODS:
 *
 *   PODS=2=mysql://user:pass@db-2.internal:3306/veylog_pod2
 *
 * Today there is one pod, and this file is the seam that keeps it that way
 * cheaply. Before a second pod takes traffic, control-plane repositories must
 * use `controlPlane` explicitly rather than the routed `pool` — the tenant
 * guard's cross-plane report lists the statements that still mix the two.
 */

interface PodConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const CONTROL_PLANE_POD = 1;

function parsePodUrl(url: string): PodConnection {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  };
}

function podConnections(): Map<number, PodConnection> {
  const map = new Map<number, PodConnection>();
  map.set(CONTROL_PLANE_POD, {
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
  });
  for (const entry of (process.env.PODS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const separator = entry.indexOf('=');
    const id = Number(entry.slice(0, separator));
    if (!Number.isInteger(id) || id <= 1) throw new Error(`PODS entry "${entry}" must look like 2=mysql://…`);
    map.set(id, parsePodUrl(entry.slice(separator + 1)));
  }
  return map;
}

const guardedTargets = new WeakSet<object>();

type Queryable = Pick<Pool, 'query' | 'execute'>;

/** Writes made inside a connection's open transaction, reported when it commits. */
const openTransactions = new WeakMap<object, Array<[number, readonly string[]]>>();

/**
 * Reports a successful write for the shop in context to the write observer:
 * straight away on autocommit, at COMMIT inside a transaction.
 */
function observeWrite(target: object, sql: string, result: unknown): void {
  if (!writeObserver.active) return;
  const tables = writtenTables(sql);
  // A view counter or a last-used stamp changes nothing anyone sees.
  if (!tables || bookkeepingOnly(sql)) return;
  const shop = tenancy.currentOrNull();
  if (!shop) return;
  const shopId = shop.id;
  (result as Promise<unknown>).then(
    () => {
      const transaction = openTransactions.get(target);
      if (transaction) transaction.push([shopId, tables]);
      else writeObserver.emit(shopId, tables);
    },
    () => undefined,
  );
}

type Transactional = {
  beginTransaction(...args: unknown[]): Promise<void>;
  commit(...args: unknown[]): Promise<void>;
  rollback(...args: unknown[]): Promise<void>;
};

/** Follows a connection's transaction so its writes are reported only once committed. */
function trackTransactions(target: object): void {
  const connection = target as Partial<Transactional>;
  if (typeof connection.beginTransaction !== 'function' || typeof connection.commit !== 'function' || typeof connection.rollback !== 'function') return;
  const begin = connection.beginTransaction.bind(target);
  const commit = connection.commit.bind(target);
  const rollback = connection.rollback.bind(target);
  connection.beginTransaction = async (...args: unknown[]) => {
    openTransactions.set(target, []);
    return begin(...args);
  };
  connection.commit = async (...args: unknown[]) => {
    await commit(...args);
    const writes = openTransactions.get(target) ?? [];
    openTransactions.delete(target);
    for (const [shopId, tables] of writes) writeObserver.emit(shopId, tables);
  };
  connection.rollback = async (...args: unknown[]) => {
    openTransactions.delete(target);
    return rollback(...args);
  };
}

/**
 * Wraps query/execute so the tenant guard sees the statement before MySQL does.
 * Applied to pools and to every connection handed out, because several modules
 * take a connection and call `conn.query` directly.
 */
export function installGuard<T extends Queryable>(target: T): T {
  if (guardedTargets.has(target)) return target;
  const originalQuery = target.query.bind(target) as (...args: unknown[]) => unknown;
  const originalExecute = target.execute.bind(target) as (...args: unknown[]) => unknown;

  (target as unknown as { query: unknown }).query = (sql: unknown, values?: unknown) => {
    const text = sqlTextOf(sql);
    tenantGuard.check(text, values ?? (sql as { values?: unknown })?.values);
    const result = values === undefined ? originalQuery(sql) : originalQuery(sql, values);
    observeWrite(target, text, result);
    return result;
  };
  (target as unknown as { execute: unknown }).execute = (sql: unknown, values?: unknown) => {
    const text = sqlTextOf(sql);
    tenantGuard.check(text, values ?? (sql as { values?: unknown })?.values);
    const result = values === undefined ? originalExecute(sql) : originalExecute(sql, values);
    observeWrite(target, text, result);
    return result;
  };
  trackTransactions(target);
  guardedTargets.add(target);
  return target;
}

function createPool(podId: number, connection: PodConnection): Pool {
  const created = mysql.createPool({
    ...connection,
    waitForConnections: true,
    connectionLimit: env.db.connectionLimit,
    queueLimit: 0,
    charset: 'utf8mb4_0900_ai_ci',
    timezone: 'Z',
    // DECIMAL and BIGINT come back as strings by default, which is correct for
    // money but painful everywhere else. We convert deliberately, per column,
    // in the row mappers rather than globally coercing to float.
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: false,
    namedPlaceholders: false,
  });

  // The driver reads and writes DATETIMEs as UTC (`timezone: 'Z'`), so the
  // session must agree: left at the server's SYSTEM zone, `NOW()` writes local
  // wall-clock time next to UTC values from JavaScript, and comparisons such
  // as the job queue's `run_at <= NOW()` are off by the server's offset — on a
  // +05:30 server every retry backoff was ignored. Commands queue in order on
  // a connection, so this runs before anything the application sends.
  // The promise pool forwards the core, callback-style connection here.
  created.on('connection', (connection) => {
    const core = connection as unknown as { query(sql: string, callback: (error: Error | null) => void): void };
    core.query("SET time_zone = '+00:00'", (error) => {
      if (error) logger.error('database.session_time_zone_failed', { pod_id: podId, error: error.message });
    });
  });

  installGuard(created);
  const originalGetConnection = created.getConnection.bind(created);
  created.getConnection = async (): Promise<PoolConnection> => installGuard(await originalGetConnection());

  logger.debug('database.pool_created', { pod_id: podId, host: connection.host, database: connection.database });
  return created;
}

class PodRouter {
  private readonly connections = podConnections();
  private readonly pools = new Map<number, Pool>();

  poolFor(podId: number): Pool {
    let existing = this.pools.get(podId);
    if (existing) return existing;
    const connection = this.connections.get(podId);
    if (!connection) throw new Error(`Pod ${podId} is not configured. Add it to PODS.`);
    existing = createPool(podId, connection);
    this.pools.set(podId, existing);
    return existing;
  }

  /** The pool for the shop in context, or the control plane outside one. */
  current(): Pool {
    const shop = tenancy.currentOrNull();
    return this.poolFor(shop?.podId ?? CONTROL_PLANE_POD);
  }

  configuredPods(): number[] {
    return [...this.connections.keys()];
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.pools.values()].map((pool) => pool.end()));
    this.pools.clear();
  }
}

export const podRouter = new PodRouter();

/** The pool holding shops, domains, identities and the job queue. */
export const controlPlane: Pool = podRouter.poolFor(CONTROL_PLANE_POD);
