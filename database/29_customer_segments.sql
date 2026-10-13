-- =============================================================================
-- File 29 : CUSTOMER SEGMENTS
-- =============================================================================
-- Customer segmentation for targeted marketing, analytics, and CRM workflows.
-- Supports:
-- - Manual segments (admin-curated customer lists)
-- - Auto segments (rule-based, dynamically evaluated)
-- - Tags for quick filtering
-- =============================================================================

-- No USE statement: the database name differs per environment (veylog locally,
-- veylor_db on the server). Hardcoding one here made every migration below fail
-- with "Access denied" on the deployed box. Connect to the right database
-- instead: `mysql -D <database> < this-file.sql`.
-- -----------------------------------------------------------------------------
-- customer_segments
-- -----------------------------------------------------------------------------
CREATE TABLE `customer_segments` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`                VARCHAR(120)    NOT NULL,
  `description`         TEXT                NULL,
  `segment_type`        ENUM('manual','auto','imported') NOT NULL DEFAULT 'manual',
  
  -- Auto-segment rules (JSON array of conditions)
  -- Example: [{"field":"total_spent","operator":">=","value":5000},{"field":"orders_count","operator":">=","value":3}]
  `rules`               JSON                NULL,
  `rules_operator`      ENUM('all','any')   NOT NULL DEFAULT 'all',  -- AND/OR for rules
  
  -- Cached count for performance
  `customer_count`      INT UNSIGNED    NOT NULL DEFAULT 0,
  `last_calculated_at`  DATETIME            NULL,
  
  `color`               VARCHAR(7)          NULL,   -- hex color for UI
  `icon`                VARCHAR(40)         NULL,
  
  `created_by_admin_id` BIGINT UNSIGNED     NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME            NULL,
  
  PRIMARY KEY (`id`),
  KEY `ix_customer_segments_type` (`segment_type`, `deleted_at`),
  CONSTRAINT `fk_customer_segments_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- customer_segment_members
-- -----------------------------------------------------------------------------
-- For manual segments: explicitly added by admin
-- For auto segments: calculated by cron job evaluating rules
-- -----------------------------------------------------------------------------
CREATE TABLE `customer_segment_members` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `segment_id`        BIGINT UNSIGNED NOT NULL,
  `customer_id`       BIGINT UNSIGNED NOT NULL,
  
  -- For manual segments
  `added_by_admin_id` BIGINT UNSIGNED     NULL,
  
  -- For auto segments
  `auto_added_at`     DATETIME            NULL,
  
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_segment_members` (`segment_id`, `customer_id`),
  KEY `ix_segment_members_customer` (`customer_id`),
  CONSTRAINT `fk_segment_members_segment`
    FOREIGN KEY (`segment_id`) REFERENCES `customer_segments` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_segment_members_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_segment_members_admin`
    FOREIGN KEY (`added_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- customer_tags (simpler than segments, just labels)
-- -----------------------------------------------------------------------------
CREATE TABLE `customer_tags` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(60)     NOT NULL,
  `color`       VARCHAR(7)          NULL,
  `description` VARCHAR(255)        NULL,
  `usage_count` INT UNSIGNED    NOT NULL DEFAULT 0,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customer_tags_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `customer_tag_assignments` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id`       BIGINT UNSIGNED NOT NULL,
  `tag_id`            BIGINT UNSIGNED NOT NULL,
  `added_by_admin_id` BIGINT UNSIGNED     NULL,
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customer_tag_assignments` (`customer_id`, `tag_id`),
  KEY `ix_customer_tag_assignments_tag` (`tag_id`),
  CONSTRAINT `fk_customer_tag_assignments_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_customer_tag_assignments_tag`
    FOREIGN KEY (`tag_id`) REFERENCES `customer_tags` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_customer_tag_assignments_admin`
    FOREIGN KEY (`added_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Seed: Common segment examples
-- -----------------------------------------------------------------------------
INSERT INTO `customer_segments` 
  (`name`, `description`, `segment_type`, `rules`, `rules_operator`, `color`, `icon`)
VALUES
  ('VIP Customers', 'Customers who have spent ₹10,000+', 'auto', 
   '[{"field":"total_spent","operator":">=","value":10000}]', 'all', '#9C27B0', 'star'),
   
  ('High-Value', 'Customers with ₹5,000+ total spend', 'auto',
   '[{"field":"total_spent","operator":">=","value":5000}]', 'all', '#FF9800', 'diamond'),
   
  ('Repeat Buyers', 'Customers with 3+ orders', 'auto',
   '[{"field":"orders_count","operator":">=","value":3}]', 'all', '#4CAF50', 'repeat'),
   
  ('First-Time Buyers', 'Customers with exactly 1 order', 'auto',
   '[{"field":"orders_count","operator":"=","value":1}]', 'all', '#2196F3', 'new_releases'),
   
  ('At Risk', 'No order in 90+ days but ordered before', 'auto',
   '[{"field":"last_order_at","operator":"<","value":"90_days_ago"},{"field":"orders_count","operator":">","value":0}]', 'all', '#F44336', 'warning'),
   
  ('Newsletter Subscribers', 'Email marketing consent given', 'auto',
   '[{"field":"accepts_email_marketing","operator":"=","value":1}]', 'all', '#00BCD4', 'email'),
   
  ('COD Blocked', 'Customers blocked from COD', 'auto',
   '[{"field":"cod_blocked","operator":"=","value":1}]', 'all', '#795548', 'block');

-- Update menu item status to available
UPDATE `menu_items` SET `status` = 'available' WHERE `menu_key` = 'customers.segments';
