-- =============================================================================
-- File 10 : MARKETING — coupons, loyalty, notifications, subscribers
-- =============================================================================
-- BRD §8.1: "Stacking, minimum order, eligible products, expiry, usage limit
-- and customer eligibility are configurable. Automatic and code discounts
-- resolve deterministically; customer sees why a code failed."
--
-- So every one of those is a column, and the eligibility joins are real tables
-- rather than a JSON blob — because "which coupons apply to this product" has
-- to be answerable by an index at checkout, under time pressure.
-- =============================================================================

USE `veylog`;

CREATE TABLE `coupons` (
  `id`                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`                    VARCHAR(60)     NOT NULL,
  `title`                   VARCHAR(191)        NULL,   -- shown in cart
  `description`             VARCHAR(500)        NULL,
  `discount_type`           ENUM('percentage','fixed_amount','free_shipping',
                                 'buy_x_get_y','free_gift')
                                            NOT NULL DEFAULT 'percentage',
  `value`                   DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `max_discount_amount`     DECIMAL(10,2)       NULL,   -- caps a % discount

  -- eligibility
  `min_order_amount`        DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `min_quantity`            SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `applies_to`              ENUM('all','products','categories','collections')
                                            NOT NULL DEFAULT 'all',
  `customer_eligibility`    ENUM('all','new_customers','returning','specific')
                                            NOT NULL DEFAULT 'all',

  -- buy X get Y / free gift
  `buy_quantity`            SMALLINT UNSIGNED   NULL,
  `get_quantity`            SMALLINT UNSIGNED   NULL,
  `get_variant_id`          BIGINT UNSIGNED     NULL,
  `gift_variant_id`         BIGINT UNSIGNED     NULL,
  -- BRD §8.1: "Free gifts reserve inventory and disappear cleanly when the
  -- threshold is no longer met."
  `gift_reserves_inventory` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,

  -- usage
  `usage_limit_total`       INT UNSIGNED        NULL,
  `usage_limit_per_customer` SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `used_count`              INT UNSIGNED    NOT NULL DEFAULT 0,

  -- resolution
  `is_stackable`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_automatic`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,  -- no code needed
  `is_visible`              TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,  -- listed on site
  `priority`                SMALLINT UNSIGNED NOT NULL DEFAULT 100,  -- lower wins first
  `starts_at`               DATETIME            NULL,
  `ends_at`                 DATETIME            NULL,
  `is_active`               TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_by_admin_id`     BIGINT UNSIGNED     NULL,
  `created_at`              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`              DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_coupons_code` (`code`),
  KEY `ix_coupons_active` (`is_active`, `starts_at`, `ends_at`),
  KEY `ix_coupons_automatic` (`is_automatic`, `is_active`, `priority`),
  CONSTRAINT `fk_coupons_get_variant`
    FOREIGN KEY (`get_variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_coupons_gift_variant`
    FOREIGN KEY (`gift_variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_coupons_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ck_coupons_value` CHECK (`value` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- deferred FKs from file 08
ALTER TABLE `orders`
  ADD CONSTRAINT `fk_orders_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE SET NULL;
ALTER TABLE `order_discounts`
  ADD CONSTRAINT `fk_order_discounts_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE SET NULL;
ALTER TABLE `cart_items`
  ADD CONSTRAINT `fk_cart_items_source_coupon`
    FOREIGN KEY (`source_coupon_id`) REFERENCES `coupons` (`id`) ON DELETE SET NULL;

-- `is_excluded` lets one row express both "only these" and "everything but
-- these", which is how most real promo briefs are actually written.
CREATE TABLE `coupon_products` (
  `coupon_id`   BIGINT UNSIGNED NOT NULL,
  `product_id`  BIGINT UNSIGNED NOT NULL,
  `is_excluded` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`coupon_id`, `product_id`),
  KEY `ix_coupon_products_product` (`product_id`),
  CONSTRAINT `fk_coupon_products_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_products_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `coupon_categories` (
  `coupon_id`   BIGINT UNSIGNED NOT NULL,
  `category_id` BIGINT UNSIGNED NOT NULL,
  `is_excluded` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`coupon_id`, `category_id`),
  KEY `ix_coupon_categories_category` (`category_id`),
  CONSTRAINT `fk_coupon_categories_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_categories_category`
    FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `coupon_collections` (
  `coupon_id`     BIGINT UNSIGNED NOT NULL,
  `collection_id` BIGINT UNSIGNED NOT NULL,
  `is_excluded`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`coupon_id`, `collection_id`),
  KEY `ix_coupon_collections_collection` (`collection_id`),
  CONSTRAINT `fk_coupon_collections_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_collections_collection`
    FOREIGN KEY (`collection_id`) REFERENCES `collections` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `coupon_customers` (
  `coupon_id`   BIGINT UNSIGNED NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`coupon_id`, `customer_id`),
  KEY `ix_coupon_customers_customer` (`customer_id`),
  CONSTRAINT `fk_coupon_customers_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_customers_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- UNIQUE(coupon, order) is what enforces per-customer limits reliably even
-- under a double-click, rather than relying on the `used_count` counter.
CREATE TABLE `coupon_redemptions` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `coupon_id`       BIGINT UNSIGNED NOT NULL,
  `order_id`        BIGINT UNSIGNED NOT NULL,
  `customer_id`     BIGINT UNSIGNED     NULL,
  `discount_amount` DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `redeemed_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_coupon_redemptions` (`coupon_id`, `order_id`),
  KEY `ix_coupon_redemptions_customer` (`customer_id`, `coupon_id`),
  CONSTRAINT `fk_coupon_redemptions_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_redemptions_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_redemptions_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Loyalty (BRD P2, but the existing UI already has a points screen)
-- Balance is a cache; loyalty_transactions is the ledger of record.
-- -----------------------------------------------------------------------------
CREATE TABLE `loyalty_accounts` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id`       BIGINT UNSIGNED NOT NULL,
  `balance`           INT             NOT NULL DEFAULT 0,
  `lifetime_earned`   INT UNSIGNED    NOT NULL DEFAULT 0,
  `lifetime_redeemed` INT UNSIGNED    NOT NULL DEFAULT 0,
  `tier`              ENUM('none','bronze','silver','gold') NOT NULL DEFAULT 'none',
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_loyalty_accounts_customer` (`customer_id`),
  CONSTRAINT `fk_loyalty_accounts_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `loyalty_transactions` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `loyalty_account_id` BIGINT UNSIGNED NOT NULL,
  `order_id`          BIGINT UNSIGNED     NULL,
  `transaction_type`  ENUM('earn','redeem','expire','adjust','reversal') NOT NULL,
  `points`            INT             NOT NULL,   -- signed
  `balance_after`     INT             NOT NULL,
  `description`       VARCHAR(255)        NULL,
  `expires_at`        DATETIME            NULL,
  `admin_user_id`     BIGINT UNSIGNED     NULL,   -- manual adjustments
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_loyalty_transactions_account` (`loyalty_account_id`, `created_at`),
  KEY `ix_loyalty_transactions_order` (`order_id`),
  KEY `ix_loyalty_transactions_expiry` (`expires_at`),
  CONSTRAINT `fk_loyalty_transactions_account`
    FOREIGN KEY (`loyalty_account_id`) REFERENCES `loyalty_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_loyalty_transactions_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_loyalty_transactions_admin`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `loyalty_rules` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`                VARCHAR(120)    NOT NULL,
  `event`               ENUM('order_delivered','order_placed','review_approved',
                             'signup','referral','birthday')
                                        NOT NULL,
  `points_type`         ENUM('fixed','percentage_of_order') NOT NULL DEFAULT 'fixed',
  `points_value`        DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `min_order_amount`    DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `max_points_per_event` INT UNSIGNED       NULL,
  `redemption_rate`     DECIMAL(8,2)    NOT NULL DEFAULT 10.00,  -- points per ₹1
  `min_redeem_points`   INT UNSIGNED    NOT NULL DEFAULT 100,
  `max_redeem_percent`  DECIMAL(5,2)    NOT NULL DEFAULT 50.00,  -- of subtotal
  `expiry_days`         SMALLINT UNSIGNED   NULL,
  `is_active`           TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_loyalty_rules_event` (`event`, `is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Newsletter / marketing list
-- consent_id points at the customer_consents row that authorises this, so an
-- audit can trace every send back to a recorded permission.
-- -----------------------------------------------------------------------------
CREATE TABLE `newsletter_subscribers` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`             VARCHAR(191)        NULL,
  `phone`             VARCHAR(15)         NULL,
  `channel`           ENUM('email','sms','whatsapp') NOT NULL DEFAULT 'email',
  `customer_id`       BIGINT UNSIGNED     NULL,
  `status`            ENUM('pending','subscribed','unsubscribed','bounced','complained')
                                      NOT NULL DEFAULT 'pending',
  `source`            VARCHAR(60)         NULL,   -- footer|popup|checkout|quiz
  `consent_id`        BIGINT UNSIGNED     NULL,
  `unsubscribe_token` CHAR(36)        NOT NULL DEFAULT (UUID()),
  `subscribed_at`     DATETIME            NULL,
  `unsubscribed_at`   DATETIME            NULL,
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_newsletter_email_channel` (`email`, `channel`),
  UNIQUE KEY `uq_newsletter_phone_channel` (`phone`, `channel`),
  UNIQUE KEY `uq_newsletter_token` (`unsubscribe_token`),
  KEY `ix_newsletter_status` (`status`, `channel`),
  CONSTRAINT `fk_newsletter_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_newsletter_consent`
    FOREIGN KEY (`consent_id`) REFERENCES `customer_consents` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Transactional messaging (BRD FR-07)
-- Templates are content, so they live in the database and are editable by the
-- content role. WhatsApp templates additionally carry the Meta-approved
-- template name in `provider_template_id`.
-- -----------------------------------------------------------------------------
CREATE TABLE `notification_templates` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_key`            VARCHAR(60)     NOT NULL,   -- otp.login, order.confirmed
  `channel`              ENUM('email','sms','whatsapp','push') NOT NULL,
  `locale`               VARCHAR(10)     NOT NULL DEFAULT 'en-IN',
  `name`                 VARCHAR(120)    NOT NULL,
  `subject`              VARCHAR(255)        NULL,   -- email only
  `body`                 LONGTEXT        NOT NULL,
  `provider`             VARCHAR(40)         NULL,
  `provider_template_id` VARCHAR(120)        NULL,   -- DLT id / WA template name
  `dlt_template_id`      VARCHAR(60)         NULL,   -- TRAI DLT registration
  `variables`            JSON                NULL,
  `is_transactional`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `is_active`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `updated_by_admin_id`  BIGINT UNSIGNED     NULL,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notification_templates` (`event_key`, `channel`, `locale`),
  CONSTRAINT `fk_notification_templates_admin`
    FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per message attempt. This is the table support looks at when a
-- customer says "I never got my OTP".
CREATE TABLE `notification_logs` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `template_id`         BIGINT UNSIGNED     NULL,
  `event_key`           VARCHAR(60)     NOT NULL,
  `channel`             ENUM('email','sms','whatsapp','push') NOT NULL,
  `recipient`           VARCHAR(191)    NOT NULL,
  `customer_id`         BIGINT UNSIGNED     NULL,
  `order_id`            BIGINT UNSIGNED     NULL,
  `provider`            VARCHAR(40)         NULL,
  `provider_message_id` VARCHAR(120)        NULL,
  `status`              ENUM('queued','sent','delivered','read','failed','bounced')
                                        NOT NULL DEFAULT 'queued',
  `error_message`       VARCHAR(500)        NULL,
  `retry_count`         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `cost`                DECIMAL(8,4)    NOT NULL DEFAULT 0.0000,
  `payload`             JSON                NULL,
  `queued_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `sent_at`             DATETIME            NULL,
  `delivered_at`        DATETIME            NULL,
  `failed_at`           DATETIME            NULL,
  PRIMARY KEY (`id`),
  KEY `ix_notification_logs_customer` (`customer_id`, `queued_at`),
  KEY `ix_notification_logs_order` (`order_id`),
  KEY `ix_notification_logs_status` (`status`, `queued_at`),
  KEY `ix_notification_logs_recipient` (`recipient`, `queued_at`),
  CONSTRAINT `fk_notification_logs_template`
    FOREIGN KEY (`template_id`) REFERENCES `notification_templates` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_notification_logs_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_notification_logs_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
