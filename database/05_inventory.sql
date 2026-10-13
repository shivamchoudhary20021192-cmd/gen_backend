-- =============================================================================
-- File 05 : INVENTORY — locations, stock levels, ledger, reservations, batches
-- =============================================================================
-- BRD risk register: "Stock mismatch → cancellation/trust → single inventory
-- source, reservations, revalidation and alerts." So:
--
--   inventory_items        the ONLY place a stock number lives
--   inventory_movements    append-only ledger; every change writes a row
--   inventory_reservations short-lived holds so two people cannot buy the last
--                          unit between add-to-cart and payment capture
--
-- `quantity_available` is a STORED generated column, so "is it in stock" is an
-- indexed read and can never drift from on_hand minus reserved.
-- =============================================================================

-- No USE statement: the database name differs per environment (veylog locally,
-- veylor_db on the server). Hardcoding one here made every migration below fail
-- with "Access denied" on the deployed box. Connect to the right database
-- instead: `mysql -D <database> < this-file.sql`.
CREATE TABLE `inventory_locations` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`         VARCHAR(40)     NOT NULL,
  `name`         VARCHAR(120)    NOT NULL,
  `location_type` ENUM('warehouse','store','3pl','virtual') NOT NULL DEFAULT 'warehouse',
  `line1`        VARCHAR(255)        NULL,
  `line2`        VARCHAR(255)        NULL,
  `city`         VARCHAR(80)         NULL,
  `state`        VARCHAR(80)         NULL,
  `state_code`   CHAR(2)             NULL,   -- GST place of supply
  `pincode`      CHAR(6)             NULL,
  `country`      CHAR(2)         NOT NULL DEFAULT 'IN',
  `gstin`        VARCHAR(15)         NULL,
  `contact_name` VARCHAR(120)        NULL,
  `contact_phone` VARCHAR(20)        NULL,
  `is_default`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_active`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `fulfils_online_orders` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `priority`     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_locations_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `inventory_items` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `variant_id`         BIGINT UNSIGNED NOT NULL,
  `location_id`        BIGINT UNSIGNED NOT NULL,
  `quantity_on_hand`   INT             NOT NULL DEFAULT 0,
  `quantity_reserved`  INT             NOT NULL DEFAULT 0,
  `quantity_incoming`  INT             NOT NULL DEFAULT 0,
  `quantity_available` INT AS (`quantity_on_hand` - `quantity_reserved`) STORED,
  `safety_stock`       INT             NOT NULL DEFAULT 0,
  `bin_location`       VARCHAR(60)         NULL,
  `last_counted_at`    DATETIME            NULL,
  `updated_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_inventory_items` (`variant_id`, `location_id`),
  KEY `ix_inventory_items_location` (`location_id`),
  KEY `ix_inventory_items_available` (`quantity_available`),
  CONSTRAINT `fk_inventory_items_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_inventory_items_location`
    FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only. Never UPDATE or DELETE a row here: this ledger is what you
-- reconcile against when the warehouse count and the site disagree.
CREATE TABLE `inventory_movements` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `variant_id`      BIGINT UNSIGNED NOT NULL,
  `location_id`     BIGINT UNSIGNED NOT NULL,
  `movement_type`   ENUM('purchase_receipt','sale','cancellation','return_restock',
                         'adjustment','damage','expiry','transfer_in','transfer_out',
                         'reservation_hold','reservation_release','stock_take','rto_restock')
                                    NOT NULL,
  `quantity_delta`  INT             NOT NULL,   -- signed
  `quantity_after`  INT             NOT NULL,   -- on_hand after this movement
  `reference_type`  VARCHAR(40)         NULL,   -- 'order','return_request','shipment'
  `reference_id`    BIGINT UNSIGNED     NULL,
  `batch_id`        BIGINT UNSIGNED     NULL,
  `unit_cost`       DECIMAL(10,2)       NULL,
  `reason`          VARCHAR(255)        NULL,
  `admin_user_id`   BIGINT UNSIGNED     NULL,
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_inventory_movements_variant` (`variant_id`, `created_at`),
  KEY `ix_inventory_movements_reference` (`reference_type`, `reference_id`),
  KEY `ix_inventory_movements_type` (`movement_type`, `created_at`),
  CONSTRAINT `fk_inventory_movements_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_inventory_movements_location`
    FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_inventory_movements_admin`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Held at checkout start, committed on payment capture, released on failure or
-- expiry. A cron sweeps `status='held' AND expires_at < NOW()`.
CREATE TABLE `inventory_reservations` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `variant_id`  BIGINT UNSIGNED NOT NULL,
  `location_id` BIGINT UNSIGNED NOT NULL,
  `quantity`    INT UNSIGNED    NOT NULL,
  `cart_id`     BIGINT UNSIGNED     NULL,   -- FK added in 08
  `order_id`    BIGINT UNSIGNED     NULL,   -- FK added in 08
  `status`      ENUM('held','committed','released','expired') NOT NULL DEFAULT 'held',
  `expires_at`  DATETIME        NOT NULL,
  `released_at` DATETIME            NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_inventory_reservations_variant` (`variant_id`, `status`),
  KEY `ix_inventory_reservations_sweep` (`status`, `expires_at`),
  KEY `ix_inventory_reservations_cart` (`cart_id`),
  KEY `ix_inventory_reservations_order` (`order_id`),
  CONSTRAINT `fk_inventory_reservations_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_inventory_reservations_location`
    FOREIGN KEY (`location_id`) REFERENCES `inventory_locations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Cosmetics need batch + expiry traceability: it is what an adverse-event
-- report is matched against, and what a recall would be scoped by.
CREATE TABLE `product_batches` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `variant_id`       BIGINT UNSIGNED NOT NULL,
  `batch_number`     VARCHAR(40)     NOT NULL,
  `manufactured_on`  DATE                NULL,
  `expires_on`       DATE                NULL,
  `best_before_on`   DATE                NULL,
  `quantity_received` INT UNSIGNED   NOT NULL DEFAULT 0,
  `quantity_remaining` INT UNSIGNED  NOT NULL DEFAULT 0,
  `supplier_name`    VARCHAR(191)        NULL,
  `manufacturing_site` VARCHAR(255)      NULL,
  `coa_media_id`     BIGINT UNSIGNED     NULL,   -- certificate of analysis
  `status`           ENUM('active','quarantined','recalled','depleted','expired')
                                     NOT NULL DEFAULT 'active',
  `notes`            TEXT                NULL,
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_batches` (`variant_id`, `batch_number`),
  KEY `ix_product_batches_expiry` (`expires_on`, `status`),
  CONSTRAINT `fk_product_batches_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_batches_coa`
    FOREIGN KEY (`coa_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `inventory_movements`
  ADD CONSTRAINT `fk_inventory_movements_batch`
    FOREIGN KEY (`batch_id`) REFERENCES `product_batches` (`id`) ON DELETE SET NULL;
