-- =============================================================================
-- File 23 : Enable payments settings menu item
-- =============================================================================
-- The menu item was seeded as 'coming_soon' in 99b_navigation_seed.sql.
-- Now that the payments module is live, flip it to 'available'.
-- Safe to re-run.
-- =============================================================================

-- No USE statement: the database name differs per environment (veylog locally,
-- veylor_db on the server). Hardcoding one here made every migration below fail
-- with "Access denied" on the deployed box. Connect to the right database
-- instead: `mysql -D <database> < this-file.sql`.
UPDATE `menu_items`
   SET `status` = 'available'
 WHERE `menu_key` = 'settings.payments';
