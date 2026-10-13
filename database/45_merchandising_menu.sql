-- ────────────────────────────────────────────────────────────────────────────
-- 45 — Merchandising in the sidebar
--
--   mysql -u <user> -p <database> < database/45_merchandising_menu.sql
--
-- A top-level group of its own rather than a ninth row under Content. A shelf
-- is not content: content is what the shop *says* (pages, articles, banners,
-- the announcement line), and a shelf is how the shop *sells* — which products
-- appear where, in what order, chosen by which rule. They are edited by
-- different people on different days, and Content is already eight rows deep.
--
-- Sits at 95, between Content (90) and Media (100), in the Content section of
-- the sidebar — the storefront cluster, where someone arranging the shop
-- window is already looking.
--
-- Idempotent through ON DUPLICATE KEY UPDATE on the unique menu_key.
-- ────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

-- The group. No route of its own: clicking it opens its children, exactly as
-- Content and Settings do.
INSERT INTO menu_items (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, section, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
) VALUES (
  NULL, 'merchandising', 'Merchandising', 'merchandising', 'material', NULL, 0,
  NULL, 'menu.merchandising', 'default', 'Content', 95, 'available',
  1, 1, 1, 0, 0, 0, 0, 1
)
ON DUPLICATE KEY UPDATE
  title      = VALUES(title),
  icon       = VALUES(icon),
  section    = VALUES(section),
  sort_order = VALUES(sort_order),
  status     = VALUES(status),
  is_active  = VALUES(is_active),
  is_visible = VALUES(is_visible);

-- Shelves, inside it. The parent is found by menu_key rather than a hardcoded
-- id, so this runs correctly against a database where the ids fell differently.
INSERT INTO menu_items (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
)
SELECT
  parent.id, 'merchandising.shelves', 'Shelves', 'shelves', 'material',
  '/merchandising/shelves', 0, '/merchandising/shelves', 'menu.merchandising.shelves',
  'default', 10, 'available', 1, 1, 0, 1, 0, 0, 0, 1
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

-- Permissions, the way migrations 35, 40 and 43 attached them to the rest of
-- the storefront group. A shelf decides what the shop shows, so it is gated on
-- the CMS permission rather than on product editing: the person arranging the
-- window is not necessarily the person who may change a price.
INSERT INTO menu_item_permissions (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM menu_items mi
  JOIN permissions p ON p.slug = 'cms.view'
 WHERE mi.menu_key IN ('merchandising', 'merchandising.shelves')
   AND NOT EXISTS (
         SELECT 1 FROM menu_item_permissions existing
          WHERE existing.menu_item_id = mi.id
            AND existing.permission_id = p.id
       );

SELECT 'Migration 45 applied.' AS result;
