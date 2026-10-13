-- =============================================================================
-- 124 — Customers → Messages: the Online Store's contact form has an inbox.
--
-- `contact_messages` (migration 123) collects what shoppers send through a
-- theme's {% form 'contact' %}. This adds its sidebar entry, visible to staff
-- who can view customers.
-- =============================================================================

INSERT INTO `menu_items` (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
)
SELECT parent.id, 'customers.messages', 'Messages', 'mail', 'material', '/customers/messages', 0,
       '/customers/messages', 'menu.customers.messages', 'default', 27, 'available',
       1, 1, 0, 1, 0, 0, 0, 1
  FROM (SELECT id FROM `menu_items` WHERE `menu_key` = 'customers' LIMIT 1) AS parent
ON DUPLICATE KEY UPDATE
  parent_id    = VALUES(parent_id),
  title        = VALUES(title),
  icon         = VALUES(icon),
  route        = VALUES(route),
  active_match = VALUES(active_match),
  sort_order   = VALUES(sort_order),
  status       = VALUES(status);

INSERT INTO `menu_item_permissions` (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM `menu_items` mi
  JOIN `permissions` p ON p.slug = 'customers.view'
 WHERE mi.menu_key = 'customers.messages'
   AND NOT EXISTS (
         SELECT 1 FROM `menu_item_permissions` existing
          WHERE existing.menu_item_id = mi.id AND existing.permission_id = p.id
       );
