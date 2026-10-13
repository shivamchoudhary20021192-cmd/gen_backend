-- =============================================================================
-- File 12 : SUPPORT AND OPERATIONS
-- =============================================================================
-- BRD §8.2 spells the contact reasons out: "product guidance, order, delivery,
-- return/refund, adverse reaction, other", and requires that the adverse-event
-- flow "captures batch number, purchase source, photos (optional), symptoms and
-- consent; routes to trained staff. Do not offer automated medical diagnosis."
--
-- That last one is why `adverse_events` is its own table rather than a ticket
-- reason: it has a different retention rule, a different access permission, a
-- different SLA, and it may need to be reported to a regulator.
-- =============================================================================

USE `veylog`;

CREATE TABLE `support_tickets` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ticket_number`       VARCHAR(20)     NOT NULL,
  `customer_id`         BIGINT UNSIGNED     NULL,
  `order_id`            BIGINT UNSIGNED     NULL,
  `name`                VARCHAR(160)    NOT NULL,
  `email`               VARCHAR(191)        NULL,
  `phone`               VARCHAR(15)         NULL,
  `reason`              ENUM('product_guidance','order_issue','delivery',
                             'return_refund','adverse_reaction','payment',
                             'feedback','wholesale','press','other')
                                        NOT NULL DEFAULT 'other',
  `subject`             VARCHAR(255)        NULL,
  `status`              ENUM('open','pending_customer','in_progress','escalated',
                             'resolved','closed')
                                        NOT NULL DEFAULT 'open',
  `priority`            ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  `channel`             ENUM('web_form','whatsapp','email','phone','chat','instagram')
                                        NOT NULL DEFAULT 'web_form',
  `assigned_admin_id`   BIGINT UNSIGNED     NULL,
  `first_response_at`   DATETIME            NULL,
  `sla_due_at`          DATETIME            NULL,   -- BRD: SLA must be visible
  `sla_breached`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `resolved_at`         DATETIME            NULL,
  `closed_at`           DATETIME            NULL,
  `resolution_note`     TEXT                NULL,
  `satisfaction_rating` TINYINT UNSIGNED    NULL,
  `escalated_at`        DATETIME            NULL,
  `escalated_to_admin_id` BIGINT UNSIGNED   NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_support_tickets_number` (`ticket_number`),
  KEY `ix_support_tickets_status` (`status`, `priority`, `created_at`),
  KEY `ix_support_tickets_customer` (`customer_id`, `created_at`),
  KEY `ix_support_tickets_order` (`order_id`),
  KEY `ix_support_tickets_assignee` (`assigned_admin_id`, `status`),
  KEY `ix_support_tickets_sla` (`sla_due_at`, `status`),
  CONSTRAINT `fk_support_tickets_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_support_tickets_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_support_tickets_assignee`
    FOREIGN KEY (`assigned_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_support_tickets_escalatee`
    FOREIGN KEY (`escalated_to_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `ticket_messages` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ticket_id`           BIGINT UNSIGNED NOT NULL,
  `sender_type`         ENUM('customer','admin','system') NOT NULL,
  `sender_id`           BIGINT UNSIGNED     NULL,
  `sender_name`         VARCHAR(160)        NULL,
  `body`                TEXT            NOT NULL,
  -- internal notes never render in the customer thread
  `is_internal_note`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `channel`             ENUM('web','email','whatsapp','sms','phone') NOT NULL DEFAULT 'web',
  `provider_message_id` VARCHAR(120)        NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_ticket_messages_ticket` (`ticket_id`, `created_at`),
  CONSTRAINT `fk_ticket_messages_ticket`
    FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- adverse_events — cosmetovigilance
-- Access should be restricted to a dedicated permission; this is health data.
-- Photos attach via media_attachments (attachable_type='adverse_event').
-- -----------------------------------------------------------------------------
CREATE TABLE `adverse_events` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `reference`             VARCHAR(20)     NOT NULL,
  `ticket_id`             BIGINT UNSIGNED     NULL,
  `customer_id`           BIGINT UNSIGNED     NULL,
  `order_id`              BIGINT UNSIGNED     NULL,
  `product_id`            BIGINT UNSIGNED     NULL,
  `variant_id`            BIGINT UNSIGNED     NULL,
  `batch_number`          VARCHAR(40)         NULL,
  `batch_id`              BIGINT UNSIGNED     NULL,
  `purchase_source`       ENUM('veylor_website','amazon','nykaa','flipkart',
                               'retail','gift','sample','unknown')
                                          NOT NULL DEFAULT 'unknown',
  `purchase_date`         DATE                NULL,
  `first_use_date`        DATE                NULL,
  `onset_date`            DATE                NULL,
  `symptoms`              TEXT            NOT NULL,
  `affected_area`         VARCHAR(191)        NULL,
  `severity`              ENUM('mild','moderate','severe','unknown') NOT NULL DEFAULT 'unknown',
  `is_ongoing`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `stopped_use`           TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `medical_attention_sought` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `concomitant_products`  TEXT                NULL,   -- what else they were using
  `known_allergies`       TEXT                NULL,
  -- explicit consent to be contacted about a health matter
  `consent_to_contact`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `consent_id`            BIGINT UNSIGNED     NULL,
  `status`                ENUM('reported','under_review','contacted','escalated',
                               'closed','reported_to_regulator')
                                          NOT NULL DEFAULT 'reported',
  `reviewed_by_admin_id`  BIGINT UNSIGNED     NULL,
  `reviewed_at`           DATETIME            NULL,
  `outcome_note`          TEXT                NULL,
  `regulatory_reported_at` DATETIME           NULL,
  `regulatory_reference`  VARCHAR(80)         NULL,
  `reported_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_adverse_events_reference` (`reference`),
  KEY `ix_adverse_events_product` (`product_id`, `reported_at`),
  KEY `ix_adverse_events_batch` (`batch_number`),
  KEY `ix_adverse_events_status` (`status`, `severity`),
  CONSTRAINT `fk_adverse_events_ticket`
    FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_adverse_events_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_adverse_events_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_adverse_events_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_adverse_events_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_adverse_events_batch`
    FOREIGN KEY (`batch_id`) REFERENCES `product_batches` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_adverse_events_consent`
    FOREIGN KEY (`consent_id`) REFERENCES `customer_consents` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_adverse_events_reviewer`
    FOREIGN KEY (`reviewed_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- order_tracking_lookups — BRD §8.2: "Track order by order number + verified
-- phone/email." Logging every attempt is what lets you rate-limit enumeration
-- of order numbers.
-- -----------------------------------------------------------------------------
CREATE TABLE `order_tracking_lookups` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_number`     VARCHAR(20)         NULL,
  `contact_value`    VARCHAR(191)        NULL,   -- phone or email supplied
  `order_id`         BIGINT UNSIGNED     NULL,
  `was_successful`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `ip`               VARBINARY(16)       NULL,
  `user_agent`       VARCHAR(255)        NULL,
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_order_tracking_lookups_ip` (`ip`, `created_at`),
  KEY `ix_order_tracking_lookups_order` (`order_number`, `created_at`),
  CONSTRAINT `fk_order_tracking_lookups_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Canned replies for the support team
CREATE TABLE `support_macros` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(120)    NOT NULL,
  `reason`      VARCHAR(60)         NULL,
  `body`        TEXT            NOT NULL,
  `is_active`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `usage_count` INT UNSIGNED    NOT NULL DEFAULT 0,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_support_macros_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
