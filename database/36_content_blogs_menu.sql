-- ────────────────────────────────────────────────────────────────────────────
-- 36 — Blogs in the Content menu
--
--   mysql -u <user> -p <database> < database/36_content_blogs_menu.sql
--
-- Articles have always belonged to a blog, and a shop can now run more than one
-- of them ("Journal", "News", "Guides"), each with its own page on the site.
-- There was no way into that from the sidebar, so this adds the row.
--
-- It sits at 25 — directly after Journal at 20 and before Banners at 30 — so
-- nothing else has to be renumbered. The blog is the container and the Journal
-- lists what is in it, so they belong next to each other.
--
-- The parent is looked up by menu_key rather than hardcoded: the Content row is
-- id 24 on the development database, and there is no reason for it to be 24
-- everywhere.
--
-- cms.view is attached the same way migration 35 attached it to the rest of the
-- group. A row with no permission behind it is visible to everyone, while the
-- API behind it requires cms.view — which shows a staff member a live-looking
-- link and then a 403.
--
-- Idempotent: menu_key is unique, so a second run updates the row it already
-- wrote rather than adding another.
-- ────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

INSERT INTO menu_items (
  parent_id,
  menu_key,
  title,
  icon,
  icon_type,
  route,
  prefetch_data,
  active_match,
  analytics_key,
  badge_variant,
  sort_order,
  status,
  is_active,
  is_visible,
  show_in_collapsed,
  is_pinnable,
  requires_super_admin,
  is_external,
  opens_new_tab,
  is_system
)
SELECT
  parent.id,
  'content.blogs',
  'Blogs',
  'blog',
  'material',
  '/content/blogs',
  0,
  '/content/blogs',
  'menu.content.blogs',
  'default',
  25,
  'available',
  1,
  1,
  0,
  1,
  0,
  0,
  0,
  1
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

-- Same permission as the rest of Content.
INSERT INTO menu_item_permissions (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM menu_items mi
  JOIN permissions p ON p.slug = 'cms.view'
 WHERE mi.menu_key = 'content.blogs'
   AND NOT EXISTS (
         SELECT 1 FROM menu_item_permissions existing
          WHERE existing.menu_item_id = mi.id
            AND existing.permission_id = p.id
       );

SELECT 'Migration 36 applied.' AS result;
