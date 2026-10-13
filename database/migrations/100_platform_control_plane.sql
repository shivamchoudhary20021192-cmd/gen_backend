-- =============================================================================
-- 100 · PLATFORM CONTROL PLANE
-- =============================================================================
-- Everything before this file describes ONE shop. From here on the database
-- describes a platform that hosts many, the way Shopify does:
--
--   pods           a physical database a set of shops lives on. One today; the
--                  router in src/db/pods.ts is what makes the second one a
--                  config change instead of a rewrite.
--   plans          what a shop pays for, and the limits/features that buys.
--   organizations  the merchant business. Owns one or more shops.
--   shops          the tenant. Every commerce row from 102 onward carries its id.
--   shop_domains   how a request finds its shop: handle.<platform domain> for
--                  every shop, plus any custom domains the merchant verifies.
--   shop_subscriptions  the billing state that decides whether a shop is open.
--   shop_staff     which identities may act in which shop, and as what.
--
-- These tables are the CONTROL PLANE: they are read before a shop is known
-- (resolving a hostname, signing someone in), so the tenant guard does not
-- demand a shop_id predicate on them. Tenant data lives in the pods.
-- =============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `pods` (
  `id`                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`              VARCHAR(40)  NOT NULL,
  `region`            VARCHAR(40)  NOT NULL DEFAULT 'default',
  -- draining: existing shops keep working, no new shops land here.
  -- read_only: maintenance; writes are refused at the router.
  `status`            ENUM('active','draining','read_only','offline') NOT NULL DEFAULT 'active',
  `accepts_new_shops` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `capacity`          INT UNSIGNED NOT NULL DEFAULT 5000,
  `notes`             VARCHAR(255) NULL,
  `created_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pods_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO `pods` (`id`, `name`, `region`, `notes`)
VALUES (1, 'pod-1', 'default', 'The original database. Holds the control plane as well until a second pod exists.');

-- -----------------------------------------------------------------------------
-- plans — limits are numbers (NULL = unlimited), features are booleans. Both
-- are JSON because adding the eleventh limit must not be a migration; the keys
-- the code understands are declared in src/platform/plans/entitlements.ts.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `plans` (
  `id`                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `handle`              VARCHAR(40)  NOT NULL,
  `name`                VARCHAR(80)  NOT NULL,
  `tagline`             VARCHAR(160) NULL,
  `price_amount`        DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `currency`            CHAR(3)      NOT NULL DEFAULT 'INR',
  `billing_interval`    ENUM('month','year') NOT NULL DEFAULT 'month',
  `trial_days`          SMALLINT UNSIGNED NOT NULL DEFAULT 14,
  -- Charged on orders paid through a third-party gateway, in basis points.
  `transaction_fee_bps` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `limits`              JSON NOT NULL,
  `features`            JSON NOT NULL,
  `is_public`           TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `is_active`           TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `sort_order`          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_plans_handle` (`handle`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO `plans`
  (`handle`, `name`, `tagline`, `price_amount`, `trial_days`, `transaction_fee_bps`, `limits`, `features`, `is_public`, `sort_order`)
VALUES
  ('starter', 'Starter', 'Everything to open your first store', 1499.00, 14, 200,
   JSON_OBJECT('staff_accounts', 2, 'products', 500, 'locations', 2, 'custom_domains', 1, 'themes', 3,
               'webhook_subscriptions', 20, 'installed_apps', 5, 'api_bucket_size', 40, 'api_leak_rate', 2, 'storage_gb', 5),
   JSON_OBJECT('custom_domain', true, 'third_party_integrations', true, 'api_access', false, 'abandoned_checkout_recovery', false,
               'advanced_reports', false, 'multi_location_inventory', false, 'remove_platform_branding', false, 'automation_flows', false,
               'marketing_campaigns', false),
   1, 10),
  ('growth', 'Growth', 'For stores that are selling every day', 4999.00, 14, 100,
   JSON_OBJECT('staff_accounts', 10, 'products', 10000, 'locations', 5, 'custom_domains', 3, 'themes', 10,
               'webhook_subscriptions', 100, 'installed_apps', 25, 'api_bucket_size', 40, 'api_leak_rate', 2, 'storage_gb', 50),
   JSON_OBJECT('custom_domain', true, 'third_party_integrations', true, 'api_access', true, 'abandoned_checkout_recovery', true,
               'advanced_reports', true, 'multi_location_inventory', true, 'remove_platform_branding', false, 'automation_flows', true,
               'marketing_campaigns', true),
   1, 20),
  ('advanced', 'Advanced', 'Scale with custom reporting and higher API limits', 14999.00, 14, 50,
   JSON_OBJECT('staff_accounts', 15, 'products', NULL, 'locations', 10, 'custom_domains', 10, 'themes', 20,
               'webhook_subscriptions', 500, 'installed_apps', NULL, 'api_bucket_size', 80, 'api_leak_rate', 4, 'storage_gb', 250),
   JSON_OBJECT('custom_domain', true, 'third_party_integrations', true, 'api_access', true, 'abandoned_checkout_recovery', true,
               'advanced_reports', true, 'multi_location_inventory', true, 'remove_platform_branding', true, 'automation_flows', true,
               'marketing_campaigns', true),
   1, 30),
  ('enterprise', 'Enterprise', 'Negotiated terms, dedicated capacity', 0.00, 0, 0,
   JSON_OBJECT('staff_accounts', NULL, 'products', NULL, 'locations', 200, 'custom_domains', 50, 'themes', 20,
               'webhook_subscriptions', NULL, 'installed_apps', NULL, 'api_bucket_size', 400, 'api_leak_rate', 20, 'storage_gb', NULL),
   JSON_OBJECT('custom_domain', true, 'third_party_integrations', true, 'api_access', true, 'abandoned_checkout_recovery', true,
               'advanced_reports', true, 'multi_location_inventory', true, 'remove_platform_branding', true, 'automation_flows', true,
               'marketing_campaigns', true),
   0, 40);

CREATE TABLE IF NOT EXISTS `organizations` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`     CHAR(36)     NOT NULL,
  `name`          VARCHAR(160) NOT NULL,
  `owner_user_id` BIGINT UNSIGNED NULL,
  `billing_email` VARCHAR(190) NULL,
  `country_code`  CHAR(2)      NOT NULL DEFAULT 'IN',
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`    DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_organizations_public_id` (`public_id`),
  KEY `ix_organizations_owner` (`owner_user_id`),
  CONSTRAINT `fk_organizations_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- shops — the tenant.
--
-- `handle` is permanent: it is the platform subdomain and appears in every app
-- installation and webhook header. `name` is what the merchant calls the shop
-- and can change daily.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `shops` (
  `id`                          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`                   CHAR(36)     NOT NULL,
  `handle`                      VARCHAR(60)  NOT NULL,
  `name`                        VARCHAR(160) NOT NULL,
  `email`                       VARCHAR(190) NULL,
  `phone`                       VARCHAR(20)  NULL,
  `organization_id`             BIGINT UNSIGNED NULL,
  `owner_user_id`               BIGINT UNSIGNED NULL,
  `pod_id`                      INT UNSIGNED NOT NULL DEFAULT 1,
  `plan_id`                     INT UNSIGNED NULL,
  -- provisioning → active ⇄ paused/frozen/suspended → closed
  `status`                      ENUM('provisioning','active','paused','frozen','suspended','closed') NOT NULL DEFAULT 'provisioning',
  `status_reason`               VARCHAR(255) NULL,
  -- Which blueprint the shop was provisioned from: beauty, fashion,
  -- electronics, grocery, home, general. Decides seeded taxonomies and theme.
  `vertical`                    VARCHAR(40)  NOT NULL DEFAULT 'general',
  `country_code`                CHAR(2)      NOT NULL DEFAULT 'IN',
  `currency`                    CHAR(3)      NOT NULL DEFAULT 'INR',
  `timezone`                    VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata',
  `locale`                      VARCHAR(10)  NOT NULL DEFAULT 'en',
  `weight_unit`                 ENUM('g','kg','lb','oz') NOT NULL DEFAULT 'g',
  -- in_gst | eu_vat | us_sales_tax | none — see src/platform/tax.
  `tax_engine`                  VARCHAR(40)  NOT NULL DEFAULT 'none',
  -- The "opening soon" gate: storefront API refuses anonymous reads until the
  -- visitor presents the password. bcrypt, never the plain value.
  `storefront_password_enabled` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `storefront_password_hash`    VARCHAR(255) NULL,
  `provisioned_at`              DATETIME NULL,
  `closed_at`                   DATETIME NULL,
  `created_at`                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shops_public_id` (`public_id`),
  UNIQUE KEY `uq_shops_handle` (`handle`),
  KEY `ix_shops_organization` (`organization_id`),
  KEY `ix_shops_owner` (`owner_user_id`),
  KEY `ix_shops_pod_status` (`pod_id`, `status`),
  KEY `ix_shops_plan` (`plan_id`),
  CONSTRAINT `fk_shops_pod` FOREIGN KEY (`pod_id`) REFERENCES `pods` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_shops_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_shops_organization` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_shops_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_shops_handle` CHECK (REGEXP_LIKE(`handle`, '^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- shop_domains — hostname → shop. The storefront resolver's only lookup.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `shop_domains` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`             BIGINT UNSIGNED NOT NULL,
  -- Lower-case, no scheme, no port, no trailing dot.
  `hostname`            VARCHAR(253) NOT NULL,
  `kind`                ENUM('platform','custom') NOT NULL,
  `is_primary`          TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  -- Custom domains prove ownership with a TXT record carrying this token.
  `verification_status` ENUM('pending','verified','failed') NOT NULL DEFAULT 'pending',
  `verification_token`  CHAR(32) NOT NULL,
  `verified_at`         DATETIME NULL,
  `ssl_status`          ENUM('pending','active','failed') NOT NULL DEFAULT 'pending',
  `redirect_to_primary` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `last_checked_at`     DATETIME NULL,
  `failure_reason`      VARCHAR(255) NULL,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- At most one primary per shop, enforced by the index rather than by hope.
  `primary_marker`      BIGINT UNSIGNED GENERATED ALWAYS AS (IF(`is_primary` = 1, `shop_id`, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shop_domains_hostname` (`hostname`),
  UNIQUE KEY `uq_shop_domains_primary` (`primary_marker`),
  KEY `ix_shop_domains_shop` (`shop_id`, `kind`),
  KEY `ix_shop_domains_pending` (`verification_status`, `last_checked_at`),
  CONSTRAINT `fk_shop_domains_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- shop_subscriptions — history of plan changes; exactly one is live.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `shop_subscriptions` (
  `id`                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`                  BIGINT UNSIGNED NOT NULL,
  `plan_id`                  INT UNSIGNED NOT NULL,
  `status`                   ENUM('trialing','active','past_due','frozen','cancelled') NOT NULL,
  -- The price at the moment of subscribing, so a plan repricing does not
  -- silently change what an existing shop is billed.
  `price_amount`             DECIMAL(12,2) NOT NULL,
  `currency`                 CHAR(3) NOT NULL,
  `billing_interval`         ENUM('month','year') NOT NULL DEFAULT 'month',
  `trial_ends_at`            DATETIME NULL,
  `current_period_start`     DATETIME NOT NULL,
  `current_period_end`       DATETIME NOT NULL,
  `cancel_at_period_end`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `cancelled_at`             DATETIME NULL,
  `provider`                 VARCHAR(40) NOT NULL DEFAULT 'manual',
  `provider_subscription_id` VARCHAR(120) NULL,
  `created_at`               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `live_marker`              BIGINT UNSIGNED GENERATED ALWAYS AS (IF(`status` <> 'cancelled', `shop_id`, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shop_subscriptions_live` (`live_marker`),
  KEY `ix_shop_subscriptions_shop` (`shop_id`, `status`),
  KEY `ix_shop_subscriptions_period` (`status`, `current_period_end`),
  CONSTRAINT `fk_shop_subscriptions_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_shop_subscriptions_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- shop_staff — identity ⇄ shop membership.
--
-- An admin_users row is a person (one login, one password, one MFA secret).
-- Whether that person may act in a given shop, and with what authority, is a
-- row here. It sits in the control plane because signing in has to list a
-- person's shops before any one shop is chosen.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `shop_staff` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`             BIGINT UNSIGNED NOT NULL,
  `admin_user_id`       BIGINT UNSIGNED NOT NULL,
  `is_owner`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  -- Every permission in this shop without listing them. Owners always have it.
  `has_full_access`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `status`              ENUM('invited','active','suspended') NOT NULL DEFAULT 'active',
  `job_title`           VARCHAR(120) NULL,
  `invited_by_admin_id` BIGINT UNSIGNED NULL,
  `joined_at`           DATETIME NULL,
  `last_accessed_at`    DATETIME NULL,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `owner_marker`        BIGINT UNSIGNED GENERATED ALWAYS AS (IF(`is_owner` = 1, `shop_id`, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shop_staff_member` (`shop_id`, `admin_user_id`),
  UNIQUE KEY `uq_shop_staff_owner` (`owner_marker`),
  KEY `ix_shop_staff_user` (`admin_user_id`, `status`),
  CONSTRAINT `fk_shop_staff_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_shop_staff_user` FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_shop_staff_inviter` FOREIGN KEY (`invited_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_shop_staff_owner_full` CHECK (`is_owner` = 0 OR `has_full_access` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
