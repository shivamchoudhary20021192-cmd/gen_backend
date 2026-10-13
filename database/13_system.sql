-- =============================================================================
-- File 13 : SYSTEM — settings, search, rate limits, import/export, jobs
-- =============================================================================

USE `veylog`;

-- -----------------------------------------------------------------------------
-- settings — every operational number that must change without a deploy:
-- free-shipping threshold, GST rate, OTP expiry, media base URLs, store GSTIN.
-- `is_public` marks what the storefront may read; `is_encrypted` marks values
-- stored via app-level encryption (API keys should still prefer env vars).
-- -----------------------------------------------------------------------------
CREATE TABLE `settings` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `group_key`           VARCHAR(50)     NOT NULL,   -- store|shipping|payment|media|otp|seo
  `setting_key`         VARCHAR(100)    NOT NULL,   -- media.local_base_url
  `label`               VARCHAR(160)        NULL,
  `value`               TEXT                NULL,
  `default_value`       TEXT                NULL,
  `value_type`          ENUM('string','number','boolean','json','media','html','secret')
                                        NOT NULL DEFAULT 'string',
  `description`         VARCHAR(500)        NULL,
  `is_public`           TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_encrypted`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `sort_order`          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `updated_by_admin_id` BIGINT UNSIGNED     NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_settings_key` (`setting_key`),
  KEY `ix_settings_group` (`group_key`, `sort_order`),
  CONSTRAINT `fk_settings_admin`
    FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Search — BRD FR-11: "Search handles product, ingredient and concern synonyms;
-- zero-results page suggests routes."
-- Synonyms are data so the content team can add "vit c" → "vitamin c,
-- ascorbic acid" the moment they see it in search_queries.
-- -----------------------------------------------------------------------------
CREATE TABLE `search_synonyms` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `term`       VARCHAR(120)    NOT NULL,
  `synonyms`   TEXT            NOT NULL,   -- comma separated
  `match_type` ENUM('synonym','typo','concept','redirect') NOT NULL DEFAULT 'synonym',
  `redirect_url` VARCHAR(500)      NULL,   -- 'vitamin c' -> /ingredients/vitamin-c
  `is_active`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_search_synonyms_term` (`term`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Zero-result queries here are the highest-signal content backlog you will get.
CREATE TABLE `search_queries` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `query`             VARCHAR(191)    NOT NULL,
  `normalized_query`  VARCHAR(191)    NOT NULL,   -- lowercased, trimmed
  `results_count`     INT UNSIGNED    NOT NULL DEFAULT 0,
  `customer_id`       BIGINT UNSIGNED     NULL,
  `session_token`     CHAR(36)            NULL,
  `clicked_product_id` BIGINT UNSIGNED    NULL,
  `converted`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `device`            ENUM('mobile','tablet','desktop','unknown') NOT NULL DEFAULT 'unknown',
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_search_queries_normalized` (`normalized_query`, `created_at`),
  KEY `ix_search_queries_zero` (`results_count`, `created_at`),
  CONSTRAINT `fk_search_queries_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_search_queries_product`
    FOREIGN KEY (`clicked_product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Recently viewed, for the account page and "continue browsing"
CREATE TABLE `product_views` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id`    BIGINT UNSIGNED NOT NULL,
  `customer_id`   BIGINT UNSIGNED     NULL,
  `session_token` CHAR(36)            NULL,
  `source`        VARCHAR(60)         NULL,
  `viewed_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_product_views_customer` (`customer_id`, `viewed_at`),
  KEY `ix_product_views_session` (`session_token`, `viewed_at`),
  KEY `ix_product_views_product` (`product_id`, `viewed_at`),
  CONSTRAINT `fk_product_views_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_views_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- rate_limits — durable backstop for OTP, login, tracking, coupon-guessing.
-- Redis is faster; this survives a restart and gives you an audit trail.
-- -----------------------------------------------------------------------------
CREATE TABLE `rate_limits` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `bucket_key`   VARCHAR(80)     NOT NULL,   -- 'otp.send', 'admin.login'
  `identifier`   VARCHAR(120)    NOT NULL,   -- phone, ip, admin id
  `hits`         INT UNSIGNED    NOT NULL DEFAULT 0,
  `window_start` DATETIME        NOT NULL,
  `expires_at`   DATETIME        NOT NULL,
  `blocked_until` DATETIME           NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rate_limits` (`bucket_key`, `identifier`, `window_start`),
  KEY `ix_rate_limits_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- import_jobs / export_jobs
-- BRD §17: "CSV exports are permissioned, logged and minimized." Every export
-- is a row here with the requesting admin, the columns taken and the filters —
-- so a customer-data export is never invisible.
-- -----------------------------------------------------------------------------
CREATE TABLE `import_jobs` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_type`            ENUM('products','variants','inventory','customers',
                             'orders','pincodes','media','redirects','reviews')
                                        NOT NULL,
  `source_media_id`     BIGINT UNSIGNED     NULL,
  `status`              ENUM('queued','validating','running','completed','failed','cancelled')
                                        NOT NULL DEFAULT 'queued',
  `total_rows`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `processed_rows`      INT UNSIGNED    NOT NULL DEFAULT 0,
  `success_rows`        INT UNSIGNED    NOT NULL DEFAULT 0,
  `error_rows`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `error_report_media_id` BIGINT UNSIGNED   NULL,
  `options`             JSON                NULL,
  `started_by_admin_id` BIGINT UNSIGNED     NULL,
  `started_at`          DATETIME            NULL,
  `finished_at`         DATETIME            NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_import_jobs_status` (`status`, `created_at`),
  CONSTRAINT `fk_import_jobs_source`
    FOREIGN KEY (`source_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_import_jobs_error_report`
    FOREIGN KEY (`error_report_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_import_jobs_admin`
    FOREIGN KEY (`started_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `export_jobs` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_type`              ENUM('products','inventory','customers','orders',
                               'reviews','coupons','gst_report','payouts')
                                          NOT NULL,
  `status`                ENUM('queued','running','completed','failed','expired')
                                          NOT NULL DEFAULT 'queued',
  `filters`               JSON                NULL,
  `columns`               JSON                NULL,   -- data minimisation record
  `contains_personal_data` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `row_count`             INT UNSIGNED    NOT NULL DEFAULT 0,
  `result_media_id`       BIGINT UNSIGNED     NULL,
  `download_count`        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `expires_at`            DATETIME            NULL,   -- link auto-expires
  `requested_by_admin_id` BIGINT UNSIGNED     NULL,
  `justification`         VARCHAR(255)        NULL,
  `started_at`            DATETIME            NULL,
  `finished_at`           DATETIME            NULL,
  `created_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_export_jobs_status` (`status`, `created_at`),
  KEY `ix_export_jobs_admin` (`requested_by_admin_id`, `created_at`),
  CONSTRAINT `fk_export_jobs_result`
    FOREIGN KEY (`result_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_export_jobs_admin`
    FOREIGN KEY (`requested_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Generic background job log: variant generation, abandoned-cart mail,
-- collection recalculation, reservation sweep, retention purge.
CREATE TABLE `job_runs` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_name`     VARCHAR(80)     NOT NULL,
  `status`       ENUM('running','completed','failed') NOT NULL DEFAULT 'running',
  `items_processed` INT UNSIGNED NOT NULL DEFAULT 0,
  `error_message` VARCHAR(500)       NULL,
  `context`      JSON                NULL,
  `started_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at`  DATETIME            NULL,
  `duration_ms`  INT UNSIGNED        NULL,
  PRIMARY KEY (`id`),
  KEY `ix_job_runs_name` (`job_name`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `feature_flags` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `flag_key`        VARCHAR(80)     NOT NULL,
  `description`     VARCHAR(500)        NULL,
  `is_enabled`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `rollout_percent` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `conditions`      JSON                NULL,
  `updated_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_feature_flags_key` (`flag_key`),
  CONSTRAINT `fk_feature_flags_admin`
    FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
