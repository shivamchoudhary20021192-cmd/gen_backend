-- =============================================================================
-- File 08 : CART AND ORDERS
-- =============================================================================
-- GUEST-FIRST CART
-- A cart exists before any customer does. `carts.token` is the guest identity,
-- stored client-side and sent as a header. At checkout login the guest cart is
-- merged into the customer's active cart and marked status='merged' with
-- `merged_into_cart_id` pointing at the survivor — nothing is deleted, so a
-- support agent can still see what the customer had.
--
-- PRICE INTEGRITY
-- cart_items.unit_price is a DISPLAY snapshot only. Order totals are always
-- recomputed server-side from product_variants at order creation. Never trust a
-- price that arrived from the client.
--
-- THREE STATUS COLUMNS, NOT ONE
-- BRD FR-06 requires statuses that "map payment, fulfilment, shipment,
-- delivery, cancellation, RTO and refund". A single status column cannot
-- express "delivered but partially refunded", so orders carry:
--   order_status        the customer-facing lifecycle
--   payment_status      money
--   fulfillment_status  goods
-- Every transition is written to order_status_history.
-- =============================================================================

USE `veylog`;

CREATE TABLE `carts` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `token`               CHAR(36)        NOT NULL DEFAULT (UUID()),  -- guest identity
  `customer_id`         BIGINT UNSIGNED     NULL,
  `status`              ENUM('active','converted','abandoned','merged','expired')
                                        NOT NULL DEFAULT 'active',
  `currency`            CHAR(3)         NOT NULL DEFAULT 'INR',
  `coupon_code`         VARCHAR(60)         NULL,
  `loyalty_points_applied` INT UNSIGNED NOT NULL DEFAULT 0,
  `item_count`          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `subtotal`            DECIMAL(12,2)   NOT NULL DEFAULT 0.00,   -- cached, display only
  `estimated_total`     DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `pincode`             CHAR(6)             NULL,   -- for the delivery estimate
  `merged_into_cart_id` BIGINT UNSIGNED     NULL,
  `converted_order_id`  BIGINT UNSIGNED     NULL,   -- FK added after `orders`
  `abandoned_at`        DATETIME            NULL,
  `recovery_email_sent_at` DATETIME         NULL,
  `recovery_token`      CHAR(36)            NULL,
  `last_activity_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- BRD FR-03: "Cart persists for at least 30 days for consenting/recognized
  -- visitors." Set to now() + 30 days on each write.
  `expires_at`          DATETIME            NULL,
  `ip`                  VARBINARY(16)       NULL,
  `user_agent`          VARCHAR(255)        NULL,
  `utm`                 JSON                NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_carts_token` (`token`),
  KEY `ix_carts_customer` (`customer_id`, `status`),
  KEY `ix_carts_status_activity` (`status`, `last_activity_at`),
  KEY `ix_carts_expiry` (`expires_at`),
  CONSTRAINT `fk_carts_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_carts_merged_into`
    FOREIGN KEY (`merged_into_cart_id`) REFERENCES `carts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `inventory_reservations`
  ADD CONSTRAINT `fk_inventory_reservations_cart`
    FOREIGN KEY (`cart_id`) REFERENCES `carts` (`id`) ON DELETE SET NULL;

CREATE TABLE `cart_items` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `cart_id`     BIGINT UNSIGNED NOT NULL,
  `product_id`  BIGINT UNSIGNED NOT NULL,
  `variant_id`  BIGINT UNSIGNED NOT NULL,
  `quantity`    SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `unit_price`  DECIMAL(10,2)   NOT NULL,   -- snapshot, revalidated server-side
  `unit_mrp`    DECIMAL(10,2)       NULL,
  `item_status` ENUM('active','saved_for_later') NOT NULL DEFAULT 'active',
  `is_gift`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,   -- threshold free gift
  `source_coupon_id` BIGINT UNSIGNED NULL,               -- FK added in file 10
  `added_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cart_items` (`cart_id`, `variant_id`, `item_status`),
  KEY `ix_cart_items_variant` (`variant_id`),
  CONSTRAINT `fk_cart_items_cart`
    FOREIGN KEY (`cart_id`) REFERENCES `carts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cart_items_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cart_items_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ck_cart_items_quantity` CHECK (`quantity` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- orders
-- -----------------------------------------------------------------------------
CREATE TABLE `orders` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_number`          VARCHAR(20)     NOT NULL,   -- 'VEY-2026-000142'
  `public_id`             CHAR(36)        NOT NULL DEFAULT (UUID()),
  `cart_id`               BIGINT UNSIGNED     NULL,
  `customer_id`           BIGINT UNSIGNED     NULL,   -- NULL survives erasure
  `is_guest`              TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  -- Contact snapshot: an order must remain contactable and printable even if
  -- the customer record is later anonymised.
  `contact_phone`         VARCHAR(15)     NOT NULL,
  `contact_email`         VARCHAR(191)        NULL,
  `customer_name`         VARCHAR(160)        NULL,

  `currency`              CHAR(3)         NOT NULL DEFAULT 'INR',
  `order_status`          ENUM('pending','confirmed','processing','packed','shipped',
                               'out_for_delivery','delivered','cancelled',
                               'returned','rto')
                                          NOT NULL DEFAULT 'pending',
  `payment_status`        ENUM('pending','authorized','paid','cod_pending',
                               'cod_collected','partially_refunded','refunded',
                               'failed','cancelled')
                                          NOT NULL DEFAULT 'pending',
  `fulfillment_status`    ENUM('unfulfilled','partially_fulfilled','fulfilled',
                               'returned','rto')
                                          NOT NULL DEFAULT 'unfulfilled',
  `payment_method`        ENUM('razorpay','cod','upi','card','netbanking','wallet','manual')
                                              NULL,

  -- ── money. Every figure recomputed server-side; none accepted from client ──
  `subtotal`              DECIMAL(12,2)   NOT NULL DEFAULT 0.00,  -- sum of line taxable pre-discount
  `discount_total`        DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `coupon_discount`       DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `loyalty_discount`      DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `shipping_total`        DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `cod_fee`               DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `tax_total`             DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `cgst_total`            DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `sgst_total`            DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `igst_total`            DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `grand_total`           DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `amount_paid`           DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `amount_refunded`       DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `amount_due`            DECIMAL(12,2)   NOT NULL DEFAULT 0.00,

  `coupon_id`             BIGINT UNSIGNED     NULL,   -- FK added in file 10
  `coupon_code`           VARCHAR(60)         NULL,
  `loyalty_points_used`   INT UNSIGNED    NOT NULL DEFAULT 0,
  `loyalty_points_earned` INT UNSIGNED    NOT NULL DEFAULT 0,

  -- ── delivery ──────────────────────────────────────────────────────────────
  `pincode`               CHAR(6)             NULL,
  `place_of_supply_state_code` CHAR(2)        NULL,   -- decides CGST+SGST vs IGST
  `shipping_method`       ENUM('standard','express','pickup') NOT NULL DEFAULT 'standard',
  `estimated_delivery_from` DATE              NULL,
  `estimated_delivery_to`   DATE              NULL,

  -- ── notes, risk, attribution ──────────────────────────────────────────────
  `customer_note`         VARCHAR(500)        NULL,
  `admin_note`            TEXT                NULL,
  `cancel_reason`         VARCHAR(255)        NULL,
  `cancelled_by`          ENUM('customer','admin','system','payment_timeout') NULL,
  `risk_score`            TINYINT UNSIGNED    NULL,   -- COD/RTO risk
  `risk_flags`            JSON                NULL,
  `source_channel`        ENUM('web','mobile_web','whatsapp','admin','app')
                                          NOT NULL DEFAULT 'web',
  `ip`                    VARBINARY(16)       NULL,
  `user_agent`            VARCHAR(255)        NULL,
  `utm`                   JSON                NULL,
  `quiz_submission_id`    BIGINT UNSIGNED     NULL,   -- attribution for the quiz

  -- ── timeline ──────────────────────────────────────────────────────────────
  `placed_at`             DATETIME            NULL,
  `confirmed_at`          DATETIME            NULL,
  `packed_at`             DATETIME            NULL,
  `shipped_at`            DATETIME            NULL,
  `delivered_at`          DATETIME            NULL,
  `cancelled_at`          DATETIME            NULL,
  `created_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_orders_number` (`order_number`),
  UNIQUE KEY `uq_orders_public_id` (`public_id`),
  KEY `ix_orders_customer` (`customer_id`, `created_at`),
  KEY `ix_orders_order_status` (`order_status`, `created_at`),
  KEY `ix_orders_payment_status` (`payment_status`, `created_at`),
  KEY `ix_orders_fulfillment` (`fulfillment_status`, `created_at`),
  KEY `ix_orders_phone` (`contact_phone`),          -- order tracking lookup
  KEY `ix_orders_created` (`created_at`),
  KEY `ix_orders_placed` (`placed_at`),
  CONSTRAINT `fk_orders_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_orders_cart`
    FOREIGN KEY (`cart_id`) REFERENCES `carts` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_orders_quiz_submission`
    FOREIGN KEY (`quiz_submission_id`) REFERENCES `quiz_submissions` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `carts`
  ADD CONSTRAINT `fk_carts_converted_order`
    FOREIGN KEY (`converted_order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL;

ALTER TABLE `inventory_reservations`
  ADD CONSTRAINT `fk_inventory_reservations_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL;

ALTER TABLE `quiz_submissions`
  ADD CONSTRAINT `fk_quiz_submissions_order`
    FOREIGN KEY (`converted_order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- order_items — fully snapshotted. Renaming a product or changing its price
-- must never alter a historical invoice.
-- -----------------------------------------------------------------------------
CREATE TABLE `order_items` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`             BIGINT UNSIGNED NOT NULL,
  `product_id`           BIGINT UNSIGNED     NULL,   -- SET NULL if product deleted
  `variant_id`           BIGINT UNSIGNED     NULL,
  `parent_order_item_id` BIGINT UNSIGNED     NULL,   -- bundle component -> parent
  `line_type`            ENUM('product','bundle','bundle_component','gift','shipping')
                                         NOT NULL DEFAULT 'product',

  -- snapshot
  `sku`                  VARCHAR(64)         NULL,
  `product_name`         VARCHAR(255)    NOT NULL,
  `variant_title`        VARCHAR(160)        NULL,
  `product_slug`         VARCHAR(191)        NULL,
  `image_url`            VARCHAR(500)        NULL,
  `hsn_code`             VARCHAR(12)         NULL,
  `batch_number`         VARCHAR(40)         NULL,   -- traceability

  `unit_mrp`             DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `unit_price`           DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `quantity`             SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `discount_amount`      DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `taxable_amount`       DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `tax_rate`             DECIMAL(5,2)    NOT NULL DEFAULT 0.00,
  `cgst_amount`          DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `sgst_amount`          DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `igst_amount`          DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `tax_amount`           DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `line_total`           DECIMAL(12,2)   NOT NULL DEFAULT 0.00,

  `fulfilled_quantity`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `cancelled_quantity`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `returned_quantity`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `refunded_amount`      DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_order_items_order` (`order_id`),
  KEY `ix_order_items_product` (`product_id`),
  KEY `ix_order_items_variant` (`variant_id`),
  KEY `ix_order_items_parent` (`parent_order_item_id`),
  CONSTRAINT `fk_order_items_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_order_items_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_order_items_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_order_items_parent`
    FOREIGN KEY (`parent_order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Address snapshot as a real table rather than a JSON column, so shipping
-- exports, pincode reports and courier manifests are plain SQL.
CREATE TABLE `order_addresses` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`      BIGINT UNSIGNED NOT NULL,
  `address_type`  ENUM('shipping','billing') NOT NULL,
  `first_name`    VARCHAR(80)     NOT NULL,
  `last_name`     VARCHAR(80)         NULL,
  `phone`         VARCHAR(15)     NOT NULL,
  `alternate_phone` VARCHAR(15)       NULL,
  `email`         VARCHAR(191)        NULL,
  `line1`         VARCHAR(255)    NOT NULL,
  `line2`         VARCHAR(255)        NULL,
  `landmark`      VARCHAR(120)        NULL,
  `city`          VARCHAR(80)     NOT NULL,
  `state`         VARCHAR(80)     NOT NULL,
  `state_code`    CHAR(2)             NULL,
  `pincode`       CHAR(6)         NOT NULL,
  `country`       CHAR(2)         NOT NULL DEFAULT 'IN',
  `gstin`         VARCHAR(15)         NULL,   -- B2B invoice
  `delivery_notes` VARCHAR(255)       NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_order_addresses` (`order_id`, `address_type`),
  KEY `ix_order_addresses_pincode` (`pincode`),
  CONSTRAINT `fk_order_addresses_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `order_status_history` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`           BIGINT UNSIGNED NOT NULL,
  `status_type`        ENUM('order','payment','fulfillment') NOT NULL,
  `from_status`        VARCHAR(40)         NULL,
  `to_status`          VARCHAR(40)     NOT NULL,
  `note`               VARCHAR(500)        NULL,
  `actor_type`         ENUM('customer','admin','system','webhook','courier')
                                       NOT NULL DEFAULT 'system',
  `actor_id`           BIGINT UNSIGNED     NULL,
  `is_customer_visible` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `notified_at`        DATETIME            NULL,
  `created_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_order_status_history_order` (`order_id`, `created_at`),
  CONSTRAINT `fk_order_status_history_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per discount that touched the order, so "why was this ₹120 off"
-- is answerable years later. BRD §8.1 requires deterministic, explainable
-- discount resolution.
CREATE TABLE `order_discounts` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`      BIGINT UNSIGNED NOT NULL,
  `discount_type` ENUM('coupon','automatic','loyalty','bundle','free_shipping','free_gift','manual')
                                  NOT NULL,
  `code`          VARCHAR(60)         NULL,
  `title`         VARCHAR(191)        NULL,
  `amount`        DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `applied_to`    ENUM('order','items','shipping') NOT NULL DEFAULT 'order',
  `coupon_id`     BIGINT UNSIGNED     NULL,   -- FK added in file 10
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_order_discounts_order` (`order_id`),
  CONSTRAINT `fk_order_discounts_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- invoices — GST tax invoice / credit note
-- Immutable once issued. A correction is a NEW credit note row, never an edit.
-- -----------------------------------------------------------------------------
CREATE TABLE `invoices` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`         BIGINT UNSIGNED NOT NULL,
  `invoice_number`   VARCHAR(30)     NOT NULL,
  `invoice_type`     ENUM('tax_invoice','credit_note') NOT NULL DEFAULT 'tax_invoice',
  `parent_invoice_id` BIGINT UNSIGNED    NULL,   -- credit note -> original
  `invoice_date`     DATE            NOT NULL,
  `seller_gstin`     VARCHAR(15)         NULL,
  `seller_legal_name` VARCHAR(191)       NULL,
  `buyer_gstin`      VARCHAR(15)         NULL,
  `place_of_supply`  CHAR(2)             NULL,
  `taxable_value`    DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `cgst_amount`      DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `sgst_amount`      DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `igst_amount`      DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `round_off`        DECIMAL(6,2)    NOT NULL DEFAULT 0.00,
  `total_amount`     DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `irn`              VARCHAR(64)         NULL,   -- e-invoice, if applicable
  `pdf_media_id`     BIGINT UNSIGNED     NULL,
  `status`           ENUM('draft','issued','cancelled') NOT NULL DEFAULT 'draft',
  `issued_at`        DATETIME            NULL,
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_invoices_number` (`invoice_number`),
  KEY `ix_invoices_order` (`order_id`),
  KEY `ix_invoices_date` (`invoice_date`),
  CONSTRAINT `fk_invoices_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_invoices_parent`
    FOREIGN KEY (`parent_invoice_id`) REFERENCES `invoices` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_invoices_pdf`
    FOREIGN KEY (`pdf_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Returns — BRD §14 requires cosmetic hygiene / damage / wrong-item scenarios
-- to be distinct, because eligibility differs per reason.
-- -----------------------------------------------------------------------------
CREATE TABLE `return_requests` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `rma_number`        VARCHAR(20)     NOT NULL,
  `order_id`          BIGINT UNSIGNED NOT NULL,
  `customer_id`       BIGINT UNSIGNED     NULL,
  `reason`            ENUM('damaged','wrong_item','missing_item','not_as_described',
                           'adverse_reaction','changed_mind','late_delivery',
                           'expired_product','other')
                                      NOT NULL,
  `reason_detail`     TEXT                NULL,
  `status`            ENUM('requested','approved','rejected','pickup_scheduled',
                           'picked_up','received','inspected','refunded','closed')
                                      NOT NULL DEFAULT 'requested',
  `refund_method`     ENUM('original','store_credit','bank_transfer','none')
                                      NOT NULL DEFAULT 'original',
  `requested_amount`  DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `approved_amount`   DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `pickup_address_id` BIGINT UNSIGNED     NULL,
  `pickup_awb`        VARCHAR(60)         NULL,
  `rejection_reason`  VARCHAR(500)        NULL,
  `inspection_note`   TEXT                NULL,
  `requested_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `approved_at`       DATETIME            NULL,
  `approved_by_admin_id` BIGINT UNSIGNED  NULL,
  `received_at`       DATETIME            NULL,
  `closed_at`         DATETIME            NULL,
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_return_requests_rma` (`rma_number`),
  KEY `ix_return_requests_order` (`order_id`),
  KEY `ix_return_requests_status` (`status`, `requested_at`),
  CONSTRAINT `fk_return_requests_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_return_requests_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_return_requests_pickup_address`
    FOREIGN KEY (`pickup_address_id`) REFERENCES `customer_addresses` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_return_requests_approver`
    FOREIGN KEY (`approved_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `return_items` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `return_request_id` BIGINT UNSIGNED NOT NULL,
  `order_item_id`     BIGINT UNSIGNED NOT NULL,
  `quantity`          SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `refund_amount`     DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `item_condition`    ENUM('unopened','opened','damaged','used','unknown')
                                      NOT NULL DEFAULT 'unknown',
  -- Opened cosmetics are usually not restockable for hygiene reasons.
  `restock`           TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `condition_note`    VARCHAR(500)        NULL,
  PRIMARY KEY (`id`),
  KEY `ix_return_items_request` (`return_request_id`),
  KEY `ix_return_items_order_item` (`order_item_id`),
  CONSTRAINT `fk_return_items_request`
    FOREIGN KEY (`return_request_id`) REFERENCES `return_requests` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_return_items_order_item`
    FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
