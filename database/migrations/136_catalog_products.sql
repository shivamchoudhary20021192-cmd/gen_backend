-- =============================================================================
-- 136 — Products (new): one product model for every kind of store.
--
-- The classic product (`products` and its satellites) was drawn for a beauty
-- store: INCI lists, skin types, coverage, pH, period-after-opening… as
-- columns. A shoe shop, a bakery or an electronics store cannot use them, and
-- every new kind of detail meant a new column and a new release. This is the
-- generic model, shaped like Shopify's and a step past it:
--
--   catalog_products          title, description, status (draft / active /
--                             unlisted / archived), vendor, product type, a
--                             standard category, SEO, template — and nothing
--                             that belongs to one trade.
--   catalog_product_options   up to three options per product (Size, Colour…),
--   catalog_option_values     each with its values — a colour swatch, an image,
--                             or a metaobject entry behind it;
--   catalog_variants          every combination that is sold: SKU, barcode,
--                             price, compare-at, cost, tax, weight and
--                             dimensions, customs data, unit price
--                             ("₹120 / 100 ml"), inventory policy;
--   catalog_variant_options   which value of each option a variant is.
--   catalog_product_media     the gallery; catalog_product_tags free tags.
--
--   metafield_definitions     the merchant's own fields ("custom data"), now
--   metafields                typed the way Shopify types them: text (with a
--                             fixed list of choices it is a dropdown), numbers,
--                             dates, measurements, money, rating, colour, link,
--                             JSON, rich text, references to products,
--                             variants, collections, files and metaobjects —
--                             and a list of any of them. Validations (min, max,
--                             regex, choices, precision…) live on the
--                             definition; values carry typed, indexed columns
--                             so they can be filtered.
--   metaobject_definitions    structured types of the merchant's own
--   metaobjects               ("Ingredient", "Size chart", "Designer"), whose
--                             entries fields and options can point at.
--   product_taxonomy_categories  a standard category tree, shared by every
--                             shop (platform data, no shop_id).
--
-- The classic products are not touched. Products (new) owns its own tables and
-- keeps a projection of each product in the classic ones — same ids — so the
-- storefront, cart, checkout, orders, inventory, reviews and collections sell a
-- new product with no change. When nothing reads the classic tables any more,
-- their foreign keys move to these tables (the ids already match) and the
-- classic ones are dropped. docs/CATALOG.md has the design and the plan.
--
-- Idempotent: safe to run again, and safe to run by hand on an existing
-- database (npm run db:migrate running it afterwards changes nothing).
-- =============================================================================

SET NAMES utf8mb4;

-- ── 1. custom fields: metafield definitions, typed like Shopify's ────────────

-- The type becomes an open string ('list.single_line_text_field',
-- 'dimension', 'metaobject_reference'…) instead of a closed enum.
SET @ddl = IF(
  (SELECT DATA_TYPE FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'metafield_definitions' AND column_name = 'value_type') = 'enum',
  'ALTER TABLE `metafield_definitions` MODIFY `value_type` VARCHAR(64) NOT NULL DEFAULT ''single_line_text_field''',
  'DO 0'
);
PREPARE `stmt136a` FROM @ddl;
EXECUTE `stmt136a`;
DEALLOCATE PREPARE `stmt136a`;

-- The names the platform used so far → Shopify's names, which apps and themes know.
UPDATE `metafield_definitions`
   SET `value_type` = CASE `value_type`
         WHEN 'single_line_text' THEN 'single_line_text_field'
         WHEN 'multi_line_text'  THEN 'multi_line_text_field'
         WHEN 'rich_text'        THEN 'rich_text_field'
         WHEN 'integer'          THEN 'number_integer'
         WHEN 'decimal'          THEN 'number_decimal'
         WHEN 'datetime'         THEN 'date_time'
         WHEN 'media'            THEN 'file_reference'
         WHEN 'media_list'       THEN 'list.file_reference'
         WHEN 'product_ref'      THEN 'product_reference'
         WHEN 'collection_ref'   THEN 'collection_reference'
         WHEN 'entry_ref'        THEN 'metaobject_reference'
         ELSE `value_type`
       END
 WHERE `value_type` IN ('single_line_text', 'multi_line_text', 'rich_text', 'integer', 'decimal', 'datetime',
                        'media', 'media_list', 'product_ref', 'collection_ref', 'entry_ref');

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'metafield_definitions' AND column_name = 'pinned_position') = 0,
  'ALTER TABLE `metafield_definitions`
     ADD COLUMN `constraints` JSON NULL COMMENT ''Shown only for these: {"product_types": [...], "categories": [...]}'' AFTER `validations`,
     ADD COLUMN `unique_values` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_filterable`,
     ADD COLUMN `pinned_position` SMALLINT UNSIGNED NULL COMMENT ''Shown on the edit page in this order; NULL: under "all fields"'' AFTER `sort_order`,
     ADD COLUMN `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`,
     ADD UNIQUE KEY `uq_metafield_definitions_tenant` (`shop_id`, `id`),
     ADD KEY `ix_metafield_definitions_owner` (`shop_id`, `owner_type`, `pinned_position`)',
  'DO 0'
);
PREPARE `stmt136b` FROM @ddl;
EXECUTE `stmt136b`;
DEALLOCATE PREPARE `stmt136b`;

-- Values: the type they were written with, a reference (product, variant,
-- collection, metaobject, file…) and a normalised form for equality filters,
-- uniqueness and sorting — each indexed per definition.
SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'metafields' AND column_name = 'value_index') = 0,
  'ALTER TABLE `metafields`
     ADD COLUMN `value_type` VARCHAR(64) NULL AFTER `locale`,
     ADD COLUMN `value_ref` BIGINT UNSIGNED NULL AFTER `value_media_id`,
     ADD COLUMN `value_index` VARCHAR(191) NULL AFTER `value_ref`,
     ADD KEY `ix_metafields_def_index` (`shop_id`, `definition_id`, `value_index`),
     ADD KEY `ix_metafields_def_number` (`shop_id`, `definition_id`, `value_number`),
     ADD KEY `ix_metafields_ref` (`shop_id`, `value_ref`)',
  'DO 0'
);
PREPARE `stmt136c` FROM @ddl;
EXECUTE `stmt136c`;
DEALLOCATE PREPARE `stmt136c`;

-- ── 2. metaobjects: the merchant's own structured types ──────────────────────

CREATE TABLE IF NOT EXISTS `metaobject_definitions` (
  `id`               BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `shop_id`          BIGINT UNSIGNED  NOT NULL,
  `type`             VARCHAR(64)      NOT NULL COMMENT 'Handle of the type, e.g. ingredient, size-chart',
  `name`             VARCHAR(120)     NOT NULL,
  `description`      VARCHAR(500)     NULL,
  `display_name_key` VARCHAR(64)      NULL COMMENT 'The field an entry is called by',
  `fields`           JSON             NOT NULL COMMENT '[{key, name, type, description, required, validations}]',
  `is_publishable`   TINYINT(1)       NOT NULL DEFAULT 1 COMMENT 'Entries are draft or active',
  `is_translatable`  TINYINT(1)       NOT NULL DEFAULT 0,
  `is_public`        TINYINT(1)       NOT NULL DEFAULT 1 COMMENT 'Readable by the storefront (Liquid, Storefront API)',
  `entry_count`      INT UNSIGNED     NOT NULL DEFAULT 0,
  `created_at`       DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_metaobject_definitions_tenant` (`shop_id`, `id`),
  UNIQUE KEY `uq_metaobject_definitions_type` (`shop_id`, `type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `metaobjects` (
  `id`                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `shop_id`             BIGINT UNSIGNED  NOT NULL,
  `definition_id`       BIGINT UNSIGNED  NOT NULL,
  `handle`              VARCHAR(191)     NOT NULL,
  `display_name`        VARCHAR(255)     NOT NULL,
  `status`              ENUM('draft','active') NOT NULL DEFAULT 'active',
  `fields`              JSON             NOT NULL COMMENT '{field key: value, as stored for its type}',
  `updated_by_admin_id` BIGINT UNSIGNED  NULL,
  `created_at`          DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_metaobjects_tenant` (`shop_id`, `id`),
  UNIQUE KEY `uq_metaobjects_handle` (`shop_id`, `definition_id`, `handle`),
  KEY `ix_metaobjects_name` (`shop_id`, `definition_id`, `display_name`),
  CONSTRAINT `fk_metaobjects_definition_t` FOREIGN KEY (`shop_id`, `definition_id`)
    REFERENCES `metaobject_definitions` (`shop_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── 3. the standard category tree (platform data, every shop shares it) ─────

CREATE TABLE IF NOT EXISTS `product_taxonomy_categories` (
  `code`         VARCHAR(191)     NOT NULL COMMENT 'Stable path id, e.g. health-beauty/personal-care/cosmetics/skin-care/serums',
  `parent_code`  VARCHAR(191)     NULL,
  `name`         VARCHAR(120)     NOT NULL,
  `full_name`    VARCHAR(500)     NOT NULL COMMENT 'Health & Beauty > Personal Care > …',
  `level`        TINYINT UNSIGNED NOT NULL,
  `is_leaf`      TINYINT(1)       NOT NULL DEFAULT 1,
  `sort_order`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `external_ids` JSON             NULL COMMENT 'The same category elsewhere: {"google": 2915, "shopify": "gid://shopify/TaxonomyCategory/…"}',
  PRIMARY KEY (`code`),
  KEY `ix_taxonomy_parent` (`parent_code`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── 4. the catalog ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `catalog_products` (
  `id`                  BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT COMMENT 'The same id as the classic products row it is projected to',
  `shop_id`             BIGINT UNSIGNED  NOT NULL,
  `public_id`           CHAR(36)         NOT NULL,
  `handle`              VARCHAR(191)     NOT NULL,
  `title`               VARCHAR(255)     NOT NULL,
  `description_html`    MEDIUMTEXT       NULL,
  `summary`             VARCHAR(500)     NULL COMMENT 'Short description: cards, search results, feeds',
  `status`              ENUM('draft','active','unlisted','archived') NOT NULL DEFAULT 'draft',
  `vendor`              VARCHAR(255)     NULL,
  `product_type`        VARCHAR(255)     NULL,
  `category_code`       VARCHAR(191)     NULL,
  `template_suffix`     VARCHAR(60)      NULL,
  `seo_title`           VARCHAR(255)     NULL,
  `seo_description`     VARCHAR(320)     NULL,
  `is_gift_card`        TINYINT(1)       NOT NULL DEFAULT 0,
  `option_count`        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `variant_count`       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `price_min`           DECIMAL(12,2)    NULL,
  `price_max`           DECIMAL(12,2)    NULL,
  `published_at`        DATETIME         NULL,
  `origin`              ENUM('native','classic') NOT NULL DEFAULT 'native' COMMENT 'classic: brought over from Products (classic)',
  `version`             INT UNSIGNED     NOT NULL DEFAULT 1 COMMENT 'Optimistic lock: a save names the version it edited',
  `created_by_admin_id` BIGINT UNSIGNED  NULL,
  `updated_by_admin_id` BIGINT UNSIGNED  NULL,
  `created_at`          DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME         NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_products_tenant` (`shop_id`, `id`),
  UNIQUE KEY `uq_catalog_products_public_id` (`shop_id`, `public_id`),
  UNIQUE KEY `uq_catalog_products_handle` (`shop_id`, `handle`),
  KEY `ix_catalog_products_status` (`shop_id`, `deleted_at`, `status`, `updated_at`, `id`),
  KEY `ix_catalog_products_updated` (`shop_id`, `deleted_at`, `updated_at`, `id`),
  KEY `ix_catalog_products_created` (`shop_id`, `deleted_at`, `created_at`, `id`),
  KEY `ix_catalog_products_title` (`shop_id`, `deleted_at`, `title`, `id`),
  KEY `ix_catalog_products_vendor` (`shop_id`, `vendor`),
  KEY `ix_catalog_products_type` (`shop_id`, `product_type`),
  KEY `ix_catalog_products_category` (`shop_id`, `category_code`),
  FULLTEXT KEY `ft_catalog_products` (`title`, `vendor`, `product_type`),
  CONSTRAINT `fk_catalog_products_category` FOREIGN KEY (`category_code`)
    REFERENCES `product_taxonomy_categories` (`code`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_catalog_products_created_by` FOREIGN KEY (`created_by_admin_id`)
    REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_catalog_products_updated_by` FOREIGN KEY (`updated_by_admin_id`)
    REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `catalog_product_options` (
  `id`                     BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `shop_id`                BIGINT UNSIGNED  NOT NULL,
  `product_id`             BIGINT UNSIGNED  NOT NULL,
  `name`                   VARCHAR(80)      NOT NULL,
  `position`               TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `display_style`          ENUM('dropdown','buttons','swatches') NOT NULL DEFAULT 'buttons',
  `linked_metaobject_type` VARCHAR(64)      NULL COMMENT 'Values are entries of this metaobject type (e.g. colour)',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_product_options_tenant` (`shop_id`, `id`),
  UNIQUE KEY `uq_catalog_product_options_name` (`product_id`, `name`),
  KEY `ix_catalog_product_options_product` (`shop_id`, `product_id`, `position`),
  CONSTRAINT `fk_catalog_product_options_product_t` FOREIGN KEY (`shop_id`, `product_id`)
    REFERENCES `catalog_products` (`shop_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `catalog_option_values` (
  `id`                   BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  `shop_id`              BIGINT UNSIGNED   NOT NULL,
  `product_id`           BIGINT UNSIGNED   NOT NULL,
  `option_id`            BIGINT UNSIGNED   NOT NULL,
  `name`                 VARCHAR(255)      NOT NULL,
  `position`             SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `swatch_color`         CHAR(7)           NULL,
  `swatch_media_id`      BIGINT UNSIGNED   NULL,
  `linked_metaobject_id` BIGINT UNSIGNED   NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_option_values_tenant` (`shop_id`, `id`),
  UNIQUE KEY `uq_catalog_option_values_name` (`option_id`, `name`),
  KEY `ix_catalog_option_values_product` (`shop_id`, `product_id`),
  KEY `ix_catalog_option_values_metaobject` (`linked_metaobject_id`),
  CONSTRAINT `fk_catalog_option_values_option_t` FOREIGN KEY (`shop_id`, `option_id`)
    REFERENCES `catalog_product_options` (`shop_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `fk_catalog_option_values_swatch` FOREIGN KEY (`swatch_media_id`)
    REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_catalog_option_values_metaobject` FOREIGN KEY (`linked_metaobject_id`)
    REFERENCES `metaobjects` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `catalog_variants` (
  `id`                        BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT COMMENT 'The same id as the classic product_variants row',
  `shop_id`                   BIGINT UNSIGNED   NOT NULL,
  `public_id`                 CHAR(36)          NOT NULL,
  `product_id`                BIGINT UNSIGNED   NOT NULL,
  `position`                  SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `title`                     VARCHAR(255)      NOT NULL DEFAULT 'Default Title' COMMENT 'Its option values, "Red / M"',
  `options_key`               VARCHAR(120)      NOT NULL COMMENT 'Option value ids in option order; unique per product',
  `sku`                       VARCHAR(64)       NULL,
  `barcode`                   VARCHAR(64)       NULL COMMENT 'GTIN, EAN, UPC or ISBN',
  `price`                     DECIMAL(12,2)     NOT NULL DEFAULT 0.00,
  `compare_at_price`          DECIMAL(12,2)     NULL,
  `cost`                      DECIMAL(12,2)     NULL,
  `taxable`                   TINYINT(1)        NOT NULL DEFAULT 1,
  `tax_class_id`              BIGINT UNSIGNED   NULL,
  `hsn_code`                  VARCHAR(12)       NULL,
  `inventory_tracked`         TINYINT(1)        NOT NULL DEFAULT 1,
  `inventory_policy`          ENUM('deny','continue') NOT NULL DEFAULT 'deny' COMMENT 'continue: keep selling when out of stock',
  `requires_shipping`         TINYINT(1)        NOT NULL DEFAULT 1,
  `weight`                    DECIMAL(10,3)     NULL,
  `weight_unit`               ENUM('g','kg','oz','lb') NOT NULL DEFAULT 'g',
  `length`                    DECIMAL(10,2)     NULL,
  `width`                     DECIMAL(10,2)     NULL,
  `height`                    DECIMAL(10,2)     NULL,
  `dimension_unit`            ENUM('mm','cm','m','in') NOT NULL DEFAULT 'cm',
  `origin_country`            CHAR(2)           NULL,
  `hs_code`                   VARCHAR(16)       NULL COMMENT 'Harmonized System code for customs',
  `unit_price_quantity`       DECIMAL(12,3)     NULL COMMENT 'What the pack holds: 250 (ml)',
  `unit_price_quantity_unit`  VARCHAR(8)        NULL,
  `unit_price_reference`      DECIMAL(12,3)     NULL COMMENT 'Price shown per: 100 (ml)',
  `unit_price_reference_unit` VARCHAR(8)        NULL,
  `media_id`                  BIGINT UNSIGNED   NULL,
  `max_per_order`             SMALLINT UNSIGNED NULL,
  `created_at`                DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`                DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`                DATETIME          NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_catalog_variants_tenant` (`shop_id`, `id`),
  UNIQUE KEY `uq_catalog_variants_public_id` (`shop_id`, `public_id`),
  UNIQUE KEY `uq_catalog_variants_options` (`product_id`, `options_key`),
  UNIQUE KEY `uq_catalog_variants_sku` (`shop_id`, `sku`),
  KEY `ix_catalog_variants_product` (`shop_id`, `product_id`, `position`),
  KEY `ix_catalog_variants_barcode` (`shop_id`, `barcode`),
  CONSTRAINT `fk_catalog_variants_product_t` FOREIGN KEY (`shop_id`, `product_id`)
    REFERENCES `catalog_products` (`shop_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `fk_catalog_variants_media` FOREIGN KEY (`media_id`)
    REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_catalog_variants_tax_class` FOREIGN KEY (`tax_class_id`)
    REFERENCES `tax_classes` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ck_catalog_variants_money` CHECK (`price` >= 0 AND (`compare_at_price` IS NULL OR `compare_at_price` >= 0) AND (`cost` IS NULL OR `cost` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `catalog_variant_options` (
  `shop_id`    BIGINT UNSIGNED NOT NULL,
  `variant_id` BIGINT UNSIGNED NOT NULL,
  `option_id`  BIGINT UNSIGNED NOT NULL,
  `value_id`   BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`variant_id`, `option_id`),
  KEY `ix_catalog_variant_options_value` (`shop_id`, `value_id`),
  CONSTRAINT `fk_catalog_variant_options_variant_t` FOREIGN KEY (`shop_id`, `variant_id`)
    REFERENCES `catalog_variants` (`shop_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `fk_catalog_variant_options_option_t` FOREIGN KEY (`shop_id`, `option_id`)
    REFERENCES `catalog_product_options` (`shop_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `fk_catalog_variant_options_value_t` FOREIGN KEY (`shop_id`, `value_id`)
    REFERENCES `catalog_option_values` (`shop_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `catalog_product_media` (
  `shop_id`    BIGINT UNSIGNED   NOT NULL,
  `product_id` BIGINT UNSIGNED   NOT NULL,
  `media_id`   BIGINT UNSIGNED   NOT NULL,
  `position`   SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `alt`        VARCHAR(255)      NULL,
  PRIMARY KEY (`product_id`, `media_id`),
  KEY `ix_catalog_product_media_order` (`shop_id`, `product_id`, `position`),
  KEY `ix_catalog_product_media_media` (`media_id`),
  CONSTRAINT `fk_catalog_product_media_product_t` FOREIGN KEY (`shop_id`, `product_id`)
    REFERENCES `catalog_products` (`shop_id`, `id`) ON DELETE CASCADE,
  CONSTRAINT `fk_catalog_product_media_media` FOREIGN KEY (`media_id`)
    REFERENCES `media` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `catalog_product_tags` (
  `shop_id`    BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `tag`        VARCHAR(255)    NOT NULL,
  PRIMARY KEY (`product_id`, `tag`),
  KEY `ix_catalog_product_tags_tag` (`shop_id`, `tag`, `product_id`),
  CONSTRAINT `fk_catalog_product_tags_product_t` FOREIGN KEY (`shop_id`, `product_id`)
    REFERENCES `catalog_products` (`shop_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── 5. who may do what ───────────────────────────────────────────────────────

INSERT IGNORE INTO `permissions` (slug, module, action, name, description, is_dangerous, sort_order) VALUES
  ('custom_data.manage', 'custom_data', 'manage', 'Manage custom fields and metaobject types', 'Add, change and remove the fields products and other records carry, and the metaobject types. Removing one removes what was entered in it.', 1, 0),
  ('metaobjects.manage', 'metaobjects', 'manage', 'Edit metaobject entries', 'Add, change and remove the entries of metaobject types, such as ingredients or size charts.', 0, 0);

-- Whoever manages settings manages the fields; whoever edits products edits entries.
INSERT IGNORE INTO `role_permissions` (shop_id, role_id, permission_id)
SELECT DISTINCT rp.shop_id, rp.role_id, target.id
  FROM `role_permissions` rp
  JOIN `permissions` source ON source.id = rp.permission_id
  JOIN `permissions` target ON (source.slug = 'settings.manage' AND target.slug = 'custom_data.manage')
                            OR (source.slug = 'products.update' AND target.slug = 'metaobjects.manage')
 WHERE NOT EXISTS (
         SELECT 1 FROM `role_permissions` existing
          WHERE existing.shop_id = rp.shop_id AND existing.role_id = rp.role_id AND existing.permission_id = target.id
       );

-- ── 6. the admin menu: Products (new), above the classic Products ────────────

INSERT INTO `menu_items` (
  parent_id, menu_key, title, hover_description, icon, icon_color, icon_type, route, prefetch_data,
  active_match, section, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
) VALUES (
  NULL, 'catalog', 'Products (new)', 'Any kind of product, with options, variants and fields of your own',
  'products', '#0ea5e9', 'material', '/catalog/products', 0,
  '/catalog/products$', 'Commerce', 'menu.catalog', 'default', 29, 'available',
  1, 1, 1, 1, 0, 0, 0, 1
)
ON DUPLICATE KEY UPDATE
  title             = VALUES(title),
  hover_description = VALUES(hover_description),
  route             = VALUES(route),
  active_match      = VALUES(active_match),
  sort_order        = VALUES(sort_order),
  status            = VALUES(status);

INSERT INTO `menu_items` (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
)
SELECT parent.id, entry.menu_key, entry.title, entry.icon, 'material', entry.route, 0,
       entry.active_match, CONCAT('menu.', entry.menu_key), 'default', entry.sort_order, 'available',
       1, 1, 0, 1, 0, 0, 0, 1
  FROM (SELECT id FROM `menu_items` WHERE `menu_key` = 'catalog' LIMIT 1) AS parent,
       (
    SELECT 'catalog.products' AS menu_key, 'All products' AS title, 'list' AS icon, '/catalog/products' AS route,
           '/catalog/products(/new|/[0-9]+)?$' AS active_match, 10 AS sort_order
    UNION ALL
    SELECT 'catalog.custom_data', 'Custom fields', 'data', '/catalog/custom-fields', '/catalog/custom-fields', 20
    UNION ALL
    SELECT 'catalog.metaobjects', 'Metaobjects', 'sections', '/catalog/metaobjects', '/catalog/metaobjects', 30
       ) AS entry
ON DUPLICATE KEY UPDATE
  parent_id    = VALUES(parent_id),
  title        = VALUES(title),
  icon         = VALUES(icon),
  route        = VALUES(route),
  active_match = VALUES(active_match),
  sort_order   = VALUES(sort_order),
  status       = VALUES(status);

INSERT INTO `menu_item_permissions` (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM `menu_items` mi
  JOIN `permissions` p ON (mi.menu_key IN ('catalog', 'catalog.products', 'catalog.metaobjects') AND p.slug = 'products.view')
                       OR (mi.menu_key = 'catalog.custom_data' AND p.slug = 'custom_data.manage')
 WHERE NOT EXISTS (
         SELECT 1 FROM `menu_item_permissions` existing
          WHERE existing.menu_item_id = mi.id AND existing.permission_id = p.id
       );

-- ── 7. the standard categories ───────────────────────────────────────────────
-- A curated slice of the usual retail tree (the top level follows Shopify's
-- Standard Product Taxonomy). Codes are paths and never change once shipped:
-- add, do not rename. `npm run taxonomy:import` can load a full tree.

INSERT INTO `product_taxonomy_categories` (code, parent_code, name, full_name, level, is_leaf, sort_order) VALUES
  ('animals-pet-supplies', NULL, 'Animals & Pet Supplies', 'Animals & Pet Supplies', 1, 0, 1),
  ('animals-pet-supplies/pet-supplies', 'animals-pet-supplies', 'Pet Supplies', 'Animals & Pet Supplies > Pet Supplies', 2, 0, 2),
  ('animals-pet-supplies/pet-supplies/dog-supplies', 'animals-pet-supplies/pet-supplies', 'Dog Supplies', 'Animals & Pet Supplies > Pet Supplies > Dog Supplies', 3, 1, 3),
  ('animals-pet-supplies/pet-supplies/cat-supplies', 'animals-pet-supplies/pet-supplies', 'Cat Supplies', 'Animals & Pet Supplies > Pet Supplies > Cat Supplies', 3, 1, 4),
  ('animals-pet-supplies/pet-supplies/bird-supplies', 'animals-pet-supplies/pet-supplies', 'Bird Supplies', 'Animals & Pet Supplies > Pet Supplies > Bird Supplies', 3, 1, 5),
  ('animals-pet-supplies/pet-supplies/fish-supplies', 'animals-pet-supplies/pet-supplies', 'Fish Supplies', 'Animals & Pet Supplies > Pet Supplies > Fish Supplies', 3, 1, 6),
  ('animals-pet-supplies/pet-supplies/small-animal-supplies', 'animals-pet-supplies/pet-supplies', 'Small Animal Supplies', 'Animals & Pet Supplies > Pet Supplies > Small Animal Supplies', 3, 1, 7),
  ('animals-pet-supplies/pet-supplies/pet-food', 'animals-pet-supplies/pet-supplies', 'Pet Food', 'Animals & Pet Supplies > Pet Supplies > Pet Food', 3, 1, 8),
  ('animals-pet-supplies/pet-supplies/pet-grooming-supplies', 'animals-pet-supplies/pet-supplies', 'Pet Grooming Supplies', 'Animals & Pet Supplies > Pet Supplies > Pet Grooming Supplies', 3, 1, 9),
  ('animals-pet-supplies/pet-supplies/pet-toys', 'animals-pet-supplies/pet-supplies', 'Pet Toys', 'Animals & Pet Supplies > Pet Supplies > Pet Toys', 3, 1, 10),
  ('apparel-accessories', NULL, 'Apparel & Accessories', 'Apparel & Accessories', 1, 0, 11),
  ('apparel-accessories/clothing', 'apparel-accessories', 'Clothing', 'Apparel & Accessories > Clothing', 2, 0, 12),
  ('apparel-accessories/clothing/activewear', 'apparel-accessories/clothing', 'Activewear', 'Apparel & Accessories > Clothing > Activewear', 3, 1, 13),
  ('apparel-accessories/clothing/dresses', 'apparel-accessories/clothing', 'Dresses', 'Apparel & Accessories > Clothing > Dresses', 3, 1, 14),
  ('apparel-accessories/clothing/outerwear', 'apparel-accessories/clothing', 'Outerwear', 'Apparel & Accessories > Clothing > Outerwear', 3, 1, 15),
  ('apparel-accessories/clothing/pants', 'apparel-accessories/clothing', 'Pants', 'Apparel & Accessories > Clothing > Pants', 3, 1, 16),
  ('apparel-accessories/clothing/shirts-tops', 'apparel-accessories/clothing', 'Shirts & Tops', 'Apparel & Accessories > Clothing > Shirts & Tops', 3, 1, 17),
  ('apparel-accessories/clothing/shorts', 'apparel-accessories/clothing', 'Shorts', 'Apparel & Accessories > Clothing > Shorts', 3, 1, 18),
  ('apparel-accessories/clothing/skirts', 'apparel-accessories/clothing', 'Skirts', 'Apparel & Accessories > Clothing > Skirts', 3, 1, 19),
  ('apparel-accessories/clothing/sleepwear-loungewear', 'apparel-accessories/clothing', 'Sleepwear & Loungewear', 'Apparel & Accessories > Clothing > Sleepwear & Loungewear', 3, 1, 20),
  ('apparel-accessories/clothing/suits', 'apparel-accessories/clothing', 'Suits', 'Apparel & Accessories > Clothing > Suits', 3, 1, 21),
  ('apparel-accessories/clothing/swimwear', 'apparel-accessories/clothing', 'Swimwear', 'Apparel & Accessories > Clothing > Swimwear', 3, 1, 22),
  ('apparel-accessories/clothing/underwear-socks', 'apparel-accessories/clothing', 'Underwear & Socks', 'Apparel & Accessories > Clothing > Underwear & Socks', 3, 1, 23),
  ('apparel-accessories/clothing/traditional-ceremonial-clothing', 'apparel-accessories/clothing', 'Traditional & Ceremonial Clothing', 'Apparel & Accessories > Clothing > Traditional & Ceremonial Clothing', 3, 1, 24),
  ('apparel-accessories/clothing/baby-kids-clothing', 'apparel-accessories/clothing', 'Baby & Kids Clothing', 'Apparel & Accessories > Clothing > Baby & Kids Clothing', 3, 1, 25),
  ('apparel-accessories/clothing-accessories', 'apparel-accessories', 'Clothing Accessories', 'Apparel & Accessories > Clothing Accessories', 2, 0, 26),
  ('apparel-accessories/clothing-accessories/belts', 'apparel-accessories/clothing-accessories', 'Belts', 'Apparel & Accessories > Clothing Accessories > Belts', 3, 1, 27),
  ('apparel-accessories/clothing-accessories/gloves-mittens', 'apparel-accessories/clothing-accessories', 'Gloves & Mittens', 'Apparel & Accessories > Clothing Accessories > Gloves & Mittens', 3, 1, 28),
  ('apparel-accessories/clothing-accessories/hair-accessories', 'apparel-accessories/clothing-accessories', 'Hair Accessories', 'Apparel & Accessories > Clothing Accessories > Hair Accessories', 3, 1, 29),
  ('apparel-accessories/clothing-accessories/hats', 'apparel-accessories/clothing-accessories', 'Hats', 'Apparel & Accessories > Clothing Accessories > Hats', 3, 1, 30),
  ('apparel-accessories/clothing-accessories/scarves-shawls', 'apparel-accessories/clothing-accessories', 'Scarves & Shawls', 'Apparel & Accessories > Clothing Accessories > Scarves & Shawls', 3, 1, 31),
  ('apparel-accessories/clothing-accessories/sunglasses', 'apparel-accessories/clothing-accessories', 'Sunglasses', 'Apparel & Accessories > Clothing Accessories > Sunglasses', 3, 1, 32),
  ('apparel-accessories/clothing-accessories/ties', 'apparel-accessories/clothing-accessories', 'Ties', 'Apparel & Accessories > Clothing Accessories > Ties', 3, 1, 33),
  ('apparel-accessories/handbags-wallets-cases', 'apparel-accessories', 'Handbags, Wallets & Cases', 'Apparel & Accessories > Handbags, Wallets & Cases', 2, 0, 34),
  ('apparel-accessories/handbags-wallets-cases/handbags', 'apparel-accessories/handbags-wallets-cases', 'Handbags', 'Apparel & Accessories > Handbags, Wallets & Cases > Handbags', 3, 1, 35),
  ('apparel-accessories/handbags-wallets-cases/wallets-money-clips', 'apparel-accessories/handbags-wallets-cases', 'Wallets & Money Clips', 'Apparel & Accessories > Handbags, Wallets & Cases > Wallets & Money Clips', 3, 1, 36),
  ('apparel-accessories/jewelry', 'apparel-accessories', 'Jewelry', 'Apparel & Accessories > Jewelry', 2, 0, 37),
  ('apparel-accessories/jewelry/bracelets', 'apparel-accessories/jewelry', 'Bracelets', 'Apparel & Accessories > Jewelry > Bracelets', 3, 1, 38),
  ('apparel-accessories/jewelry/earrings', 'apparel-accessories/jewelry', 'Earrings', 'Apparel & Accessories > Jewelry > Earrings', 3, 1, 39),
  ('apparel-accessories/jewelry/necklaces', 'apparel-accessories/jewelry', 'Necklaces', 'Apparel & Accessories > Jewelry > Necklaces', 3, 1, 40),
  ('apparel-accessories/jewelry/rings', 'apparel-accessories/jewelry', 'Rings', 'Apparel & Accessories > Jewelry > Rings', 3, 1, 41),
  ('apparel-accessories/jewelry/watches', 'apparel-accessories/jewelry', 'Watches', 'Apparel & Accessories > Jewelry > Watches', 3, 1, 42),
  ('apparel-accessories/shoes', 'apparel-accessories', 'Shoes', 'Apparel & Accessories > Shoes', 2, 0, 43),
  ('apparel-accessories/shoes/athletic-shoes', 'apparel-accessories/shoes', 'Athletic Shoes', 'Apparel & Accessories > Shoes > Athletic Shoes', 3, 1, 44),
  ('apparel-accessories/shoes/boots', 'apparel-accessories/shoes', 'Boots', 'Apparel & Accessories > Shoes > Boots', 3, 1, 45),
  ('apparel-accessories/shoes/flats', 'apparel-accessories/shoes', 'Flats', 'Apparel & Accessories > Shoes > Flats', 3, 1, 46),
  ('apparel-accessories/shoes/heels', 'apparel-accessories/shoes', 'Heels', 'Apparel & Accessories > Shoes > Heels', 3, 1, 47),
  ('apparel-accessories/shoes/sandals', 'apparel-accessories/shoes', 'Sandals', 'Apparel & Accessories > Shoes > Sandals', 3, 1, 48),
  ('apparel-accessories/shoes/sneakers', 'apparel-accessories/shoes', 'Sneakers', 'Apparel & Accessories > Shoes > Sneakers', 3, 1, 49),
  ('apparel-accessories/shoes/slippers', 'apparel-accessories/shoes', 'Slippers', 'Apparel & Accessories > Shoes > Slippers', 3, 1, 50),
  ('arts-entertainment', NULL, 'Arts & Entertainment', 'Arts & Entertainment', 1, 0, 51),
  ('arts-entertainment/hobbies-creative-arts', 'arts-entertainment', 'Hobbies & Creative Arts', 'Arts & Entertainment > Hobbies & Creative Arts', 2, 0, 52),
  ('arts-entertainment/hobbies-creative-arts/arts-crafts', 'arts-entertainment/hobbies-creative-arts', 'Arts & Crafts', 'Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts', 3, 1, 53),
  ('arts-entertainment/hobbies-creative-arts/collectibles', 'arts-entertainment/hobbies-creative-arts', 'Collectibles', 'Arts & Entertainment > Hobbies & Creative Arts > Collectibles', 3, 1, 54),
  ('arts-entertainment/hobbies-creative-arts/musical-instruments', 'arts-entertainment/hobbies-creative-arts', 'Musical Instruments', 'Arts & Entertainment > Hobbies & Creative Arts > Musical Instruments', 3, 1, 55),
  ('arts-entertainment/party-celebration', 'arts-entertainment', 'Party & Celebration', 'Arts & Entertainment > Party & Celebration', 2, 0, 56),
  ('arts-entertainment/party-celebration/gift-wrapping', 'arts-entertainment/party-celebration', 'Gift Wrapping', 'Arts & Entertainment > Party & Celebration > Gift Wrapping', 3, 1, 57),
  ('arts-entertainment/party-celebration/party-supplies', 'arts-entertainment/party-celebration', 'Party Supplies', 'Arts & Entertainment > Party & Celebration > Party Supplies', 3, 1, 58),
  ('baby-toddler', NULL, 'Baby & Toddler', 'Baby & Toddler', 1, 0, 59),
  ('baby-toddler/baby-bathing', 'baby-toddler', 'Baby Bathing', 'Baby & Toddler > Baby Bathing', 2, 1, 60),
  ('baby-toddler/baby-health', 'baby-toddler', 'Baby Health', 'Baby & Toddler > Baby Health', 2, 1, 61),
  ('baby-toddler/baby-toys-activity-equipment', 'baby-toddler', 'Baby Toys & Activity Equipment', 'Baby & Toddler > Baby Toys & Activity Equipment', 2, 1, 62),
  ('baby-toddler/diapering', 'baby-toddler', 'Diapering', 'Baby & Toddler > Diapering', 2, 1, 63),
  ('baby-toddler/nursing-feeding', 'baby-toddler', 'Nursing & Feeding', 'Baby & Toddler > Nursing & Feeding', 2, 1, 64),
  ('business-industrial', NULL, 'Business & Industrial', 'Business & Industrial', 1, 0, 65),
  ('business-industrial/medical-supplies', 'business-industrial', 'Medical Supplies', 'Business & Industrial > Medical Supplies', 2, 1, 66),
  ('business-industrial/retail-supplies', 'business-industrial', 'Retail Supplies', 'Business & Industrial > Retail Supplies', 2, 1, 67),
  ('business-industrial/work-safety-protective-gear', 'business-industrial', 'Work Safety Protective Gear', 'Business & Industrial > Work Safety Protective Gear', 2, 1, 68),
  ('cameras-optics', NULL, 'Cameras & Optics', 'Cameras & Optics', 1, 0, 69),
  ('cameras-optics/cameras', 'cameras-optics', 'Cameras', 'Cameras & Optics > Cameras', 2, 1, 70),
  ('cameras-optics/camera-optic-accessories', 'cameras-optics', 'Camera & Optic Accessories', 'Cameras & Optics > Camera & Optic Accessories', 2, 1, 71),
  ('cameras-optics/optics', 'cameras-optics', 'Optics', 'Cameras & Optics > Optics', 2, 1, 72),
  ('electronics', NULL, 'Electronics', 'Electronics', 1, 0, 73),
  ('electronics/audio', 'electronics', 'Audio', 'Electronics > Audio', 2, 0, 74),
  ('electronics/audio/headphones-headsets', 'electronics/audio', 'Headphones & Headsets', 'Electronics > Audio > Headphones & Headsets', 3, 1, 75),
  ('electronics/audio/microphones', 'electronics/audio', 'Microphones', 'Electronics > Audio > Microphones', 3, 1, 76),
  ('electronics/audio/speakers', 'electronics/audio', 'Speakers', 'Electronics > Audio > Speakers', 3, 1, 77),
  ('electronics/computers', 'electronics', 'Computers', 'Electronics > Computers', 2, 0, 78),
  ('electronics/computers/desktop-computers', 'electronics/computers', 'Desktop Computers', 'Electronics > Computers > Desktop Computers', 3, 1, 79),
  ('electronics/computers/laptops', 'electronics/computers', 'Laptops', 'Electronics > Computers > Laptops', 3, 1, 80),
  ('electronics/computers/tablet-computers', 'electronics/computers', 'Tablet Computers', 'Electronics > Computers > Tablet Computers', 3, 1, 81),
  ('electronics/computer-accessories', 'electronics', 'Computer Accessories', 'Electronics > Computer Accessories', 2, 0, 82),
  ('electronics/computer-accessories/cables', 'electronics/computer-accessories', 'Cables', 'Electronics > Computer Accessories > Cables', 3, 1, 83),
  ('electronics/computer-accessories/chargers-power-adapters', 'electronics/computer-accessories', 'Chargers & Power Adapters', 'Electronics > Computer Accessories > Chargers & Power Adapters', 3, 1, 84),
  ('electronics/computer-accessories/keyboards-mice', 'electronics/computer-accessories', 'Keyboards & Mice', 'Electronics > Computer Accessories > Keyboards & Mice', 3, 1, 85),
  ('electronics/computer-accessories/memory-storage', 'electronics/computer-accessories', 'Memory & Storage', 'Electronics > Computer Accessories > Memory & Storage', 3, 1, 86),
  ('electronics/mobile-phones', 'electronics', 'Mobile Phones', 'Electronics > Mobile Phones', 2, 0, 87),
  ('electronics/mobile-phones/smartphones', 'electronics/mobile-phones', 'Smartphones', 'Electronics > Mobile Phones > Smartphones', 3, 1, 88),
  ('electronics/mobile-phones/mobile-phone-accessories', 'electronics/mobile-phones', 'Mobile Phone Accessories', 'Electronics > Mobile Phones > Mobile Phone Accessories', 3, 1, 89),
  ('electronics/video', 'electronics', 'Video', 'Electronics > Video', 2, 0, 90),
  ('electronics/video/projectors', 'electronics/video', 'Projectors', 'Electronics > Video > Projectors', 3, 1, 91),
  ('electronics/video/televisions', 'electronics/video', 'Televisions', 'Electronics > Video > Televisions', 3, 1, 92),
  ('electronics/video-game-consoles-games', 'electronics', 'Video Game Consoles & Games', 'Electronics > Video Game Consoles & Games', 2, 1, 93),
  ('electronics/wearable-technology', 'electronics', 'Wearable Technology', 'Electronics > Wearable Technology', 2, 0, 94),
  ('electronics/wearable-technology/fitness-trackers', 'electronics/wearable-technology', 'Fitness Trackers', 'Electronics > Wearable Technology > Fitness Trackers', 3, 1, 95),
  ('electronics/wearable-technology/smartwatches', 'electronics/wearable-technology', 'Smartwatches', 'Electronics > Wearable Technology > Smartwatches', 3, 1, 96),
  ('food-beverages-tobacco', NULL, 'Food, Beverages & Tobacco', 'Food, Beverages & Tobacco', 1, 0, 97),
  ('food-beverages-tobacco/beverages', 'food-beverages-tobacco', 'Beverages', 'Food, Beverages & Tobacco > Beverages', 2, 0, 98),
  ('food-beverages-tobacco/beverages/coffee', 'food-beverages-tobacco/beverages', 'Coffee', 'Food, Beverages & Tobacco > Beverages > Coffee', 3, 1, 99),
  ('food-beverages-tobacco/beverages/juice', 'food-beverages-tobacco/beverages', 'Juice', 'Food, Beverages & Tobacco > Beverages > Juice', 3, 1, 100),
  ('food-beverages-tobacco/beverages/soft-drinks', 'food-beverages-tobacco/beverages', 'Soft Drinks', 'Food, Beverages & Tobacco > Beverages > Soft Drinks', 3, 1, 101),
  ('food-beverages-tobacco/beverages/tea-infusions', 'food-beverages-tobacco/beverages', 'Tea & Infusions', 'Food, Beverages & Tobacco > Beverages > Tea & Infusions', 3, 1, 102),
  ('food-beverages-tobacco/beverages/water', 'food-beverages-tobacco/beverages', 'Water', 'Food, Beverages & Tobacco > Beverages > Water', 3, 1, 103),
  ('food-beverages-tobacco/food-items', 'food-beverages-tobacco', 'Food Items', 'Food, Beverages & Tobacco > Food Items', 2, 0, 104),
  ('food-beverages-tobacco/food-items/bakery', 'food-beverages-tobacco/food-items', 'Bakery', 'Food, Beverages & Tobacco > Food Items > Bakery', 3, 1, 105),
  ('food-beverages-tobacco/food-items/candy-chocolate', 'food-beverages-tobacco/food-items', 'Candy & Chocolate', 'Food, Beverages & Tobacco > Food Items > Candy & Chocolate', 3, 1, 106),
  ('food-beverages-tobacco/food-items/condiments-sauces', 'food-beverages-tobacco/food-items', 'Condiments & Sauces', 'Food, Beverages & Tobacco > Food Items > Condiments & Sauces', 3, 1, 107),
  ('food-beverages-tobacco/food-items/cooking-baking-ingredients', 'food-beverages-tobacco/food-items', 'Cooking & Baking Ingredients', 'Food, Beverages & Tobacco > Food Items > Cooking & Baking Ingredients', 3, 1, 108),
  ('food-beverages-tobacco/food-items/dairy-products', 'food-beverages-tobacco/food-items', 'Dairy Products', 'Food, Beverages & Tobacco > Food Items > Dairy Products', 3, 1, 109),
  ('food-beverages-tobacco/food-items/fruits-vegetables', 'food-beverages-tobacco/food-items', 'Fruits & Vegetables', 'Food, Beverages & Tobacco > Food Items > Fruits & Vegetables', 3, 1, 110),
  ('food-beverages-tobacco/food-items/grains-rice-cereal', 'food-beverages-tobacco/food-items', 'Grains, Rice & Cereal', 'Food, Beverages & Tobacco > Food Items > Grains, Rice & Cereal', 3, 1, 111),
  ('food-beverages-tobacco/food-items/meat-seafood-eggs', 'food-beverages-tobacco/food-items', 'Meat, Seafood & Eggs', 'Food, Beverages & Tobacco > Food Items > Meat, Seafood & Eggs', 3, 1, 112),
  ('food-beverages-tobacco/food-items/nuts-seeds', 'food-beverages-tobacco/food-items', 'Nuts & Seeds', 'Food, Beverages & Tobacco > Food Items > Nuts & Seeds', 3, 1, 113),
  ('food-beverages-tobacco/food-items/pasta-noodles', 'food-beverages-tobacco/food-items', 'Pasta & Noodles', 'Food, Beverages & Tobacco > Food Items > Pasta & Noodles', 3, 1, 114),
  ('food-beverages-tobacco/food-items/seasonings-spices', 'food-beverages-tobacco/food-items', 'Seasonings & Spices', 'Food, Beverages & Tobacco > Food Items > Seasonings & Spices', 3, 1, 115),
  ('food-beverages-tobacco/food-items/snack-foods', 'food-beverages-tobacco/food-items', 'Snack Foods', 'Food, Beverages & Tobacco > Food Items > Snack Foods', 3, 1, 116),
  ('furniture', NULL, 'Furniture', 'Furniture', 1, 0, 117),
  ('furniture/beds-accessories', 'furniture', 'Beds & Accessories', 'Furniture > Beds & Accessories', 2, 1, 118),
  ('furniture/cabinets-storage', 'furniture', 'Cabinets & Storage', 'Furniture > Cabinets & Storage', 2, 1, 119),
  ('furniture/chairs', 'furniture', 'Chairs', 'Furniture > Chairs', 2, 1, 120),
  ('furniture/office-furniture', 'furniture', 'Office Furniture', 'Furniture > Office Furniture', 2, 1, 121),
  ('furniture/outdoor-furniture', 'furniture', 'Outdoor Furniture', 'Furniture > Outdoor Furniture', 2, 1, 122),
  ('furniture/shelving', 'furniture', 'Shelving', 'Furniture > Shelving', 2, 1, 123),
  ('furniture/sofas', 'furniture', 'Sofas', 'Furniture > Sofas', 2, 1, 124),
  ('furniture/tables', 'furniture', 'Tables', 'Furniture > Tables', 2, 1, 125),
  ('hardware', NULL, 'Hardware', 'Hardware', 1, 0, 126),
  ('hardware/building-materials', 'hardware', 'Building Materials', 'Hardware > Building Materials', 2, 1, 127),
  ('hardware/plumbing', 'hardware', 'Plumbing', 'Hardware > Plumbing', 2, 1, 128),
  ('hardware/tools', 'hardware', 'Tools', 'Hardware > Tools', 2, 1, 129),
  ('health-beauty', NULL, 'Health & Beauty', 'Health & Beauty', 1, 0, 130),
  ('health-beauty/health-care', 'health-beauty', 'Health Care', 'Health & Beauty > Health Care', 2, 0, 131),
  ('health-beauty/health-care/first-aid', 'health-beauty/health-care', 'First Aid', 'Health & Beauty > Health Care > First Aid', 3, 1, 132),
  ('health-beauty/health-care/fitness-nutrition', 'health-beauty/health-care', 'Fitness & Nutrition', 'Health & Beauty > Health Care > Fitness & Nutrition', 3, 0, 133),
  ('health-beauty/health-care/fitness-nutrition/vitamins-supplements', 'health-beauty/health-care/fitness-nutrition', 'Vitamins & Supplements', 'Health & Beauty > Health Care > Fitness & Nutrition > Vitamins & Supplements', 4, 1, 134),
  ('health-beauty/personal-care', 'health-beauty', 'Personal Care', 'Health & Beauty > Personal Care', 2, 0, 135),
  ('health-beauty/personal-care/cosmetics', 'health-beauty/personal-care', 'Cosmetics', 'Health & Beauty > Personal Care > Cosmetics', 3, 0, 136),
  ('health-beauty/personal-care/cosmetics/bath-body', 'health-beauty/personal-care/cosmetics', 'Bath & Body', 'Health & Beauty > Personal Care > Cosmetics > Bath & Body', 4, 1, 137),
  ('health-beauty/personal-care/cosmetics/cosmetic-tools', 'health-beauty/personal-care/cosmetics', 'Cosmetic Tools', 'Health & Beauty > Personal Care > Cosmetics > Cosmetic Tools', 4, 1, 138),
  ('health-beauty/personal-care/cosmetics/makeup', 'health-beauty/personal-care/cosmetics', 'Makeup', 'Health & Beauty > Personal Care > Cosmetics > Makeup', 4, 0, 139),
  ('health-beauty/personal-care/cosmetics/makeup/eye-makeup', 'health-beauty/personal-care/cosmetics/makeup', 'Eye Makeup', 'Health & Beauty > Personal Care > Cosmetics > Makeup > Eye Makeup', 5, 1, 140),
  ('health-beauty/personal-care/cosmetics/makeup/face-makeup', 'health-beauty/personal-care/cosmetics/makeup', 'Face Makeup', 'Health & Beauty > Personal Care > Cosmetics > Makeup > Face Makeup', 5, 1, 141),
  ('health-beauty/personal-care/cosmetics/makeup/lip-makeup', 'health-beauty/personal-care/cosmetics/makeup', 'Lip Makeup', 'Health & Beauty > Personal Care > Cosmetics > Makeup > Lip Makeup', 5, 1, 142),
  ('health-beauty/personal-care/cosmetics/nail-care', 'health-beauty/personal-care/cosmetics', 'Nail Care', 'Health & Beauty > Personal Care > Cosmetics > Nail Care', 4, 1, 143),
  ('health-beauty/personal-care/cosmetics/perfume-cologne', 'health-beauty/personal-care/cosmetics', 'Perfume & Cologne', 'Health & Beauty > Personal Care > Cosmetics > Perfume & Cologne', 4, 1, 144),
  ('health-beauty/personal-care/cosmetics/skin-care', 'health-beauty/personal-care/cosmetics', 'Skin Care', 'Health & Beauty > Personal Care > Cosmetics > Skin Care', 4, 0, 145),
  ('health-beauty/personal-care/cosmetics/skin-care/cleansers', 'health-beauty/personal-care/cosmetics/skin-care', 'Cleansers', 'Health & Beauty > Personal Care > Cosmetics > Skin Care > Cleansers', 5, 1, 146),
  ('health-beauty/personal-care/cosmetics/skin-care/eye-creams', 'health-beauty/personal-care/cosmetics/skin-care', 'Eye Creams', 'Health & Beauty > Personal Care > Cosmetics > Skin Care > Eye Creams', 5, 1, 147),
  ('health-beauty/personal-care/cosmetics/skin-care/face-masks', 'health-beauty/personal-care/cosmetics/skin-care', 'Face Masks', 'Health & Beauty > Personal Care > Cosmetics > Skin Care > Face Masks', 5, 1, 148),
  ('health-beauty/personal-care/cosmetics/skin-care/lip-balms-treatments', 'health-beauty/personal-care/cosmetics/skin-care', 'Lip Balms & Treatments', 'Health & Beauty > Personal Care > Cosmetics > Skin Care > Lip Balms & Treatments', 5, 1, 149),
  ('health-beauty/personal-care/cosmetics/skin-care/moisturizers', 'health-beauty/personal-care/cosmetics/skin-care', 'Moisturizers', 'Health & Beauty > Personal Care > Cosmetics > Skin Care > Moisturizers', 5, 1, 150),
  ('health-beauty/personal-care/cosmetics/skin-care/serums', 'health-beauty/personal-care/cosmetics/skin-care', 'Serums', 'Health & Beauty > Personal Care > Cosmetics > Skin Care > Serums', 5, 1, 151),
  ('health-beauty/personal-care/cosmetics/skin-care/sunscreen', 'health-beauty/personal-care/cosmetics/skin-care', 'Sunscreen', 'Health & Beauty > Personal Care > Cosmetics > Skin Care > Sunscreen', 5, 1, 152),
  ('health-beauty/personal-care/cosmetics/skin-care/toners-astringents', 'health-beauty/personal-care/cosmetics/skin-care', 'Toners & Astringents', 'Health & Beauty > Personal Care > Cosmetics > Skin Care > Toners & Astringents', 5, 1, 153),
  ('health-beauty/personal-care/deodorant-anti-perspirant', 'health-beauty/personal-care', 'Deodorant & Anti-Perspirant', 'Health & Beauty > Personal Care > Deodorant & Anti-Perspirant', 3, 1, 154),
  ('health-beauty/personal-care/feminine-care', 'health-beauty/personal-care', 'Feminine Care', 'Health & Beauty > Personal Care > Feminine Care', 3, 1, 155),
  ('health-beauty/personal-care/hair-care', 'health-beauty/personal-care', 'Hair Care', 'Health & Beauty > Personal Care > Hair Care', 3, 0, 156),
  ('health-beauty/personal-care/hair-care/hair-color', 'health-beauty/personal-care/hair-care', 'Hair Color', 'Health & Beauty > Personal Care > Hair Care > Hair Color', 4, 1, 157),
  ('health-beauty/personal-care/hair-care/hair-styling-products', 'health-beauty/personal-care/hair-care', 'Hair Styling Products', 'Health & Beauty > Personal Care > Hair Care > Hair Styling Products', 4, 1, 158),
  ('health-beauty/personal-care/hair-care/hair-treatments', 'health-beauty/personal-care/hair-care', 'Hair Treatments', 'Health & Beauty > Personal Care > Hair Care > Hair Treatments', 4, 1, 159),
  ('health-beauty/personal-care/hair-care/shampoo-conditioner', 'health-beauty/personal-care/hair-care', 'Shampoo & Conditioner', 'Health & Beauty > Personal Care > Hair Care > Shampoo & Conditioner', 4, 1, 160),
  ('health-beauty/personal-care/oral-care', 'health-beauty/personal-care', 'Oral Care', 'Health & Beauty > Personal Care > Oral Care', 3, 1, 161),
  ('health-beauty/personal-care/shaving-grooming', 'health-beauty/personal-care', 'Shaving & Grooming', 'Health & Beauty > Personal Care > Shaving & Grooming', 3, 1, 162),
  ('home-garden', NULL, 'Home & Garden', 'Home & Garden', 1, 0, 163),
  ('home-garden/bathroom-accessories', 'home-garden', 'Bathroom Accessories', 'Home & Garden > Bathroom Accessories', 2, 1, 164),
  ('home-garden/decor', 'home-garden', 'Decor', 'Home & Garden > Decor', 2, 0, 165),
  ('home-garden/decor/artwork', 'home-garden/decor', 'Artwork', 'Home & Garden > Decor > Artwork', 3, 1, 166),
  ('home-garden/decor/candles', 'home-garden/decor', 'Candles', 'Home & Garden > Decor > Candles', 3, 1, 167),
  ('home-garden/decor/clocks', 'home-garden/decor', 'Clocks', 'Home & Garden > Decor > Clocks', 3, 1, 168),
  ('home-garden/decor/home-fragrances', 'home-garden/decor', 'Home Fragrances', 'Home & Garden > Decor > Home Fragrances', 3, 1, 169),
  ('home-garden/decor/mirrors', 'home-garden/decor', 'Mirrors', 'Home & Garden > Decor > Mirrors', 3, 1, 170),
  ('home-garden/decor/rugs', 'home-garden/decor', 'Rugs', 'Home & Garden > Decor > Rugs', 3, 1, 171),
  ('home-garden/decor/throw-pillows', 'home-garden/decor', 'Throw Pillows', 'Home & Garden > Decor > Throw Pillows', 3, 1, 172),
  ('home-garden/decor/vases', 'home-garden/decor', 'Vases', 'Home & Garden > Decor > Vases', 3, 1, 173),
  ('home-garden/household-supplies', 'home-garden', 'Household Supplies', 'Home & Garden > Household Supplies', 2, 0, 174),
  ('home-garden/household-supplies/household-cleaning-supplies', 'home-garden/household-supplies', 'Household Cleaning Supplies', 'Home & Garden > Household Supplies > Household Cleaning Supplies', 3, 1, 175),
  ('home-garden/household-supplies/laundry-supplies', 'home-garden/household-supplies', 'Laundry Supplies', 'Home & Garden > Household Supplies > Laundry Supplies', 3, 1, 176),
  ('home-garden/household-supplies/storage-organization', 'home-garden/household-supplies', 'Storage & Organization', 'Home & Garden > Household Supplies > Storage & Organization', 3, 1, 177),
  ('home-garden/kitchen-dining', 'home-garden', 'Kitchen & Dining', 'Home & Garden > Kitchen & Dining', 2, 0, 178),
  ('home-garden/kitchen-dining/cookware-bakeware', 'home-garden/kitchen-dining', 'Cookware & Bakeware', 'Home & Garden > Kitchen & Dining > Cookware & Bakeware', 3, 1, 179),
  ('home-garden/kitchen-dining/drinkware', 'home-garden/kitchen-dining', 'Drinkware', 'Home & Garden > Kitchen & Dining > Drinkware', 3, 1, 180),
  ('home-garden/kitchen-dining/food-storage', 'home-garden/kitchen-dining', 'Food Storage', 'Home & Garden > Kitchen & Dining > Food Storage', 3, 1, 181),
  ('home-garden/kitchen-dining/kitchen-appliances', 'home-garden/kitchen-dining', 'Kitchen Appliances', 'Home & Garden > Kitchen & Dining > Kitchen Appliances', 3, 1, 182),
  ('home-garden/kitchen-dining/kitchen-tools-utensils', 'home-garden/kitchen-dining', 'Kitchen Tools & Utensils', 'Home & Garden > Kitchen & Dining > Kitchen Tools & Utensils', 3, 1, 183),
  ('home-garden/kitchen-dining/tableware', 'home-garden/kitchen-dining', 'Tableware', 'Home & Garden > Kitchen & Dining > Tableware', 3, 1, 184),
  ('home-garden/lawn-garden', 'home-garden', 'Lawn & Garden', 'Home & Garden > Lawn & Garden', 2, 0, 185),
  ('home-garden/lawn-garden/gardening', 'home-garden/lawn-garden', 'Gardening', 'Home & Garden > Lawn & Garden > Gardening', 3, 1, 186),
  ('home-garden/lawn-garden/outdoor-living', 'home-garden/lawn-garden', 'Outdoor Living', 'Home & Garden > Lawn & Garden > Outdoor Living', 3, 1, 187),
  ('home-garden/lawn-garden/plants', 'home-garden/lawn-garden', 'Plants', 'Home & Garden > Lawn & Garden > Plants', 3, 1, 188),
  ('home-garden/lighting', 'home-garden', 'Lighting', 'Home & Garden > Lighting', 2, 1, 189),
  ('home-garden/linens-bedding', 'home-garden', 'Linens & Bedding', 'Home & Garden > Linens & Bedding', 2, 0, 190),
  ('home-garden/linens-bedding/bedding', 'home-garden/linens-bedding', 'Bedding', 'Home & Garden > Linens & Bedding > Bedding', 3, 1, 191),
  ('home-garden/linens-bedding/table-linens', 'home-garden/linens-bedding', 'Table Linens', 'Home & Garden > Linens & Bedding > Table Linens', 3, 1, 192),
  ('home-garden/linens-bedding/towels', 'home-garden/linens-bedding', 'Towels', 'Home & Garden > Linens & Bedding > Towels', 3, 1, 193),
  ('luggage-bags', NULL, 'Luggage & Bags', 'Luggage & Bags', 1, 0, 194),
  ('luggage-bags/backpacks', 'luggage-bags', 'Backpacks', 'Luggage & Bags > Backpacks', 2, 1, 195),
  ('luggage-bags/duffel-bags', 'luggage-bags', 'Duffel Bags', 'Luggage & Bags > Duffel Bags', 2, 1, 196),
  ('luggage-bags/suitcases', 'luggage-bags', 'Suitcases', 'Luggage & Bags > Suitcases', 2, 1, 197),
  ('luggage-bags/travel-accessories', 'luggage-bags', 'Travel Accessories', 'Luggage & Bags > Travel Accessories', 2, 1, 198),
  ('media', NULL, 'Media', 'Media', 1, 0, 199),
  ('media/books', 'media', 'Books', 'Media > Books', 2, 1, 200),
  ('media/magazines-newspapers', 'media', 'Magazines & Newspapers', 'Media > Magazines & Newspapers', 2, 1, 201),
  ('media/music-sound-recordings', 'media', 'Music & Sound Recordings', 'Media > Music & Sound Recordings', 2, 1, 202),
  ('media/videos', 'media', 'Videos', 'Media > Videos', 2, 1, 203),
  ('office-supplies', NULL, 'Office Supplies', 'Office Supplies', 1, 0, 204),
  ('office-supplies/filing-organization', 'office-supplies', 'Filing & Organization', 'Office Supplies > Filing & Organization', 2, 1, 205),
  ('office-supplies/office-equipment', 'office-supplies', 'Office Equipment', 'Office Supplies > Office Equipment', 2, 1, 206),
  ('office-supplies/paper-products', 'office-supplies', 'Paper Products', 'Office Supplies > Paper Products', 2, 1, 207),
  ('office-supplies/writing-drawing-instruments', 'office-supplies', 'Writing & Drawing Instruments', 'Office Supplies > Writing & Drawing Instruments', 2, 1, 208),
  ('religious-ceremonial', NULL, 'Religious & Ceremonial', 'Religious & Ceremonial', 1, 0, 209),
  ('religious-ceremonial/religious-items', 'religious-ceremonial', 'Religious Items', 'Religious & Ceremonial > Religious Items', 2, 1, 210),
  ('religious-ceremonial/wedding-ceremony-supplies', 'religious-ceremonial', 'Wedding Ceremony Supplies', 'Religious & Ceremonial > Wedding Ceremony Supplies', 2, 1, 211),
  ('software', NULL, 'Software', 'Software', 1, 0, 212),
  ('software/computer-software', 'software', 'Computer Software', 'Software > Computer Software', 2, 1, 213),
  ('software/digital-goods-currency', 'software', 'Digital Goods & Currency', 'Software > Digital Goods & Currency', 2, 1, 214),
  ('sporting-goods', NULL, 'Sporting Goods', 'Sporting Goods', 1, 0, 215),
  ('sporting-goods/athletics', 'sporting-goods', 'Athletics', 'Sporting Goods > Athletics', 2, 0, 216),
  ('sporting-goods/athletics/badminton', 'sporting-goods/athletics', 'Badminton', 'Sporting Goods > Athletics > Badminton', 3, 1, 217),
  ('sporting-goods/athletics/basketball', 'sporting-goods/athletics', 'Basketball', 'Sporting Goods > Athletics > Basketball', 3, 1, 218),
  ('sporting-goods/athletics/cricket', 'sporting-goods/athletics', 'Cricket', 'Sporting Goods > Athletics > Cricket', 3, 1, 219),
  ('sporting-goods/athletics/football', 'sporting-goods/athletics', 'Football', 'Sporting Goods > Athletics > Football', 3, 1, 220),
  ('sporting-goods/athletics/tennis', 'sporting-goods/athletics', 'Tennis', 'Sporting Goods > Athletics > Tennis', 3, 1, 221),
  ('sporting-goods/exercise-fitness', 'sporting-goods', 'Exercise & Fitness', 'Sporting Goods > Exercise & Fitness', 2, 0, 222),
  ('sporting-goods/exercise-fitness/cardio', 'sporting-goods/exercise-fitness', 'Cardio', 'Sporting Goods > Exercise & Fitness > Cardio', 3, 1, 223),
  ('sporting-goods/exercise-fitness/weight-lifting', 'sporting-goods/exercise-fitness', 'Weight Lifting', 'Sporting Goods > Exercise & Fitness > Weight Lifting', 3, 1, 224),
  ('sporting-goods/exercise-fitness/yoga-pilates', 'sporting-goods/exercise-fitness', 'Yoga & Pilates', 'Sporting Goods > Exercise & Fitness > Yoga & Pilates', 3, 1, 225),
  ('sporting-goods/outdoor-recreation', 'sporting-goods', 'Outdoor Recreation', 'Sporting Goods > Outdoor Recreation', 2, 0, 226),
  ('sporting-goods/outdoor-recreation/camping-hiking', 'sporting-goods/outdoor-recreation', 'Camping & Hiking', 'Sporting Goods > Outdoor Recreation > Camping & Hiking', 3, 1, 227),
  ('sporting-goods/outdoor-recreation/cycling', 'sporting-goods/outdoor-recreation', 'Cycling', 'Sporting Goods > Outdoor Recreation > Cycling', 3, 1, 228),
  ('toys-games', NULL, 'Toys & Games', 'Toys & Games', 1, 0, 229),
  ('toys-games/games', 'toys-games', 'Games', 'Toys & Games > Games', 2, 0, 230),
  ('toys-games/games/board-games', 'toys-games/games', 'Board Games', 'Toys & Games > Games > Board Games', 3, 1, 231),
  ('toys-games/games/card-games', 'toys-games/games', 'Card Games', 'Toys & Games > Games > Card Games', 3, 1, 232),
  ('toys-games/games/puzzles', 'toys-games/games', 'Puzzles', 'Toys & Games > Games > Puzzles', 3, 1, 233),
  ('toys-games/toys', 'toys-games', 'Toys', 'Toys & Games > Toys', 2, 0, 234),
  ('toys-games/toys/building-toys', 'toys-games/toys', 'Building Toys', 'Toys & Games > Toys > Building Toys', 3, 1, 235),
  ('toys-games/toys/dolls-action-figures', 'toys-games/toys', 'Dolls & Action Figures', 'Toys & Games > Toys > Dolls & Action Figures', 3, 1, 236),
  ('toys-games/toys/educational-toys', 'toys-games/toys', 'Educational Toys', 'Toys & Games > Toys > Educational Toys', 3, 1, 237),
  ('toys-games/toys/outdoor-play-equipment', 'toys-games/toys', 'Outdoor Play Equipment', 'Toys & Games > Toys > Outdoor Play Equipment', 3, 1, 238),
  ('toys-games/toys/stuffed-animals', 'toys-games/toys', 'Stuffed Animals', 'Toys & Games > Toys > Stuffed Animals', 3, 1, 239),
  ('vehicles-parts', NULL, 'Vehicles & Parts', 'Vehicles & Parts', 1, 0, 240),
  ('vehicles-parts/vehicle-parts-accessories', 'vehicles-parts', 'Vehicle Parts & Accessories', 'Vehicles & Parts > Vehicle Parts & Accessories', 2, 1, 241),
  ('vehicles-parts/vehicles', 'vehicles-parts', 'Vehicles', 'Vehicles & Parts > Vehicles', 2, 1, 242),
  ('gift-cards', NULL, 'Gift Cards', 'Gift Cards', 1, 1, 243),
  ('bundles', NULL, 'Bundles', 'Bundles', 1, 1, 244),
  ('product-add-ons', NULL, 'Product Add-Ons', 'Product Add-Ons', 1, 1, 245),
  ('services', NULL, 'Services', 'Services', 1, 1, 246),
  ('uncategorized', NULL, 'Uncategorized', 'Uncategorized', 1, 1, 247)
ON DUPLICATE KEY UPDATE
  parent_code = VALUES(parent_code),
  name        = VALUES(name),
  full_name   = VALUES(full_name),
  level       = VALUES(level),
  is_leaf     = VALUES(is_leaf),
  sort_order  = VALUES(sort_order);
