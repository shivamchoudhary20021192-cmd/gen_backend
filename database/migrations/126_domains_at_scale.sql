-- =============================================================================
-- 126 — Custom domains the way Shopify runs them, built for global scale.
--
-- A domain now has a lifecycle, not two flags:
--
--   pending_dns ──► provisioning_ssl ──► active ──► misconfigured ─┐
--        │                 │               ▲                      │
--        │                 └► ssl_failed ──┘ (re-checked)          │
--        └► expired (no DNS after 14 days; re-check revives it)   ◄┘ (DNS fixed)
--
-- and everything the platform needs to run millions of them:
--
--   routing_target        a CNAME target unique to the domain
--                         (d-<token>.<edge zone>): pointing at it proves
--                         control of DNS, so subdomains need no TXT record
--   root_domain, pair_id  example.com and www.example.com are added together;
--                         one is primary, the other redirects to it
--   edge_*                the certificate and hostname at the edge (Cloudflare
--                         for SaaS custom hostnames, or an on-demand-TLS edge)
--   next_check_at, check_lease
--                         a due-list the sweep claims in batches, so any number
--                         of workers can share the checking without overlap
--   market_id, locale     international domains: example.fr serves the France
--                         market in French at its root
--   dns_snapshot          what the last check saw, for the admin's diagnostics
--
--   domain_events         each domain's history (status changes, checks that
--                         changed something, claims) — support's first stop
--   domain_registrations  domains bought through the platform
--
-- All on the control plane: a hostname is resolved to a shop before any pod
-- is known. `verification_status` / `ssl_status` stay, kept in step, for the
-- code and reports that read them.
-- =============================================================================

SET NAMES utf8mb4;

ALTER TABLE `shop_domains`
  ADD COLUMN `status` ENUM('pending_dns','provisioning_ssl','active','misconfigured','ssl_failed','expired') NOT NULL DEFAULT 'pending_dns' AFTER `kind`,
  ADD COLUMN `source` ENUM('platform','connected','purchased') NOT NULL DEFAULT 'connected' AFTER `status`,
  ADD COLUMN `root_domain` VARCHAR(253) NULL AFTER `hostname`,
  ADD COLUMN `pair_id` BIGINT UNSIGNED NULL AFTER `root_domain`,
  ADD COLUMN `routing_target` VARCHAR(253) NULL AFTER `verification_token`,
  ADD COLUMN `ownership_method` ENUM('txt','cname','sibling','registrar','platform','transfer') NULL AFTER `routing_target`,
  ADD COLUMN `dns_snapshot` JSON NULL AFTER `failure_reason`,
  ADD COLUMN `edge_provider` VARCHAR(30) NULL,
  ADD COLUMN `edge_hostname_id` VARCHAR(120) NULL,
  ADD COLUMN `certificate_status` ENUM('none','pending','active','failed') NOT NULL DEFAULT 'none',
  ADD COLUMN `certificate_issuer` VARCHAR(120) NULL,
  ADD COLUMN `certificate_expires_at` DATETIME NULL,
  ADD COLUMN `market_id` BIGINT UNSIGNED NULL,
  ADD COLUMN `locale` VARCHAR(10) NULL,
  ADD COLUMN `check_attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `next_check_at` DATETIME NULL,
  ADD COLUMN `check_lease` CHAR(36) NULL,
  ADD COLUMN `status_changed_at` DATETIME NULL,
  ADD COLUMN `last_healthy_at` DATETIME NULL,
  ADD UNIQUE KEY `uq_shop_domains_routing_target` (`routing_target`),
  ADD KEY `ix_shop_domains_due` (`next_check_at`, `status`),
  ADD KEY `ix_shop_domains_lease` (`check_lease`),
  ADD KEY `ix_shop_domains_root` (`root_domain`),
  ADD KEY `ix_shop_domains_status` (`status`, `status_changed_at`);

-- The domains that exist today, placed in the lifecycle.
UPDATE `shop_domains`
   SET `status` = CASE
                    WHEN `kind` = 'platform' THEN 'active'
                    WHEN `verification_status` = 'verified' AND `ssl_status` = 'active' THEN 'active'
                    WHEN `verification_status` = 'verified' THEN 'provisioning_ssl'
                    ELSE 'pending_dns'
                  END,
       `source` = IF(`kind` = 'platform', 'platform', 'connected'),
       `ownership_method` = IF(`kind` = 'platform', 'platform', IF(`verification_status` = 'verified', 'txt', NULL)),
       `certificate_status` = IF(`ssl_status` = 'active', 'active', 'none'),
       `next_check_at` = IF(`kind` = 'platform', NULL, NOW()),
       `status_changed_at` = COALESCE(`verified_at`, `created_at`);

CREATE TABLE IF NOT EXISTS `domain_events` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `domain_id`    BIGINT UNSIGNED NOT NULL,
  `shop_id`      BIGINT UNSIGNED NOT NULL,
  `hostname`     VARCHAR(253) NOT NULL,
  -- status_changed | added | removed | claimed | primary | settings | check_failed
  `event`        VARCHAR(40) NOT NULL,
  `from_status`  VARCHAR(30) NULL,
  `to_status`    VARCHAR(30) NULL,
  `detail`       JSON NULL,
  `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_domain_events_domain` (`domain_id`, `created_at`),
  KEY `ix_domain_events_shop` (`shop_id`, `created_at`),
  KEY `ix_domain_events_hostname` (`hostname`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `domain_registrations` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`             BIGINT UNSIGNED NOT NULL,
  -- The registrable domain bought: example.com, example.co.uk.
  `domain`              VARCHAR(253) NOT NULL,
  `registrar`           VARCHAR(30) NOT NULL,
  `registrar_order_id`  VARCHAR(120) NULL,
  `status`              ENUM('pending','active','expired','transferred_out','failed') NOT NULL DEFAULT 'pending',
  `years`               TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `price_amount`        DECIMAL(12,2) NOT NULL,
  `renewal_amount`      DECIMAL(12,2) NOT NULL,
  `currency`            CHAR(3) NOT NULL,
  `auto_renew`          TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `privacy`             TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `registered_at`       DATETIME NULL,
  `expires_at`          DATETIME NULL,
  `last_error`          VARCHAR(500) NULL,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_domain_registrations_domain` (`domain`),
  KEY `ix_domain_registrations_shop` (`shop_id`),
  KEY `ix_domain_registrations_expiry` (`status`, `expires_at`),
  CONSTRAINT `fk_domain_registrations_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Domains bought through the platform are billed like the plan: on the next invoice.
ALTER TABLE `platform_invoice_lines`
  MODIFY COLUMN `kind` ENUM('subscription','transaction_fee','proration','adjustment','domain') NOT NULL;
