-- ────────────────────────────────────────────────────────────────────────────
-- 38 — shades, creators, story sections and pinned labels
--
--   mysql -u <user> -p <database> < database/38_product_storytelling.sql
--
-- Everything a cosmetics product page needs beyond a description: a shade you
-- can pick by name and colour, photographs that belong to that shade, story
-- sections with any number of image/title/description blocks, labels pinned to
-- points on an image, and the models whose looks sell the thing.
--
-- Entirely additive. No existing column changes type, no table is dropped, and
-- nothing that works today stops working. Safe to run on a live database.
--
-- Idempotent: every statement checks first, so a second run is a no-op.
-- ────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

-- ── a small helper for additive columns ─────────────────────────────────────
-- MySQL has no ADD COLUMN IF NOT EXISTS, and a migration that fails halfway on
-- a second run is worse than one that is slightly repetitive.
DROP PROCEDURE IF EXISTS veylor_add_column;
DELIMITER //
CREATE PROCEDURE veylor_add_column(
  IN target_table VARCHAR(64),
  IN target_column VARCHAR(64),
  IN definition VARCHAR(500)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = target_table
       AND COLUMN_NAME = target_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', target_table, '` ADD COLUMN `', target_column, '` ', definition);
    PREPARE statement FROM @ddl;
    EXECUTE statement;
    DEALLOCATE PREPARE statement;
  END IF;
END //
DELIMITER ;

-- ── 1. shades ───────────────────────────────────────────────────────────────
-- 'monet — shimmery apricot (limited edition)'. The name was already there;
-- everything that makes it read like a shade rather than a dropdown entry was
-- not.
--
-- There is deliberately no `is_sold_out`. That is derived from
-- inventory_items.quantity_available for the variants carrying this value: a
-- stored flag goes stale the moment stock moves, and then the site lies about
-- availability, which is worse than showing nothing.
CALL veylor_add_column('product_option_values', 'descriptor',
  "VARCHAR(160) NULL COMMENT 'shimmery apricot' AFTER `value`");
CALL veylor_add_column('product_option_values', 'badge',
  "VARCHAR(40) NULL COMMENT 'limited edition, new' AFTER `descriptor`");
CALL veylor_add_column('product_option_values', 'description',
  "VARCHAR(500) NULL COMMENT 'longer note shown in the shade dropdown' AFTER `badge`");
CALL veylor_add_column('product_option_values', 'is_active',
  'TINYINT(1) UNSIGNED NOT NULL DEFAULT 1');

-- ── 2. size in words ────────────────────────────────────────────────────────
-- `net_quantity` is what is printed on the pack ('30 ml') and `volume_ml` is
-- what price-per-ml is worked out from. This is the sentence a shopper reads:
-- 'about 60 applications — roughly three months of nightly use'.
CALL veylor_add_column('product_variants', 'size_description',
  "VARCHAR(255) NULL COMMENT 'how much is in it, in words' AFTER `net_quantity`");

-- ── 3. creators ─────────────────────────────────────────────────────────────
-- A library rather than rows on each product: a model cast once appears on the
-- serum, the sunscreen and a campaign page, and her handle is fixed in one
-- place when it changes.
CREATE TABLE IF NOT EXISTS `creators` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`         CHAR(36)        NOT NULL DEFAULT (UUID()),
  `slug`              VARCHAR(160)    NOT NULL,
  `name`              VARCHAR(160)    NOT NULL,
  `handle`            VARCHAR(80)         NULL COMMENT '@name, shown under the portrait',
  `role`              VARCHAR(120)        NULL COMMENT 'Founder, Makeup artist, Creator',
  `bio`               VARCHAR(1000)       NULL,
  `portrait_media_id` BIGINT UNSIGNED     NULL,
  -- Stored whole rather than as a handle plus a guessed prefix: these are
  -- links the site sends people to, and a guessed URL is a broken one.
  `instagram_url`     VARCHAR(500)        NULL,
  `youtube_url`       VARCHAR(500)        NULL,
  `tiktok_url`        VARCHAR(500)        NULL,
  `website_url`       VARCHAR(500)        NULL,
  `is_active`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `sort_order`        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_by_admin_id` BIGINT UNSIGNED   NULL,
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`        DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_creators_slug` (`slug`),
  UNIQUE KEY `uq_creators_public_id` (`public_id`),
  KEY `ix_creators_active` (`is_active`, `sort_order`),
  CONSTRAINT `fk_creators_portrait`
    FOREIGN KEY (`portrait_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_creators_admin`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── 4. story sections ───────────────────────────────────────────────────────
-- An ordered list of typed sections with ordered blocks inside them — the same
-- shape the CMS uses for pages, which is what lets the claims block, the
-- packaging diagram and a model's routine all be content rather than code.
--
-- A section is authored once and attached wherever it belongs, which is what
-- `content_section_assignments` below is for. The existing `cms_page_sections`
-- is left exactly as it is; when the page section editor is finally built it
-- adopts these tables and the old pair is dropped then. One engine and one
-- editor, without touching anything that works today.
CREATE TABLE IF NOT EXISTS `content_sections` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `section_key`    VARCHAR(60)     NOT NULL COMMENT 'claims|packaging|model_routine|feature|how_to',
  -- Required, because this is what the "attach an existing section" picker
  -- shows. A library of sections called "Section 7" is a library nobody reuses.
  `name`           VARCHAR(120)    NOT NULL COMMENT 'admin-facing label',
  `heading`        VARCHAR(255)        NULL COMMENT 'less harm, more pearl.',
  `standfirst`     VARCHAR(500)        NULL,
  `footnote`       VARCHAR(500)        NULL COMMENT 'used when no claim supplies one',
  `layout`         VARCHAR(40)     NOT NULL DEFAULT 'split' COMMENT 'split|stacked|carousel|grid',
  `background`     VARCHAR(40)         NULL,
  `padding_top`    ENUM('none','sm','md','lg','xl') NOT NULL DEFAULT 'md',
  `padding_bottom` ENUM('none','sm','md','lg','xl') NOT NULL DEFAULT 'md',
  `settings`       JSON                NULL,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`     DATETIME            NULL,
  PRIMARY KEY (`id`),
  KEY `ix_content_sections_key` (`section_key`, `deleted_at`),
  CONSTRAINT `fk_content_sections_admin`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Where a section appears. Separate from the section itself because "less harm,
-- more pearl" is the same words on every product in a range: authored once,
-- corrected once, and attached to twelve products rather than pasted into
-- twelve products and corrected in eleven of them.
--
-- Position and scheduling live here rather than on the section, so the same
-- packaging story can sit third on one product and last on another, and a
-- campaign module can run on one product without running on all of them.
CREATE TABLE IF NOT EXISTS `content_section_assignments` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `section_id`    BIGINT UNSIGNED NOT NULL,
  `owner_type`    ENUM('product','page','collection') NOT NULL DEFAULT 'product',
  `owner_id`      BIGINT UNSIGNED NOT NULL,
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_enabled`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `visible_from`  DATETIME            NULL,
  `visible_until` DATETIME            NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_content_assignment` (`section_id`, `owner_type`, `owner_id`),
  KEY `ix_content_assignments_owner` (`owner_type`, `owner_id`, `sort_order`),
  CONSTRAINT `fk_content_assignments_section`
    FOREIGN KEY (`section_id`) REFERENCES `content_sections` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The repeatable children: the four stat lines, the five looks in a routine,
-- the two halves of a packaging diagram.
CREATE TABLE IF NOT EXISTS `content_section_blocks` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `section_id`         BIGINT UNSIGNED NOT NULL,
  `block_type`         VARCHAR(60)     NOT NULL COMMENT 'stat|look|diagram|feature|step',
  `sort_order`         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_enabled`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `heading`            VARCHAR(255)        NULL COMMENT '100% — or: highlight milk',
  `body`               TEXT                NULL,
  `media_id`           BIGINT UNSIGNED     NULL COMMENT 'the photograph, or the film',
  `secondary_media_id` BIGINT UNSIGNED     NULL COMMENT 'the swatch beside the copy',
  `creator_id`         BIGINT UNSIGNED     NULL COMMENT 'whose look this is',
  -- An efficacy number on a cosmetics page should not be free text. Pointing at
  -- an approved claim is what carries the footnote and the evidence with it.
  `claim_id`           BIGINT UNSIGNED     NULL,
  `option_value_id`    BIGINT UNSIGNED     NULL COMMENT 'the shade this look wears',
  `link_type`          ENUM('none','url','product','collection','category','page','article')
                                       NOT NULL DEFAULT 'none',
  `link_ref_id`        BIGINT UNSIGNED     NULL,
  `link_url`           VARCHAR(500)        NULL,
  `cta_label`          VARCHAR(60)         NULL,
  `settings`           JSON                NULL,
  `created_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_content_section_blocks_section` (`section_id`, `sort_order`),
  CONSTRAINT `fk_content_blocks_section`
    FOREIGN KEY (`section_id`) REFERENCES `content_sections` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_content_blocks_media`
    FOREIGN KEY (`media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_content_blocks_secondary_media`
    FOREIGN KEY (`secondary_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_content_blocks_creator`
    FOREIGN KEY (`creator_id`) REFERENCES `creators` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_content_blocks_claim`
    FOREIGN KEY (`claim_id`) REFERENCES `claims` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_content_blocks_option_value`
    FOREIGN KEY (`option_value_id`) REFERENCES `product_option_values` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── 5. labels pinned to a point on an image ─────────────────────────────────
-- 'Cap — 50% PCR' on the packaging diagram, and 'highlight milk — apply to
-- bare skin' on a model shot, are the same thing: a dot on a photograph with
-- words attached.
--
-- Percentages, never pixels. The photograph is rendered at whatever width the
-- screen allows, and a label measured in pixels slides off the cap.
CREATE TABLE IF NOT EXISTS `content_block_hotspots` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `block_id`       BIGINT UNSIGNED NOT NULL,
  `x_pct`          DECIMAL(5,2)    NOT NULL COMMENT '0-100, from the left edge',
  `y_pct`          DECIMAL(5,2)    NOT NULL COMMENT '0-100, from the top edge',
  `label`          VARCHAR(120)    NOT NULL COMMENT 'Cap | highlight milk',
  `body`           VARCHAR(500)        NULL COMMENT '50% PCR | apply to bare skin…',
  `product_id`     BIGINT UNSIGNED     NULL COMMENT 'so the callout is clickable',
  `media_id`       BIGINT UNSIGNED     NULL COMMENT 'the blob shown beside the label',
  `line_direction` ENUM('left','right','up','down') NOT NULL DEFAULT 'right',
  `sort_order`     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_content_hotspots_block` (`block_id`, `sort_order`),
  CONSTRAINT `fk_content_hotspots_block`
    FOREIGN KEY (`block_id`) REFERENCES `content_section_blocks` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_content_hotspots_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_content_hotspots_media`
    FOREIGN KEY (`media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ck_content_hotspots_bounds`
    CHECK (`x_pct` >= 0 AND `x_pct` <= 100 AND `y_pct` >= 0 AND `y_pct` <= 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DROP PROCEDURE IF EXISTS veylor_add_column;

SELECT 'Migration 38 applied.' AS result;
