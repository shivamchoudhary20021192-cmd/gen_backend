-- ────────────────────────────────────────────────────────────────────────────
-- 33 — the re-engagement menu row needs a permission
--
--   mysql -u <user> -p <database> < database/33_reengagement_menu_permission.sql
--
-- Migration 32 added the "Wanted, not bought" row but attached no permission to
-- it, so every staff member saw the link while the API behind it requires
-- customers.view. Someone without that permission clicked a live-looking menu
-- item and got a 403 with no explanation.
--
-- Idempotent: safe to run more than once.
-- ────────────────────────────────────────────────────────────────────────────

INSERT INTO menu_item_permissions (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM menu_items mi
  JOIN permissions p ON p.slug = 'customers.view'
 WHERE mi.menu_key = 'customers.reengagement'
   AND NOT EXISTS (
         SELECT 1 FROM menu_item_permissions existing
          WHERE existing.menu_item_id = mi.id
            AND existing.permission_id = p.id
       );

SELECT 'Migration 33 applied.' AS result;
