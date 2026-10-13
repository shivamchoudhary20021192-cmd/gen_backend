-- =============================================================================
-- 112 — Platform billing: the platform charging its merchants.
--
-- Until now a shop's subscription was a record (provider = 'manual') and
-- nothing was ever charged. This adds what a Shopify-style bill needs:
--
--   plan_prices             a plan's price in each billing currency, so a US
--                           store is billed in dollars, not rupees;
--   billing_accounts        how a shop pays: provider, customer, card on file;
--   platform_invoices       one bill: a period, a total, a status, and the
--                           dunning state (attempts, next retry);
--   platform_invoice_lines  what a bill is made of — the plan (in advance),
--                           transaction fees (in arrears), prorations and
--                           adjustments. A line with no invoice is pending and
--                           is swept into the next one.
--
-- All four live in the control plane: a bill is between the platform and a
-- shop, read by the billing job before any one shop is in context.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `plan_prices` (
  `plan_id`       INT UNSIGNED  NOT NULL,
  `currency`      CHAR(3)       NOT NULL,
  `price_amount`  DECIMAL(12,2) NOT NULL,
  PRIMARY KEY (`plan_id`, `currency`),
  CONSTRAINT `fk_plan_prices_plan` FOREIGN KEY (`plan_id`) REFERENCES `plans` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every plan in its own currency, then the platform's standard price points.
INSERT IGNORE INTO `plan_prices` (`plan_id`, `currency`, `price_amount`)
SELECT `id`, `currency`, `price_amount` FROM `plans`;

INSERT IGNORE INTO `plan_prices` (`plan_id`, `currency`, `price_amount`)
SELECT p.`id`, x.`currency`,
       CASE p.`handle`
         WHEN 'starter'  THEN x.`starter`
         WHEN 'growth'   THEN x.`growth`
         WHEN 'advanced' THEN x.`advanced`
       END
  FROM `plans` p
  JOIN (
    SELECT 'USD' AS `currency`, 19.00 AS `starter`, 59.00 AS `growth`, 179.00 AS `advanced`
    UNION ALL SELECT 'EUR', 19.00, 55.00, 169.00
    UNION ALL SELECT 'GBP', 16.00, 49.00, 149.00
    UNION ALL SELECT 'CAD', 25.00, 79.00, 239.00
    UNION ALL SELECT 'AUD', 29.00, 89.00, 269.00
  ) x
 WHERE p.`handle` IN ('starter', 'growth', 'advanced');

CREATE TABLE IF NOT EXISTS `billing_accounts` (
  `id`                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`                 BIGINT UNSIGNED NOT NULL,
  `provider`                VARCHAR(40)  NOT NULL,
  `provider_customer_id`    VARCHAR(120) NULL,
  -- The card (or mandate) charged for bills, and how to describe it.
  `payment_method_ref`      VARCHAR(120) NULL,
  `payment_method_label`    VARCHAR(120) NULL,
  `payment_method_expires`  CHAR(7)      NULL,
  -- A card being added that the provider has not confirmed yet.
  `pending_setup_ref`       VARCHAR(120) NULL,
  `billing_email`           VARCHAR(191) NULL,
  `created_at`              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_billing_accounts_shop` (`shop_id`),
  CONSTRAINT `fk_billing_accounts_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `platform_invoices` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`              BIGINT UNSIGNED NOT NULL,
  `subscription_id`      BIGINT UNSIGNED NULL,
  `invoice_number`       VARCHAR(32) NULL,
  `kind`                 ENUM('cycle','plan_change','manual') NOT NULL DEFAULT 'cycle',
  `currency`             CHAR(3) NOT NULL,
  `period_start`         DATETIME NOT NULL,
  `period_end`           DATETIME NOT NULL,
  `total`                DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `status`               ENUM('open','paid','failed','void') NOT NULL DEFAULT 'open',
  `attempt_count`        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `next_attempt_at`      DATETIME NULL,
  `first_failed_at`      DATETIME NULL,
  `last_error`           VARCHAR(500) NULL,
  `provider`             VARCHAR(40) NULL,
  `provider_payment_id`  VARCHAR(120) NULL,
  `issued_at`            DATETIME NOT NULL,
  `paid_at`              DATETIME NULL,
  `voided_at`            DATETIME NULL,
  -- One cycle invoice per subscription period, however often the job runs.
  `cycle_key`            VARCHAR(80) NULL,
  `created_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_platform_invoices_number` (`invoice_number`),
  UNIQUE KEY `uq_platform_invoices_cycle` (`cycle_key`),
  KEY `ix_platform_invoices_shop` (`shop_id`, `status`),
  KEY `ix_platform_invoices_retry` (`status`, `next_attempt_at`),
  CONSTRAINT `fk_platform_invoices_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `platform_invoice_lines` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`       BIGINT UNSIGNED NOT NULL,
  `invoice_id`    BIGINT UNSIGNED NULL,
  `kind`          ENUM('subscription','transaction_fee','proration','adjustment') NOT NULL,
  `description`   VARCHAR(255) NOT NULL,
  `currency`      CHAR(3) NOT NULL,
  `amount`        DECIMAL(12,2) NOT NULL,
  `period_start`  DATETIME NULL,
  `period_end`    DATETIME NULL,
  `reference`     VARCHAR(120) NULL,
  `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_platform_invoice_lines_invoice` (`invoice_id`),
  KEY `ix_platform_invoice_lines_pending` (`shop_id`, `invoice_id`),
  CONSTRAINT `fk_platform_invoice_lines_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_platform_invoice_lines_invoice` FOREIGN KEY (`invoice_id`) REFERENCES `platform_invoices` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Subscriptions opened before prices existed per currency were priced in the
-- plan's base currency whatever the shop sold in. Re-price the live ones in
-- the shop's own currency where the plan has a price for it.
UPDATE `shop_subscriptions` s
  JOIN `shops` sh ON sh.`id` = s.`shop_id`
  JOIN `plan_prices` pp ON pp.`plan_id` = s.`plan_id` AND pp.`currency` = sh.`currency`
   SET s.`currency` = pp.`currency`, s.`price_amount` = pp.`price_amount`
 WHERE s.`status` <> 'cancelled' AND s.`currency` <> sh.`currency`;
