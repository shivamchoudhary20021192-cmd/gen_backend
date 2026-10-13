-- ────────────────────────────────────────────────────────────────────────────
-- 43 — The announcement strip in the Content menu
--
--   mysql -u <user> -p <database> < database/43_announcements_menu.sql
--
-- The lines above the header. Beside Banners rather than inside it, because a
-- banner is a hero with a photograph and this is a sentence — and because the
-- strip has settings of its own (how fast it rotates, whether it can be closed)
-- that belong to the strip rather than to any one line in it.
--
-- Sits at 32, between Banners (30) and FAQs (40), so nothing is renumbered.
--
-- The parent is found by menu_key rather than a hardcoded id, and cms.view is
-- attached the way migrations 35 and 40 attached it to the rest of the group.
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
  parent.id, 'content.announcements', 'Announcement bar', 'announcement', 'material',
  '/content/announcements', 0, '/content/announcements', 'menu.content.announcements',
  'default', 32, 'available', 1, 1, 0, 1, 0, 0, 0, 1
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
 WHERE mi.menu_key = 'content.announcements'
   AND NOT EXISTS (
         SELECT 1 FROM menu_item_permissions existing
          WHERE existing.menu_item_id = mi.id
            AND existing.permission_id = p.id
       );

SELECT 'Migration 43 applied.' AS result;
