-- =============================================================================
-- 114 — Email from the platform to merchants and staff.
--
-- A shop's customer emails go through the shop's own provider (messaging).
-- These are the platform's own: a staff invitation, a password reset, a
-- failed card, a frozen store. Each is written to this outbox first and
-- delivered by a job, so a slow or failing provider never fails the request
-- that caused the email, and every email can be traced to what sent it.
--
-- `dedupe_key` makes "once" enforceable: the trial-ending reminder for one
-- subscription is sent once however often the billing job runs.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `platform_emails` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`              BIGINT UNSIGNED NULL,
  `to_email`             VARCHAR(191) NOT NULL,
  `template`             VARCHAR(60)  NOT NULL,
  `subject`              VARCHAR(255) NOT NULL,
  -- Emptied after delivery for emails that carry a secret (a reset link).
  `body`                 MEDIUMTEXT   NULL,
  `sensitive`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `status`               ENUM('queued','sent','failed') NOT NULL DEFAULT 'queued',
  `provider`             VARCHAR(40)  NULL,
  `provider_message_id`  VARCHAR(191) NULL,
  `error`                VARCHAR(500) NULL,
  `attempts`             SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `dedupe_key`           VARCHAR(191) NULL,
  `sent_at`              DATETIME NULL,
  `created_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_platform_emails_dedupe` (`dedupe_key`),
  KEY `ix_platform_emails_to` (`to_email`, `created_at`),
  KEY `ix_platform_emails_shop` (`shop_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Staff invitations are now sent. A full-access invitation carries no role,
-- and an invitation is looked up by its token alone, before a shop is known.
ALTER TABLE `admin_invites`
  MODIFY `role_id` BIGINT UNSIGNED NULL,
  ADD KEY `ix_admin_invites_token_lookup` (`token_hash`);
