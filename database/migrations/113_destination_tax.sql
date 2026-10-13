-- =============================================================================
-- 113 — Destination-based sales tax.
--
-- Class-rate regimes (GST, VAT) charge a product's own rate wherever it goes.
-- Sales tax in the US and GST/HST/PST in Canada depend on where the parcel is
-- delivered, and a store only collects where it is registered to (its
-- "nexus"). A US store that collects nothing until it registers somewhere is
-- correct, not a missing feature; one that charged the same rate in every
-- state was wrong.
--
--   tax_registrations      where a shop collects tax, at what combined rate,
--                          and whether delivery is taxable there; the most
--                          specific one (country + region over country)
--                          applies to an order;
--   tax_classes.is_exempt  "this product is not taxed" for regimes whose rate
--                          comes from the destination, not the class;
--   orders.shipping_tax    tax charged on delivery, and
--   orders.tax_lines       the named taxes an order was charged ("California
--                          sales tax 7.25%"), for receipts and invoices;
--   carts.region_code      the delivery state, so the bag shows exact tax.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `tax_registrations` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`              BIGINT UNSIGNED NOT NULL,
  `country_code`         CHAR(2)      NOT NULL,
  -- NULL: the whole country (Canada's federal GST); a code: one state or province.
  `region_code`          VARCHAR(10)  NULL,
  `name`                 VARCHAR(120) NOT NULL,
  `registration_number`  VARCHAR(60)  NULL,
  -- Percent, combined (state + average local, or GST + PST).
  `rate`                 DECIMAL(7,4) NOT NULL,
  `shipping_taxable`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_active`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- One registration per place; the generated column lets "whole country"
  -- (NULL region) be unique too.
  `region_key`           VARCHAR(10) GENERATED ALWAYS AS (COALESCE(`region_code`, '*')) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tax_registrations_place` (`shop_id`, `country_code`, `region_key`),
  CONSTRAINT `fk_tax_registrations_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `tax_classes`
  ADD COLUMN `is_exempt` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0 AFTER `is_inclusive`;

-- The exempt and zero-rated classes the region blueprints create.
UPDATE `tax_classes` SET `is_exempt` = 1
 WHERE `code` IN ('EXEMPT', 'ZERO', 'GST_0', 'VAT_ZERO') AND `gst_rate` = 0;

ALTER TABLE `orders`
  ADD COLUMN `shipping_tax` DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `shipping_total`,
  ADD COLUMN `tax_lines` JSON NULL AFTER `igst_total`;

-- The delivery state the shopper gave, beside the postcode, so the bag can
-- show the exact tax before checkout.
ALTER TABLE `carts`
  ADD COLUMN `region_code` VARCHAR(10) NULL AFTER `pincode`;
