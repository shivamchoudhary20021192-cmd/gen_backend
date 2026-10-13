-- =============================================================================
-- File 07 : CUSTOMERS — phone identity, OTP, sessions, consent, addresses
-- =============================================================================
-- Identity is the phone number, not the email. `(country_code, phone)` is the
-- unique key; email is an optional profile field used for invoices and
-- transactional mail. That matches the "mobile + OTP only" flow and means a
-- customer who never gives an email is still a complete, orderable record.
--
-- Nothing here stores a password. The only secret material is:
--   otp_requests.otp_hash            sha256 of the 6-digit code
--   customer_sessions.refresh_token_hash
--
-- Guest browsing works with no row in this table at all — the cart is keyed by
-- a token (file 08) and only linked to a customer at the checkout login step.
-- =============================================================================

USE `veylog`;

CREATE TABLE `customers` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`           CHAR(36)        NOT NULL DEFAULT (UUID()),
  `country_code`        VARCHAR(5)      NOT NULL DEFAULT '+91',
  `phone`               VARCHAR(15)     NOT NULL,      -- digits only, no spaces
  `email`               VARCHAR(191)        NULL,      -- optional throughout
  `first_name`          VARCHAR(80)         NULL,      -- captured after first OTP
  `last_name`           VARCHAR(80)         NULL,
  `gender`              ENUM('female','male','other','undisclosed') NOT NULL DEFAULT 'undisclosed',
  `date_of_birth`       DATE                NULL,
  `avatar_media_id`     BIGINT UNSIGNED     NULL,

  `status`              ENUM('active','blocked','deleted') NOT NULL DEFAULT 'active',
  `phone_verified_at`   DATETIME            NULL,
  `email_verified_at`   DATETIME            NULL,
  `profile_completed_at` DATETIME           NULL,      -- name captured

  -- Fast-read cache of the latest consent state. `customer_consents` remains
  -- the legal record of who consented to what, when, under which notice version.
  `accepts_email_marketing`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `accepts_sms_marketing`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `accepts_whatsapp_marketing` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  -- skin profile, from the quiz or the profile page
  `skin_type_id`        BIGINT UNSIGNED     NULL,
  `primary_concern_id`  BIGINT UNSIGNED     NULL,

  -- CRM aggregates, recalculated on order events
  `orders_count`        INT UNSIGNED    NOT NULL DEFAULT 0,
  `total_spent`         DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `average_order_value` DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `first_order_at`      DATETIME            NULL,
  `last_order_at`       DATETIME            NULL,
  `last_seen_at`        DATETIME            NULL,
  -- COD risk: high RTO customers get prepaid-only checkout
  `rto_count`           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `cod_blocked`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  `signup_source`       ENUM('web','mobile_web','whatsapp','import','admin','app')
                                        NOT NULL DEFAULT 'web',
  `signup_utm`          JSON                NULL,
  `referred_by_customer_id` BIGINT UNSIGNED NULL,
  `preferred_language`  VARCHAR(10)     NOT NULL DEFAULT 'en-IN',

  -- DPDP erasure: `deleted_at` plus a scheduled hard-anonymise pass that
  -- scrubs name/email/phone while leaving order rows intact for tax law.
  `anonymised_at`       DATETIME            NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customers_phone` (`country_code`, `phone`),
  UNIQUE KEY `uq_customers_public_id` (`public_id`),
  -- MySQL allows many NULLs in a UNIQUE index, so email stays optional but
  -- cannot be duplicated when present.
  UNIQUE KEY `uq_customers_email` (`email`),
  KEY `ix_customers_status` (`status`, `created_at`),
  KEY `ix_customers_last_order` (`last_order_at`),
  KEY `ix_customers_spend` (`total_spent`),
  CONSTRAINT `fk_customers_avatar`
    FOREIGN KEY (`avatar_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_customers_skin_type`
    FOREIGN KEY (`skin_type_id`) REFERENCES `skin_types` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_customers_concern`
    FOREIGN KEY (`primary_concern_id`) REFERENCES `skin_concerns` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_customers_referrer`
    FOREIGN KEY (`referred_by_customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- deferred FKs from earlier files
ALTER TABLE `media`
  ADD CONSTRAINT `fk_media_uploader_customer`
    FOREIGN KEY (`uploaded_by_customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL;

ALTER TABLE `quiz_submissions`
  ADD CONSTRAINT `fk_quiz_submissions_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- customer_addresses
-- -----------------------------------------------------------------------------
CREATE TABLE `customer_addresses` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id`        BIGINT UNSIGNED NOT NULL,
  `label`              VARCHAR(40)     NOT NULL DEFAULT 'Home',
  `address_type`       ENUM('home','work','other') NOT NULL DEFAULT 'home',
  `first_name`         VARCHAR(80)     NOT NULL,
  `last_name`          VARCHAR(80)         NULL,
  `phone`              VARCHAR(15)     NOT NULL,
  `alternate_phone`    VARCHAR(15)         NULL,
  `line1`              VARCHAR(255)    NOT NULL,
  `line2`              VARCHAR(255)        NULL,
  `landmark`           VARCHAR(120)        NULL,
  `city`               VARCHAR(80)     NOT NULL,
  `state`              VARCHAR(80)     NOT NULL,
  `state_code`         CHAR(2)             NULL,   -- GST state code
  `pincode`            CHAR(6)         NOT NULL,
  `country`            CHAR(2)         NOT NULL DEFAULT 'IN',
  `latitude`           DECIMAL(10,7)       NULL,
  `longitude`          DECIMAL(10,7)       NULL,
  `is_default_shipping` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_default_billing`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_verified`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `delivery_notes`     VARCHAR(255)        NULL,
  `created_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`         DATETIME            NULL,
  PRIMARY KEY (`id`),
  KEY `ix_customer_addresses_customer` (`customer_id`, `deleted_at`),
  KEY `ix_customer_addresses_pincode` (`pincode`),
  CONSTRAINT `fk_customer_addresses_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- otp_requests — one row per code sent
-- -----------------------------------------------------------------------------
-- The plaintext OTP is never stored. `otp_hash` is sha256(otp + pepper), and
-- verification is a hash comparison with `attempts` incremented on every miss.
-- Keep rows for ~90 days for fraud investigation, then purge.
-- -----------------------------------------------------------------------------
CREATE TABLE `otp_requests` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id`          CHAR(36)        NOT NULL DEFAULT (UUID()),  -- returned to client
  `country_code`        VARCHAR(5)      NOT NULL DEFAULT '+91',
  `phone`               VARCHAR(15)     NOT NULL,
  `purpose`             ENUM('login','signup','checkout_verify','phone_change',
                             'order_track','cod_confirm')
                                        NOT NULL DEFAULT 'login',
  `channel`             ENUM('sms','whatsapp') NOT NULL,
  `otp_hash`            CHAR(64)        NOT NULL,
  `otp_length`          TINYINT UNSIGNED NOT NULL DEFAULT 6,
  `attempts`            TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts`        TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `resend_count`        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `status`              ENUM('pending','sent','verified','expired','failed','cancelled')
                                        NOT NULL DEFAULT 'pending',
  `provider`            VARCHAR(40)         NULL,   -- msg91|twilio|gupshup|meta_cloud
  `provider_message_id` VARCHAR(120)        NULL,
  `provider_status`     VARCHAR(60)         NULL,
  `error_message`       VARCHAR(255)        NULL,
  `customer_id`         BIGINT UNSIGNED     NULL,   -- set once matched
  `ip`                  VARBINARY(16)       NULL,
  `user_agent`          VARCHAR(255)        NULL,
  `device_id`           VARCHAR(64)         NULL,
  `sent_at`             DATETIME            NULL,
  `expires_at`          DATETIME        NOT NULL,   -- typically now() + 5 min
  `verified_at`         DATETIME            NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_otp_requests_request_id` (`request_id`),
  -- the rate-limit query: count rows for this phone in the last hour
  KEY `ix_otp_requests_phone_time` (`country_code`, `phone`, `created_at`),
  KEY `ix_otp_requests_status` (`status`, `expires_at`),
  KEY `ix_otp_requests_ip` (`ip`, `created_at`),
  CONSTRAINT `fk_otp_requests_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Sliding-window counters. OTP SMS costs real money, so the limit is enforced
-- here (durable, survives a restart) as well as in memory/Redis.
-- Suggested: 5 per phone per hour, 20 per IP per hour, 10 per device per hour.
CREATE TABLE `otp_throttle` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `identifier`      VARCHAR(120)    NOT NULL,   -- '+919876543210' | ip | device id
  `identifier_type` ENUM('phone','ip','device') NOT NULL,
  `window_start`    DATETIME        NOT NULL,
  `request_count`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `blocked_until`   DATETIME            NULL,
  `block_reason`    VARCHAR(120)        NULL,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_otp_throttle` (`identifier_type`, `identifier`, `window_start`),
  KEY `ix_otp_throttle_blocked` (`blocked_until`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- customer_sessions — refresh-token rotation
-- -----------------------------------------------------------------------------
-- The access JWT is short-lived (10-15 min) and stateless. The refresh token is
-- long-lived, stored here as a hash, and rotated on every use:
-- `rotated_from_session_id` chains the family, so if an old token is replayed
-- the whole family is revoked — the standard defence for the localStorage/XSS
-- risk called out in the brief.
-- -----------------------------------------------------------------------------
CREATE TABLE `customer_sessions` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id`           BIGINT UNSIGNED NOT NULL,
  `refresh_token_hash`    CHAR(64)        NOT NULL,
  `access_token_jti`      CHAR(36)            NULL,
  `rotated_from_session_id` BIGINT UNSIGNED   NULL,
  `device_id`             VARCHAR(64)         NULL,
  `device_name`           VARCHAR(120)        NULL,
  `platform`              ENUM('web','mobile_web','ios','android') NOT NULL DEFAULT 'web',
  `ip`                    VARBINARY(16)       NULL,
  `user_agent`            VARCHAR(255)        NULL,
  `issued_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at`          DATETIME            NULL,
  `expires_at`            DATETIME        NOT NULL,
  `revoked_at`            DATETIME            NULL,
  `revoked_reason`        ENUM('logout','rotation','reuse_detected','admin','expired','password_change')
                                              NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customer_sessions_refresh` (`refresh_token_hash`),
  KEY `ix_customer_sessions_customer` (`customer_id`, `revoked_at`),
  KEY `ix_customer_sessions_expiry` (`expires_at`),
  CONSTRAINT `fk_customer_sessions_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_customer_sessions_parent`
    FOREIGN KEY (`rotated_from_session_id`) REFERENCES `customer_sessions` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- customer_consents — append-only DPDP record
-- -----------------------------------------------------------------------------
-- Never UPDATE a consent row. Withdrawal is a NEW row with status='withdrawn'.
-- `subject_identifier` covers consent captured before an account exists (footer
-- newsletter, quiz as a guest).
-- BRD §14: "Email/SMS/WhatsApp marketing consent and unsubscribe separate from
-- transactional communication" — hence separate purposes per channel.
-- -----------------------------------------------------------------------------
CREATE TABLE `customer_consents` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id`        BIGINT UNSIGNED     NULL,
  `subject_identifier` VARCHAR(191)        NULL,   -- phone or email pre-account
  `purpose`            ENUM('transactional','marketing_email','marketing_sms',
                            'marketing_whatsapp','analytics_cookies',
                            'advertising_cookies','quiz_data','review_media',
                            'adverse_event_contact','data_processing')
                                       NOT NULL,
  `status`             ENUM('granted','withdrawn') NOT NULL,
  `notice_version`     VARCHAR(20)     NOT NULL,   -- privacy notice this refers to
  `source`             ENUM('signup','checkout','footer','popup','quiz',
                            'preference_center','admin','import','support')
                                       NOT NULL,
  `ip`                 VARBINARY(16)       NULL,
  `user_agent`         VARCHAR(255)        NULL,
  `evidence`           JSON                NULL,   -- exact wording shown, checkbox state
  `expires_at`         DATETIME            NULL,
  `created_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_customer_consents_customer` (`customer_id`, `purpose`, `created_at`),
  KEY `ix_customer_consents_subject` (`subject_identifier`, `purpose`, `created_at`),
  CONSTRAINT `fk_customer_consents_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `quiz_submissions`
  ADD CONSTRAINT `fk_quiz_submissions_consent`
    FOREIGN KEY (`consent_id`) REFERENCES `customer_consents` (`id`) ON DELETE SET NULL;

-- DPDP rights requests: access, correction, erasure, grievance
CREATE TABLE `data_requests` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `reference`     VARCHAR(20)     NOT NULL,
  `customer_id`   BIGINT UNSIGNED     NULL,
  `contact_value` VARCHAR(191)    NOT NULL,   -- how they reached us
  `request_type`  ENUM('access','correction','erasure','portability','grievance','withdraw_consent')
                                  NOT NULL,
  `status`        ENUM('received','verifying','in_progress','completed','rejected')
                                  NOT NULL DEFAULT 'received',
  `details`       TEXT                NULL,
  `verified_at`   DATETIME            NULL,
  `due_at`        DATETIME            NULL,
  `completed_at`  DATETIME            NULL,
  `outcome_note`  TEXT                NULL,
  `export_media_id` BIGINT UNSIGNED   NULL,
  `handled_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_data_requests_reference` (`reference`),
  KEY `ix_data_requests_status` (`status`, `due_at`),
  CONSTRAINT `fk_data_requests_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_data_requests_admin`
    FOREIGN KEY (`handled_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_data_requests_export`
    FOREIGN KEY (`export_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Wishlist and back-in-stock
-- -----------------------------------------------------------------------------
CREATE TABLE `wishlists` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `name`        VARCHAR(120)    NOT NULL DEFAULT 'My Wishlist',
  `is_public`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `share_token` CHAR(36)            NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wishlists_customer` (`customer_id`),
  UNIQUE KEY `uq_wishlists_share_token` (`share_token`),
  CONSTRAINT `fk_wishlists_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `wishlist_items` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `wishlist_id` BIGINT UNSIGNED NOT NULL,
  `product_id`  BIGINT UNSIGNED NOT NULL,
  `variant_id`  BIGINT UNSIGNED     NULL,
  `note`        VARCHAR(255)        NULL,
  `added_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wishlist_items` (`wishlist_id`, `product_id`),
  KEY `ix_wishlist_items_product` (`product_id`),
  CONSTRAINT `fk_wishlist_items_wishlist`
    FOREIGN KEY (`wishlist_id`) REFERENCES `wishlists` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wishlist_items_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wishlist_items_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- BRD FR-12: back-in-stock notification "with explicit marketing consent"
CREATE TABLE `back_in_stock_requests` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `variant_id`  BIGINT UNSIGNED NOT NULL,
  `customer_id` BIGINT UNSIGNED     NULL,
  `email`       VARCHAR(191)        NULL,
  `phone`       VARCHAR(15)         NULL,
  `channel`     ENUM('email','sms','whatsapp') NOT NULL DEFAULT 'email',
  `consent_id`  BIGINT UNSIGNED     NULL,
  `status`      ENUM('pending','notified','cancelled','expired') NOT NULL DEFAULT 'pending',
  `notified_at` DATETIME            NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_back_in_stock_variant` (`variant_id`, `status`),
  KEY `ix_back_in_stock_customer` (`customer_id`),
  CONSTRAINT `fk_back_in_stock_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_back_in_stock_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_back_in_stock_consent`
    FOREIGN KEY (`consent_id`) REFERENCES `customer_consents` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Internal CRM notes, visible only to staff with the customers.view permission
CREATE TABLE `customer_notes` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id`   BIGINT UNSIGNED NOT NULL,
  `admin_user_id` BIGINT UNSIGNED     NULL,
  `note`          TEXT            NOT NULL,
  `is_pinned`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_customer_notes_customer` (`customer_id`, `created_at`),
  CONSTRAINT `fk_customer_notes_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_customer_notes_admin`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
