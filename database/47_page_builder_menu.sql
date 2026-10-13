-- ────────────────────────────────────────────────────────────────────────────
-- 47 — The page builder in the sidebar
--
--   mysql -u <user> -p <database> < database/47_page_builder_menu.sql
--
-- Under Merchandising, above Shelves, because that is the order of the work: a
-- merchandiser lays out the page first and fills a shelf second. Both are about
-- how the shop sells rather than what it says, which is why neither is in
-- Content.
--
-- Idempotent through ON DUPLICATE KEY UPDATE on the unique menu_key.
-- ────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

INSERT INTO menu_items (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
)
SELECT
  parent.id, 'merchandising.pages', 'Page builder', 'page_builder', 'material',
  '/merchandising/pages', 0, '/merchandising/pages', 'menu.merchandising.pages',
  'default', 5, 'available', 1, 1, 0, 1, 0, 0, 0, 1
FROM (SELECT id FROM menu_items WHERE menu_key = 'merchandising' LIMIT 1) AS parent
ON DUPLICATE KEY UPDATE
  parent_id    = VALUES(parent_id),
  title        = VALUES(title),
  icon         = VALUES(icon),
  route        = VALUES(route),
  active_match = VALUES(active_match),
  sort_order   = VALUES(sort_order),
  status       = VALUES(status),
  is_active    = VALUES(is_active),
  is_visible   = VALUES(is_visible);

INSERT INTO menu_item_permissions (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM menu_items mi
  JOIN permissions p ON p.slug = 'cms.view'
 WHERE mi.menu_key = 'merchandising.pages'
   AND NOT EXISTS (
         SELECT 1 FROM menu_item_permissions existing
          WHERE existing.menu_item_id = mi.id AND existing.permission_id = p.id
       );

SELECT 'Migration 47 applied.' AS result;
