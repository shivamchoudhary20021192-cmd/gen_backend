-- =============================================================================
-- 132 — Price lists: prices set by hand, per market (and, next, per B2B company).
--
-- Until now a market's prices were always the store's prices converted,
-- adjusted and rounded. A price list lets a merchant set the price of a
-- variant outright in the list's currency — €24.00 in France, not whatever
-- ₹1,999 happens to convert to — with a compare-at price if they want one.
-- Variants without a fixed price fall back to the conversion, then the
-- list's percentage adjustment (a wholesale catalog at −30%, say).
--
-- A market uses a price list (markets.price_list_id); B2B company locations
-- will too. Fixed prices are what the shopper sees and pays: not converted,
-- not rounded again, and not reduced for export tax.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `price_lists` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`             BIGINT UNSIGNED NOT NULL,
  `name`                VARCHAR(120)    NOT NULL,
  `currency`            CHAR(3)         NOT NULL,
  `adjustment_percent`  DECIMAL(6,2)    NOT NULL DEFAULT 0.00,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_price_lists_name` (`shop_id`, `name`),
  CONSTRAINT `fk_price_lists_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `price_list_prices` (
  `shop_id`           BIGINT UNSIGNED NOT NULL,
  `price_list_id`     BIGINT UNSIGNED NOT NULL,
  `variant_id`        BIGINT UNSIGNED NOT NULL,
  `price`             DECIMAL(12,2)   NOT NULL,
  `compare_at_price`  DECIMAL(12,2)   NULL,
  `updated_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`price_list_id`, `variant_id`),
  KEY `ix_price_list_prices_variant` (`shop_id`, `variant_id`),
  CONSTRAINT `fk_price_list_prices_list` FOREIGN KEY (`price_list_id`) REFERENCES `price_lists` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_price_list_prices_variant` FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `markets`
  ADD COLUMN `price_list_id` BIGINT UNSIGNED NULL AFTER `rounding`,
  ADD CONSTRAINT `fk_markets_price_list` FOREIGN KEY (`price_list_id`) REFERENCES `price_lists` (`id`) ON DELETE SET NULL;
