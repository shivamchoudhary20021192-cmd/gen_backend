import type { RowDataPacket } from 'mysql2/promise';
import { indexExists, indexName, rows } from '../helpers';
import type { TsMigration } from '../runner';

/**
 * Makes a cross-shop reference impossible, not merely unlikely.
 *
 * Application code scopes every query by shop, and the tenant guard checks
 * that it does. This is the third line: for every CASCADE/RESTRICT foreign key
 * between two shop-owned tables, the key becomes composite —
 *
 *     collection_products (shop_id, product_id) → products (shop_id, id)
 *
 * — so the database itself refuses a row in shop A that points at a row in
 * shop B, whatever id a request body smuggles in.
 *
 * SET NULL keys stay single-column: MySQL nulls every column of a composite
 * key on delete, and shop_id is NOT NULL. Those references are covered by the
 * application check alone, which is why services look a referenced row up in
 * the current shop before writing its id.
 */

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

interface Candidate {
  table: string;
  name: string;
  column: string;
  parent: string;
  onDelete: string;
  onUpdate: string;
}

const migration: TsMigration = {
  description: 'Composite (shop_id, …) foreign keys between shop-owned tables',

  async up(ctx) {
    const found = await rows<RowDataPacket>(
      ctx,
      `SELECT k.table_name, k.constraint_name, k.column_name, k.referenced_table_name, k.referenced_column_name,
              r.delete_rule, r.update_rule,
              (SELECT COUNT(*) FROM information_schema.key_column_usage k2
                WHERE k2.constraint_schema = k.constraint_schema AND k2.table_name = k.table_name
                  AND k2.constraint_name = k.constraint_name) AS part_count
         FROM information_schema.key_column_usage k
         JOIN information_schema.referential_constraints r
           ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name
        WHERE k.constraint_schema = DATABASE() AND k.referenced_table_name IS NOT NULL`,
    );

    const tenantTables = new Set(
      (
        await rows<RowDataPacket>(
          ctx,
          `SELECT table_name FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'shop_id'`,
        )
      )
        .map((row) => String(row.TABLE_NAME ?? row.table_name))
        .filter((table) => !CONTROL_PLANE.has(table)),
    );

    const candidates: Candidate[] = [];
    for (const row of found) {
      const table = String(row.TABLE_NAME ?? row.table_name);
      const parent = String(row.REFERENCED_TABLE_NAME ?? row.referenced_table_name);
      const onDelete = String(row.DELETE_RULE ?? row.delete_rule);
      // Already composite (a re-run), or not a shop-to-shop single-column key.
      if (Number(row.part_count) !== 1) continue;
      if (String(row.REFERENCED_COLUMN_NAME ?? row.referenced_column_name) !== 'id') continue;
      if (!tenantTables.has(table) || !tenantTables.has(parent)) continue;
      if (onDelete === 'SET NULL' || onDelete === 'SET DEFAULT') continue;
      candidates.push({
        table,
        name: String(row.CONSTRAINT_NAME ?? row.constraint_name),
        column: String(row.COLUMN_NAME ?? row.column_name),
        parent,
        onDelete,
        onUpdate: String(row.UPDATE_RULE ?? row.update_rule),
      });
    }

    // Each referenced table needs (shop_id, id) as the leading columns of a key.
    for (const parent of new Set(candidates.map((candidate) => candidate.parent))) {
      const name = indexName('uq', parent, 'tenant');
      if (await indexExists(ctx, parent, name)) continue;
      await ctx.exec(`ALTER TABLE \`${parent}\` ADD UNIQUE KEY \`${name}\` (\`shop_id\`, \`id\`)`);
    }

    // One ALTER per child table, so each table's swap is atomic: MySQL 8 DDL
    // either lands whole or not at all, and a re-run skips keys that are
    // already composite. MySQL will not drop and re-add a foreign key of the
    // same name in one statement, hence the `_t` (tenant) suffix.
    const byTable = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const list = byTable.get(candidate.table) ?? [];
      list.push(candidate);
      byTable.set(candidate.table, list);
    }

    for (const [table, keys] of byTable) {
      const clauses = keys.flatMap((key) => {
        const renamed = key.name.length <= 62 ? `${key.name}_t` : indexName('fk', table, `${key.column}_t`);
        return [
          `DROP FOREIGN KEY \`${key.name}\``,
          `ADD CONSTRAINT \`${renamed}\` FOREIGN KEY (\`shop_id\`, \`${key.column}\`) ` +
            `REFERENCES \`${key.parent}\` (\`shop_id\`, \`id\`) ON DELETE ${key.onDelete} ON UPDATE ${key.onUpdate}`,
        ];
      });
      await ctx.exec(`ALTER TABLE \`${table}\` ${clauses.join(', ')}`);
    }

    ctx.log(`${candidates.length} foreign key(s) made tenant-consistent across ${byTable.size} table(s)`);
  },
};

export default migration;
