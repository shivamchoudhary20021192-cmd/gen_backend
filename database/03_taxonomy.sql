-- =============================================================================
-- File 03 : TAXONOMY — brands, categories, collections, skin attributes, tax
-- =============================================================================
-- Two different grouping concepts, on purpose:
--
--   categories   a strict tree, one primary parent per product. Drives
--                /shop/[category] and the breadcrumb. Merchandising-stable.
--   collections  many-to-many, manual OR rule-based (Shopify "smart
--                collections"). Drives /shop/bestsellers, /shop/new,
--                /shop/bundles and any campaign landing page.
--
-- Skin types and concerns are lookup tables, not ENUMs, because the BRD makes
-- them filter facets the content team must be able to extend without a
-- migration (BRD §7.4).
-- =============================================================================

USE `veylog`;

CREATE TABLE `brands` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`          VARCHAR(140)    NOT NULL,
  `name`          VARCHAR(120)    NOT NULL,
  `description`   TEXT                NULL,
  `logo_media_id` BIGINT UNSIGNED     NULL,
  `is_active`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_brands_slug` (`slug`),
  CONSTRAINT `fk_brands_logo`
    FOREIGN KEY (`logo_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- categories — serums, moisturizers, cleansers, sunscreens, treatments
-- -----------------------------------------------------------------------------
CREATE TABLE `categories` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `parent_id`          BIGINT UNSIGNED     NULL,
  `slug`               VARCHAR(140)    NOT NULL,
  `name`               VARCHAR(120)    NOT NULL,
  `short_description`  VARCHAR(500)        NULL,
  `description`        TEXT                NULL,
  `banner_media_id`    BIGINT UNSIGNED     NULL,
  `thumbnail_media_id` BIGINT UNSIGNED     NULL,
  `path`               VARCHAR(500)    NOT NULL DEFAULT '',
  `depth`              TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `sort_order`         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_active`          TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `show_in_menu`       TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `product_count`      INT UNSIGNED    NOT NULL DEFAULT 0,   -- denormalised cache
  `created_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`         DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_categories_slug` (`slug`),
  KEY `ix_categories_parent` (`parent_id`, `sort_order`),
  KEY `ix_categories_active` (`is_active`, `deleted_at`),
  CONSTRAINT `fk_categories_parent`
    FOREIGN KEY (`parent_id`) REFERENCES `categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_categories_banner`
    FOREIGN KEY (`banner_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_categories_thumbnail`
    FOREIGN KEY (`thumbnail_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- collections — manual or rule-driven product groupings
-- -----------------------------------------------------------------------------
CREATE TABLE `collections` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`            VARCHAR(140)    NOT NULL,
  `title`           VARCHAR(160)    NOT NULL,
  `subtitle`        VARCHAR(255)        NULL,
  `description`     TEXT                NULL,
  `collection_type` ENUM('manual','automatic') NOT NULL DEFAULT 'manual',
  -- how multiple rules combine, for automatic collections
  `match_condition` ENUM('all','any') NOT NULL DEFAULT 'all',
  `sort_type`       ENUM('manual','best_selling','newest','price_asc','price_desc','title_asc','rating_desc')
                                    NOT NULL DEFAULT 'manual',
  `image_media_id`  BIGINT UNSIGNED     NULL,
  `banner_media_id` BIGINT UNSIGNED     NULL,
  `is_active`       TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `show_in_menu`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `product_count`   INT UNSIGNED    NOT NULL DEFAULT 0,
  `published_at`    DATETIME            NULL,
  `sort_order`      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`      DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_collections_slug` (`slug`),
  KEY `ix_collections_active` (`is_active`, `published_at`),
  CONSTRAINT `fk_collections_image`
    FOREIGN KEY (`image_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_collections_banner`
    FOREIGN KEY (`banner_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `collection_rules` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `collection_id` BIGINT UNSIGNED NOT NULL,
  `field`         ENUM('title','tag','category','brand','price','compare_at_price',
                       'inventory_quantity','skin_type','concern','is_new',
                       'is_bestseller','rating','created_at')
                                  NOT NULL,
  `operator`      ENUM('equals','not_equals','contains','not_contains',
                       'starts_with','ends_with','greater_than','less_than',
                       'is_set','is_not_set')
                                  NOT NULL,
  `value`         VARCHAR(255)        NULL,
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `ix_collection_rules_collection` (`collection_id`, `sort_order`),
  CONSTRAINT `fk_collection_rules_collection`
    FOREIGN KEY (`collection_id`) REFERENCES `collections` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Materialised membership. Automatic collections are recalculated by a job and
-- written here too, so the storefront always reads one cheap indexed join
-- instead of evaluating rules per request.
CREATE TABLE `collection_products` (
  `collection_id` BIGINT UNSIGNED NOT NULL,
  `product_id`    BIGINT UNSIGNED NOT NULL,
  `position`      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_pinned`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,  -- survives re-sort
  `added_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`collection_id`, `product_id`),
  KEY `ix_collection_products_product` (`product_id`),
  KEY `ix_collection_products_position` (`collection_id`, `position`),
  CONSTRAINT `fk_collection_products_collection`
    FOREIGN KEY (`collection_id`) REFERENCES `collections` (`id`) ON DELETE CASCADE
  -- FK to products added at the end of 04_catalog.sql
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- skin_types / skin_concerns — filter facets and routine-matching inputs
-- -----------------------------------------------------------------------------
CREATE TABLE `skin_types` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`          VARCHAR(60)     NOT NULL,   -- all|oily|dry|combination|sensitive|normal
  `name`          VARCHAR(80)     NOT NULL,
  `description`   VARCHAR(500)        NULL,
  `icon_media_id` BIGINT UNSIGNED     NULL,
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_active`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_skin_types_slug` (`slug`),
  CONSTRAINT `fk_skin_types_icon`
    FOREIGN KEY (`icon_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `skin_concerns` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`            VARCHAR(60)     NOT NULL,   -- pigmentation|dullness|hydration|barrier|...
  `name`            VARCHAR(80)     NOT NULL,
  `short_label`     VARCHAR(80)         NULL,   -- appearance-safe wording for UI
  `description`     TEXT                NULL,
  `icon_media_id`   BIGINT UNSIGNED     NULL,
  `hero_media_id`   BIGINT UNSIGNED     NULL,
  `has_landing_page` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,  -- /routine/[concern]
  `sort_order`      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_active`       TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_skin_concerns_slug` (`slug`),
  CONSTRAINT `fk_skin_concerns_icon`
    FOREIGN KEY (`icon_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_skin_concerns_hero`
    FOREIGN KEY (`hero_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- tags — shared across products, articles and customers via `taggables`
-- -----------------------------------------------------------------------------
CREATE TABLE `tags` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`        VARCHAR(80)     NOT NULL,
  `name`        VARCHAR(80)     NOT NULL,
  `tag_type`    ENUM('product','article','customer','general') NOT NULL DEFAULT 'general',
  `usage_count` INT UNSIGNED    NOT NULL DEFAULT 0,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tags_slug_type` (`tag_type`, `slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `taggables` (
  `tag_id`        BIGINT UNSIGNED NOT NULL,
  `taggable_type` VARCHAR(60)     NOT NULL,
  `taggable_id`   BIGINT UNSIGNED NOT NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`tag_id`, `taggable_type`, `taggable_id`),
  KEY `ix_taggables_owner` (`taggable_type`, `taggable_id`),
  CONSTRAINT `fk_taggables_tag`
    FOREIGN KEY (`tag_id`) REFERENCES `tags` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- tax_classes / tax_rates — GST. BRD §14 requires GST-compliant invoicing, and
-- CGST+SGST vs IGST depends on whether the shipping state matches the place of
-- supply, so rates are stored per state rather than as one flat 18%.
-- -----------------------------------------------------------------------------
CREATE TABLE `tax_classes` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`        VARCHAR(40)     NOT NULL,   -- GST_18_COSMETICS
  `name`        VARCHAR(120)    NOT NULL,
  `hsn_code`    VARCHAR(12)         NULL,   -- 3304 / 3307 for cosmetics
  `gst_rate`    DECIMAL(5,2)    NOT NULL DEFAULT 18.00,
  `cess_rate`   DECIMAL(5,2)    NOT NULL DEFAULT 0.00,
  `is_inclusive` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,  -- is MRP tax-inclusive
  `is_default`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_active`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tax_classes_code` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `tax_rates` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tax_class_id`   BIGINT UNSIGNED NOT NULL,
  `country`        CHAR(2)         NOT NULL DEFAULT 'IN',
  `state_code`     CHAR(2)             NULL,   -- NULL = applies to all states
  `tax_type`       ENUM('cgst','sgst','igst','ugst','cess') NOT NULL,
  `rate`           DECIMAL(5,2)    NOT NULL,
  `effective_from` DATE            NOT NULL,
  `effective_to`   DATE                NULL,
  `is_active`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `ix_tax_rates_lookup` (`tax_class_id`, `country`, `state_code`, `effective_from`),
  CONSTRAINT `fk_tax_rates_class`
    FOREIGN KEY (`tax_class_id`) REFERENCES `tax_classes` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
