-- =============================================================================
-- File 04 : CATALOG — products, variants, ingredients, claims, bundles,
--                     routines, quiz
-- =============================================================================
-- Everything sellable is a `product` with at least one `product_variant`, even
-- a single-size serum. That one rule removes the whole class of bugs where the
-- cart, inventory and order tables disagree about what a "product" is: carts,
-- inventory, order lines and bundles all reference `product_variants.id`, never
-- `products.id`.
--
-- Long-form editorial content (benefits, usage steps, INCI, claims) is
-- normalised into child tables rather than kept as JSON blobs, because the BRD
-- requires each of those to be independently reviewable, orderable and
-- legally approvable (BRD §9, §14).
-- =============================================================================

USE `veylog`;

-- -----------------------------------------------------------------------------
-- products
-- -----------------------------------------------------------------------------
CREATE TABLE `products` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`           CHAR(36)        NOT NULL DEFAULT (UUID()),
  `slug`                VARCHAR(191)    NOT NULL,
  `name`                VARCHAR(191)    NOT NULL,
  `subtitle`            VARCHAR(255)        NULL,   -- one-line functional descriptor
  `category_id`         BIGINT UNSIGNED     NULL,
  `brand_id`            BIGINT UNSIGNED     NULL,
  `product_type`        ENUM('simple','variable','bundle','kit','gift_card')
                                        NOT NULL DEFAULT 'simple',
  `status`              ENUM('draft','in_review','active','archived')
                                        NOT NULL DEFAULT 'draft',
  `visibility`          ENUM('public','hidden','search_only') NOT NULL DEFAULT 'public',

  -- ── copy (BRD §9.1 product content template) ──────────────────────────────
  `short_description`   VARCHAR(500)        NULL,   -- the 30-60 word summary
  `description`         LONGTEXT            NULL,   -- sanitised HTML
  `description_json`    JSON                NULL,   -- block editor source of truth
  `texture`             VARCHAR(255)        NULL,
  `scent`               VARCHAR(120)        NULL,
  `fragrance_disclosure` VARCHAR(255)       NULL,   -- allergen / fragrance-free
  `suitability_note`    TEXT                NULL,   -- who it is for
  `contraindications`   TEXT                NULL,   -- who should seek advice
  `patch_test_note`     VARCHAR(500)        NULL,
  `routine_position`    ENUM('cleanse','treat','hydrate','protect','mask','none')
                                        NOT NULL DEFAULT 'none',
  `time_of_day`         ENUM('AM','PM','BOTH')  NOT NULL DEFAULT 'BOTH',

  -- ── formulation ───────────────────────────────────────────────────────────
  -- Stored verbatim exactly as legally approved. Never generated from the
  -- product_ingredients rows, which are the *editorial* highlight cards.
  `full_inci`           LONGTEXT            NULL,
  `inci_approved_at`    DATETIME            NULL,
  `inci_approved_by_admin_id` BIGINT UNSIGNED NULL,

  -- ── mandatory label / e-commerce declarations (BRD §14) ───────────────────
  `manufacturer_name`      VARCHAR(255)     NULL,
  `manufacturer_address`   VARCHAR(500)     NULL,
  `marketed_by_name`       VARCHAR(255)     NULL,
  `marketed_by_address`    VARCHAR(500)     NULL,
  `manufacturing_licence_no` VARCHAR(80)    NULL,
  `country_of_origin`      VARCHAR(80)  NOT NULL DEFAULT 'India',
  `customer_care_contact`  VARCHAR(255)     NULL,
  `shelf_life_months`      SMALLINT UNSIGNED NULL,
  `pao_months`             SMALLINT UNSIGNED NULL,   -- period after opening
  `storage_instructions`   VARCHAR(500)     NULL,
  `disposal_instructions`  VARCHAR(500)     NULL,

  -- ── merchandising ─────────────────────────────────────────────────────────
  `is_new`              TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_bestseller`       TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  -- Free text badge, but "#1 Bestseller" must be data-backed (BRD §7.4)
  `badge`               VARCHAR(60)         NULL,
  `badge_expires_at`    DATETIME            NULL,

  -- ── denormalised read caches, written by jobs, never trusted for money ─────
  `rating_average`      DECIMAL(3,2)    NOT NULL DEFAULT 0.00,
  `rating_count`        INT UNSIGNED    NOT NULL DEFAULT 0,
  `review_count`        INT UNSIGNED    NOT NULL DEFAULT 0,
  `total_sold`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `view_count`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `min_price`           DECIMAL(10,2)       NULL,   -- across active variants
  `max_price`           DECIMAL(10,2)       NULL,
  `in_stock`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  `tax_class_id`        BIGINT UNSIGNED     NULL,
  `default_variant_id`  BIGINT UNSIGNED     NULL,   -- FK added at end of file
  `requires_shipping`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `sort_order`          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `published_at`        DATETIME            NULL,
  `created_by_admin_id` BIGINT UNSIGNED     NULL,
  `updated_by_admin_id` BIGINT UNSIGNED     NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_products_slug` (`slug`),
  UNIQUE KEY `uq_products_public_id` (`public_id`),
  KEY `ix_products_status` (`status`, `visibility`, `published_at`),
  KEY `ix_products_category` (`category_id`, `status`),
  KEY `ix_products_brand` (`brand_id`),
  KEY `ix_products_merch` (`is_bestseller`, `is_new`, `sort_order`),
  KEY `ix_products_price` (`min_price`),
  FULLTEXT KEY `ft_products_search` (`name`, `subtitle`, `short_description`),
  CONSTRAINT `fk_products_category`
    FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_brand`
    FOREIGN KEY (`brand_id`) REFERENCES `brands` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_tax_class`
    FOREIGN KEY (`tax_class_id`) REFERENCES `tax_classes` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_created_by`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_updated_by`
    FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_products_inci_approver`
    FOREIGN KEY (`inci_approved_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `collection_products`
  ADD CONSTRAINT `fk_collection_products_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- product_options / values — Size, Shade. Only used by product_type='variable'.
-- -----------------------------------------------------------------------------
CREATE TABLE `product_options` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `name`       VARCHAR(50)     NOT NULL,   -- 'Size', 'Shade'
  `display_type` ENUM('dropdown','pill','swatch') NOT NULL DEFAULT 'pill',
  `position`   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_options` (`product_id`, `name`),
  CONSTRAINT `fk_product_options_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `product_option_values` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `option_id`       BIGINT UNSIGNED NOT NULL,
  `value`           VARCHAR(80)     NOT NULL,   -- '30ml', 'Shade 02'
  `swatch_hex`      CHAR(7)             NULL,
  `swatch_media_id` BIGINT UNSIGNED     NULL,
  `position`        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_option_values` (`option_id`, `value`),
  CONSTRAINT `fk_product_option_values_option`
    FOREIGN KEY (`option_id`) REFERENCES `product_options` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_option_values_swatch`
    FOREIGN KEY (`swatch_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- product_variants — the actual sellable unit. Price and stock live HERE.
-- -----------------------------------------------------------------------------
CREATE TABLE `product_variants` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`           CHAR(36)        NOT NULL DEFAULT (UUID()),
  `product_id`          BIGINT UNSIGNED NOT NULL,
  `sku`                 VARCHAR(64)     NOT NULL,
  `barcode`             VARCHAR(64)         NULL,   -- EAN/UPC
  `variant_title`       VARCHAR(160)        NULL,   -- '30ml' or '30ml / Shade 02'
  `net_quantity`        VARCHAR(40)         NULL,   -- '30 ml' as printed on pack
  `volume_ml`           DECIMAL(8,2)        NULL,   -- numeric, for price-per-ml
  `weight_grams`        INT UNSIGNED        NULL,   -- shipping weight
  `length_mm`           SMALLINT UNSIGNED   NULL,
  `width_mm`            SMALLINT UNSIGNED   NULL,
  `height_mm`           SMALLINT UNSIGNED   NULL,

  -- ── pricing ───────────────────────────────────────────────────────────────
  `mrp`                 DECIMAL(10,2)   NOT NULL,   -- printed MRP, tax inclusive
  `price`               DECIMAL(10,2)   NOT NULL,   -- current selling price
  `cost_price`          DECIMAL(10,2)       NULL,   -- margin reporting, admin only
  -- BRD §8.1: "Strike-through price is shown only against a genuine reference
  -- price and valid period." These two columns are what let the storefront
  -- prove that, instead of showing a permanent fake discount.
  `sale_starts_at`      DATETIME            NULL,
  `sale_ends_at`        DATETIME            NULL,
  `tax_class_id`        BIGINT UNSIGNED     NULL,   -- overrides product default

  `position`            SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_default`          TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `status`              ENUM('active','archived') NOT NULL DEFAULT 'active',
  `track_inventory`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `allow_backorder`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `low_stock_threshold` INT UNSIGNED    NOT NULL DEFAULT 5,
  `max_per_order`       SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  `image_media_id`      BIGINT UNSIGNED     NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_variants_sku` (`sku`),
  UNIQUE KEY `uq_product_variants_public_id` (`public_id`),
  KEY `ix_product_variants_product` (`product_id`, `position`),
  KEY `ix_product_variants_status` (`status`, `deleted_at`),
  CONSTRAINT `fk_product_variants_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_variants_tax_class`
    FOREIGN KEY (`tax_class_id`) REFERENCES `tax_classes` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_product_variants_image`
    FOREIGN KEY (`image_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ck_product_variants_price` CHECK (`price` >= 0 AND `mrp` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `products`
  ADD CONSTRAINT `fk_products_default_variant`
    FOREIGN KEY (`default_variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL;

CREATE TABLE `variant_option_values` (
  `variant_id`      BIGINT UNSIGNED NOT NULL,
  `option_id`       BIGINT UNSIGNED NOT NULL,
  `option_value_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`variant_id`, `option_id`),
  KEY `ix_variant_option_values_value` (`option_value_id`),
  CONSTRAINT `fk_variant_option_values_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_variant_option_values_option`
    FOREIGN KEY (`option_id`) REFERENCES `product_options` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_variant_option_values_value`
    FOREIGN KEY (`option_value_id`) REFERENCES `product_option_values` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Product editorial children
-- -----------------------------------------------------------------------------
CREATE TABLE `product_benefits` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id`    BIGINT UNSIGNED NOT NULL,
  `benefit`       VARCHAR(255)    NOT NULL,
  `detail`        TEXT                NULL,
  `benefit_kind`  ENUM('immediate','long_term','sensorial') NOT NULL DEFAULT 'long_term',
  `icon_media_id` BIGINT UNSIGNED     NULL,
  `claim_id`      BIGINT UNSIGNED     NULL,   -- FK added after `claims` below
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `ix_product_benefits_product` (`product_id`, `sort_order`),
  CONSTRAINT `fk_product_benefits_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_benefits_icon`
    FOREIGN KEY (`icon_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `product_usage_steps` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id`  BIGINT UNSIGNED NOT NULL,
  `step_no`     TINYINT UNSIGNED NOT NULL,
  `instruction` VARCHAR(500)    NOT NULL,
  `time_of_day` ENUM('AM','PM','BOTH') NOT NULL DEFAULT 'BOTH',
  `frequency`   VARCHAR(80)         NULL,   -- 'daily', '2-3x per week'
  `amount`      VARCHAR(80)         NULL,   -- '3-4 drops', 'pearl-sized'
  `media_id`    BIGINT UNSIGNED     NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_usage_steps` (`product_id`, `step_no`),
  CONSTRAINT `fk_product_usage_steps_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_usage_steps_media`
    FOREIGN KEY (`media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `product_skin_types` (
  `product_id`   BIGINT UNSIGNED NOT NULL,
  `skin_type_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`product_id`, `skin_type_id`),
  KEY `ix_product_skin_types_type` (`skin_type_id`),
  CONSTRAINT `fk_product_skin_types_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_skin_types_type`
    FOREIGN KEY (`skin_type_id`) REFERENCES `skin_types` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `product_concerns` (
  `product_id` BIGINT UNSIGNED NOT NULL,
  `concern_id` BIGINT UNSIGNED NOT NULL,
  `is_primary` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`product_id`, `concern_id`),
  KEY `ix_product_concerns_concern` (`concern_id`, `is_primary`),
  CONSTRAINT `fk_product_concerns_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_concerns_concern`
    FOREIGN KEY (`concern_id`) REFERENCES `skin_concerns` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- routine pairing, cross-sell, "complete the routine", frequently bought
CREATE TABLE `product_related` (
  `product_id`         BIGINT UNSIGNED NOT NULL,
  `related_product_id` BIGINT UNSIGNED NOT NULL,
  `relation_type`      ENUM('routine_pairing','cross_sell','upsell',
                            'frequently_bought','alternative','refill')
                                       NOT NULL DEFAULT 'cross_sell',
  `sort_order`         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`product_id`, `related_product_id`, `relation_type`),
  KEY `ix_product_related_target` (`related_product_id`),
  CONSTRAINT `fk_product_related_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_related_target`
    FOREIGN KEY (`related_product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- ingredients — the /ingredients library, and the key-actives cards on the PDP
-- -----------------------------------------------------------------------------
CREATE TABLE `ingredients` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`             VARCHAR(140)    NOT NULL,
  `name`             VARCHAR(140)    NOT NULL,   -- 'Niacinamide'
  `inci_name`        VARCHAR(191)        NULL,   -- 'Niacinamide'
  `scientific_name`  VARCHAR(191)        NULL,   -- 'Rhodiola Rosea Root Extract'
  `origin`           VARCHAR(191)        NULL,
  `ingredient_class` ENUM('active','botanical','humectant','emollient','occlusive',
                          'antioxidant','peptide','exfoliant','surfactant',
                          'preservative','uv_filter','other')
                                     NOT NULL DEFAULT 'active',
  `benefit_summary`  VARCHAR(500)        NULL,   -- evidence-safe one-liner
  `description`      LONGTEXT            NULL,
  `evidence_note`    TEXT                NULL,   -- what the literature supports
  `caution_note`     TEXT                NULL,
  `image_media_id`   BIGINT UNSIGNED     NULL,
  `is_key_active`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `show_in_library`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `status`           ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  `sort_order`       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`       DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ingredients_slug` (`slug`),
  KEY `ix_ingredients_status` (`status`, `show_in_library`),
  FULLTEXT KEY `ft_ingredients_search` (`name`, `inci_name`, `benefit_summary`),
  CONSTRAINT `fk_ingredients_image`
    FOREIGN KEY (`image_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `product_ingredients` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id`    BIGINT UNSIGNED NOT NULL,
  `ingredient_id` BIGINT UNSIGNED NOT NULL,
  `role`          VARCHAR(191)        NULL,   -- 'Pore refinement & melanin transfer inhibition'
  -- Free text, not numeric: BRD §7.3 says show a percentage only if verified,
  -- and some are stated as ranges or not stated at all.
  `concentration` VARCHAR(20)         NULL,   -- '10%', '2%'
  `is_key`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_product_ingredients` (`product_id`, `ingredient_id`),
  KEY `ix_product_ingredients_ingredient` (`ingredient_id`),
  CONSTRAINT `fk_product_ingredients_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_ingredients_ingredient`
    FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- BRD §7.3 "Compatibility: works with / use caution / avoid together — reviewed
-- by qualified formulation or clinical expert." Reviewer is recorded because
-- this is safety content, not marketing copy.
CREATE TABLE `ingredient_compatibility` (
  `ingredient_id`       BIGINT UNSIGNED NOT NULL,
  `other_ingredient_id` BIGINT UNSIGNED NOT NULL,
  `level`               ENUM('works_with','use_caution','avoid') NOT NULL,
  `note`                VARCHAR(500)        NULL,
  `reviewed_by_admin_id` BIGINT UNSIGNED    NULL,
  `reviewed_at`         DATETIME            NULL,
  PRIMARY KEY (`ingredient_id`, `other_ingredient_id`),
  KEY `ix_ingredient_compat_other` (`other_ingredient_id`),
  CONSTRAINT `fk_ingredient_compat_a`
    FOREIGN KEY (`ingredient_id`) REFERENCES `ingredients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ingredient_compat_b`
    FOREIGN KEY (`other_ingredient_id`) REFERENCES `ingredients` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ingredient_compat_reviewer`
    FOREIGN KEY (`reviewed_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- claims + evidence — the claims matrix the BRD makes a launch gate (§9, §14).
-- Every efficacy sentence on the site should point at a row here, so legal can
-- answer "where is this claim used and what backs it" with one query.
-- -----------------------------------------------------------------------------
CREATE TABLE `claims` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `claim_text`          VARCHAR(500)    NOT NULL,
  `claim_type`          ENUM('brand_promise','product_benefit','ingredient_role',
                             'evidence_stat','safety','certification')
                                        NOT NULL DEFAULT 'product_benefit',
  `status`              ENUM('draft','under_review','approved','rejected','retired')
                                        NOT NULL DEFAULT 'draft',
  `footnote`            VARCHAR(500)        NULL,   -- the asterisk text
  -- where this exact wording is cleared for use
  `permitted_placements` SET('pdp','home','collection','ads','packaging',
                             'email','sms','whatsapp','social','pr')
                                            NULL,
  `qualifier`           VARCHAR(255)        NULL,   -- 'in a consumer study of 32'
  `legal_reference`     VARCHAR(255)        NULL,
  `approved_by_admin_id` BIGINT UNSIGNED    NULL,
  `approved_at`         DATETIME            NULL,
  `review_due_at`       DATE                NULL,   -- re-review cadence
  `retired_at`          DATETIME            NULL,
  `created_by_admin_id` BIGINT UNSIGNED     NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_claims_status` (`status`, `review_due_at`),
  CONSTRAINT `fk_claims_approver`
    FOREIGN KEY (`approved_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_claims_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `product_benefits`
  ADD CONSTRAINT `fk_product_benefits_claim`
    FOREIGN KEY (`claim_id`) REFERENCES `claims` (`id`) ON DELETE SET NULL;

CREATE TABLE `claim_evidence` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `claim_id`       BIGINT UNSIGNED NOT NULL,
  `evidence_type`  ENUM('clinical','consumer_perception','in_vitro','instrumental',
                        'ingredient_literature','certification','stability','safety')
                                   NOT NULL,
  `method`         TEXT                NULL,
  `endpoint`       VARCHAR(255)        NULL,
  `duration`       VARCHAR(80)         NULL,   -- '4 weeks'
  `sample_size`    INT UNSIGNED        NULL,
  `result_summary` TEXT                NULL,
  `source`         VARCHAR(500)        NULL,   -- lab name / citation
  `document_media_id` BIGINT UNSIGNED  NULL,   -- the actual report PDF
  `verified_by_admin_id` BIGINT UNSIGNED NULL,
  `verified_at`    DATETIME            NULL,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_claim_evidence_claim` (`claim_id`),
  CONSTRAINT `fk_claim_evidence_claim`
    FOREIGN KEY (`claim_id`) REFERENCES `claims` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_claim_evidence_document`
    FOREIGN KEY (`document_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_claim_evidence_verifier`
    FOREIGN KEY (`verified_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `product_claims` (
  `product_id` BIGINT UNSIGNED NOT NULL,
  `claim_id`   BIGINT UNSIGNED NOT NULL,
  `placement`  ENUM('hero','benefit_list','evidence_block','footnote','badge')
                               NOT NULL DEFAULT 'benefit_list',
  `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`product_id`, `claim_id`, `placement`),
  KEY `ix_product_claims_claim` (`claim_id`),
  CONSTRAINT `fk_product_claims_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_claims_claim`
    FOREIGN KEY (`claim_id`) REFERENCES `claims` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- bundle_items — a bundle is a product whose components are real variants, so
-- selling one bundle decrements the serum and the moisturizer separately
-- (BRD FR-13 "inventory decomposition").
-- -----------------------------------------------------------------------------
CREATE TABLE `bundle_items` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `bundle_product_id`    BIGINT UNSIGNED NOT NULL,
  `component_variant_id` BIGINT UNSIGNED NOT NULL,
  `quantity`             SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  -- how much of the bundle price this line carries, for GST split and refunds
  `allocated_price`      DECIMAL(10,2)       NULL,
  `is_optional`          TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `sort_order`           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_bundle_items` (`bundle_product_id`, `component_variant_id`),
  KEY `ix_bundle_items_component` (`component_variant_id`),
  CONSTRAINT `fk_bundle_items_bundle`
    FOREIGN KEY (`bundle_product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_bundle_items_component`
    FOREIGN KEY (`component_variant_id`) REFERENCES `product_variants` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- routines — /routine and /routine/[concern]
-- -----------------------------------------------------------------------------
CREATE TABLE `routines` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`          VARCHAR(140)    NOT NULL,
  `name`          VARCHAR(160)    NOT NULL,
  `concern_id`    BIGINT UNSIGNED     NULL,
  `description`   TEXT                NULL,
  `hero_media_id` BIGINT UNSIGNED     NULL,
  `bundle_product_id` BIGINT UNSIGNED NULL,   -- buy-the-whole-routine CTA
  `status`        ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_routines_slug` (`slug`),
  KEY `ix_routines_concern` (`concern_id`),
  CONSTRAINT `fk_routines_concern`
    FOREIGN KEY (`concern_id`) REFERENCES `skin_concerns` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_routines_hero`
    FOREIGN KEY (`hero_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_routines_bundle`
    FOREIGN KEY (`bundle_product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `routine_steps` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `routine_id`  BIGINT UNSIGNED NOT NULL,
  `step_no`     TINYINT UNSIGNED NOT NULL,
  `time_of_day` ENUM('AM','PM','BOTH') NOT NULL DEFAULT 'BOTH',
  `product_id`  BIGINT UNSIGNED     NULL,
  `variant_id`  BIGINT UNSIGNED     NULL,
  `title`       VARCHAR(160)        NULL,   -- for non-product steps ('SPF')
  `instruction` VARCHAR(500)        NULL,
  `wait_note`   VARCHAR(120)        NULL,   -- 'wait 60 seconds'
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_routine_steps` (`routine_id`, `time_of_day`, `step_no`),
  CONSTRAINT `fk_routine_steps_routine`
    FOREIGN KEY (`routine_id`) REFERENCES `routines` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_routine_steps_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_routine_steps_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Skin quiz — BRD FR-15 and §11: rules must be "editable, versioned and
-- reviewed by qualified product stakeholders". Hence a version table that gets
-- signed off, rather than logic in code.
-- -----------------------------------------------------------------------------
CREATE TABLE `quiz_versions` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `version`       VARCHAR(20)     NOT NULL,   -- 'v1.0'
  `name`          VARCHAR(160)    NOT NULL,
  `status`        ENUM('draft','in_review','published','retired') NOT NULL DEFAULT 'draft',
  `disclaimer`    TEXT                NULL,   -- "not a diagnosis" text
  `reviewed_by_admin_id` BIGINT UNSIGNED NULL,
  `reviewed_at`   DATETIME            NULL,
  `published_at`  DATETIME            NULL,
  `retention_days` SMALLINT UNSIGNED NOT NULL DEFAULT 365,  -- DPDP retention rule
  `notes`         TEXT                NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_quiz_versions_version` (`version`),
  CONSTRAINT `fk_quiz_versions_reviewer`
    FOREIGN KEY (`reviewed_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `quiz_questions` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `quiz_version_id`  BIGINT UNSIGNED NOT NULL,
  `step_no`          TINYINT UNSIGNED NOT NULL,
  `question_key`     VARCHAR(60)     NOT NULL,   -- 'primary_concern'
  `question`         VARCHAR(255)    NOT NULL,
  `help_text`        VARCHAR(500)        NULL,
  `input_type`       ENUM('single','multi','scale','text') NOT NULL DEFAULT 'single',
  `is_required`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_quiz_questions` (`quiz_version_id`, `question_key`),
  CONSTRAINT `fk_quiz_questions_version`
    FOREIGN KEY (`quiz_version_id`) REFERENCES `quiz_versions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `quiz_options` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `question_id`   BIGINT UNSIGNED NOT NULL,
  `value_key`     VARCHAR(60)     NOT NULL,   -- 'dullness'
  `label`         VARCHAR(191)    NOT NULL,
  `description`   VARCHAR(255)        NULL,
  `icon_media_id` BIGINT UNSIGNED     NULL,
  `concern_id`    BIGINT UNSIGNED     NULL,   -- maps answer onto taxonomy
  `skin_type_id`  BIGINT UNSIGNED     NULL,
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_quiz_options` (`question_id`, `value_key`),
  CONSTRAINT `fk_quiz_options_question`
    FOREIGN KEY (`question_id`) REFERENCES `quiz_questions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_quiz_options_icon`
    FOREIGN KEY (`icon_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_quiz_options_concern`
    FOREIGN KEY (`concern_id`) REFERENCES `skin_concerns` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_quiz_options_skin_type`
    FOREIGN KEY (`skin_type_id`) REFERENCES `skin_types` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `quiz_rules` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `quiz_version_id`   BIGINT UNSIGNED NOT NULL,
  `name`              VARCHAR(160)    NOT NULL,
  -- {"all":[{"q":"primary_concern","in":["dullness"]},
  --         {"q":"skin_feel","not_in":["sensitive"]}]}
  `condition_json`    JSON            NOT NULL,
  `outcome`           ENUM('recommend','exclude','advise_professional')
                                      NOT NULL DEFAULT 'recommend',
  `recommended_product_ids` JSON          NULL,
  `routine_id`        BIGINT UNSIGNED     NULL,
  `rationale`         VARCHAR(500)        NULL,   -- shown to the user as "why"
  `caution_note`      VARCHAR(500)        NULL,
  `priority`          SMALLINT UNSIGNED NOT NULL DEFAULT 100,
  `is_active`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `ix_quiz_rules_version` (`quiz_version_id`, `priority`),
  CONSTRAINT `fk_quiz_rules_version`
    FOREIGN KEY (`quiz_version_id`) REFERENCES `quiz_versions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_quiz_rules_routine`
    FOREIGN KEY (`routine_id`) REFERENCES `routines` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Answers are personal data. Stored only with consent, and every row carries
-- its own purge date so the retention job needs no business logic.
CREATE TABLE `quiz_submissions` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`          CHAR(36)        NOT NULL DEFAULT (UUID()),
  `quiz_version_id`    BIGINT UNSIGNED NOT NULL,
  `customer_id`        BIGINT UNSIGNED     NULL,   -- FK added in 07
  `session_token`      CHAR(36)            NULL,   -- guest continuity
  `answers`            JSON            NOT NULL,
  `result_product_ids` JSON                NULL,
  `result_routine_id`  BIGINT UNSIGNED     NULL,
  `matched_rule_ids`   JSON                NULL,   -- explainability
  `consent_given`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `consent_id`         BIGINT UNSIGNED     NULL,   -- FK added in 07
  `ip`                 VARBINARY(16)       NULL,
  `converted_order_id` BIGINT UNSIGNED     NULL,
  `created_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `purge_after`        DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_quiz_submissions_public_id` (`public_id`),
  KEY `ix_quiz_submissions_customer` (`customer_id`, `created_at`),
  KEY `ix_quiz_submissions_purge` (`purge_after`),
  CONSTRAINT `fk_quiz_submissions_version`
    FOREIGN KEY (`quiz_version_id`) REFERENCES `quiz_versions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_quiz_submissions_routine`
    FOREIGN KEY (`result_routine_id`) REFERENCES `routines` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
