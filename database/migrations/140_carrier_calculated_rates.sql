-- =============================================================================
-- 140 — Carrier-calculated shipping rates.
--
-- A rate row could only charge a fixed price. Now it can ask a connected
-- courier what this parcel costs to this address (Shopify's "carrier-calculated
-- rates"), with the row's own `rate` kept as the fallback:
--
--   rate_type               'flat' (as before) or 'carrier'.
--   carrier_id              The shipping_carriers row to ask. Its api_provider
--                           decides who answers (Shiprocket, the stand-in…).
--   carrier_markup_percent  Added to the carrier's price, then
--   carrier_markup_amount   this, so a shop can cover packing or round up.
--
-- A carrier row matches baskets exactly like a flat row (method, zone, order
-- value and weight bands, free-above). Only the price differs: the carrier's
-- quote plus markup, or `rate` when the carrier cannot answer in time, does
-- not serve the address, or no postcode is known yet. Checkout never fails
-- because a courier's API is down.
--
-- carrier_id carries no foreign key: shipping_carriers has no (shop_id, id)
-- key to make one tenant-consistent, and a missing carrier is handled (the
-- fallback price) rather than prevented. The service checks it on write.
--
-- Idempotent: safe to run again.
-- =============================================================================

SET NAMES utf8mb4;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'shipping_rates' AND column_name = 'rate_type') = 0,
  'ALTER TABLE `shipping_rates`
     ADD COLUMN `rate_type` ENUM(''flat'',''carrier'') NOT NULL DEFAULT ''flat'' AFTER `method`,
     ADD COLUMN `carrier_id` BIGINT UNSIGNED NULL AFTER `rate_type`,
     ADD COLUMN `carrier_markup_percent` DECIMAL(5,2) NOT NULL DEFAULT 0.00 AFTER `free_above_amount`,
     ADD COLUMN `carrier_markup_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00 AFTER `carrier_markup_percent`,
     ADD KEY `ix_shipping_rates_carrier` (`shop_id`, `carrier_id`)',
  'DO 0'
);
PREPARE `stmt140` FROM @ddl;
EXECUTE `stmt140`;
DEALLOCATE PREPARE `stmt140`;
