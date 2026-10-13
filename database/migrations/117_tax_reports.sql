-- =============================================================================
-- 117 — Sales reported to the shop's tax service.
--
-- A tax service computes tax at checkout; to file returns from it, it also
-- needs the completed sales and refunds. Each report is recorded here once —
-- a sale per order when it ships, a refund per refund — so a retried event
-- never reports twice and the admin can see what the service was told.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `tax_reports` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`       BIGINT UNSIGNED NOT NULL,
  `order_id`      BIGINT UNSIGNED NOT NULL,
  `kind`          ENUM('sale','refund') NOT NULL,
  -- The order id for a sale, the refund id for a refund.
  `reference_id`  BIGINT UNSIGNED NOT NULL,
  `provider`      VARCHAR(40)  NOT NULL,
  `external_id`   VARCHAR(80)  NOT NULL,
  `amount`        DECIMAL(12,2) NOT NULL,
  `sales_tax`     DECIMAL(12,2) NOT NULL,
  `reported_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tax_reports_once` (`shop_id`, `kind`, `reference_id`),
  KEY `ix_tax_reports_order` (`shop_id`, `order_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
