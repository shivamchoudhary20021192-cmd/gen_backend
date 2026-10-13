-- ────────────────────────────────────────────────────────────────────────────
-- 35 — the Content menu is real, so stop greying it out
--
--   mysql -u <user> -p <database> < database/35_content_menu_available.sql
--
-- Every row under Content sat at 'coming_soon', so the whole group rendered
-- disabled in the sidebar with a "Soon" chip — including Pages, Banners and
-- FAQs, which have had working admin screens and a full API for some time. The
-- screens were reachable only by typing the URL.
--
-- Redirects stays 'coming_soon' on purpose: its screens are still placeholders,
-- and the frontend's route registry leaves it out for the same reason. Flip it
-- on the commit that builds it.
--
-- Also attaches cms.view to each row. Without a permission attached a menu row
-- is visible to everyone, while the API behind it requires cms.view — so a
-- staff member without it saw a live-looking link and got a 403.
--
-- Idempotent: safe to run more than once.
-- ────────────────────────────────────────────────────────────────────────────

UPDATE menu_items
   SET status = 'available'
 WHERE menu_key IN (
   'content',
   'content.pages',
   'content.articles',
   'content.banners',
   'content.faqs',
   'content.menus'
 );

INSERT INTO menu_item_permissions (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM menu_items mi
  JOIN permissions p ON p.slug = 'cms.view'
 WHERE mi.menu_key IN (
   'content',
   'content.pages',
   'content.articles',
   'content.banners',
   'content.faqs',
   'content.redirects'
 )
   AND NOT EXISTS (
         SELECT 1 FROM menu_item_permissions existing
          WHERE existing.menu_item_id = mi.id
            AND existing.permission_id = p.id
       );

-- Storefront navigation is menu editing, which has its own permission.
INSERT INTO menu_item_permissions (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM menu_items mi
  JOIN permissions p ON p.slug = 'cms.menus'
 WHERE mi.menu_key = 'content.menus'
   AND NOT EXISTS (
         SELECT 1 FROM menu_item_permissions existing
          WHERE existing.menu_item_id = mi.id
            AND existing.permission_id = p.id
       );

SELECT 'Migration 35 applied.' AS result;
