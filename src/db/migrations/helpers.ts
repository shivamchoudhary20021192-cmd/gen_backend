import crypto from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import type { MigrationContext } from './runner';

/**
 * Introspection helpers for TypeScript migrations.
 *
 * MySQL 8 has no `ADD COLUMN IF NOT EXISTS`, and a migration that fails half
 * way must be safe to run again, so every structural change in a TS migration
 * asks first. These always read (even under --dry-run) and never write.
 */

export async function rows<T extends RowDataPacket>(ctx: MigrationContext, sql: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await ctx.conn.query<T[]>(sql, params);
  return result;
}

export async function scalar<T = unknown>(ctx: MigrationContext, sql: string, params: unknown[] = []): Promise<T | null> {
  const result = await rows<RowDataPacket>(ctx, sql, params);
  if (result.length === 0) return null;
  const first = result[0];
  return first[Object.keys(first)[0]] as T;
}

export async function tableExists(ctx: MigrationContext, table: string): Promise<boolean> {
  return (
    Number(
      await scalar(
        ctx,
        `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
        [table],
      ),
    ) > 0
  );
}

export async function columnExists(ctx: MigrationContext, table: string, column: string): Promise<boolean> {
  return (
    Number(
      await scalar(
        ctx,
        `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column],
      ),
    ) > 0
  );
}

export async function indexExists(ctx: MigrationContext, table: string, index: string): Promise<boolean> {
  return (
    Number(
      await scalar(
        ctx,
        `SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, index],
      ),
    ) > 0
  );
}

export async function foreignKeyExists(ctx: MigrationContext, table: string, name: string): Promise<boolean> {
  return (
    Number(
      await scalar(
        ctx,
        `SELECT COUNT(*) FROM information_schema.table_constraints
          WHERE constraint_schema = DATABASE() AND table_name = ? AND constraint_name = ? AND constraint_type = 'FOREIGN KEY'`,
        [table, name],
      ),
    ) > 0
  );
}

export async function addColumnIfMissing(ctx: MigrationContext, table: string, column: string, definition: string): Promise<void> {
  if (await columnExists(ctx, table, column)) return;
  await ctx.exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

/**
 * Index names are capped at 64 characters; long table names blow past it.
 * Truncated names get a digest of the full name so two long names that share
 * a prefix cannot collide.
 */
export function indexName(prefix: string, table: string, suffix: string): string {
  const name = `${prefix}_${table}_${suffix}`;
  if (name.length <= 64) return name;
  const digest = crypto.createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${name.slice(0, 55)}_${digest}`;
}
