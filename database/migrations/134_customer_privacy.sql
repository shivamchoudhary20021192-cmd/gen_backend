-- =============================================================================
-- 134 — Customer privacy: policies, the cookie banner and Customer Privacy API,
--       the tracking-consent record, and privacy requests.
--
-- What Shopify calls Settings → Policies and Settings → Customer privacy, plus
-- the privacy-request workflow behind Customers → Consents & privacy:
--
--   shop_policies / shop_policy_versions
--       Privacy policy, terms of service, refund, shipping, contact information
--       and legal notice, served at /policies/*. Every save is a new version
--       and the old text is kept, so a consent can be traced to the exact
--       notice the shopper was shown (GDPR Art. 7(1), DPDP s.5–6).
--
--   shop_privacy_settings
--       The cookie banner (where it shows, how it looks, what it says), the
--       "Do not sell or share" opt-out for US shoppers, Global Privacy Control,
--       response deadlines for requests, and the grievance officer the DPDP
--       Act asks a data fiduciary to name. No row means the defaults.
--
--   customer_tracking_consents
--       Append-only: one row per choice a visitor makes in the banner, the
--       preferences dialog or on the opt-out page — the proof of consent.
--       The IP is kept truncated (/24, /48): where from, never who.
--
--   customer_data_exports
--       The data file an access or portability request produces, downloadable
--       by staff and — through a link that expires — by the customer.
--
--   data_requests (existing, from the DPDP schema) gains how the request
--       came in, identity verification, and the erasure schedule.
--
-- Idempotent: safe to run again, and safe to run by hand on an existing
-- database (npm run db:migrate running it afterwards changes nothing).
-- =============================================================================

SET NAMES utf8mb4;

-- ── policies ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `shop_policies` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`              BIGINT UNSIGNED NOT NULL,
  `kind`                 ENUM('privacy','terms','refund','shipping','contact','legal_notice') NOT NULL,
  `title`                VARCHAR(191)    NOT NULL,
  `body`                 MEDIUMTEXT      NOT NULL,
  -- Bumped on every change; consent records cite it.
  `version`              INT UNSIGNED    NOT NULL DEFAULT 1,
  `updated_by_admin_id`  BIGINT UNSIGNED NULL,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shop_policies_kind` (`shop_id`, `kind`),
  UNIQUE KEY `uq_shop_policies_tenant` (`shop_id`, `id`),
  CONSTRAINT `fk_shop_policies_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `shop_policy_versions` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`              BIGINT UNSIGNED NOT NULL,
  `kind`                 ENUM('privacy','terms','refund','shipping','contact','legal_notice') NOT NULL,
  `version`              INT UNSIGNED    NOT NULL,
  `title`                VARCHAR(191)    NOT NULL,
  `body`                 MEDIUMTEXT      NOT NULL,
  `created_by_admin_id`  BIGINT UNSIGNED NULL,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shop_policy_versions` (`shop_id`, `kind`, `version`),
  CONSTRAINT `fk_shop_policy_versions_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── the cookie banner, the opt-out, and request handling ─────────────────────

CREATE TABLE IF NOT EXISTS `shop_privacy_settings` (
  `shop_id`                    BIGINT UNSIGNED NOT NULL,
  `banner_enabled`             TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  -- required: where the law asks for opt-in consent (EU/EEA, UK, Switzerland,
  -- India, Brazil); all: everywhere; custom: banner_countries.
  `banner_regions`             ENUM('required','all','custom') NOT NULL DEFAULT 'required',
  `banner_countries`           JSON NULL,
  `banner_position`            ENUM('bottom','bottom_left','bottom_right','center') NOT NULL DEFAULT 'bottom',
  -- {background, text, button, button_text}; null follows the defaults.
  `banner_colors`              JSON NULL,
  -- {locale: {title, message, accept, decline, manage}}; unset strings use the built-in wording.
  `banner_copy`                JSON NULL,
  `consent_max_age_days`       SMALLINT UNSIGNED NOT NULL DEFAULT 365,
  `reprompt_on_policy_change`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `sale_opt_out_enabled`       TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `sale_opt_out_countries`     JSON NULL,
  `honor_gpc`                  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `request_form_enabled`       TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `request_response_days`      SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  `erasure_grace_days`         SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  `erasure_order_hold_days`    SMALLINT UNSIGNED NOT NULL DEFAULT 180,
  `privacy_email`              VARCHAR(191) NULL,
  `grievance_officer_name`     VARCHAR(120) NULL,
  `grievance_officer_email`    VARCHAR(191) NULL,
  `grievance_officer_phone`    VARCHAR(40)  NULL,
  `updated_by_admin_id`        BIGINT UNSIGNED NULL,
  `created_at`                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`shop_id`),
  CONSTRAINT `fk_shop_privacy_settings_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── the proof of consent ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `customer_tracking_consents` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`              BIGINT UNSIGNED NOT NULL,
  -- The id in the visitor's _tracking_consent cookie: random, set only when
  -- they choose, and used for nothing but finding their choices again.
  `consent_id`           CHAR(36)        NOT NULL,
  `customer_id`          BIGINT UNSIGNED NULL,
  `country`              CHAR(2)         NULL,
  `consent_required`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `sale_opt_out_region`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `analytics`            TINYINT(1) UNSIGNED NOT NULL,
  `marketing`            TINYINT(1) UNSIGNED NOT NULL,
  `preferences`          TINYINT(1) UNSIGNED NOT NULL,
  `sale_of_data`         TINYINT(1) UNSIGNED NOT NULL,
  `method`               ENUM('accept_all','reject_all','custom','opt_out_page','gpc','api','account') NOT NULL,
  `gpc`                  TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `policy_version`       INT UNSIGNED    NULL,
  `locale`               VARCHAR(10)     NULL,
  `page_path`            VARCHAR(255)    NULL,
  `ip_prefix`            VARCHAR(45)     NULL,
  `user_agent`           VARCHAR(255)    NULL,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_tracking_consents_created` (`shop_id`, `created_at`),
  KEY `ix_tracking_consents_consent` (`shop_id`, `consent_id`),
  KEY `ix_tracking_consents_customer` (`shop_id`, `customer_id`),
  CONSTRAINT `fk_tracking_consents_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── privacy requests ─────────────────────────────────────────────────────────

ALTER TABLE `data_requests`
  MODIFY `status` ENUM('verifying','received','in_progress','scheduled','completed','rejected','cancelled') NOT NULL DEFAULT 'received';

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'data_requests' AND column_name = 'source') = 0,
  'ALTER TABLE `data_requests`
     ADD COLUMN `source` ENUM(''storefront'',''account'',''admin'',''api'') NOT NULL DEFAULT ''admin'' AFTER `request_type`,
     ADD COLUMN `requester_country` CHAR(2) NULL AFTER `source`,
     ADD COLUMN `verification_token_hash` CHAR(64) NULL AFTER `details`,
     ADD COLUMN `verification_expires_at` DATETIME NULL AFTER `verification_token_hash`,
     ADD COLUMN `scheduled_for` DATETIME NULL AFTER `due_at`,
     ADD COLUMN `processed_at` DATETIME NULL AFTER `scheduled_for`,
     ADD COLUMN `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`,
     ADD UNIQUE KEY `uq_data_requests_verification` (`verification_token_hash`),
     ADD KEY `ix_data_requests_scheduled` (`status`, `scheduled_for`)',
  'DO 0'
);
PREPARE `stmt134` FROM @ddl;
EXECUTE `stmt134`;
DEALLOCATE PREPARE `stmt134`;

CREATE TABLE IF NOT EXISTS `customer_data_exports` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`              BIGINT UNSIGNED NOT NULL,
  `data_request_id`      BIGINT UNSIGNED NOT NULL,
  `customer_id`          BIGINT UNSIGNED NULL,
  -- The JSON document itself: small, private, and gone when it expires.
  `content`              LONGTEXT        NOT NULL,
  `size_bytes`           INT UNSIGNED    NOT NULL,
  `download_token_hash`  CHAR(64)        NULL,
  `expires_at`           DATETIME        NOT NULL,
  `downloaded_at`        DATETIME        NULL,
  `created_by_admin_id`  BIGINT UNSIGNED NULL,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customer_data_exports_token` (`download_token_hash`),
  KEY `ix_customer_data_exports_request` (`shop_id`, `data_request_id`),
  KEY `ix_customer_data_exports_expiry` (`expires_at`),
  CONSTRAINT `fk_customer_data_exports_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_customer_data_exports_request` FOREIGN KEY (`data_request_id`) REFERENCES `data_requests` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── permissions ──────────────────────────────────────────────────────────────

INSERT IGNORE INTO `permissions` (slug, module, action, name, description, is_dangerous, sort_order) VALUES
  ('privacy.view', 'privacy', 'view', 'View privacy requests and consent records', 'See privacy requests, their status and deadlines, and the record of cookie consents.', 0, 0),
  ('privacy.settings', 'privacy', 'settings', 'Manage the cookie banner and policies', 'Change the cookie banner, the data-sharing opt-out and the store''s policies.', 1, 0);

-- Whoever sees customers sees privacy requests; whoever manages settings manages
-- the banner and the policies; whoever may delete customers handles requests.
INSERT IGNORE INTO `role_permissions` (shop_id, role_id, permission_id)
SELECT DISTINCT rp.shop_id, rp.role_id, target.id
  FROM `role_permissions` rp
  JOIN `permissions` source ON source.id = rp.permission_id
  JOIN `permissions` target ON (source.slug = 'customers.view' AND target.slug = 'privacy.view')
                            OR (source.slug = 'settings.manage' AND target.slug = 'privacy.settings')
                            OR (source.slug = 'customers.delete' AND target.slug = 'data_requests.manage')
 WHERE NOT EXISTS (
         SELECT 1 FROM `role_permissions` existing
          WHERE existing.shop_id = rp.shop_id AND existing.role_id = rp.role_id AND existing.permission_id = target.id
       );

-- ── the admin menu ───────────────────────────────────────────────────────────

-- Customers → Consents & privacy: built now.
UPDATE `menu_items`
   SET `status` = 'available', `route` = '/privacy', `active_match` = '/privacy', `badge_key` = 'privacy.open'
 WHERE `menu_key` = 'customers.privacy';

INSERT INTO `menu_items` (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
)
SELECT parent.id, entry.menu_key, entry.title, entry.icon, 'material', entry.route, 0,
       entry.route, CONCAT('menu.', entry.menu_key), 'default', entry.sort_order, 'available',
       1, 1, 0, 1, 0, 0, 0, 1
  FROM (SELECT id FROM `menu_items` WHERE `menu_key` = 'settings' LIMIT 1) AS parent,
       (
    SELECT 'settings.customer_privacy' AS menu_key, 'Customer privacy' AS title, 'shield' AS icon, '/settings/customer-privacy' AS route, 33 AS sort_order
    UNION ALL
    SELECT 'settings.policies', 'Policies', 'policy', '/settings/policies', 34
       ) AS entry
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
  JOIN `permissions` p ON (mi.menu_key = 'customers.privacy' AND p.slug = 'privacy.view')
                       OR (mi.menu_key IN ('settings.customer_privacy', 'settings.policies') AND p.slug = 'settings.view')
 WHERE NOT EXISTS (
         SELECT 1 FROM `menu_item_permissions` existing
          WHERE existing.menu_item_id = mi.id AND existing.permission_id = p.id
       );

-- ── the messages a request sends ─────────────────────────────────────────────

-- For every existing shop (new shops get them from the blueprint). A template a
-- shop already has is kept.
INSERT IGNORE INTO `notification_templates` (shop_id, event_key, channel, category, locale, name, subject, body, is_transactional, is_active)
SELECT s.id, t.event_key, 'email', 'transactional', 'en-IN', t.name, t.subject, t.body, 1, 1
  FROM `shops` s,
       (
    SELECT 'privacy.request_verify' AS event_key, 'Privacy request: confirm it is you — Email' AS name,
           'Confirm your privacy request to {{shop_name}}' AS subject,
           'Hi,\n\nWe received a request to {{request_action}} the personal data {{shop_name}} holds about {{contact}}.\n\nIf this was you, confirm it here (the link works for 48 hours):\n{{link}}\n\nIf it was not you, ignore this email — nothing will happen.\n\nReference: {{reference}}\n\n— {{shop_name}}' AS body
    UNION ALL
    SELECT 'privacy.request_received', 'Privacy request received — Email',
           'We have your privacy request {{reference}}',
           'Hi {{first_name}},\n\nWe have your request to {{request_action}} your personal data, reference {{reference}}. We will respond by {{due_date}}.\n\nQuestions about it: {{privacy_contact}}\n\n— {{shop_name}}'
    UNION ALL
    SELECT 'privacy.request_completed', 'Privacy request completed — Email',
           'Your privacy request {{reference}} is complete',
           'Hi {{first_name}},\n\n{{outcome}}\n\n{{link_line}}If you are not satisfied with how we handled it, contact {{privacy_contact}}.\n\n— {{shop_name}}'
    UNION ALL
    SELECT 'staff.privacy_request', 'New privacy request — Staff email',
           'New privacy request {{reference}}',
           '{{title}}\n\n{{body}}\n\n— {{shop_name}}'
       ) AS t;
