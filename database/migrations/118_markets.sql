-- =============================================================================
-- 118 — Markets: selling to other countries, in their currencies.
--
-- Until now a store sold in one country and one currency. A market is a group
-- of countries a store sells to, with the currency its shoppers see and pay
-- in, a price adjustment and a rounding rule ("€24.99", not "€24.37"). Every
-- store has exactly one primary market — its own country, in its own
-- currency — so a store that never adds a market behaves exactly as before.
--
--   exchange_rates   units of each currency per US dollar (control plane),
--                    from the ECB's daily reference rates or set by an
--                    operator for currencies the ECB does not publish;
--   markets          the groups, and market_countries the countries in them
--                    (a country is in one market);
--   carts            remember the shopper's country;
--   orders           are charged in the market's currency and also record
--                    the store's currency and the rate, so reports stay in
--                    the store's own money.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `exchange_rates` (
  `currency`    CHAR(3)        NOT NULL,
  -- Units of this currency for one US dollar.
  `per_usd`     DECIMAL(24,10) NOT NULL,
  `source`      ENUM('ecb','manual') NOT NULL DEFAULT 'ecb',
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`currency`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The dollar is the base; everything else arrives from the rates job or an operator.
INSERT IGNORE INTO `exchange_rates` (`currency`, `per_usd`, `source`) VALUES ('USD', 1, 'ecb');

CREATE TABLE IF NOT EXISTS `markets` (
  `id`                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`                   BIGINT UNSIGNED NOT NULL,
  `name`                      VARCHAR(120) NOT NULL,
  `currency`                  CHAR(3) NOT NULL,
  -- +10.00 makes prices 10% higher in this market (duties, freight, positioning).
  `price_adjustment_percent`  DECIMAL(6,2) NOT NULL DEFAULT 0.00,
  `rounding`                  ENUM('none','whole','ninety_nine') NOT NULL DEFAULT 'none',
  `is_primary`                TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_active`                 TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `primary_marker`            BIGINT UNSIGNED GENERATED ALWAYS AS (IF(`is_primary` = 1, `shop_id`, NULL)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_markets_name` (`shop_id`, `name`),
  UNIQUE KEY `uq_markets_primary` (`primary_marker`),
  -- RESTRICT: MySQL allows no cascading action on a column a stored generated
  -- column is computed from (`primary_marker` reads `shop_id`).
  CONSTRAINT `fk_markets_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `market_countries` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`       BIGINT UNSIGNED NOT NULL,
  `market_id`     BIGINT UNSIGNED NOT NULL,
  `country_code`  CHAR(2) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_market_countries_country` (`shop_id`, `country_code`),
  KEY `ix_market_countries_market` (`market_id`),
  CONSTRAINT `fk_market_countries_market` FOREIGN KEY (`market_id`) REFERENCES `markets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every existing store: one primary market, its own country and currency.
INSERT IGNORE INTO `markets` (`shop_id`, `name`, `currency`, `is_primary`)
SELECT `id`, `country_code`, `currency`, 1 FROM `shops`;
UPDATE `markets` m JOIN `shops` s ON s.`id` = m.`shop_id`
   SET m.`name` = CONCAT('Domestic (', s.`country_code`, ')')
 WHERE m.`is_primary` = 1 AND m.`name` = s.`country_code`;
INSERT IGNORE INTO `market_countries` (`shop_id`, `market_id`, `country_code`)
SELECT m.`shop_id`, m.`id`, s.`country_code` FROM `markets` m JOIN `shops` s ON s.`id` = m.`shop_id` WHERE m.`is_primary` = 1;

ALTER TABLE `carts`
  ADD COLUMN `country_code` CHAR(2) NULL AFTER `currency`;

ALTER TABLE `orders`
  ADD COLUMN `market_id` BIGINT UNSIGNED NULL AFTER `currency`,
  ADD COLUMN `shop_currency` CHAR(3) NULL AFTER `market_id`,
  -- Store-currency units for one unit of the order's currency; 1 at home.
  ADD COLUMN `exchange_rate` DECIMAL(20,10) NOT NULL DEFAULT 1 AFTER `shop_currency`;

UPDATE `orders` SET `shop_currency` = `currency` WHERE `shop_currency` IS NULL;
