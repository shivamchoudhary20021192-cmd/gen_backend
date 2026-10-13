-- ────────────────────────────────────────────────────────────────────────────
-- 49 · Messaging in the sidebar
--
--   mysql -u <user> -p <database> < database/49_messaging_menu.sql
--
-- Row 23 — menu_key 'notifications', "Message templates", Marketing, 80 — has
-- been sitting on `coming_soon` since the first navigation seed. It becomes the
-- parent of the four screens that make up messaging, keeping its key, its
-- section and its sort order so nothing that references it has to move:
--
--     Messaging
--       Message templates   /notifications/templates
--       Campaigns           /notifications/campaigns
--       Delivery log        /notifications/activity
--       Senders             /notifications/senders
--
-- The parent's title changes from "Message templates" to "Messaging" because
-- the templates are now one of its four children rather than the whole of it,
-- and its route goes NULL — the same shape as Content, Settings and
-- Merchandising, which are groups rather than destinations.
--
-- Idempotent through ON DUPLICATE KEY UPDATE on the unique menu_key.
-- ────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

-- ── the parent ──────────────────────────────────────────────────────────────
UPDATE menu_items
   SET title        = 'Messaging',
       route        = NULL,
       active_match = '/notifications',
       icon         = 'message',
       status       = 'available',
       is_active    = 1,
       is_visible   = 1
 WHERE menu_key = 'notifications';

-- ── the children ────────────────────────────────────────────────────────────
--
-- One statement each rather than one statement with a UNION: MySQL will not
-- accept ON DUPLICATE KEY UPDATE on an INSERT ... SELECT whose source is a
-- union, and being able to re-run this file matters more than being terse.
DROP PROCEDURE IF EXISTS veylor_messaging_child;
DELIMITER $$
CREATE PROCEDURE veylor_messaging_child(
  IN p_key VARCHAR(80), IN p_title VARCHAR(120), IN p_subtitle VARCHAR(255),
  IN p_icon VARCHAR(60), IN p_route VARCHAR(191), IN p_sort SMALLINT
)
BEGIN
  INSERT INTO menu_items (
    parent_id, menu_key, title, subtitle, icon, icon_type, route, prefetch_data,
    active_match, analytics_key, badge_variant, sort_order, status,
    is_active, is_visible, show_in_collapsed, is_pinnable,
    requires_super_admin, is_external, opens_new_tab, is_system
  )
  SELECT parent.id, p_key, p_title, p_subtitle, p_icon, 'material', p_route, 0,
         p_route, CONCAT('menu.', p_key), 'default', p_sort, 'available',
         1, 1, 0, 1, 0, 0, 0, 1
    FROM (SELECT id FROM menu_items WHERE menu_key = 'notifications' LIMIT 1) AS parent
  ON DUPLICATE KEY UPDATE
    parent_id    = VALUES(parent_id),
    title        = VALUES(title),
    subtitle     = VALUES(subtitle),
    icon         = VALUES(icon),
    route        = VALUES(route),
    active_match = VALUES(active_match),
    sort_order   = VALUES(sort_order),
    status       = VALUES(status),
    is_active    = VALUES(is_active),
    is_visible   = VALUES(is_visible);
END$$
DELIMITER ;

CALL veylor_messaging_child('notifications.templates', 'Message templates',
  'What the shop says, per channel', 'description', '/notifications/templates', 10);
CALL veylor_messaging_child('notifications.campaigns', 'Campaigns',
  'One message to many people', 'campaign', '/notifications/campaigns', 20);
CALL veylor_messaging_child('notifications.activity', 'Delivery log',
  'Every message the shop has sent', 'receipt_long', '/notifications/activity', 30);
CALL veylor_messaging_child('notifications.senders', 'Senders',
  'Who messages come from, and the providers behind them', 'verified_user', '/notifications/senders', 40);

DROP PROCEDURE IF EXISTS veylor_messaging_child;

-- ── who may see them ────────────────────────────────────────────────────────
INSERT INTO menu_item_permissions (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM menu_items mi
  JOIN permissions p ON p.slug = 'notifications.view'
 WHERE mi.menu_key IN (
         'notifications', 'notifications.templates', 'notifications.campaigns',
         'notifications.activity', 'notifications.senders'
       )
   AND NOT EXISTS (
         SELECT 1 FROM menu_item_permissions existing
          WHERE existing.menu_item_id = mi.id AND existing.permission_id = p.id
       );

SELECT 'Migration 49 applied.' AS result;
