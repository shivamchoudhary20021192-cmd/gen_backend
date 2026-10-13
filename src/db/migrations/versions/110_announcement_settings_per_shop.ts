import type { RowDataPacket } from 'mysql2/promise';
import { rows } from '../helpers';
import type { TsMigration } from '../runner';

/**
 * announcement_settings: one row per shop, for real.
 *
 * The table was a singleton — `id` defaulted to 1 with no AUTO_INCREMENT, and a
 * CHECK constraint pinned it there. 102 gave it a unique shop_id, but the
 * primary key still meant "one row, total": the second shop's
 * `INSERT IGNORE … (shop_id)` collided on id = 1, was silently ignored, and its
 * settings came back empty. The check goes, the id becomes an ordinary
 * surrogate key, and `uq_announcement_settings_shop` remains the one-per-shop
 * rule. Introspective, because not every database has the check.
 */
const migration: TsMigration = {
  description: 'announcement_settings gets a real surrogate key so every shop can have its row',
  async up(ctx) {
    const checks = await rows<RowDataPacket & { name: string }>(
      ctx,
      `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'announcement_settings' AND CONSTRAINT_TYPE = 'CHECK'`,
      [ctx.database],
    );
    const clauses = checks.map((check) => `DROP CHECK \`${check.name}\``);
    clauses.push('MODIFY `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT');
    await ctx.exec(`ALTER TABLE \`announcement_settings\` ${clauses.join(', ')}`);
  },
};

export default migration;
