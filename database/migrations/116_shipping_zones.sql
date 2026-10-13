-- =============================================================================
-- 116 — Shipping zones for any country.
--
-- The rate table knew one set of zone names — local, regional, metro,
-- rest_of_india — attached to Indian PIN codes one by one. That cannot say
-- "Alaska and Hawaii cost more" or "the Highlands take three days longer".
--
-- A zone is now a named set of places inside the store's country: whole
-- states or provinces, and postcode prefixes ("941" San Francisco, "IV"
-- Inverness, "560" Bengaluru). An address belongs to the most specific zone
-- that covers it, and that zone's rates are the ones offered there — a zone
-- with no express rate simply has no express delivery. Addresses in no zone
-- get the store's everywhere rates. The old named zones and the PIN-code
-- table keep working as before for the stores that use them.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `shipping_zones` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`     BIGINT UNSIGNED NOT NULL,
  `name`        VARCHAR(120) NOT NULL,
  `is_active`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shipping_zones_name` (`shop_id`, `name`),
  CONSTRAINT `fk_shipping_zones_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `shipping_zone_areas` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`        BIGINT UNSIGNED NOT NULL,
  `zone_id`        BIGINT UNSIGNED NOT NULL,
  `country_code`   CHAR(2)     NOT NULL,
  -- A state or province; NULL with no prefix means the whole country.
  `region_code`    VARCHAR(10) NULL,
  -- Postcodes starting with this, upper-case without spaces.
  `postal_prefix`  VARCHAR(16) NULL,
  -- A place is in one zone at most.
  `area_key`       VARCHAR(40) GENERATED ALWAYS AS
                     (CONCAT(`country_code`, ':', COALESCE(`region_code`, '*'), ':', COALESCE(`postal_prefix`, '*'))) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shipping_zone_areas_place` (`shop_id`, `area_key`),
  KEY `ix_shipping_zone_areas_zone` (`zone_id`),
  CONSTRAINT `fk_shipping_zone_areas_zone` FOREIGN KEY (`zone_id`) REFERENCES `shipping_zones` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A rate for one zone. NULL keeps the named-zone behaviour (`zone`), where
-- 'all' is everywhere no zone covers.
ALTER TABLE `shipping_rates`
  ADD COLUMN `zone_id` BIGINT UNSIGNED NULL AFTER `zone`,
  ADD KEY `ix_shipping_rates_zone_id` (`shop_id`, `zone_id`),
  ADD CONSTRAINT `fk_shipping_rates_zone` FOREIGN KEY (`zone_id`) REFERENCES `shipping_zones` (`id`) ON DELETE CASCADE;
