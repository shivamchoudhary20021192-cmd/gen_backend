-- =============================================================================
-- 128 — Transferring a domain in: Shopify's "Transfer to Shopify".
--
-- A merchant who connected a domain registered elsewhere can move the
-- registration to the platform's registrar with the transfer (EPP) code from
-- their current provider. The registry takes up to a week to complete a
-- transfer, so the registration sits in `transferring` while a job asks the
-- registrar how it is going; on completion one year is added, it is billed
-- on the next invoice, and the store's domains for it become `transferred`
-- (managed here: renewals, auto-renew, the transfer-out code).
-- =============================================================================

ALTER TABLE `domain_registrations`
  MODIFY COLUMN `status` ENUM('pending','transferring','active','expired','transferred_out','failed') NOT NULL DEFAULT 'pending',
  ADD COLUMN `kind` ENUM('registration','transfer') NOT NULL DEFAULT 'registration' AFTER `registrar`,
  ADD COLUMN `transfer_checked_at` DATETIME NULL AFTER `last_error`,
  ADD KEY `ix_domain_registrations_transfers` (`status`, `transfer_checked_at`);

ALTER TABLE `shop_domains`
  MODIFY COLUMN `source` ENUM('platform','connected','purchased','transferred') NOT NULL DEFAULT 'connected';
