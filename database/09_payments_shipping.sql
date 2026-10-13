-- =============================================================================
-- File 09 : PAYMENTS AND SHIPPING
-- =============================================================================
-- PAYMENT SAFETY RULES BAKED INTO THE SCHEMA
--   1. No raw card data. Ever. Only the network, last four and issuer, which
--      Razorpay returns for display purposes.
--   2. `signature_verified` must be 1 before an order can move to paid. The
--      client's "payment success" callback is never sufficient (BRD FR-05).
--   3. `payment_webhook_events.event_id` is UNIQUE — that single constraint is
--      what makes webhook replay idempotent, as the BRD requires.
--   4. `payments.idempotency_key` is UNIQUE, so a double-submitted checkout
--      cannot create two gateway orders for one cart.
-- =============================================================================

USE `veylog`;

CREATE TABLE `payments` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`            BIGINT UNSIGNED NOT NULL,
  `gateway`             ENUM('razorpay','cod','manual','store_credit') NOT NULL DEFAULT 'razorpay',
  `gateway_order_id`    VARCHAR(80)         NULL,   -- order_XXXXXXXX
  `gateway_payment_id`  VARCHAR(80)         NULL,   -- pay_XXXXXXXX
  `gateway_signature`   VARCHAR(255)        NULL,
  `signature_verified`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `idempotency_key`     VARCHAR(80)         NULL,
  `attempt_no`          TINYINT UNSIGNED NOT NULL DEFAULT 1,

  `method`              ENUM('upi','card','netbanking','wallet','emi','paylater','cod','other')
                                              NULL,
  `amount`              DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `currency`            CHAR(3)         NOT NULL DEFAULT 'INR',
  `status`              ENUM('created','pending','authorized','captured','failed',
                             'cancelled','refunded','partially_refunded')
                                        NOT NULL DEFAULT 'created',

  -- display-only instrument details returned by the gateway
  `card_network`        VARCHAR(30)         NULL,
  `card_last4`          CHAR(4)             NULL,
  `card_issuer`         VARCHAR(80)         NULL,
  `upi_vpa`             VARCHAR(120)        NULL,
  `bank`                VARCHAR(80)         NULL,
  `wallet`              VARCHAR(40)         NULL,
  `is_international`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  `gateway_fee`         DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `gateway_tax`         DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `error_code`          VARCHAR(60)         NULL,
  `error_description`   VARCHAR(500)        NULL,
  `error_source`        VARCHAR(60)         NULL,
  `error_step`          VARCHAR(60)         NULL,
  `error_reason`        VARCHAR(120)        NULL,
  `raw_response`        JSON                NULL,
  `authorized_at`       DATETIME            NULL,
  `captured_at`         DATETIME            NULL,
  `failed_at`           DATETIME            NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payments_gateway_payment_id` (`gateway_payment_id`),
  UNIQUE KEY `uq_payments_idempotency` (`idempotency_key`),
  KEY `ix_payments_order` (`order_id`, `created_at`),
  KEY `ix_payments_gateway_order` (`gateway_order_id`),
  KEY `ix_payments_status` (`status`, `created_at`),
  CONSTRAINT `fk_payments_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every webhook body is stored before it is acted on. `event_id` UNIQUE means a
-- redelivered event is rejected by the database, not by hopeful application
-- logic. Failed events keep their payload so they can be replayed by hand.
CREATE TABLE `payment_webhook_events` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `gateway`          VARCHAR(30)     NOT NULL DEFAULT 'razorpay',
  `event_id`         VARCHAR(120)    NOT NULL,   -- x-razorpay-event-id
  `event_type`       VARCHAR(80)     NOT NULL,   -- payment.captured, refund.processed
  `payload`          JSON            NOT NULL,
  `signature`        VARCHAR(255)        NULL,
  `signature_valid`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `order_id`         BIGINT UNSIGNED     NULL,
  `payment_id`       BIGINT UNSIGNED     NULL,
  `status`           ENUM('received','processing','processed','failed','ignored')
                                     NOT NULL DEFAULT 'received',
  `attempts`         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `last_error`       VARCHAR(500)        NULL,
  `received_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `processed_at`     DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payment_webhook_events` (`gateway`, `event_id`),
  KEY `ix_payment_webhook_status` (`status`, `received_at`),
  KEY `ix_payment_webhook_order` (`order_id`),
  CONSTRAINT `fk_payment_webhook_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payment_webhook_payment`
    FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `refunds` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`           BIGINT UNSIGNED NOT NULL,
  `payment_id`         BIGINT UNSIGNED     NULL,
  `return_request_id`  BIGINT UNSIGNED     NULL,
  `gateway_refund_id`  VARCHAR(80)         NULL,
  `amount`             DECIMAL(12,2)   NOT NULL,
  `refund_type`        ENUM('full','partial') NOT NULL DEFAULT 'partial',
  `reason`             VARCHAR(255)        NULL,
  `internal_note`      TEXT                NULL,
  `status`             ENUM('pending','processing','processed','failed','cancelled')
                                       NOT NULL DEFAULT 'pending',
  `speed`              ENUM('normal','optimum','instant') NOT NULL DEFAULT 'normal',
  `arn`                VARCHAR(60)         NULL,   -- bank reference for support
  `initiated_by_admin_id` BIGINT UNSIGNED  NULL,
  `raw_response`       JSON                NULL,
  `processed_at`       DATETIME            NULL,
  `created_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_refunds_gateway_id` (`gateway_refund_id`),
  KEY `ix_refunds_order` (`order_id`),
  KEY `ix_refunds_status` (`status`, `created_at`),
  CONSTRAINT `fk_refunds_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_refunds_payment`
    FOREIGN KEY (`payment_id`) REFERENCES `payments` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_refunds_return`
    FOREIGN KEY (`return_request_id`) REFERENCES `return_requests` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_refunds_admin`
    FOREIGN KEY (`initiated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- =============================================================================
-- SHIPPING
-- =============================================================================

CREATE TABLE `shipping_carriers` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`                 VARCHAR(40)     NOT NULL,   -- delhivery|bluedart|shiprocket
  `name`                 VARCHAR(120)    NOT NULL,
  `tracking_url_template` VARCHAR(500)       NULL,   -- 'https://.../{awb}'
  `api_provider`         VARCHAR(40)         NULL,   -- aggregator behind it
  `supports_cod`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `supports_reverse_pickup` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `logo_media_id`        BIGINT UNSIGNED     NULL,
  `is_active`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `priority`             SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shipping_carriers_code` (`code`),
  CONSTRAINT `fk_shipping_carriers_logo`
    FOREIGN KEY (`logo_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One order can ship in several parcels; each parcel is a shipment.
CREATE TABLE `shipments` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shipment_number`       VARCHAR(20)     NOT NULL,
  `order_id`              BIGINT UNSIGNED NOT NULL,
  `carrier_id`            BIGINT UNSIGNED     NULL,
  `location_id`           BIGINT UNSIGNED     NULL,   -- shipped from
  `awb_number`            VARCHAR(60)         NULL,
  `tracking_url`          VARCHAR(500)        NULL,
  `provider_shipment_id`  VARCHAR(80)         NULL,
  `status`                ENUM('created','label_generated','pickup_scheduled',
                               'picked_up','in_transit','out_for_delivery',
                               'delivered','ndr','rto_initiated','rto_in_transit',
                               'rto_delivered','lost','damaged','cancelled')
                                          NOT NULL DEFAULT 'created',
  `shipping_mode`         ENUM('surface','air','express') NOT NULL DEFAULT 'surface',
  `weight_grams`          INT UNSIGNED        NULL,
  `length_mm`             SMALLINT UNSIGNED   NULL,
  `width_mm`              SMALLINT UNSIGNED   NULL,
  `height_mm`             SMALLINT UNSIGNED   NULL,
  `shipping_charge`       DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `cod_amount`            DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `cod_remitted_at`       DATETIME            NULL,   -- COD reconciliation
  `label_media_id`        BIGINT UNSIGNED     NULL,
  `manifest_reference`    VARCHAR(60)         NULL,
  -- NDR = non-delivery report. Tracking these is what keeps RTO losses down.
  `ndr_reason`            VARCHAR(255)        NULL,
  `ndr_attempts`          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `rto_reason`            VARCHAR(255)        NULL,
  `shipped_at`            DATETIME            NULL,
  `estimated_delivery_at` DATETIME            NULL,
  `delivered_at`          DATETIME            NULL,
  `created_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shipments_number` (`shipment_number`),
  KEY `ix_shipments_order` (`order_id`),
  KEY `ix_shipments_awb` (`awb_number`),
  KEY `ix_shipments_status` (`status`, `updated_at`),
  CONSTRAINT `fk_shipments_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_shipments_carrier`
    FOREIGN KEY (`carrier_id`) REFERENCES `shipping_carriers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_shipments_location`
    FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_shipments_label`
    FOREIGN KEY (`label_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `shipment_items` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shipment_id`   BIGINT UNSIGNED NOT NULL,
  `order_item_id` BIGINT UNSIGNED NOT NULL,
  `quantity`      SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shipment_items` (`shipment_id`, `order_item_id`),
  KEY `ix_shipment_items_order_item` (`order_item_id`),
  CONSTRAINT `fk_shipment_items_shipment`
    FOREIGN KEY (`shipment_id`) REFERENCES `shipments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_shipment_items_order_item`
    FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Courier scan events. UNIQUE on (shipment, code, time) makes ingesting the
-- same tracking payload twice a no-op.
CREATE TABLE `shipment_tracking_events` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shipment_id`  BIGINT UNSIGNED NOT NULL,
  `status_code`  VARCHAR(40)     NOT NULL,
  `status_label` VARCHAR(120)        NULL,
  `description`  VARCHAR(500)        NULL,
  `location`     VARCHAR(120)        NULL,
  `event_at`     DATETIME        NOT NULL,
  `is_customer_visible` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `raw`          JSON                NULL,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shipment_tracking_events` (`shipment_id`, `status_code`, `event_at`),
  KEY `ix_shipment_tracking_shipment` (`shipment_id`, `event_at`),
  CONSTRAINT `fk_shipment_tracking_shipment`
    FOREIGN KEY (`shipment_id`) REFERENCES `shipments` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- pincode_serviceability — powers the PDP/cart pincode check (BRD §7.3, §7.5)
-- ~19,000 rows for India. Loaded from the courier aggregator and refreshed on a
-- schedule; `pincode` is the primary lookup so the check is a single indexed hit.
-- -----------------------------------------------------------------------------
CREATE TABLE `pincode_serviceability` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pincode`              CHAR(6)         NOT NULL,
  `city`                 VARCHAR(80)         NULL,
  `district`             VARCHAR(80)         NULL,
  `state`                VARCHAR(80)         NULL,
  `state_code`           CHAR(2)             NULL,
  `zone`                 ENUM('local','regional','metro','rest_of_india','special')
                                         NOT NULL DEFAULT 'rest_of_india',
  `is_serviceable`       TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `prepaid_available`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `cod_available`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `express_available`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `standard_eta_min_days` TINYINT UNSIGNED NOT NULL DEFAULT 3,
  `standard_eta_max_days` TINYINT UNSIGNED NOT NULL DEFAULT 7,
  `express_eta_days`     TINYINT UNSIGNED    NULL,
  `default_carrier_id`   BIGINT UNSIGNED     NULL,
  `order_cutoff_time`    TIME                NULL,
  `notes`                VARCHAR(255)        NULL,
  `source`               VARCHAR(40)         NULL,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pincode_serviceability` (`pincode`),
  KEY `ix_pincode_state` (`state_code`),
  KEY `ix_pincode_cod` (`cod_available`, `is_serviceable`),
  CONSTRAINT `fk_pincode_carrier`
    FOREIGN KEY (`default_carrier_id`) REFERENCES `shipping_carriers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Rate card. Free-shipping threshold lives here rather than as a magic number
-- in code, so ops can change it per zone without a deploy.
CREATE TABLE `shipping_rates` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`              VARCHAR(120)    NOT NULL,
  `zone`              ENUM('local','regional','metro','rest_of_india','special','all')
                                      NOT NULL DEFAULT 'all',
  `method`            ENUM('standard','express','pickup') NOT NULL DEFAULT 'standard',
  `min_order_amount`  DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `max_order_amount`  DECIMAL(10,2)       NULL,
  `min_weight_grams`  INT UNSIGNED    NOT NULL DEFAULT 0,
  `max_weight_grams`  INT UNSIGNED        NULL,
  `rate`              DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `free_above_amount` DECIMAL(10,2)       NULL,
  `eta_min_days`      TINYINT UNSIGNED NOT NULL DEFAULT 3,
  `eta_max_days`      TINYINT UNSIGNED NOT NULL DEFAULT 7,
  `is_active`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `priority`          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_shipping_rates_lookup` (`zone`, `method`, `is_active`, `priority`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- BRD decision register: "COD: enable with pincode/order-value controls."
CREATE TABLE `cod_rules` (
  `id`                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`                   VARCHAR(120)    NOT NULL,
  `is_active`              TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `min_order_amount`       DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `max_order_amount`       DECIMAL(10,2)       NULL,
  `cod_fee`                DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `prepaid_discount_amount` DECIMAL(10,2)  NOT NULL DEFAULT 0.00,
  `prepaid_discount_percent` DECIMAL(5,2)  NOT NULL DEFAULT 0.00,
  `requires_otp_confirmation` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `max_open_cod_orders`    TINYINT UNSIGNED NOT NULL DEFAULT 2,
  `block_if_rto_count_gte` TINYINT UNSIGNED    NULL,
  `blocked_pincodes`       JSON                NULL,
  `blocked_categories`     JSON                NULL,
  `priority`               SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_cod_rules_active` (`is_active`, `priority`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
