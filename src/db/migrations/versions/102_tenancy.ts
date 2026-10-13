import type { RowDataPacket } from 'mysql2/promise';
import { indexName, rows } from '../helpers';
import type { MigrationContext, TsMigration } from '../runner';

/**
 * Makes every commerce table belong to a shop.
 *
 * The Shopify model: one set of tables, a `shop_id` on every row, and every
 * query filtered by it. (The alternative — a database per shop — was rejected:
 * it caps a MySQL server at a few thousand shops and turns every migration into
 * a loop over all of them.)
 *
 * The migration introspects instead of hardcoding, because the database it
 * runs on was built by hand and may not match the files exactly. Per table:
 *
 *   1. ADD shop_id — existing rows become the founding shop's (id 1), then the
 *      default is dropped, so an INSERT that forgets shop_id fails loudly
 *      rather than quietly filing a new shop's product under shop 1.
 *
 *   2. Unique keys and non-`id` primary keys get shop_id in front, unless they
 *      already contain a column pointing at another shop-owned row (then the
 *      parent scopes them already). Two shops can both have a product called
 *      "serum", a coupon WELCOME10 and an order VEY0000001.
 *
 *   3. Secondary indexes on query paths get shop_id in front, so a listing in
 *      one shop never walks another shop's rows. Indexes whose first column
 *      backs a foreign key are left alone — MySQL needs them as they are.
 *
 * The control-plane list is frozen here on purpose: a migration must build the
 * same schema next year as today, whatever the runtime list has become.
 */

const FOUNDING_SHOP_ID = 1;

const CONTROL_PLANE = new Set([
  'schema_migrations',
  'pods',
  'plans',
  'organizations',
  'shops',
  'shop_domains',
  'shop_subscriptions',
  'shop_staff',
  'admin_users',
  'admin_sessions',
  'admin_password_resets',
  'permissions',
  'menu_items',
  'menu_item_permissions',
  'sidebar_sections',
  'admin_menu_preferences',
  'user_sidebar_preferences',
  'menu_item_analytics',
  'rate_limits',
  'job_runs',
  'media_migrations',
  'feature_flags',
]);

/** Rows here may legitimately belong to no shop (platform-level actions). */
const NULLABLE_SHOP = new Set(['audit_logs']);

/** One row per shop, where the legacy table assumed one row in total. */
const SINGLETON_PER_SHOP = new Set(['announcement_settings']);

interface KeyPart {
  column: string | null;
  subPart: number | null;
  desc: boolean;
}

interface IndexInfo {
  name: string;
  unique: boolean;
  type: string;
  parts: KeyPart[];
}

interface ForeignKeyInfo {
  name: string;
  column: string;
  referencedTable: string;
}

async function loadIndexes(ctx: MigrationContext, table: string): Promise<IndexInfo[]> {
  const result = await rows<RowDataPacket>(
    ctx,
    `SELECT index_name, non_unique, index_type, column_name, sub_part, collation, seq_in_index
       FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = ?
      ORDER BY index_name, seq_in_index`,
    [table],
  );
  const byName = new Map<string, IndexInfo>();
  for (const row of result) {
    const name = String(row.INDEX_NAME ?? row.index_name);
    let index = byName.get(name);
    if (!index) {
      index = {
        name,
        unique: Number(row.NON_UNIQUE ?? row.non_unique) === 0,
        type: String(row.INDEX_TYPE ?? row.index_type),
        parts: [],
      };
      byName.set(name, index);
    }
    const column = row.COLUMN_NAME ?? row.column_name;
    const subPart = row.SUB_PART ?? row.sub_part;
    index.parts.push({
      column: column === null || column === undefined ? null : String(column),
      subPart: subPart === null || subPart === undefined ? null : Number(subPart),
      desc: String(row.COLLATION ?? row.collation) === 'D',
    });
  }
  return [...byName.values()];
}

async function loadForeignKeys(ctx: MigrationContext, table: string): Promise<ForeignKeyInfo[]> {
  const result = await rows<RowDataPacket>(
    ctx,
    `SELECT constraint_name, column_name, referenced_table_name
       FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND table_name = ? AND referenced_table_name IS NOT NULL`,
    [table],
  );
  return result.map((row) => ({
    name: String(row.CONSTRAINT_NAME ?? row.constraint_name),
    column: String(row.COLUMN_NAME ?? row.column_name),
    referencedTable: String(row.REFERENCED_TABLE_NAME ?? row.referenced_table_name),
  }));
}

function renderParts(parts: KeyPart[]): string {
  return parts
    .map((part) => `\`${part.column}\`${part.subPart ? `(${part.subPart})` : ''}${part.desc ? ' DESC' : ''}`)
    .join(', ');
}

const SHOP_PART: KeyPart = { column: 'shop_id', subPart: null, desc: false };

export async function planTable(ctx: MigrationContext, table: string): Promise<string[]> {
  const columns = (
    await rows<RowDataPacket>(
      ctx,
      `SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
      [table],
    )
  ).map((row) => String(row.COLUMN_NAME ?? row.column_name));

  if (columns.includes('shop_id')) return [];

  const indexes = await loadIndexes(ctx, table);
  const foreignKeys = await loadForeignKeys(ctx, table);
  const fkColumns = new Set(foreignKeys.map((fk) => fk.column));
  const tenantFkColumns = new Set(
    foreignKeys.filter((fk) => !CONTROL_PLANE.has(fk.referencedTable)).map((fk) => fk.column),
  );

  const clauses: string[] = [];
  const nullable = NULLABLE_SHOP.has(table);
  const position = columns.includes('id') ? 'AFTER `id`' : 'FIRST';
  clauses.push(
    `ADD COLUMN \`shop_id\` BIGINT UNSIGNED ${nullable ? 'NULL' : 'NOT NULL'} DEFAULT ${FOUNDING_SHOP_ID} ${position}`,
  );

  const anchored = (index: IndexInfo) => index.parts.some((part) => part.column && tenantFkColumns.has(part.column));
  const hasExpression = (index: IndexInfo) => index.parts.some((part) => part.column === null);

  // The index set as it will be once this ALTER lands, by leading column. Used
  // to make sure no foreign key loses the index MySQL requires for it.
  const finalLeadingColumns: string[] = [];

  for (const index of indexes) {
    if (index.type !== 'BTREE' || hasExpression(index)) {
      if (index.parts[0]?.column) finalLeadingColumns.push(index.parts[0].column);
      continue;
    }

    const keep = () => finalLeadingColumns.push(index.parts[0].column as string);
    const prefixed = renderParts([SHOP_PART, ...index.parts]);

    if (index.name === 'PRIMARY') {
      const isSurrogate = index.parts.length === 1 && index.parts[0].column === 'id';
      if (isSurrogate || anchored(index)) {
        keep();
        continue;
      }
      clauses.push('DROP PRIMARY KEY', `ADD PRIMARY KEY (${prefixed})`);
      finalLeadingColumns.push('shop_id');
      continue;
    }

    if (index.unique) {
      if (anchored(index)) {
        keep();
        continue;
      }
      clauses.push(`DROP INDEX \`${index.name}\``, `ADD UNIQUE KEY \`${index.name}\` (${prefixed})`);
      finalLeadingColumns.push('shop_id');
      continue;
    }

    const first = index.parts[0].column as string;
    if (fkColumns.has(first)) {
      keep();
      continue;
    }
    clauses.push(`DROP INDEX \`${index.name}\``, `ADD KEY \`${index.name}\` (${prefixed})`);
    finalLeadingColumns.push('shop_id');
  }

  // A rebuilt primary or unique key may have been the only index a foreign key
  // could use (admin_user_permissions' PK backs its admin_user_id FK). MySQL
  // refuses the drop in that case, so the FK gets an index of its own.
  for (const column of fkColumns) {
    if (finalLeadingColumns.includes(column)) continue;
    clauses.push(`ADD KEY \`${indexName('ix', table, column)}\` (\`${column}\`)`);
    finalLeadingColumns.push(column);
  }

  if (SINGLETON_PER_SHOP.has(table)) {
    clauses.push(`ADD UNIQUE KEY \`${indexName('uq', table, 'shop')}\` (\`shop_id\`)`);
    finalLeadingColumns.push('shop_id');
  }

  if (!finalLeadingColumns.includes('shop_id')) {
    clauses.push(`ADD KEY \`${indexName('ix', table, 'shop')}\` (\`shop_id\`)`);
  }

  return [`ALTER TABLE \`${table}\` ${clauses.join(', ')}`];
}

const migration: TsMigration = {
  description: 'shop_id on every tenant table, with shop-scoped keys and indexes',

  async up(ctx) {
    const tables = (
      await rows<RowDataPacket>(
        ctx,
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`,
      )
    ).map((row) => String(row.TABLE_NAME ?? row.table_name));

    let converted = 0;
    for (const table of tables) {
      if (CONTROL_PLANE.has(table)) continue;
      const statements = await planTable(ctx, table);
      for (const statement of statements) await ctx.exec(statement);
      if (statements.length > 0) converted += 1;
    }
    ctx.log(`${converted} table(s) given a shop_id`);

    // Contract step. Separate from the ALTERs above so a failure there leaves
    // the defaults in place and a re-run picks up where it stopped.
    const withDefault = await rows<RowDataPacket>(
      ctx,
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = DATABASE() AND column_name = 'shop_id' AND column_default IS NOT NULL`,
    );
    for (const row of withDefault) {
      const table = String(row.TABLE_NAME ?? row.table_name);
      if (CONTROL_PLANE.has(table)) continue;
      await ctx.exec(`ALTER TABLE \`${table}\` ALTER COLUMN \`shop_id\` DROP DEFAULT`);
    }
  },
};

export default migration;
