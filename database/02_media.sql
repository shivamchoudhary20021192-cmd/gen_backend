-- =============================================================================
-- File 02 : MEDIA LIBRARY
-- =============================================================================
-- This is the module you said matters most, so it is built to survive the one
-- thing that usually breaks image handling: moving the files later.
--
-- STORAGE MODEL
-- -----------------------------------------------------------------------------
-- A file's address is always TWO columns, never a hardcoded URL:
--
--     disk         where it lives right now        'local'
--     storage_key  path within that disk           'media/2026/09/a1b2.../original.jpg'
--
-- The public URL is composed at read time as  {base_url_for_disk} + storage_key.
-- The base URL lives in `settings` (media.local_base_url, media.s3_base_url),
-- NOT in this table. That single rule is what makes the S3 migration a copy job
-- plus one UPDATE of `disk` per row — no rewriting of product HTML, no broken
-- <img> tags, no data migration of any other table.
--
-- Recommended on-disk layout while `disk = 'local'`:
--     /storage/media/{YYYY}/{MM}/{public_id}/original.jpg
--     /storage/media/{YYYY}/{MM}/{public_id}/lg.webp
--     /storage/media/{YYYY}/{MM}/{public_id}/lg.avif
--     ...
-- Sharding by year/month keeps any single directory under a few thousand
-- entries, which matters on ext4/NTFS once you are in the tens of thousands of
-- product and review images. Never store uploads inside the web root or inside
-- /public — serve them through a route that can 404, authorise and set
-- immutable cache headers.
--
-- WHY THREE TABLES
-- -----------------------------------------------------------------------------
--   media              the original upload — one row per real file
--   media_variants     every derived rendition (width x format)
--   media_attachments  which entity uses which media, in what slot, in what order
--
-- Splitting variants out means a product gallery image can gain an AVIF
-- rendition next year without touching the product. Splitting attachments out
-- means the SAME image can be a PDP gallery shot, a collection banner and an OG
-- image with three different alt texts and zero duplicate files — which is
-- exactly what a two-SKU catalogue with heavy art direction needs.
-- =============================================================================

USE `veylog`;

-- -----------------------------------------------------------------------------
-- media_folders — admin-facing organisation only. Has no bearing on storage
-- paths (moving a folder must never move a file).
-- -----------------------------------------------------------------------------
CREATE TABLE `media_folders` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `parent_id`   BIGINT UNSIGNED     NULL,
  `name`        VARCHAR(120)    NOT NULL,
  `slug`        VARCHAR(140)    NOT NULL,
  `path`        VARCHAR(500)    NOT NULL,   -- 'products/serum/pack-shots'
  `depth`       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `sort_order`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `media_count` INT UNSIGNED    NOT NULL DEFAULT 0,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_media_folders_sibling` (`parent_id`, `slug`),
  KEY `ix_media_folders_path` (`path`),
  CONSTRAINT `fk_media_folders_parent`
    FOREIGN KEY (`parent_id`) REFERENCES `media_folders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_media_folders_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- media — one row per uploaded original
-- -----------------------------------------------------------------------------
CREATE TABLE `media` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`         CHAR(36)        NOT NULL DEFAULT (UUID()),
  `folder_id`         BIGINT UNSIGNED     NULL,

  -- ── address ───────────────────────────────────────────────────────────────
  `disk`              ENUM('local','s3','r2','gcs','supabase','cloudinary','external')
                                      NOT NULL DEFAULT 'local',
  `storage_key`       VARCHAR(500)    NOT NULL,
  -- Only set for `external` / CDN-signed hosts where the URL cannot be composed
  -- from disk + key. Leave NULL for local and S3.
  `absolute_url`      VARCHAR(1000)       NULL,

  -- ── file facts ────────────────────────────────────────────────────────────
  `original_filename` VARCHAR(255)    NOT NULL,
  `extension`         VARCHAR(12)     NOT NULL,
  `mime_type`         VARCHAR(120)    NOT NULL,
  `media_type`        ENUM('image','video','audio','document','other')
                                      NOT NULL DEFAULT 'image',
  `size_bytes`        BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `width`             MEDIUMINT UNSIGNED  NULL,
  `height`            MEDIUMINT UNSIGNED  NULL,
  `aspect_ratio`      DECIMAL(8,4)        NULL,
  `duration_ms`       INT UNSIGNED        NULL,   -- video / audio
  `has_alpha`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  -- sha256 of the original bytes. Indexed, not unique: the upload handler looks
  -- it up first and reuses the existing row instead of storing the same pack
  -- shot ten times. Not UNIQUE because a soft-deleted row must not block a
  -- legitimate re-upload.
  `checksum_sha256`   CHAR(64)            NULL,

  -- ── editorial metadata (accessibility + BRD §13 WCAG 2.2 AA) ───────────────
  `alt_text`          VARCHAR(255)        NULL,
  `title`             VARCHAR(255)        NULL,
  `caption`           VARCHAR(500)        NULL,
  `credit`            VARCHAR(255)        NULL,   -- photographer / UGC rights holder
  `usage_rights`      ENUM('owned','licensed','ugc_permissioned','stock','unknown')
                                      NOT NULL DEFAULT 'owned',
  `rights_expires_at` DATE                NULL,   -- licensed stock / UGC consent window

  -- ── art direction ─────────────────────────────────────────────────────────
  -- BRD §10.2: "Photography ratios defined per component so mobile crops are
  -- composed, not accidental." Focal point drives object-position on every
  -- responsive crop, so one master image can be cropped 4:5 on mobile and 16:9
  -- on desktop without decapitating the bottle.
  `focal_x`           DECIMAL(5,4)    NOT NULL DEFAULT 0.5000,
  `focal_y`           DECIMAL(5,4)    NOT NULL DEFAULT 0.5000,
  `dominant_color`    CHAR(7)             NULL,   -- '#E8E0D5'
  `blurhash`          VARCHAR(64)         NULL,   -- LQIP, kills layout shift (CLS)
  `placeholder_uri`   VARCHAR(2000)       NULL,   -- tiny base64 fallback

  -- ── processing state machine ──────────────────────────────────────────────
  `status`            ENUM('uploading','processing','ready','failed','quarantined')
                                      NOT NULL DEFAULT 'processing',
  `processing_error`  VARCHAR(500)        NULL,
  `variants_generated_at` DATETIME        NULL,
  `virus_scanned_at`  DATETIME            NULL,   -- required for customer uploads

  -- ── provenance & housekeeping ─────────────────────────────────────────────
  `source`            ENUM('admin_upload','customer_upload','import','seed','api')
                                      NOT NULL DEFAULT 'admin_upload',
  `uploaded_by_admin_id`    BIGINT UNSIGNED NULL,
  `uploaded_by_customer_id` BIGINT UNSIGNED NULL,   -- FK added in 07_customers.sql
  -- attachment counter, maintained by the app. 0 for > 30 days = safe to purge.
  `usage_count`       INT UNSIGNED    NOT NULL DEFAULT 0,
  `last_used_at`      DATETIME            NULL,

  -- ── migration bookkeeping (local -> S3 later) ─────────────────────────────
  `previous_disk`     VARCHAR(20)         NULL,
  `previous_key`      VARCHAR(500)        NULL,
  `migrated_at`       DATETIME            NULL,

  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`        DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_media_public_id` (`public_id`),
  UNIQUE KEY `uq_media_disk_key` (`disk`, `storage_key`),
  KEY `ix_media_checksum` (`checksum_sha256`),
  KEY `ix_media_folder` (`folder_id`, `created_at`),
  KEY `ix_media_status` (`status`, `created_at`),
  KEY `ix_media_type` (`media_type`, `deleted_at`),
  KEY `ix_media_orphans` (`usage_count`, `created_at`),
  KEY `ix_media_migration` (`disk`, `migrated_at`),
  CONSTRAINT `fk_media_folder`
    FOREIGN KEY (`folder_id`) REFERENCES `media_folders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_media_uploader_admin`
    FOREIGN KEY (`uploaded_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- admin avatars, now that `media` exists
ALTER TABLE `admin_users`
  ADD CONSTRAINT `fk_admin_users_avatar`
    FOREIGN KEY (`avatar_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- media_variants — every derived rendition
-- -----------------------------------------------------------------------------
-- One row per (size x format). A typical product image ends up with:
--   thumb/sm/md/lg/xl  x  webp + avif  = 10 rows, plus the jpeg fallback set.
-- The srcset is built straight out of this table, so the front end never
-- guesses a URL that might not exist yet — if the row is missing, the renderer
-- falls back to `original` instead of shipping a 404 into the page.
--
-- Suggested variant_key widths (mobile-first, BRD §13.1 hero <= 250KB):
--   thumb  160    sm  400    md  800    lg  1200    xl  1800    og  1200x630
-- -----------------------------------------------------------------------------
CREATE TABLE `media_variants` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `media_id`     BIGINT UNSIGNED NOT NULL,
  `variant_key`  VARCHAR(32)     NOT NULL,   -- thumb|sm|md|lg|xl|og|square|original
  `format`       ENUM('webp','avif','jpeg','png','gif','svg','mp4','webm')
                                 NOT NULL,
  `width`        MEDIUMINT UNSIGNED  NULL,
  `height`       MEDIUMINT UNSIGNED  NULL,
  `size_bytes`   BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `quality`      TINYINT UNSIGNED    NULL,
  `disk`         ENUM('local','s3','r2','gcs','supabase','cloudinary','external')
                                 NOT NULL DEFAULT 'local',
  `storage_key`  VARCHAR(500)    NOT NULL,
  `is_default`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_media_variants` (`media_id`, `variant_key`, `format`),
  KEY `ix_media_variants_disk` (`disk`),
  CONSTRAINT `fk_media_variants_media`
    FOREIGN KEY (`media_id`) REFERENCES `media` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- media_attachments — the polymorphic join that replaces per-table image columns
-- -----------------------------------------------------------------------------
-- attachable_type values in use:
--   product, product_variant, ingredient, category, collection, cms_page,
--   cms_section, cms_section_block, cms_article, cms_banner, review,
--   support_ticket, adverse_event, claim_evidence, routine, quiz_option,
--   invoice, shipment_label
--
-- `collection` is the slot within that entity:
--   gallery | pack_front | pack_back | texture | in_hand | application |
--   routine_pairing | hero_desktop | hero_mobile | thumbnail | og | swatch |
--   attachment | ugc
--
-- Because sort_order and is_primary live here, reordering a PDP gallery is one
-- cheap UPDATE and never touches the `media` rows themselves.
-- -----------------------------------------------------------------------------
CREATE TABLE `media_attachments` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `media_id`         BIGINT UNSIGNED NOT NULL,
  `attachable_type`  VARCHAR(60)     NOT NULL,
  `attachable_id`    BIGINT UNSIGNED NOT NULL,
  `collection`       VARCHAR(50)     NOT NULL DEFAULT 'gallery',
  `sort_order`       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_primary`       TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  -- Same file, different context, different alt. Falls back to media.alt_text.
  `alt_override`     VARCHAR(255)        NULL,
  `caption_override` VARCHAR(500)        NULL,
  `link_url`         VARCHAR(500)        NULL,   -- shoppable/UGC tiles
  -- Per-placement crop override when focal point is not enough
  -- {"ratio":"4:5","crop":{"x":0.1,"y":0,"w":0.8,"h":1}}
  `meta`             JSON                NULL,
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_media_attachment` (`attachable_type`, `attachable_id`, `collection`, `media_id`),
  KEY `ix_media_attachments_owner` (`attachable_type`, `attachable_id`, `collection`, `sort_order`),
  KEY `ix_media_attachments_media` (`media_id`),
  CONSTRAINT `fk_media_attachments_media`
    FOREIGN KEY (`media_id`) REFERENCES `media` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- media_tags — findability once the library passes a few hundred assets
-- -----------------------------------------------------------------------------
CREATE TABLE `media_tags` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`       VARCHAR(80)     NOT NULL,
  `name`       VARCHAR(80)     NOT NULL,
  `usage_count` INT UNSIGNED   NOT NULL DEFAULT 0,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_media_tags_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `media_tag_map` (
  `media_id` BIGINT UNSIGNED NOT NULL,
  `tag_id`   BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`media_id`, `tag_id`),
  KEY `ix_media_tag_map_tag` (`tag_id`),
  CONSTRAINT `fk_media_tag_map_media`
    FOREIGN KEY (`media_id`) REFERENCES `media` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_media_tag_map_tag`
    FOREIGN KEY (`tag_id`) REFERENCES `media_tags` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- media_migrations — audit trail for the eventual local -> S3 move
-- One row per batch so a failed run can be resumed rather than restarted.
-- -----------------------------------------------------------------------------
CREATE TABLE `media_migrations` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `from_disk`        VARCHAR(20)     NOT NULL,
  `to_disk`          VARCHAR(20)     NOT NULL,
  `status`           ENUM('pending','running','completed','failed','rolled_back')
                                     NOT NULL DEFAULT 'pending',
  `total_files`      INT UNSIGNED    NOT NULL DEFAULT 0,
  `migrated_files`   INT UNSIGNED    NOT NULL DEFAULT 0,
  `failed_files`     INT UNSIGNED    NOT NULL DEFAULT 0,
  `last_media_id`    BIGINT UNSIGNED     NULL,   -- resume cursor
  `bytes_transferred` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `error_log`        JSON                NULL,
  `started_by_admin_id` BIGINT UNSIGNED  NULL,
  `started_at`       DATETIME            NULL,
  `finished_at`      DATETIME            NULL,
  `created_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_media_migrations_admin`
    FOREIGN KEY (`started_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
