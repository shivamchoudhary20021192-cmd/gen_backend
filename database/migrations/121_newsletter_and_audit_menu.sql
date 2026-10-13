-- =============================================================================
-- 121 — Newsletter subscribers, and two sidebar entries that now have screens.
--
-- A storefront's "sign up for news" box collects an email and nothing else.
-- Customers here are identified by phone, so an email on its own cannot be a
-- customer; it is a subscriber. The consent itself is still written to the
-- append-only `customer_consents` log (by subject_identifier, the email), and
-- when the email belongs to a customer that customer's email-marketing flag
-- follows it.
--
-- Unsubscribing is a link in every email and needs no sign-in, so each
-- subscriber carries an unguessable token.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `newsletter_subscribers` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`           BIGINT UNSIGNED NOT NULL,
  `email`             VARCHAR(191) NOT NULL,
  `status`            ENUM('subscribed','unsubscribed') NOT NULL DEFAULT 'subscribed',
  -- Where they signed up: the footer, checkout, a pop-up, an import.
  `source`            ENUM('footer','checkout','popup','account','import','admin') NOT NULL DEFAULT 'footer',
  `customer_id`       BIGINT UNSIGNED NULL,
  `unsubscribe_token` CHAR(43) NOT NULL,
  `country_code`      CHAR(2) NULL,
  `subscribed_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `unsubscribed_at`   DATETIME NULL,
  `created_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_newsletter_subscribers_email` (`shop_id`, `email`),
  UNIQUE KEY `uq_newsletter_subscribers_token` (`unsubscribe_token`),
  KEY `ix_newsletter_subscribers_status` (`shop_id`, `status`, `subscribed_at`),
  KEY `ix_newsletter_subscribers_customer` (`shop_id`, `customer_id`),
  CONSTRAINT `fk_newsletter_subscribers_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The audit log has a screen now.
UPDATE `menu_items` SET `status` = 'available' WHERE `menu_key` = 'settings.audit';

INSERT INTO `menu_items` (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
)
SELECT parent.id, 'customers.subscribers', 'Subscribers', 'subscribers', 'material', '/customers/subscribers', 0,
       '/customers/subscribers', 'menu.customers.subscribers', 'default', 25, 'available',
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
 WHERE mi.menu_key = 'customers.subscribers'
   AND NOT EXISTS (
         SELECT 1 FROM `menu_item_permissions` existing
          WHERE existing.menu_item_id = mi.id AND existing.permission_id = p.id
       );
