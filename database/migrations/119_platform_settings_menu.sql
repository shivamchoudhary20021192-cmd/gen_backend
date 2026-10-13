-- =============================================================================
-- 119 — Sidebar entries for the platform's settings screens.
--
-- Store details and Taxes were seeded as "coming soon"; they now have screens.
-- Plan & billing, Markets, Domains, Integrations, Notifications and Apps are
-- new under Settings, and Themes joins Merchandising beside the page builder.
--
-- Each row is tied to the permission its API checks, so the sidebar never
-- offers a screen whose requests would answer 403. Idempotent: rows upsert on
-- the unique menu_key and permission links are added only when missing.
-- =============================================================================

UPDATE `menu_items` SET `status` = 'available' WHERE `menu_key` IN ('settings.store', 'settings.taxes');

INSERT INTO `menu_items` (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
)
SELECT parent.id, item.menu_key, item.title, item.icon, 'material', item.route, 0,
       item.route, CONCAT('menu.', item.menu_key), 'default', item.sort_order, 'available',
       1, 1, 0, 1, 0, 0, 0, 1
  FROM (SELECT id FROM `menu_items` WHERE `menu_key` = 'settings' LIMIT 1) AS parent
  JOIN (
    SELECT 'settings.billing' AS menu_key, 'Plan & billing' AS title, 'billing' AS icon, '/settings/billing' AS route, 15 AS sort_order
    UNION ALL SELECT 'settings.markets', 'Markets', 'markets', '/settings/markets', 25
    UNION ALL SELECT 'settings.domains', 'Domains', 'domains', '/settings/domains', 45
    UNION ALL SELECT 'settings.integrations', 'Integrations', 'integrations', '/settings/integrations', 47
    UNION ALL SELECT 'settings.notifications', 'Notifications', 'notifications_prefs', '/settings/notifications', 55
    UNION ALL SELECT 'settings.apps', 'Apps', 'apps', '/settings/apps', 58
  ) AS item ON TRUE
ON DUPLICATE KEY UPDATE
  parent_id  = VALUES(parent_id),
  title      = VALUES(title),
  icon       = VALUES(icon),
  route      = VALUES(route),
  active_match = VALUES(active_match),
  sort_order = VALUES(sort_order),
  status     = VALUES(status),
  is_active  = VALUES(is_active),
  is_visible = VALUES(is_visible);

INSERT INTO `menu_items` (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
)
SELECT parent.id, 'merchandising.themes', 'Themes', 'themes', 'material', '/merchandising/themes', 0,
       '/merchandising/themes', 'menu.merchandising.themes', 'default', 3, 'available',
       1, 1, 0, 1, 0, 0, 0, 1
  FROM (SELECT id FROM `menu_items` WHERE `menu_key` = 'merchandising' LIMIT 1) AS parent
ON DUPLICATE KEY UPDATE
  parent_id  = VALUES(parent_id),
  title      = VALUES(title),
  icon       = VALUES(icon),
  route      = VALUES(route),
  active_match = VALUES(active_match),
  sort_order = VALUES(sort_order),
  status     = VALUES(status);

INSERT INTO `menu_item_permissions` (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM `menu_items` mi
  JOIN (
    SELECT 'settings.store' AS menu_key, 'shop.view' AS slug
    UNION ALL SELECT 'settings.billing', 'billing.view'
    UNION ALL SELECT 'settings.markets', 'settings.view'
    UNION ALL SELECT 'settings.taxes', 'settings.view'
    UNION ALL SELECT 'settings.domains', 'shop.view'
    UNION ALL SELECT 'settings.integrations', 'integrations.view'
    UNION ALL SELECT 'settings.notifications', 'notifications.view'
    UNION ALL SELECT 'settings.apps', 'apps.view'
    UNION ALL SELECT 'merchandising.themes', 'themes.view'
  ) AS link ON link.menu_key = mi.menu_key
  JOIN `permissions` p ON p.slug = link.slug
 WHERE NOT EXISTS (
         SELECT 1 FROM `menu_item_permissions` existing
          WHERE existing.menu_item_id = mi.id AND existing.permission_id = p.id
       );
