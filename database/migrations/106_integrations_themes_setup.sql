-- =============================================================================
-- 106 — Integrations, themes, the setup ledger and notification preferences.
--
-- Every table here except theme_library is a tenant table (shop_id first in
-- every key). None of them has a foreign key to `shops`: tenant tables live on
-- a pod's database and `shops` on the control plane, which may be a different
-- server. Consistency with the shop is the tenancy layer's job, not MySQL's.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- integration_connections — one configured third-party account per row.
--
-- `provider` names a manifest in src/platform/integrations/providers (twilio,
-- stripe, sendgrid…); `category` is copied from it so "the default SMS
-- provider" is one indexed lookup. Credentials are sealed with the vault
-- (AES-256-GCM, bound to shop and connection) and never leave this server in
-- clear: the API only ever returns `credentials_hint`.
--
-- At most one default per category per shop: the generated marker is NULL for
-- every non-default row, and MySQL unique indexes ignore NULLs.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `integration_connections` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`             BIGINT UNSIGNED NOT NULL,
  `public_id`           CHAR(36)     NOT NULL,
  `provider`            VARCHAR(40)  NOT NULL,
  `category`            VARCHAR(30)  NOT NULL,
  `name`                VARCHAR(120) NOT NULL,
  `status`              ENUM('active','disabled','error') NOT NULL DEFAULT 'active',
  `mode`                ENUM('live','test') NOT NULL DEFAULT 'test',
  `is_default`          TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `credentials_sealed`  TEXT NULL,
  `credentials_hint`    VARCHAR(160) NULL,
  `config`              JSON NULL,
  `last_verified_at`    DATETIME NULL,
  `last_used_at`        DATETIME NULL,
  `last_error`          VARCHAR(500) NULL,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `default_marker`      VARCHAR(80) GENERATED ALWAYS AS (
                          IF(`is_default` = 1, CONCAT(`shop_id`, ':', `category`), NULL)
                        ) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_integration_connections_public_id` (`shop_id`, `public_id`),
  UNIQUE KEY `uq_integration_connections_name` (`shop_id`, `provider`, `name`),
  UNIQUE KEY `uq_integration_connections_default` (`default_marker`),
  UNIQUE KEY `uq_integration_connections_tenant` (`shop_id`, `id`),
  KEY `ix_integration_connections_category` (`shop_id`, `category`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- integration_webhook_events — what providers sent us, verified or not.
--
-- The unique key is the idempotency guarantee: providers retry, and the same
-- `payment.captured` arriving three times must be processed once. External id
-- is the provider's own event id when it has one, else a hash of the body.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `integration_webhook_events` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`         BIGINT UNSIGNED NOT NULL,
  `connection_id`   BIGINT UNSIGNED NULL,
  `provider`        VARCHAR(40)  NOT NULL,
  `external_id`     VARCHAR(190) NOT NULL,
  `event_type`      VARCHAR(120) NULL,
  `signature_valid` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `status`          ENUM('received','processed','ignored','failed') NOT NULL DEFAULT 'received',
  `attempts`        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `payload`         JSON NULL,
  `error`           VARCHAR(1000) NULL,
  `received_at`     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `processed_at`    DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_integration_webhook_events_external` (`shop_id`, `provider`, `external_id`),
  UNIQUE KEY `uq_integration_webhook_events_tenant` (`shop_id`, `id`),
  KEY `ix_integration_webhook_events_status` (`shop_id`, `status`, `received_at`),
  KEY `ix_integration_webhook_events_connection` (`shop_id`, `connection_id`, `received_at`),
  KEY `ix_integration_webhook_events_received` (`received_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- theme_library — the themes a shop can install. Control plane.
--
-- Built-in themes are defined in code (src/platform/themes/library) and synced
-- into this table at boot, keyed by handle; operators can add more rows. A
-- theme is presentation only: design tokens, layout choices, which section
-- types it can render, and the starter layout a fresh shop's pages get.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `theme_library` (
  `id`                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `handle`            VARCHAR(60)  NOT NULL,
  `name`              VARCHAR(120) NOT NULL,
  `author`            VARCHAR(120) NOT NULL DEFAULT 'Veylog',
  `version`           VARCHAR(20)  NOT NULL,
  `description`       TEXT NULL,
  `verticals`         JSON NOT NULL,
  `preview_image_url` VARCHAR(500) NULL,
  `demo_url`          VARCHAR(500) NULL,
  `price_amount`      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `currency`          CHAR(3)      NOT NULL DEFAULT 'USD',
  `settings_schema`   JSON NOT NULL,
  `presets`           JSON NOT NULL,
  `templates`         JSON NOT NULL,
  `section_types`     JSON NOT NULL,
  `is_builtin`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `status`            ENUM('draft','published','retired') NOT NULL DEFAULT 'published',
  `sort_order`        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_theme_library_handle` (`handle`),
  KEY `ix_theme_library_status` (`status`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- shop_themes — a shop's installed copies. Exactly one is `main` (live).
--
-- `settings_data` is the merchant's customisation of the theme's schema; the
-- library row is never edited through a shop. Publishing swaps roles in one
-- transaction, and the generated marker makes a second `main` impossible.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `shop_themes` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`             BIGINT UNSIGNED NOT NULL,
  `public_id`           CHAR(36)     NOT NULL,
  `library_theme_id`    INT UNSIGNED NULL,
  `library_handle`      VARCHAR(60)  NOT NULL,
  `name`                VARCHAR(120) NOT NULL,
  `role`                ENUM('main','unpublished','development') NOT NULL DEFAULT 'unpublished',
  `theme_version`       VARCHAR(20)  NOT NULL,
  `preset`              VARCHAR(60)  NULL,
  `settings_data`       JSON NOT NULL,
  `published_at`        DATETIME NULL,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `main_marker`         BIGINT UNSIGNED GENERATED ALWAYS AS (IF(`role` = 'main', `shop_id`, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shop_themes_public_id` (`shop_id`, `public_id`),
  UNIQUE KEY `uq_shop_themes_main` (`main_marker`),
  UNIQUE KEY `uq_shop_themes_tenant` (`shop_id`, `id`),
  KEY `ix_shop_themes_role` (`shop_id`, `role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- shop_setup_tasks — the provisioning ledger and the merchant's setup guide.
--
-- `provisioning` rows are the steps that seed a new shop (roles, settings,
-- taxonomies…); each is idempotent and recorded here when done, so a
-- provisioning job that dies halfway resumes where it stopped. `onboarding`
-- rows are the checklist a merchant sees ("add your first product", "set up
-- payments"), completed by the events that satisfy them.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `shop_setup_tasks` (
  `shop_id`      BIGINT UNSIGNED NOT NULL,
  `task_key`     VARCHAR(60) NOT NULL,
  `kind`         ENUM('provisioning','onboarding') NOT NULL,
  `status`       ENUM('pending','done','skipped','failed') NOT NULL DEFAULT 'pending',
  `attempts`     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `last_error`   VARCHAR(500) NULL,
  `meta`         JSON NULL,
  `sort_order`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `completed_at` DATETIME NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`shop_id`, `task_key`),
  KEY `ix_shop_setup_tasks_kind` (`shop_id`, `kind`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- notification_preferences — which automatic messages a shop sends, on which
-- channel, to whom. Absent row = the event's built-in default.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `notification_preferences` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`             BIGINT UNSIGNED NOT NULL,
  `event_key`           VARCHAR(60) NOT NULL,
  `audience`            ENUM('customer','staff') NOT NULL,
  `channel`             ENUM('email','sms','whatsapp','push') NOT NULL,
  `is_enabled`          TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `recipients`          JSON NULL,
  `updated_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notification_preferences` (`shop_id`, `event_key`, `audience`, `channel`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
