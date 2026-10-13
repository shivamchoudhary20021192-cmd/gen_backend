import type { RowDataPacket } from 'mysql2/promise';
import { rows } from '../helpers';
import type { TsMigration } from '../runner';

/**
 * Lets an address from any country fit.
 *
 * The single-shop schema was built for India: `pincode CHAR(6)` and
 * `state_code CHAR(2)`. A UK postcode ("SW1A 1AA"), a Canadian one
 * ("K1A 0B1"), a Brazilian CEP ("01310-100") and most ISO 3166-2 subdivision
 * codes ("NSW", "ENG", "BY") do not fit, and MySQL in strict mode refuses the
 * INSERT rather than truncating — so a US shop could not take a single order.
 *
 * Columns keep their names, because the API and both frontends already use
 * them; `pincode` now means "postal code". Nullability and existing values are
 * preserved. Introspective, so it only touches columns that are still narrow.
 */

const WIDEN: Record<string, string> = {
  pincode: 'VARCHAR(16)',
  state_code: 'VARCHAR(10)',
  place_of_supply_state_code: 'VARCHAR(10)',
};

interface ColumnRow extends RowDataPacket {
  table_name: string;
  column_name: string;
  column_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  column_comment: string;
}

const migration: TsMigration = {
  description: 'Widen postal and region code columns for addresses outside India',
  async up(ctx) {
    const columns = await rows<ColumnRow>(
      ctx,
      `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS column_type,
              c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default, c.COLUMN_COMMENT AS column_comment
         FROM information_schema.COLUMNS c
         JOIN information_schema.TABLES t
           ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
        WHERE c.TABLE_SCHEMA = ? AND c.COLUMN_NAME IN (?) AND c.COLUMN_TYPE LIKE 'char(%'`,
      [ctx.database, Object.keys(WIDEN)],
    );

    const byTable = new Map<string, string[]>();
    for (const column of columns) {
      const target = WIDEN[column.column_name];
      const nullability = column.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      const fallback = column.column_default === null ? '' : ` DEFAULT ${ctx.conn.escape(column.column_default)}`;
      const comment = column.column_comment ? ` COMMENT ${ctx.conn.escape(column.column_comment)}` : '';
      const clause = `MODIFY \`${column.column_name}\` ${target} ${nullability}${fallback}${comment}`;
      byTable.set(column.table_name, [...(byTable.get(column.table_name) ?? []), clause]);
    }

    for (const [table, clauses] of byTable) {
      ctx.log(`${table}: ${clauses.length} column(s) widened`);
      await ctx.exec(`ALTER TABLE \`${table}\` ${clauses.join(', ')}`);
    }
  },
};

export default migration;
