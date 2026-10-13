-- =============================================================================
-- 131 — The platform's bills: tax, and the processor telling us what happened.
--
--   Tax     Bills now carry the platform's own tax (GST for Indian merchants,
--           split CGST/SGST or IGST by state; nothing on an export of
--           services): lines of kind 'tax', subtotal / tax_total on the bill,
--           and the merchant's tax ID and state from Settings → Billing.
--   Events  Stripe webhooks settle bills that were confirmed away from the
--           platform (3-D Secure in another tab, a delayed bank payment) and
--           record failures; each event is handled once
--           (billing_provider_events).
-- =============================================================================

ALTER TABLE `billing_accounts`
  ADD COLUMN `legal_name` VARCHAR(160) NULL AFTER `billing_email`,
  ADD COLUMN `tax_id`     VARCHAR(40)  NULL AFTER `legal_name`,
  ADD COLUMN `tax_region` VARCHAR(10)  NULL AFTER `tax_id`;

ALTER TABLE `platform_invoices`
  ADD COLUMN `subtotal`        DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `period_end`,
  ADD COLUMN `tax_total`       DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `subtotal`,
  ADD COLUMN `tax_note`        VARCHAR(200)  NULL AFTER `tax_total`,
  ADD COLUMN `customer_tax_id` VARCHAR(40)   NULL AFTER `tax_note`;

UPDATE `platform_invoices` SET `subtotal` = `total` WHERE `subtotal` = 0 AND `total` <> 0;

ALTER TABLE `platform_invoice_lines`
  MODIFY COLUMN `kind` ENUM('subscription','transaction_fee','proration','adjustment','domain','tax') NOT NULL;

CREATE TABLE IF NOT EXISTS `billing_provider_events` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider`      VARCHAR(40)     NOT NULL,
  `event_id`      VARCHAR(120)    NOT NULL,
  `type`          VARCHAR(80)     NOT NULL,
  `invoice_id`    BIGINT UNSIGNED NULL,
  `outcome`       VARCHAR(40)     NULL,
  `error`         VARCHAR(500)    NULL,
  `received_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `processed_at`  DATETIME        NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_billing_provider_events` (`provider`, `event_id`),
  KEY `ix_billing_provider_events_invoice` (`invoice_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
