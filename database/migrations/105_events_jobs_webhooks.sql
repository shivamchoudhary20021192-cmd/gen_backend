-- =============================================================================
-- 105 · EVENTS, JOBS, WEBHOOKS
-- =============================================================================
-- The asynchronous spine of the platform.
--
--   events         transactional outbox. A service writes the event in the
--                  SAME transaction as the change it describes, so an order
--                  never exists without its orders/create event and an event
--                  never describes a change that rolled back. (tenant)
--
--   jobs           the work queue. Claimed with FOR UPDATE SKIP LOCKED, so any
--                  number of workers can pull from it without a broker. Retries
--                  with backoff, dead-letters after max_attempts. (control plane:
--                  one queue for every shop, so one worker pool serves all.)
--
--   webhook_subscriptions / webhook_deliveries
--                  who wants to hear about which topic, and what happened each
--                  time we told them. (tenant)
-- =============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `events` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`           BIGINT UNSIGNED NOT NULL,
  -- Sent as X-Veylog-Event-Id. Receivers de-duplicate on it: delivery is at
  -- least once, never exactly once.
  `event_uuid`        CHAR(36)     NOT NULL,
  `topic`             VARCHAR(80)  NOT NULL,
  `resource_type`     VARCHAR(40)  NULL,
  `resource_id`       BIGINT UNSIGNED NULL,
  `payload`           JSON         NOT NULL,
  `actor_type`        VARCHAR(20)  NULL,
  `actor_id`          BIGINT UNSIGNED NULL,
  -- Set when an event is for one app only (app/uninstalled goes to the app
  -- that was uninstalled, not to every subscriber of the topic).
  `only_app_id`       BIGINT UNSIGNED NULL,
  `occurred_at`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `dispatched_at`     DATETIME(3)  NULL,
  `dispatch_attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `last_error`        VARCHAR(500) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_events_uuid` (`shop_id`, `event_uuid`),
  UNIQUE KEY `uq_events_tenant` (`shop_id`, `id`),
  KEY `ix_events_pending` (`dispatched_at`, `id`),
  KEY `ix_events_topic` (`shop_id`, `topic`, `occurred_at`),
  KEY `ix_events_resource` (`shop_id`, `resource_type`, `resource_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `jobs` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `queue`           VARCHAR(40)  NOT NULL DEFAULT 'default',
  `type`            VARCHAR(80)  NOT NULL,
  `shop_id`         BIGINT UNSIGNED NULL,
  `payload`         JSON         NOT NULL,
  `status`          ENUM('pending','running','succeeded','dead','cancelled') NOT NULL DEFAULT 'pending',
  -- Lower runs sooner.
  `priority`        TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `attempts`        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts`    SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  `run_at`          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `locked_by`       VARCHAR(80)  NULL,
  `lock_expires_at` DATETIME(3)  NULL,
  -- Enqueueing the same unique_key twice is a no-op. How an event fan-out that
  -- runs twice after a crash still delivers each webhook once, and how two
  -- workers' schedulers agree on who runs the 10:05 tick.
  `unique_key`      VARCHAR(190) NULL,
  `last_error`      TEXT         NULL,
  `created_at`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `started_at`      DATETIME(3)  NULL,
  `finished_at`     DATETIME(3)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_jobs_unique_key` (`unique_key`),
  KEY `ix_jobs_claim` (`status`, `queue`, `run_at`, `priority`),
  KEY `ix_jobs_lock` (`status`, `lock_expires_at`),
  KEY `ix_jobs_shop` (`shop_id`, `type`, `status`),
  KEY `ix_jobs_finished` (`status`, `finished_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `webhook_subscriptions` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`              BIGINT UNSIGNED NOT NULL,
  `public_id`            CHAR(36)      NOT NULL,
  -- The app that owns it. NULL: created by staff in the admin.
  `app_id`               BIGINT UNSIGNED NULL,
  `topic`                VARCHAR(80)   NOT NULL,
  `address`              VARCHAR(1000) NOT NULL,
  `api_version`          VARCHAR(10)   NOT NULL,
  -- Optional allow-list of top-level payload fields, to keep bodies small.
  `include_fields`       JSON          NULL,
  -- Staff-created subscriptions sign with their own secret; app-owned ones
  -- sign with the app's client secret, as Shopify's do.
  `secret_ciphertext`    TEXT          NULL,
  `status`               ENUM('active','disabled') NOT NULL DEFAULT 'active',
  `disabled_reason`      VARCHAR(255)  NULL,
  `consecutive_failures` INT UNSIGNED  NOT NULL DEFAULT 0,
  `failing_since`        DATETIME      NULL,
  `last_success_at`      DATETIME      NULL,
  `last_failure_at`      DATETIME      NULL,
  `created_by_admin_id`  BIGINT UNSIGNED NULL,
  `created_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `address_hash`         CHAR(64) GENERATED ALWAYS AS (SHA2(`address`, 256)) STORED,
  `owner_key`            BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(`app_id`, 0)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_webhook_subscriptions_public_id` (`shop_id`, `public_id`),
  UNIQUE KEY `uq_webhook_subscriptions_target` (`shop_id`, `owner_key`, `topic`, `address_hash`),
  UNIQUE KEY `uq_webhook_subscriptions_tenant` (`shop_id`, `id`),
  KEY `ix_webhook_subscriptions_topic` (`shop_id`, `topic`, `status`),
  KEY `ix_webhook_subscriptions_app` (`shop_id`, `app_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `webhook_deliveries` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`         BIGINT UNSIGNED NOT NULL,
  `subscription_id` BIGINT UNSIGNED NOT NULL,
  `event_id`        BIGINT UNSIGNED NOT NULL,
  `event_uuid`      CHAR(36)     NOT NULL,
  `topic`           VARCHAR(80)  NOT NULL,
  `attempt`         SMALLINT UNSIGNED NOT NULL,
  `status`          ENUM('succeeded','failed') NOT NULL,
  `response_status` SMALLINT UNSIGNED NULL,
  -- The first KB of what the receiver said. Enough to debug; never a dump.
  `response_body`   VARCHAR(1024) NULL,
  `error`           VARCHAR(500) NULL,
  `duration_ms`     INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `ix_webhook_deliveries_subscription` (`shop_id`, `subscription_id`, `created_at`),
  KEY `ix_webhook_deliveries_event` (`shop_id`, `event_id`),
  KEY `ix_webhook_deliveries_created` (`created_at`),
  CONSTRAINT `fk_webhook_deliveries_subscription` FOREIGN KEY (`shop_id`, `subscription_id`)
    REFERENCES `webhook_subscriptions` (`shop_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
