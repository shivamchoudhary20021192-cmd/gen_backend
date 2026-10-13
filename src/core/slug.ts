import { queryOne, type Executor, type RowDataPacket } from '../db/pool';
import { shopId } from '../platform/tenancy/context';

const ALLOWED_TABLES = new Set([
  'products',
  'categories',
  'collections',
  'ingredients',
  'cms_pages',
  'cms_articles',
  'routines',
  'brands',
  'creators',
]);

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180);
}

interface SlugRow extends RowDataPacket {
  id: number;
}

/**
 * Returns a slug that is free in `table` IN THE CURRENT SHOP, appending -2,
 * -3 … if needed. Two shops can both have a product called "serum".
 * `excludeId` lets an update keep its own slug.
 *
 * The table name is checked against a whitelist because it is interpolated —
 * a parameter placeholder cannot stand in for an identifier in MySQL.
 */
export async function uniqueSlug(
  table: string,
  desired: string,
  excludeId?: number,
  exec?: Executor,
): Promise<string> {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`uniqueSlug called with a non-whitelisted table: ${table}`);
  }

  const base = slugify(desired) || 'item';
  let candidate = base;
  let suffix = 1;

  for (;;) {
    const sql = excludeId
      ? `SELECT id FROM \`${table}\` WHERE shop_id = ? AND slug = ? AND id <> ? LIMIT 1`
      : `SELECT id FROM \`${table}\` WHERE shop_id = ? AND slug = ? LIMIT 1`;
    const params = excludeId ? [shopId(), candidate, excludeId] : [shopId(), candidate];
    const existing = await queryOne<SlugRow>(sql, params, exec);
    if (!existing) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
    if (suffix > 500) throw new Error(`Could not derive a unique slug for "${desired}"`);
  }
}
