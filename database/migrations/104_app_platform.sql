-- =============================================================================
-- 104 · APP PLATFORM
-- =============================================================================
-- Shopify's extension model: third parties build apps; a merchant installs one
-- through OAuth, granting named scopes; the app then calls the Admin API with
-- an offline access token and receives webhooks for the topics it subscribed
-- to. A merchant can also build a "custom app" for their own shop and get a
-- token directly, without OAuth.
--
--   apps                       the app itself (control plane: resolved by
--                              client_id before any shop is known)
--   app_installations          an app on a shop, with the scopes granted (tenant)
--   app_access_tokens          offline Admin API tokens (control plane: a token
--                              is what TELLS us the shop)
--   oauth_authorization_codes  the short-lived code of the OAuth dance
--   storefront_access_tokens   public tokens for headless storefronts/channels
--
-- No foreign keys cross between control-plane and tenant tables: in a
-- multi-pod deployment they live in different databases.
-- =============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `apps` (
  `id`                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`                 CHAR(36)     NOT NULL,
  -- The public identifier an app sends in OAuth (Shopify's "API key").
  `client_id`                 VARCHAR(64)  NOT NULL,
  -- Needed in the clear to sign webhooks and OAuth redirects, so it is
  -- encrypted with the vault rather than hashed.
  `client_secret_ciphertext`  TEXT         NOT NULL,
  `client_secret_hint`        VARCHAR(12)  NOT NULL,
  `handle`                    VARCHAR(80)  NOT NULL,
  `name`                      VARCHAR(120) NOT NULL,
  `tagline`                   VARCHAR(200) NULL,
  `description`               TEXT         NULL,
  `icon_url`                  VARCHAR(500) NULL,
  `developer_name`            VARCHAR(160) NULL,
  `developer_email`           VARCHAR(190) NULL,
  `support_url`               VARCHAR(500) NULL,
  `privacy_policy_url`        VARCHAR(500) NULL,
  -- Where the merchant lands after installing.
  `app_url`                   VARCHAR(500) NULL,
  -- Receives customers/data_request, customers/redact and shop/redact for
  -- every shop the app is installed on. Required before a public app can be
  -- published: handling privacy requests is a condition of access to data.
  `compliance_webhook_url`    VARCHAR(500) NULL,
  -- OAuth redirect_uri must be one of these, exactly.
  `redirect_urls`             JSON         NOT NULL,
  `requested_scopes`          JSON         NOT NULL,
  -- public: listed for every shop. custom: built by one shop for itself.
  `distribution`              ENUM('public','custom') NOT NULL DEFAULT 'public',
  `owner_shop_id`             BIGINT UNSIGNED NULL,
  `status`                    ENUM('draft','published','delisted') NOT NULL DEFAULT 'draft',
  `webhook_api_version`       VARCHAR(10)  NOT NULL DEFAULT '2026-10',
  -- The identity the app acts as, so `created_by` columns and the audit log
  -- can say "Created by Klaviyo" instead of nothing.
  `bot_admin_user_id`         BIGINT UNSIGNED NULL,
  `created_by_admin_id`       BIGINT UNSIGNED NULL,
  `created_at`                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`                DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_apps_public_id` (`public_id`),
  UNIQUE KEY `uq_apps_client_id` (`client_id`),
  UNIQUE KEY `uq_apps_handle` (`handle`),
  KEY `ix_apps_listing` (`distribution`, `status`),
  KEY `ix_apps_owner_shop` (`owner_shop_id`),
  CONSTRAINT `fk_apps_bot` FOREIGN KEY (`bot_admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_apps_creator` FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `app_installations` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`               BIGINT UNSIGNED NOT NULL,
  `app_id`                BIGINT UNSIGNED NOT NULL,
  `granted_scopes`        JSON NOT NULL,
  `status`                ENUM('active','uninstalled') NOT NULL DEFAULT 'active',
  `installed_by_admin_id` BIGINT UNSIGNED NULL,
  `installed_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `uninstalled_at`        DATETIME NULL,
  `updated_at`            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_app_installations_app` (`shop_id`, `app_id`),
  UNIQUE KEY `uq_app_installations_tenant` (`shop_id`, `id`),
  KEY `ix_app_installations_status` (`shop_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `app_access_tokens` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`         BIGINT UNSIGNED NOT NULL,
  `app_id`          BIGINT UNSIGNED NOT NULL,
  `installation_id` BIGINT UNSIGNED NOT NULL,
  `token_hash`      CHAR(64)    NOT NULL,
  -- The last few characters, so a merchant can tell two tokens apart.
  `token_hint`      VARCHAR(12) NOT NULL,
  `scopes`          JSON        NOT NULL,
  `last_used_at`    DATETIME NULL,
  `revoked_at`      DATETIME NULL,
  `revoked_reason`  VARCHAR(60) NULL,
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_app_access_tokens_hash` (`token_hash`),
  KEY `ix_app_access_tokens_installation` (`shop_id`, `installation_id`, `revoked_at`),
  CONSTRAINT `fk_app_access_tokens_app` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `oauth_authorization_codes` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code_hash`     CHAR(64)     NOT NULL,
  `app_id`        BIGINT UNSIGNED NOT NULL,
  `shop_id`       BIGINT UNSIGNED NOT NULL,
  `admin_user_id` BIGINT UNSIGNED NOT NULL,
  `scopes`        JSON         NOT NULL,
  `redirect_uri`  VARCHAR(500) NOT NULL,
  `expires_at`    DATETIME     NOT NULL,
  `used_at`       DATETIME     NULL,
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_oauth_codes_hash` (`code_hash`),
  KEY `ix_oauth_codes_expiry` (`expires_at`),
  CONSTRAINT `fk_oauth_codes_app` FOREIGN KEY (`app_id`) REFERENCES `apps` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_oauth_codes_admin` FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `storefront_access_tokens` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`             BIGINT UNSIGNED NOT NULL,
  `app_id`              BIGINT UNSIGNED NULL,
  `title`               VARCHAR(120) NOT NULL,
  `token_hash`          CHAR(64)     NOT NULL,
  `token_hint`          VARCHAR(12)  NOT NULL,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `last_used_at`        DATETIME NULL,
  `revoked_at`          DATETIME NULL,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_storefront_access_tokens_hash` (`token_hash`),
  KEY `ix_storefront_access_tokens_shop` (`shop_id`, `revoked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Permissions for everything the platform adds. Seeded into every shop's
-- founder role below; new shops get them from the provisioning blueprint.
-- -----------------------------------------------------------------------------
INSERT IGNORE INTO `permissions` (`slug`, `module`, `action`, `name`, `description`, `is_dangerous`, `sort_order`) VALUES
  ('shop.view',           'shop',         'view',   'View store details',         'Store profile, plan and usage.', 0, 1000),
  ('shop.manage',         'shop',         'manage', 'Manage store details',       'Name, contact, currency, timezone and storefront password.', 1, 1001),
  ('domains.manage',      'domains',      'manage', 'Manage domains',             'Connect, verify and choose the primary domain.', 1, 1010),
  ('billing.view',        'billing',      'view',   'View billing',               'Plan, invoices and usage.', 0, 1020),
  ('billing.manage',      'billing',      'manage', 'Manage billing',             'Change plan and payment details.', 1, 1021),
  ('apps.view',           'apps',         'view',   'View apps',                  'Installed apps and what they can access.', 0, 1030),
  ('apps.manage',         'apps',         'manage', 'Install and remove apps',    'Grant apps access to store data.', 1, 1031),
  ('apps.develop',        'apps',         'develop','Develop custom apps',        'Create custom apps and their API tokens.', 1, 1032),
  ('webhooks.manage',     'webhooks',     'manage', 'Manage webhooks',            'Send store events to external URLs.', 1, 1040),
  ('integrations.view',   'integrations', 'view',   'View integrations',          'Connected payment, messaging and shipping providers.', 0, 1050),
  ('integrations.manage', 'integrations', 'manage', 'Manage integrations',        'Connect providers and store their credentials.', 1, 1051),
  ('themes.view',         'themes',       'view',   'View themes',                'Installed themes and their settings.', 0, 1060),
  ('themes.manage',       'themes',       'manage', 'Edit and publish themes',    'Change what the storefront looks like.', 0, 1061),
  ('notifications.templates', 'notifications', 'templates', 'Edit customer notifications', 'Order, shipping and account messages.', 0, 1070);

INSERT IGNORE INTO `role_permissions` (`shop_id`, `role_id`, `permission_id`)
SELECT r.shop_id, r.id, p.id
  FROM `roles` r
  JOIN `permissions` p ON p.module IN ('shop','domains','billing','apps','webhooks','integrations','themes','notifications')
 WHERE r.slug = 'founder';

INSERT IGNORE INTO `role_permissions` (`shop_id`, `role_id`, `permission_id`)
SELECT r.shop_id, r.id, p.id
  FROM `roles` r
  JOIN `permissions` p ON p.slug IN ('themes.view','themes.manage','apps.view','integrations.view','shop.view')
 WHERE r.slug IN ('content','developer');

INSERT IGNORE INTO `role_permissions` (`shop_id`, `role_id`, `permission_id`)
SELECT r.shop_id, r.id, p.id
  FROM `roles` r
  JOIN `permissions` p ON p.slug IN ('apps.develop','apps.manage','webhooks.manage','integrations.manage')
 WHERE r.slug = 'developer';
