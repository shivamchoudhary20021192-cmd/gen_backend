-- =============================================================================
-- File 16 : Enable the Roles & permissions menu item
-- =============================================================================
-- `99b_navigation_seed.sql` deliberately never overwrites `status` on re-run —
-- that is what lets a super admin hide or rename an item without a redeploy
-- undoing it. The cost is that a row seeded as 'coming_soon' stays that way
-- forever once the screen behind it exists, so shipping a screen needs an
-- explicit flip.
--
-- Safe to re-run, and it will not resurrect an item somebody deliberately hid:
-- only 'coming_soon' is promoted.
-- =============================================================================

-- No USE statement: the database name differs per environment (veylog locally,
-- veylor_db on the server). Hardcoding one here made every migration below fail
-- with "Access denied" on the deployed box. Connect to the right database
-- instead: `mysql -D <database> < this-file.sql`.
UPDATE `menu_items`
   SET `status` = 'available'
 WHERE `menu_key` = 'settings.roles'
   AND `status` = 'coming_soon';

SELECT `menu_key`, `status` FROM `menu_items` WHERE `menu_key` IN ('settings.staff','settings.roles');
