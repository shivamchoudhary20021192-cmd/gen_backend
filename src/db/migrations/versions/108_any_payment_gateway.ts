import type { RowDataPacket } from 'mysql2/promise';
import { columnExists, rows } from '../helpers';
import type { TsMigration } from '../runner';

/**
 * Lets an order be paid through any connected gateway.
 *
 * `payments.gateway` and `orders.payment_method` were ENUMs naming Razorpay,
 * which made a Stripe or PayPal payment impossible to record. They become
 * VARCHAR(40) holding the provider key (`razorpay`, `stripe`, `paypal`, `cod`,
 * `manual`…); existing values are unchanged. Nullability and defaults are
 * read from the live column and preserved.
 *
 * `payments.connection_id` remembers which integration connection took the
 * money, so a refund goes back through the same account even after the shop
 * has switched its default gateway.
 */

interface ColumnRow extends RowDataPacket {
  column_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
}

async function toVarchar(
  ctx: Parameters<TsMigration['up']>[0],
  table: string,
  column: string,
): Promise<void> {
  const [found] = await rows<ColumnRow>(
    ctx,
    `SELECT COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [ctx.database, table, column],
  );
  if (!found || !found.column_type.startsWith('enum(')) return;
  const nullability = found.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
  const fallback = found.column_default === null ? '' : ` DEFAULT ${ctx.conn.escape(found.column_default)}`;
  await ctx.exec(`ALTER TABLE \`${table}\` MODIFY \`${column}\` VARCHAR(40) ${nullability}${fallback}`);
}

const migration: TsMigration = {
  description: 'Payment gateway and method columns accept any provider',
  async up(ctx) {
    await toVarchar(ctx, 'payments', 'gateway');
    await toVarchar(ctx, 'orders', 'payment_method');
    if (!(await columnExists(ctx, 'payments', 'connection_id'))) {
      await ctx.exec('ALTER TABLE `payments` ADD COLUMN `connection_id` BIGINT UNSIGNED NULL AFTER `gateway`');
    }
  },
};

export default migration;
