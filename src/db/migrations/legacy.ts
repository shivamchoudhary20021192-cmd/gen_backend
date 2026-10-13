/**
 * The hand-applied schema files that predate the migration runner, in the
 * order they were actually applied.
 *
 * The numbering alone does not give that order: `99_seed_reference` seeds
 * tables created by 01–13 and must run before 14, and `99b_navigation_seed`
 * fills the menu created by 14 and must run before 16 edits it. The order is
 * written out here once instead of being rediscovered by whoever builds the
 * next fresh database.
 *
 * These are never edited again. An existing database is marked as having all
 * of them with `npm run db:migrate -- baseline`; a fresh one replays them.
 * Every change from here on is a new file under database/migrations or
 * src/db/migrations/versions.
 */
export const LEGACY_MIGRATIONS: readonly string[] = [
  '00_database.sql',
  '01_admin_rbac.sql',
  '02_media.sql',
  '03_taxonomy.sql',
  '04_catalog.sql',
  '05_inventory.sql',
  '06_cms.sql',
  '07_customers.sql',
  '08_cart_orders.sql',
  '09_payments_shipping.sql',
  '10_marketing.sql',
  '11_reviews.sql',
  '12_support_ops.sql',
  '13_system.sql',
  '99_seed_reference.sql',
  '14_navigation.sql',
  '99b_navigation_seed.sql',
  '15_collection_seo.sql',
  '16_menu_enable_roles.sql',
  '17_number_sequences.sql',
  '18_enable_orders_customers_menu.sql',
  '19_fulfilment_setup.sql',
  '20_enable_fulfilment_menu.sql',
  '21_enable_inventory_menu.sql',
  '22_enable_shipping_menu.sql',
  '23_enable_payments_menu.sql',
  '25_products_cosmetics_enhancement.sql',
  '26_lookup_tables.sql',
  '27_additional_lookup_categories.sql',
  '28_advanced_sidebar.sql',
  '29_customer_segments.sql',
  '30_fix_menu_active_match.sql',
  '31_reviews_setup.sql',
  '32_saved_products_and_reengagement.sql',
  '33_reengagement_menu_permission.sql',
  '34_content_starter.sql',
  '35_content_menu_available.sql',
  '36_content_blogs_menu.sql',
  '37_banner_video_poster.sql',
  '38_banner_video_fixes.sql',
  '38_product_storytelling.sql',
  '39_creators_menu.sql',
  '40_sections_menu.sql',
  '41_creator_identity.sql',
  '42_announcements.sql',
  '43_announcements_menu.sql',
  '44_shelves.sql',
  '45_merchandising_menu.sql',
  '46_page_builder.sql',
  '47_page_builder_menu.sql',
  '48_messaging.sql',
  '49_messaging_menu.sql',
];

/**
 * Fixes for legacy files that cannot replay as written.
 *
 * Each of these failed when it was first applied by hand and was finished off
 * manually, so an existing database has the intended result and a fresh one
 * would stop at the error. The patch is applied to the replay only; the file on
 * disk and its checksum stay exactly as they were.
 */
const LEGACY_PATCHES: Record<string, (sql: string) => string> = {
  // media_variants has never had a variant_type column; posters are the
  // variant_key. The statement is a data fix, a no-op on an empty database.
  '38_banner_video_fixes.sql': (sql) => sql.replace(/v\.variant_type\s*=\s*'poster'/g, "v.variant_key = 'poster'"),
};

/**
 * The legacy files hardcode the database name. Rewriting it is what lets the
 * same files build `veylog_test` or a per-developer database without a copy.
 */
export function retargetLegacySql(sql: string, database: string, file?: string): string {
  const patched = file && LEGACY_PATCHES[file] ? LEGACY_PATCHES[file](sql) : sql;
  return patched
    .replace(/CREATE DATABASE IF NOT EXISTS `veylog`/gi, `CREATE DATABASE IF NOT EXISTS \`${database}\``)
    .replace(/USE `veylog`\s*;/gi, `USE \`${database}\`;`);
}
