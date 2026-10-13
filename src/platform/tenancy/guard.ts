import { logger } from '../../core/logger';
import { tenancy } from './context';
import { scanSql, type SqlScan } from './sqlScan';
import { CONTROL_PLANE_TABLES } from './tables';

/**
 * The tenant guard: the check that makes "we forgot a WHERE shop_id" a failed
 * request instead of a data breach.
 *
 * It sits on the database driver, so it sees every statement — the helpers in
 * db/pool.ts, and the modules that take a connection and call it directly.
 * For each statement that touches a shop-owned table it demands two things:
 *
 *   1. the statement mentions shop_id at all;
 *   2. every value bound to a `shop_id = ?` (or to the shop_id column of an
 *      INSERT) is the CURRENT shop's id.
 *
 * The second is what catches the realistic mistake. Adding `AND shop_id = ?`
 * to a query and pushing the param in the wrong place does not fail on its own
 * — it silently queries shop 5, where 5 was meant to be a product id.
 *
 * Which tables are shop-owned is read from the database at boot (every table
 * with a shop_id column, minus the control plane), so a new tenant table is
 * guarded from the moment it exists without anyone remembering to list it.
 *
 * Modes: enforce (throw — the default everywhere), warn (log once per
 * statement), off. Downgrading is an incident response, not a setting.
 */

export type GuardMode = 'enforce' | 'warn' | 'off';

export class TenantIsolationError extends Error {
  readonly sql: string;

  constructor(message: string, sql: string) {
    super(message);
    this.name = 'TenantIsolationError';
    this.sql = sql;
  }
}

const MAX_CACHED = 5000;

class TenantGuard {
  private mode: GuardMode = 'enforce';
  private tenantTables: ReadonlySet<string> = new Set();
  private ready = false;
  private readonly scans = new Map<string, SqlScan>();
  private readonly warned = new Set<string>();

  configure(mode: GuardMode): void {
    this.mode = mode;
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Tables with a shop_id column, as read from information_schema at boot. */
  load(tablesWithShopId: Iterable<string>): void {
    const tenant = new Set<string>();
    for (const table of tablesWithShopId) {
      const name = table.toLowerCase();
      if (!CONTROL_PLANE_TABLES.has(name)) tenant.add(name);
    }
    this.tenantTables = tenant;
    this.ready = true;
  }

  isTenantTable(table: string): boolean {
    return this.tenantTables.has(table.toLowerCase());
  }

  private scan(sql: string): SqlScan {
    let result = this.scans.get(sql);
    if (!result) {
      if (this.scans.size >= MAX_CACHED) this.scans.clear();
      result = scanSql(sql);
      this.scans.set(sql, result);
    }
    return result;
  }

  check(sql: string, params: unknown): void {
    if (this.mode === 'off' || !this.ready) return;

    const scan = this.scan(sql);
    const touched = scan.tables.filter((table) => this.tenantTables.has(table));
    if (touched.length === 0) return;
    if (tenancy.unscopedReason() !== null) return;

    const shop = tenancy.currentOrNull();
    if (!shop) {
      this.violation(`Query on ${touched.join(', ')} ran outside any shop context.`, sql);
      return;
    }

    if (!scan.mentionsShopId) {
      this.violation(`Query on ${touched.join(', ')} is not scoped by shop_id.`, sql);
      return;
    }

    if (Array.isArray(params)) {
      for (const index of scan.shopParamIndexes) {
        const bound = params[index];
        if (bound === undefined) continue;
        if (Number(bound) !== shop.id) {
          this.violation(
            `shop_id is bound to ${JSON.stringify(bound)} (parameter ${index + 1}) but the current shop is ${shop.id}. ` +
              'Check the order of the parameters.',
            sql,
          );
          return;
        }
      }
    }
  }

  private violation(message: string, sql: string): void {
    const statement = sql.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (this.mode === 'enforce') throw new TenantIsolationError(message, statement);
    const key = `${message}|${statement}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    logger.error('tenancy.guard_violation', { message, statement });
  }
}

export const tenantGuard = new TenantGuard();

/** The SQL text from either calling convention mysql2 accepts. */
export function sqlTextOf(sqlOrOptions: unknown): string {
  if (typeof sqlOrOptions === 'string') return sqlOrOptions;
  if (sqlOrOptions && typeof sqlOrOptions === 'object' && 'sql' in sqlOrOptions) {
    return String((sqlOrOptions as { sql: unknown }).sql);
  }
  return '';
}
