-- ────────────────────────────────────────────────────────────────────────────
-- 40 — Story sections in the Content menu
--
--   mysql -u <user> -p <database> < database/40_sections_menu.sql
--
-- The claims strip, the packaging diagram, a model's routine. A section is
-- authored once here and attached to as many products as it belongs on, so it
-- lives beside Pages and Blogs rather than inside any one product.
--
-- Sits at 48, between Creators (45) and Storefront navigation (50), so nothing
-- else has to be renumbered.
--
-- The parent is found by menu_key rather than a hardcoded id, and cms.view is
-- attached the way migration 35 attached it to the rest of the group: a row with
-- no permission behind it is visible to everyone while the API returns 403.
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
  parent.id, 'content.sections', 'Story sections', 'sections', 'material',
  '/content/sections', 0, '/content/sections', 'menu.content.sections',
  'default', 48, 'available', 1, 1, 0, 1, 0, 0, 0, 1
FROM (SELECT id FROM menu_items WHERE menu_key = 'content' LIMIT 1) AS parent
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
 WHERE mi.menu_key = 'content.sections'
   AND NOT EXISTS (
         SELECT 1 FROM menu_item_permissions existing
          WHERE existing.menu_item_id = mi.id
            AND existing.permission_id = p.id
       );

SELECT 'Migration 40 applied.' AS result;
