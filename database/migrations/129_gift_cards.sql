-- =============================================================================
-- 129 — Gift cards, the way Shopify has them.
--
--   gift_cards               a card: its value, balance, currency, expiry, who
--                            it is for. The code is never stored in the clear:
--                            code_hash (SHA-256 of shop and code) finds it at
--                            checkout, code_sealed (the vault, AES-256-GCM,
--                            bound to the row) lets the customer's gift card
--                            page show it, last_characters is what staff see.
--   gift_card_transactions   every change to a balance — issued, spent on an
--                            order, credited back when that order is cancelled,
--                            adjusted by staff — with the balance after it.
--
-- A gift card is spent like a payment, not a discount: the order's total and
-- tax are unchanged, orders.gift_card_total records how much of it the cards
-- paid, and amount_due is what is left for the gateway or cash on delivery.
-- Cards are sold as products (products.is_gift_card): no delivery, no tax, no
-- discounts, paid online, issued and sent when the order is paid.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `gift_cards` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`              BIGINT UNSIGNED NOT NULL,
  `code_hash`            CHAR(64)        NOT NULL,
  `code_sealed`          VARCHAR(255)    NOT NULL,
  `last_characters`      CHAR(4)         NOT NULL,
  -- The customer's page: /gift_cards/<lookup_token>. Random, unrelated to the code.
  `lookup_token`         CHAR(32)        NOT NULL,
  `initial_value`        DECIMAL(12,2)   NOT NULL,
  `balance`              DECIMAL(12,2)   NOT NULL,
  `currency`             CHAR(3)         NOT NULL,
  `expires_on`           DATE            NULL,
  `status`               ENUM('enabled','disabled') NOT NULL DEFAULT 'enabled',
  `source`               ENUM('manual','purchase','api') NOT NULL DEFAULT 'manual',
  `customer_id`          BIGINT UNSIGNED NULL,
  `order_id`             BIGINT UNSIGNED NULL,
  `order_item_id`        BIGINT UNSIGNED NULL,
  -- Which of the line's cards this is (a quantity of 3 issues 1, 2 and 3): issuing twice is a no-op.
  `order_item_sequence`  SMALLINT UNSIGNED NULL,
  `recipient_name`       VARCHAR(120)    NULL,
  `recipient_email`      VARCHAR(191)    NULL,
  `recipient_phone`      VARCHAR(24)     NULL,
  `message`              VARCHAR(500)    NULL,
  `note`                 VARCHAR(500)    NULL,
  `created_by_admin_id`  BIGINT UNSIGNED NULL,
  `disabled_at`          DATETIME        NULL,
  `last_used_at`         DATETIME        NULL,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_gift_cards_code` (`shop_id`, `code_hash`),
  UNIQUE KEY `uq_gift_cards_lookup` (`lookup_token`),
  UNIQUE KEY `uq_gift_cards_order_item` (`shop_id`, `order_item_id`, `order_item_sequence`),
  KEY `ix_gift_cards_list` (`shop_id`, `status`, `created_at`),
  KEY `ix_gift_cards_customer` (`shop_id`, `customer_id`),
  KEY `ix_gift_cards_last` (`shop_id`, `last_characters`),
  CONSTRAINT `fk_gift_cards_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `gift_card_transactions` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`        BIGINT UNSIGNED NOT NULL,
  `gift_card_id`   BIGINT UNSIGNED NOT NULL,
  `kind`           ENUM('issue','debit','credit','adjustment') NOT NULL,
  -- Signed: spent is negative, credited and issued are positive.
  `amount`         DECIMAL(12,2)   NOT NULL,
  `balance_after`  DECIMAL(12,2)   NOT NULL,
  `order_id`       BIGINT UNSIGNED NULL,
  `note`           VARCHAR(500)    NULL,
  `actor_type`     ENUM('admin','customer','system') NOT NULL DEFAULT 'system',
  `actor_id`       BIGINT UNSIGNED NULL,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_gift_card_transactions_card` (`shop_id`, `gift_card_id`, `id`),
  KEY `ix_gift_card_transactions_order` (`shop_id`, `order_id`),
  CONSTRAINT `fk_gift_card_transactions_card` FOREIGN KEY (`gift_card_id`) REFERENCES `gift_cards` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The cards a shopper has put against their bag (ids, in the order applied).
ALTER TABLE `carts` ADD COLUMN `gift_card_ids` JSON NULL AFTER `coupon_code`;
ALTER TABLE `products` ADD COLUMN `is_gift_card` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0;
ALTER TABLE `orders` ADD COLUMN `gift_card_total` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `amount_due`;

-- Permissions: issuing a card is issuing money.
INSERT IGNORE INTO `permissions` (slug, module, action, name, description, is_dangerous, sort_order) VALUES
  ('gift_cards.view', 'gift_cards', 'view', 'View gift cards', 'See gift cards, balances and their history (never the full code).', 0, 0),
  ('gift_cards.manage', 'gift_cards', 'manage', 'Issue and manage gift cards', 'Issue gift cards, change expiry, adjust balances, disable cards.', 1, 0);

-- Whoever manages discounts manages gift cards; whoever sees discounts sees them.
INSERT IGNORE INTO `role_permissions` (shop_id, role_id, permission_id)
SELECT DISTINCT rp.shop_id, rp.role_id, target.id
  FROM `role_permissions` rp
  JOIN `permissions` source ON source.id = rp.permission_id
  JOIN `permissions` target ON (source.slug = 'coupons.manage' AND target.slug IN ('gift_cards.view', 'gift_cards.manage'))
                            OR (source.slug = 'coupons.view' AND target.slug = 'gift_cards.view')
 WHERE NOT EXISTS (
         SELECT 1 FROM `role_permissions` existing
          WHERE existing.shop_id = rp.shop_id AND existing.role_id = rp.role_id AND existing.permission_id = target.id
       );

-- Products → Gift cards.
INSERT INTO `menu_items` (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
)
SELECT parent.id, 'products.gift_cards', 'Gift cards', 'card_giftcard', 'material', '/gift-cards', 0,
       '/gift-cards', 'menu.products.gift_cards', 'default', 45, 'available',
       1, 1, 0, 1, 0, 0, 0, 1
  FROM (SELECT id FROM `menu_items` WHERE `menu_key` = 'products' LIMIT 1) AS parent
ON DUPLICATE KEY UPDATE
  parent_id = VALUES(parent_id), title = VALUES(title), icon = VALUES(icon), route = VALUES(route),
  active_match = VALUES(active_match), sort_order = VALUES(sort_order), status = VALUES(status);

INSERT INTO `menu_item_permissions` (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM `menu_items` mi
  JOIN `permissions` p ON p.slug = 'gift_cards.view'
 WHERE mi.menu_key = 'products.gift_cards'
   AND NOT EXISTS (
         SELECT 1 FROM `menu_item_permissions` existing
          WHERE existing.menu_item_id = mi.id AND existing.permission_id = p.id
       );

-- The message that carries a new card to its recipient, for every existing shop
-- (new shops get it from the blueprint). A template a shop already has is kept.
INSERT IGNORE INTO `notification_templates` (shop_id, event_key, channel, category, locale, name, subject, body, is_transactional, is_active)
SELECT s.id, t.event_key, t.channel, 'transactional', 'en-IN', t.name, t.subject, t.body, 1, 1
  FROM `shops` s,
       (
    SELECT 'gift_card.issued' AS event_key, 'email' AS channel, 'Gift card — Email' AS name,
           'Your {{gift_card_value}} {{shop_name}} gift card' AS subject,
           'Hi {{first_name}},\n\n{{gift_card_message}}You have a {{gift_card_value}} gift card for {{shop_name}}.\n\nCode: {{gift_card_code}}\n{{gift_card_expiry}}\nUse it at checkout, or see its balance any time: {{gift_card_url}}\n\n— {{shop_name}}' AS body
    UNION ALL
    SELECT 'gift_card.issued', 'sms', 'Gift card — SMS', NULL,
           '{{shop_name}}: your {{gift_card_value}} gift card code is {{gift_card_code}}. Balance: {{gift_card_url}}'
    UNION ALL
    SELECT 'gift_card.issued', 'whatsapp', 'Gift card — WhatsApp', NULL,
           'You have a {{gift_card_value}} gift card for {{shop_name}}. Code: {{gift_card_code}}. See it any time: {{gift_card_url}}'
       ) AS t;
