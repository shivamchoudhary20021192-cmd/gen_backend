

-- ############################################################
-- SOURCE FILE: 00_database.sql
-- ############################################################

-- =============================================================================
-- VEYLOG / VEYLOR  —  D2C SKINCARE COMMERCE  —  MySQL 8.0 SCHEMA
-- File 00 : Database creation and global conventions
-- =============================================================================
--
-- Run order:
--   00_database.sql
--   01_admin_rbac.sql
--   02_media.sql
--   03_taxonomy.sql
--   04_catalog.sql
--   05_inventory.sql
--   06_cms.sql
--   07_customers.sql
--   08_cart_orders.sql
--   09_payments_shipping.sql
--   10_marketing.sql
--   11_reviews.sql
--   12_support_ops.sql
--   13_system.sql
--   99_seed_reference.sql
--
-- CONVENTIONS
-- -----------------------------------------------------------------------------
-- Engine        InnoDB, utf8mb4 / utf8mb4_0900_ai_ci (full emoji + Indic support)
-- Primary key   BIGINT UNSIGNED AUTO_INCREMENT named `id`
-- Public id     `public_id CHAR(36)` (UUID) on anything exposed in a URL or API
--               response, so internal sequential ids are never leaked.
-- Money         DECIMAL(10,2) for unit prices, DECIMAL(12,2) for totals. Never
--               FLOAT. Razorpay works in paise: multiply by 100 at the API
--               boundary only, never store paise.
-- Dates         DATETIME (not TIMESTAMP) to avoid the 2038 limit. Application
--               writes UTC; display converts to Asia/Kolkata.
-- created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
-- updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
--                        ON UPDATE CURRENT_TIMESTAMP
-- deleted_at    Present only where soft delete is genuinely required
--               (catalog, media, customers, admin users). Everything else is
--               hard-deleted or status-flagged.
-- Booleans      TINYINT(1) UNSIGNED, 0/1, prefixed `is_` / `has_` / `allow_`.
-- Enums         ENUM for closed sets the code branches on (status machines).
--               Lookup tables for anything an admin must be able to add
--               (skin types, concerns, tags, carriers).
-- JSON          Only for genuinely schemaless payloads: gateway responses,
--               section settings, webhook bodies, audit diffs. Never for data
--               you need to filter or join on.
-- IP addresses  VARBINARY(16) via INET6_ATON() — holds IPv4 and IPv6.
-- Secrets       Only *_hash columns are stored (SHA-256 hex, CHAR(64)) for
--               tokens/OTP. Passwords use bcrypt/argon2 in `password_hash`.
--
-- FOREIGN KEY POLICY
-- -----------------------------------------------------------------------------
--   CASCADE   child rows meaningless without the parent (cart_items, variants,
--             page sections, order_items)
--   SET NULL  historical rows that must survive the parent (orders keep their
--             snapshot when a customer or product is deleted)
--   RESTRICT  reference data that must not vanish under live rows
--             (tax classes, carriers, roles)
--
-- Polymorphic relations (media_attachments, metafields, seo_meta, audit_logs)
-- deliberately carry no FK — MySQL cannot express them. Integrity for those is
-- enforced in the application layer and by the nightly orphan-sweep job.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS `veylog`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE `veylog`;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;
SET SESSION sql_require_primary_key = 1;
SET SESSION time_zone = '+00:00';


-- ############################################################
-- SOURCE FILE: 01_admin_rbac.sql
-- ############################################################

-- =============================================================================
-- File 01 : ADMIN PANEL — staff accounts, roles, permissions, sessions, audit
-- =============================================================================
-- Staff and customers are deliberately separate tables.
--   * Staff  : email + password + MFA, this file.
--   * Customer: phone + OTP, file 07.
-- They have different lifecycles, different threat models and different
-- deletion rules (DPDP erasure applies to customers, not to staff records that
-- back an audit trail). One `users` table for both would force every query to
-- filter on a type column and would let a customer row ever become an admin.
-- =============================================================================

USE `veylog`;

-- -----------------------------------------------------------------------------
-- roles — Founder/Admin, Content, Operations, Support, Growth, Developer
-- (BRD §17 "Admin and Operations"). Seeded in 99_seed_reference.sql.
-- -----------------------------------------------------------------------------
CREATE TABLE `roles` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`          VARCHAR(50)     NOT NULL,
  `name`          VARCHAR(80)     NOT NULL,
  `description`   VARCHAR(255)        NULL,
  -- system roles cannot be renamed or deleted from the UI
  `is_system`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  -- lower number = more powerful; used to stop a role escalating above itself
  `level`         SMALLINT UNSIGNED   NOT NULL DEFAULT 100,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_roles_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- permissions — one row per capability, slug is `module.action`
-- e.g. orders.refund, products.publish, cms.publish, customers.export
-- -----------------------------------------------------------------------------
CREATE TABLE `permissions` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`          VARCHAR(80)     NOT NULL,
  `module`        VARCHAR(50)     NOT NULL,
  `action`        VARCHAR(50)     NOT NULL,
  `name`          VARCHAR(120)    NOT NULL,
  `description`   VARCHAR(255)        NULL,
  -- money movement, PII export, role changes: always re-authenticate + audit
  `is_dangerous`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `sort_order`    SMALLINT UNSIGNED   NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_permissions_slug` (`slug`),
  KEY `ix_permissions_module` (`module`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `role_permissions` (
  `role_id`       BIGINT UNSIGNED NOT NULL,
  `permission_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`role_id`, `permission_id`),
  KEY `ix_role_permissions_permission` (`permission_id`),
  CONSTRAINT `fk_role_permissions_role`
    FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_role_permissions_permission`
    FOREIGN KEY (`permission_id`) REFERENCES `permissions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- admin_users — staff accounts
-- -----------------------------------------------------------------------------
CREATE TABLE `admin_users` (
  `id`                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`              CHAR(36)        NOT NULL DEFAULT (UUID()),
  `email`                  VARCHAR(191)    NOT NULL,
  `password_hash`          VARCHAR(255)        NULL,   -- NULL until invite accepted
  `first_name`             VARCHAR(80)     NOT NULL,
  `last_name`              VARCHAR(80)         NULL,
  `phone`                  VARCHAR(20)         NULL,
  `avatar_media_id`        BIGINT UNSIGNED     NULL,   -- FK added in 02_media.sql
  `job_title`              VARCHAR(120)        NULL,
  `status`                 ENUM('invited','active','suspended','disabled')
                                           NOT NULL DEFAULT 'invited',
  -- super admin bypasses the permission table entirely; keep the count tiny
  `is_super_admin`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  -- MFA is mandatory for Founder/Admin per BRD §17
  `mfa_enabled`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `mfa_secret`             VARCHAR(255)        NULL,   -- encrypted at rest
  `mfa_recovery_codes`     JSON                NULL,   -- array of hashes
  `mfa_enforced_at`        DATETIME            NULL,

  -- brute-force protection
  `failed_login_attempts`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `locked_until`           DATETIME            NULL,
  `last_login_at`          DATETIME            NULL,
  `last_login_ip`          VARBINARY(16)       NULL,
  `password_changed_at`    DATETIME            NULL,
  `must_change_password`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  `timezone`               VARCHAR(64)     NOT NULL DEFAULT 'Asia/Kolkata',
  `locale`                 VARCHAR(10)     NOT NULL DEFAULT 'en-IN',
  `created_by_admin_id`    BIGINT UNSIGNED     NULL,
  `created_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`             DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_users_email` (`email`),
  UNIQUE KEY `uq_admin_users_public_id` (`public_id`),
  KEY `ix_admin_users_status` (`status`),
  CONSTRAINT `fk_admin_users_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `admin_user_roles` (
  `admin_user_id` BIGINT UNSIGNED NOT NULL,
  `role_id`       BIGINT UNSIGNED NOT NULL,
  `assigned_by_admin_id` BIGINT UNSIGNED NULL,
  `assigned_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`admin_user_id`, `role_id`),
  KEY `ix_admin_user_roles_role` (`role_id`),
  CONSTRAINT `fk_admin_user_roles_user`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_admin_user_roles_role`
    FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_admin_user_roles_assigner`
    FOREIGN KEY (`assigned_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Per-user override on top of role grants. `deny` always wins over any role
-- allow — this is how you take refund rights off one Support agent without
-- inventing a new role.
CREATE TABLE `admin_user_permissions` (
  `admin_user_id` BIGINT UNSIGNED NOT NULL,
  `permission_id` BIGINT UNSIGNED NOT NULL,
  `effect`        ENUM('allow','deny') NOT NULL DEFAULT 'allow',
  `expires_at`    DATETIME            NULL,   -- time-boxed developer access
  `granted_by_admin_id` BIGINT UNSIGNED NULL,
  `granted_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`admin_user_id`, `permission_id`),
  KEY `ix_admin_user_permissions_permission` (`permission_id`),
  CONSTRAINT `fk_admin_user_permissions_user`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_admin_user_permissions_permission`
    FOREIGN KEY (`permission_id`) REFERENCES `permissions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_admin_user_permissions_granter`
    FOREIGN KEY (`granted_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- admin_sessions — server-side session records so a stolen JWT can be killed
-- -----------------------------------------------------------------------------
CREATE TABLE `admin_sessions` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `admin_user_id`       BIGINT UNSIGNED NOT NULL,
  `session_token_hash`  CHAR(64)        NOT NULL,   -- sha256 of the token
  `refresh_token_hash`  CHAR(64)            NULL,
  `ip`                  VARBINARY(16)       NULL,
  `user_agent`          VARCHAR(255)        NULL,
  `mfa_satisfied_at`    DATETIME            NULL,
  `last_active_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at`          DATETIME        NOT NULL,
  `revoked_at`          DATETIME            NULL,
  `revoked_reason`      VARCHAR(120)        NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_sessions_token` (`session_token_hash`),
  KEY `ix_admin_sessions_user` (`admin_user_id`, `revoked_at`),
  KEY `ix_admin_sessions_expiry` (`expires_at`),
  CONSTRAINT `fk_admin_sessions_user`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `admin_password_resets` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `admin_user_id` BIGINT UNSIGNED NOT NULL,
  `token_hash`    CHAR(64)        NOT NULL,
  `ip`            VARBINARY(16)       NULL,
  `expires_at`    DATETIME        NOT NULL,
  `used_at`       DATETIME            NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_password_resets_token` (`token_hash`),
  KEY `ix_admin_password_resets_user` (`admin_user_id`),
  CONSTRAINT `fk_admin_password_resets_user`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `admin_invites` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`         VARCHAR(191)    NOT NULL,
  `role_id`       BIGINT UNSIGNED NOT NULL,
  `token_hash`    CHAR(64)        NOT NULL,
  `invited_by_admin_id` BIGINT UNSIGNED NULL,
  `expires_at`    DATETIME        NOT NULL,
  `accepted_at`   DATETIME            NULL,
  `revoked_at`    DATETIME            NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_invites_token` (`token_hash`),
  KEY `ix_admin_invites_email` (`email`),
  CONSTRAINT `fk_admin_invites_role`
    FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_admin_invites_inviter`
    FOREIGN KEY (`invited_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- audit_logs — BRD §17: "All material price, refund, role and content changes
-- are auditable." Deliberately polymorphic and append-only: no UPDATE, no
-- DELETE, no FK to the entity (the entity may later be deleted; the log must
-- outlive it).
-- Partition or archive to cold storage by `created_at` once past ~12 months.
-- -----------------------------------------------------------------------------
CREATE TABLE `audit_logs` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `actor_type`   ENUM('admin','customer','system','webhook','job') NOT NULL DEFAULT 'admin',
  `actor_id`     BIGINT UNSIGNED     NULL,
  `actor_label`  VARCHAR(191)        NULL,   -- denormalised: survives deletion
  `action`       VARCHAR(80)     NOT NULL,   -- product.price_changed, order.refunded
  `entity_type`  VARCHAR(60)         NULL,   -- 'product', 'order', 'cms_page'
  `entity_id`    BIGINT UNSIGNED     NULL,
  `summary`      VARCHAR(255)        NULL,   -- human line for the activity feed
  `changes`      JSON                NULL,   -- {"field":{"from":x,"to":y}}
  `context`      JSON                NULL,   -- request id, route, reason given
  `ip`           VARBINARY(16)       NULL,
  `user_agent`   VARCHAR(255)        NULL,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_audit_logs_entity` (`entity_type`, `entity_id`, `created_at`),
  KEY `ix_audit_logs_actor` (`actor_type`, `actor_id`, `created_at`),
  KEY `ix_audit_logs_action` (`action`, `created_at`),
  KEY `ix_audit_logs_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- In-panel alerts: low stock, failed payment, new adverse-event report,
-- webhook dead-letter. admin_user_id NULL = broadcast to everyone with the
-- matching permission.
CREATE TABLE `admin_notifications` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `admin_user_id` BIGINT UNSIGNED     NULL,
  `type`          VARCHAR(60)     NOT NULL,
  `severity`      ENUM('info','success','warning','critical') NOT NULL DEFAULT 'info',
  `title`         VARCHAR(191)    NOT NULL,
  `body`          VARCHAR(500)        NULL,
  `link_url`      VARCHAR(500)        NULL,
  `entity_type`   VARCHAR(60)         NULL,
  `entity_id`     BIGINT UNSIGNED     NULL,
  `read_at`       DATETIME            NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_admin_notifications_inbox` (`admin_user_id`, `read_at`, `created_at`),
  KEY `ix_admin_notifications_type` (`type`, `created_at`),
  CONSTRAINT `fk_admin_notifications_user`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ############################################################
-- SOURCE FILE: 02_media.sql
-- ############################################################

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


-- ############################################################
-- SOURCE FILE: 03_taxonomy.sql
-- ############################################################

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


-- ############################################################
-- SOURCE FILE: 04_catalog.sql
-- ############################################################

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


-- ############################################################
-- SOURCE FILE: 05_inventory.sql
-- ############################################################

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

USE `veylog`;

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


-- ############################################################
-- SOURCE FILE: 06_cms.sql
-- ############################################################

-- =============================================================================
-- File 06 : CONTENT MANAGEMENT SYSTEM  (Shopify-equivalent)
-- =============================================================================
-- Mapping to the Shopify concepts you asked for:
--
--   Shopify                         here
--   ------------------------------  ------------------------------------------
--   Pages                           cms_pages
--   Theme sections & blocks         cms_page_sections + cms_section_blocks
--   Blogs / Articles                cms_blogs + cms_articles
--   Navigation menus                cms_menus + cms_menu_items
--   Metafields / Metaobjects        metafield_definitions + metafields
--   Metaobject entries              cms_entries + cms_entry_values
--   URL redirects                   cms_redirects
--   SEO fields on every resource    seo_meta (polymorphic)
--   Files                           media (file 02)
--   Theme settings                  settings (file 13)
--
-- The section/block model is the important one. A homepage is not a blob of
-- HTML — it is an ordered list of typed sections, each with JSON settings and
-- its own ordered blocks. That is what lets the content team reorder the
-- homepage modules in BRD §7.2 (hero → trust strip → routine → ingredient
-- story → texture → evidence → reviews → education → founder note → opt-in)
-- without a deploy, and lets a developer add a new section type by shipping one
-- React component plus a settings schema.
--
-- Every content entity here supports: draft → in_review → scheduled →
-- published → archived, plus versioned snapshots for rollback. BRD §18 makes
-- "preview, SEO fields, scheduled publish, author/reviewer and
-- rollback/version" a definition of done.
-- =============================================================================

USE `veylog`;

-- -----------------------------------------------------------------------------
-- cms_pages
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_pages` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`           CHAR(36)        NOT NULL DEFAULT (UUID()),
  `parent_id`           BIGINT UNSIGNED     NULL,
  `slug`                VARCHAR(191)    NOT NULL,
  `full_path`           VARCHAR(500)    NOT NULL,   -- '/policies/shipping'
  `title`               VARCHAR(191)    NOT NULL,
  `subtitle`            VARCHAR(255)        NULL,
  `page_type`           ENUM('home','standard','landing','policy','about',
                             'support','concern','ingredient_library','custom')
                                        NOT NULL DEFAULT 'standard',
  `template`            VARCHAR(60)     NOT NULL DEFAULT 'default',
  `locale`              VARCHAR(10)     NOT NULL DEFAULT 'en-IN',

  -- Pages are either section-composed (page_type home/landing) or a single
  -- rich-text body (policies, about). Both are supported; use one or the other.
  `body_html`           LONGTEXT            NULL,
  `body_json`           JSON                NULL,
  `hero_media_id`       BIGINT UNSIGNED     NULL,

  `status`              ENUM('draft','in_review','scheduled','published','archived')
                                        NOT NULL DEFAULT 'draft',
  `published_at`        DATETIME            NULL,
  `scheduled_at`        DATETIME            NULL,
  `unpublish_at`        DATETIME            NULL,

  -- BRD §17: "Staging/preview and approval workflow exist for claims-sensitive
  -- pages." A page flagged here cannot move to `published` without a reviewer.
  `requires_legal_review` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `reviewed_by_admin_id` BIGINT UNSIGNED    NULL,
  `reviewed_at`         DATETIME            NULL,
  `review_due_at`       DATE                NULL,

  `is_indexable`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `show_in_sitemap`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `preview_token`       CHAR(36)            NULL,   -- share an unpublished draft
  `current_version`     INT UNSIGNED    NOT NULL DEFAULT 1,
  `view_count`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `author_admin_id`     BIGINT UNSIGNED     NULL,
  `updated_by_admin_id` BIGINT UNSIGNED     NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_pages_slug_locale` (`slug`, `locale`),
  UNIQUE KEY `uq_cms_pages_public_id` (`public_id`),
  KEY `ix_cms_pages_status` (`status`, `published_at`),
  KEY `ix_cms_pages_type` (`page_type`),
  KEY `ix_cms_pages_parent` (`parent_id`),
  KEY `ix_cms_pages_scheduled` (`status`, `scheduled_at`),
  CONSTRAINT `fk_cms_pages_parent`
    FOREIGN KEY (`parent_id`) REFERENCES `cms_pages` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_pages_hero`
    FOREIGN KEY (`hero_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_pages_author`
    FOREIGN KEY (`author_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_pages_reviewer`
    FOREIGN KEY (`reviewed_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_pages_updater`
    FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- cms_page_sections — the ordered modules on a page
-- -----------------------------------------------------------------------------
-- section_key is the React component name the renderer resolves. Launch set,
-- straight from BRD §7.2 / §10.3:
--   announcement_bar, hero, trust_strip, two_product_routine,
--   ingredient_story, texture_proof, evidence_results, reviews_ugc,
--   education_articles, founder_note, optin, faq, rich_text, image_with_text,
--   product_grid, collection_banner, comparison_table, support_panel
--
-- `settings` holds whatever that component needs (headline, CTA label, layout
-- variant, background token). It is JSON because the shape differs per section
-- type and is validated by a per-type schema in application code — this is the
-- exact same trade-off Shopify makes with section settings.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_page_sections` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `page_id`        BIGINT UNSIGNED NOT NULL,
  `section_key`    VARCHAR(60)     NOT NULL,
  `name`           VARCHAR(120)        NULL,   -- admin-facing label
  `sort_order`     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_enabled`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `settings`       JSON                NULL,
  `background`     VARCHAR(40)         NULL,   -- design token: ivory|sand|ink|white
  `padding_top`    ENUM('none','sm','md','lg','xl') NOT NULL DEFAULT 'md',
  `padding_bottom` ENUM('none','sm','md','lg','xl') NOT NULL DEFAULT 'md',
  -- optional scheduling of a single module (campaign strip, launch banner)
  `visible_from`   DATETIME            NULL,
  `visible_until`  DATETIME            NULL,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_cms_page_sections_page` (`page_id`, `sort_order`),
  KEY `ix_cms_page_sections_key` (`section_key`),
  CONSTRAINT `fk_cms_page_sections_page`
    FOREIGN KEY (`page_id`) REFERENCES `cms_pages` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Repeatable children within a section: the three ingredient cards, the four
-- trust claims, the five slides in a carousel.
CREATE TABLE `cms_section_blocks` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `section_id`  BIGINT UNSIGNED NOT NULL,
  `block_type`  VARCHAR(60)     NOT NULL,   -- claim_tile|ingredient_card|slide|step|faq_item
  `sort_order`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_enabled`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `heading`     VARCHAR(255)        NULL,
  `body`        TEXT                NULL,
  `media_id`    BIGINT UNSIGNED     NULL,
  `link_type`   ENUM('none','url','page','product','collection','category','article')
                                NOT NULL DEFAULT 'none',
  `link_ref_id` BIGINT UNSIGNED     NULL,
  `link_url`    VARCHAR(500)        NULL,
  `cta_label`   VARCHAR(60)         NULL,
  -- Every efficacy line rendered on the site should point at an approved claim.
  `claim_id`    BIGINT UNSIGNED     NULL,
  `settings`    JSON                NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_cms_section_blocks_section` (`section_id`, `sort_order`),
  CONSTRAINT `fk_cms_section_blocks_section`
    FOREIGN KEY (`section_id`) REFERENCES `cms_page_sections` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_section_blocks_media`
    FOREIGN KEY (`media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_section_blocks_claim`
    FOREIGN KEY (`claim_id`) REFERENCES `claims` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- cms_revisions — rollback for any content entity
-- Snapshot is the fully composed JSON of the entity plus its children, so a
-- restore is a single deterministic write and does not depend on the current
-- schema of the live tables.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_revisions` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entity_type`     ENUM('page','article','product','banner','menu','entry','ingredient')
                                    NOT NULL,
  `entity_id`       BIGINT UNSIGNED NOT NULL,
  `version`         INT UNSIGNED    NOT NULL,
  `snapshot`        JSON            NOT NULL,
  `change_note`     VARCHAR(255)        NULL,
  `is_published_version` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_revisions` (`entity_type`, `entity_id`, `version`),
  KEY `ix_cms_revisions_entity` (`entity_type`, `entity_id`, `created_at`),
  CONSTRAINT `fk_cms_revisions_admin`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Blogs and articles (the Journal)
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_blogs` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`        VARCHAR(140)    NOT NULL,   -- 'journal'
  `title`       VARCHAR(160)    NOT NULL,
  `description` VARCHAR(500)        NULL,
  `is_active`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_blogs_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cms_article_categories` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`       VARCHAR(140)    NOT NULL,
  `name`       VARCHAR(120)    NOT NULL,
  `description` VARCHAR(500)       NULL,
  `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_active`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_article_categories_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cms_articles` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`           CHAR(36)        NOT NULL DEFAULT (UUID()),
  `blog_id`             BIGINT UNSIGNED NOT NULL,
  `category_id`         BIGINT UNSIGNED     NULL,
  `slug`                VARCHAR(191)    NOT NULL,
  `title`               VARCHAR(191)    NOT NULL,
  `subtitle`            VARCHAR(255)        NULL,
  `excerpt`             VARCHAR(500)        NULL,
  `body_html`           LONGTEXT            NULL,
  `body_json`           JSON                NULL,
  `cover_media_id`      BIGINT UNSIGNED     NULL,
  `locale`              VARCHAR(10)     NOT NULL DEFAULT 'en-IN',

  -- Byline is free text: a guest dermatologist is not an admin_user.
  `author_name`         VARCHAR(120)        NULL,
  `author_title`        VARCHAR(160)        NULL,
  `author_media_id`     BIGINT UNSIGNED     NULL,
  `author_admin_id`     BIGINT UNSIGNED     NULL,
  -- BRD §16 SEO + §9 claims: medical-adjacent education needs a named reviewer
  -- and a visible review date.
  `medically_reviewed_by` VARCHAR(160)      NULL,
  `reviewed_at`         DATE                NULL,
  `next_review_due`     DATE                NULL,

  `read_time_minutes`   TINYINT UNSIGNED    NULL,
  `status`              ENUM('draft','in_review','scheduled','published','archived')
                                        NOT NULL DEFAULT 'draft',
  `is_featured`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `published_at`        DATETIME            NULL,
  `scheduled_at`        DATETIME            NULL,
  `is_indexable`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `view_count`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `current_version`     INT UNSIGNED    NOT NULL DEFAULT 1,
  `preview_token`       CHAR(36)            NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_articles_slug_locale` (`slug`, `locale`),
  UNIQUE KEY `uq_cms_articles_public_id` (`public_id`),
  KEY `ix_cms_articles_blog` (`blog_id`, `status`, `published_at`),
  KEY `ix_cms_articles_featured` (`is_featured`, `published_at`),
  KEY `ix_cms_articles_category` (`category_id`),
  FULLTEXT KEY `ft_cms_articles_search` (`title`, `excerpt`, `body_html`),
  CONSTRAINT `fk_cms_articles_blog`
    FOREIGN KEY (`blog_id`) REFERENCES `cms_blogs` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_articles_category`
    FOREIGN KEY (`category_id`) REFERENCES `cms_article_categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_articles_cover`
    FOREIGN KEY (`cover_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_articles_author_media`
    FOREIGN KEY (`author_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_articles_author_admin`
    FOREIGN KEY (`author_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Articles → products ("shop this routine" inside an editorial piece)
CREATE TABLE `cms_article_products` (
  `article_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`article_id`, `product_id`),
  KEY `ix_cms_article_products_product` (`product_id`),
  CONSTRAINT `fk_cms_article_products_article`
    FOREIGN KEY (`article_id`) REFERENCES `cms_articles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_article_products_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Navigation menus — header, footer, mobile drawer, support
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_menus` (
  `id`        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`      VARCHAR(60)     NOT NULL,   -- main|footer_shop|footer_support|mobile_drawer
  `name`      VARCHAR(120)    NOT NULL,
  `is_active` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_menus_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- link_type + link_ref_id instead of a hardcoded URL, so renaming a product
-- slug never leaves a dead nav item. `url` is used only for link_type='url'.
CREATE TABLE `cms_menu_items` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `menu_id`       BIGINT UNSIGNED NOT NULL,
  `parent_id`     BIGINT UNSIGNED     NULL,
  `label`         VARCHAR(120)    NOT NULL,
  `link_type`     ENUM('url','page','category','collection','product','article',
                       'policy','ingredient','routine','none')
                                  NOT NULL DEFAULT 'url',
  `link_ref_id`   BIGINT UNSIGNED     NULL,
  `url`           VARCHAR(500)        NULL,
  `icon_media_id` BIGINT UNSIGNED     NULL,
  `image_media_id` BIGINT UNSIGNED    NULL,   -- mega-menu promo tile
  `badge_label`   VARCHAR(30)         NULL,   -- 'New'
  `description`   VARCHAR(255)        NULL,
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `opens_new_tab` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_active`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `ix_cms_menu_items_menu` (`menu_id`, `parent_id`, `sort_order`),
  CONSTRAINT `fk_cms_menu_items_menu`
    FOREIGN KEY (`menu_id`) REFERENCES `cms_menus` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_menu_items_parent`
    FOREIGN KEY (`parent_id`) REFERENCES `cms_menu_items` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_menu_items_icon`
    FOREIGN KEY (`icon_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_menu_items_image`
    FOREIGN KEY (`image_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- cms_banners — announcement bar, hero carousel, promo strips
-- BRD §7.1 warns against rotating three offers, so `priority` + date windows
-- exist to make exactly one win at a time rather than to build a carousel.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_banners` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`              VARCHAR(120)    NOT NULL,   -- internal
  `placement`         ENUM('announcement_bar','home_hero','home_carousel',
                           'category_top','pdp_strip','cart_drawer','checkout',
                           'popup','footer')
                                      NOT NULL,
  `title`             VARCHAR(191)        NULL,
  `subtitle`          VARCHAR(255)        NULL,
  `body`              VARCHAR(500)        NULL,
  `cta_label`         VARCHAR(60)         NULL,
  `cta_link_type`     ENUM('url','page','category','collection','product','article','none')
                                      NOT NULL DEFAULT 'none',
  `cta_link_ref_id`   BIGINT UNSIGNED     NULL,
  `cta_url`           VARCHAR(500)        NULL,
  `desktop_media_id`  BIGINT UNSIGNED     NULL,
  `mobile_media_id`   BIGINT UNSIGNED     NULL,   -- art-directed mobile crop
  `background_hex`    CHAR(7)             NULL,
  `text_hex`          CHAR(7)             NULL,
  `audience`          ENUM('all','new_visitors','returning','logged_in','guests')
                                      NOT NULL DEFAULT 'all',
  `starts_at`         DATETIME            NULL,
  `ends_at`           DATETIME            NULL,
  `priority`          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_active`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `is_dismissible`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `impression_count`  INT UNSIGNED    NOT NULL DEFAULT 0,
  `click_count`       INT UNSIGNED    NOT NULL DEFAULT 0,
  `created_by_admin_id` BIGINT UNSIGNED   NULL,
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_cms_banners_slot` (`placement`, `is_active`, `priority`),
  KEY `ix_cms_banners_window` (`starts_at`, `ends_at`),
  CONSTRAINT `fk_cms_banners_desktop_media`
    FOREIGN KEY (`desktop_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_banners_mobile_media`
    FOREIGN KEY (`mobile_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_banners_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- FAQs — global groups, or attached to any entity (product, policy, shipping)
-- BRD §7.3 requires product FAQs to be server-rendered and indexable.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_faq_groups` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`       VARCHAR(140)    NOT NULL,
  `name`       VARCHAR(160)    NOT NULL,
  `description` VARCHAR(500)       NULL,
  `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_active`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_faq_groups_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cms_faqs` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `group_id`     BIGINT UNSIGNED     NULL,
  `entity_type`  VARCHAR(40)         NULL,   -- 'product','cms_page', NULL = global
  `entity_id`    BIGINT UNSIGNED     NULL,
  `question`     VARCHAR(500)    NOT NULL,
  `answer`       TEXT            NOT NULL,
  `claim_id`     BIGINT UNSIGNED     NULL,
  `sort_order`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_published` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `is_indexable` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,   -- FAQPage schema
  `helpful_count` INT UNSIGNED   NOT NULL DEFAULT 0,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_cms_faqs_group` (`group_id`, `sort_order`),
  KEY `ix_cms_faqs_entity` (`entity_type`, `entity_id`, `sort_order`),
  CONSTRAINT `fk_cms_faqs_group`
    FOREIGN KEY (`group_id`) REFERENCES `cms_faq_groups` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_faqs_claim`
    FOREIGN KEY (`claim_id`) REFERENCES `claims` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- cms_redirects — BRD §16 "Redirect map protects URLs during renaming"
-- The app should also auto-insert a row whenever a product/page slug changes.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_redirects` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `from_path`    VARCHAR(500)    NOT NULL,
  `to_path`      VARCHAR(500)    NOT NULL,
  `status_code`  SMALLINT UNSIGNED NOT NULL DEFAULT 301,
  `is_active`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `is_auto`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,   -- created by slug change
  `hit_count`    INT UNSIGNED    NOT NULL DEFAULT 0,
  `last_hit_at`  DATETIME            NULL,
  `note`         VARCHAR(255)        NULL,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_redirects_from` (`from_path`),
  KEY `ix_cms_redirects_active` (`is_active`),
  CONSTRAINT `fk_cms_redirects_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- seo_meta — one polymorphic table instead of six sets of near-identical
-- columns on products, collections, categories, pages, articles, ingredients.
-- BRD §16: "Unique title, meta description, H1 and canonical for every
-- indexable route."
-- -----------------------------------------------------------------------------
CREATE TABLE `seo_meta` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entity_type`      VARCHAR(40)     NOT NULL,   -- product|collection|category|cms_page|cms_article|ingredient|routine
  `entity_id`        BIGINT UNSIGNED NOT NULL,
  `locale`           VARCHAR(10)     NOT NULL DEFAULT 'en-IN',
  `meta_title`       VARCHAR(200)        NULL,
  `meta_description` VARCHAR(320)        NULL,
  `h1_override`      VARCHAR(191)        NULL,
  `canonical_url`    VARCHAR(500)        NULL,
  `og_title`         VARCHAR(200)        NULL,
  `og_description`   VARCHAR(320)        NULL,
  `og_media_id`      BIGINT UNSIGNED     NULL,
  `twitter_card`     ENUM('summary','summary_large_image') NOT NULL DEFAULT 'summary_large_image',
  `robots_index`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `robots_follow`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  -- Extra or overriding JSON-LD. Product/Article/Breadcrumb schema is generated
  -- from live data; this is for anything the generator cannot know.
  `structured_data`  JSON                NULL,
  `sitemap_priority` DECIMAL(2,1)        NULL,
  `sitemap_changefreq` ENUM('always','hourly','daily','weekly','monthly','yearly','never') NULL,
  `updated_by_admin_id` BIGINT UNSIGNED  NULL,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_seo_meta` (`entity_type`, `entity_id`, `locale`),
  CONSTRAINT `fk_seo_meta_og_media`
    FOREIGN KEY (`og_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_seo_meta_updater`
    FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Metafields — Shopify's escape hatch, and the reason this CMS will not need a
-- migration every time marketing invents a new field.
--
-- Define once in metafield_definitions ("product / veylor / clinical_study_pdf,
-- type media"), then store values per entity in metafields. The typed value
-- columns (rather than one JSON blob) mean you can still filter and sort:
-- "all products where veylor.spf_rating >= 50" is an indexed query.
-- -----------------------------------------------------------------------------
CREATE TABLE `metafield_definitions` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `owner_type`  VARCHAR(40)     NOT NULL,   -- product|variant|collection|cms_page|customer|order
  `namespace`   VARCHAR(50)     NOT NULL DEFAULT 'veylor',
  `meta_key`    VARCHAR(60)     NOT NULL,
  `name`        VARCHAR(120)    NOT NULL,
  `description` VARCHAR(500)        NULL,
  `value_type`  ENUM('single_line_text','multi_line_text','rich_text','integer',
                     'decimal','boolean','date','datetime','json','url','color',
                     'media','media_list','product_ref','collection_ref','entry_ref')
                                NOT NULL DEFAULT 'single_line_text',
  `validations` JSON                NULL,   -- {"min":0,"max":100,"choices":[...]}
  `is_required` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_public`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,   -- exposed to storefront API
  `is_filterable` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `sort_order`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_metafield_definitions` (`owner_type`, `namespace`, `meta_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `metafields` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `definition_id`  BIGINT UNSIGNED     NULL,
  `owner_type`     VARCHAR(40)     NOT NULL,
  `owner_id`       BIGINT UNSIGNED NOT NULL,
  `namespace`      VARCHAR(50)     NOT NULL DEFAULT 'veylor',
  `meta_key`       VARCHAR(60)     NOT NULL,
  `locale`         VARCHAR(10)     NOT NULL DEFAULT 'en-IN',
  `value_text`     LONGTEXT            NULL,
  `value_number`   DECIMAL(20,6)       NULL,
  `value_boolean`  TINYINT(1) UNSIGNED NULL,
  `value_datetime` DATETIME            NULL,
  `value_json`     JSON                NULL,
  `value_media_id` BIGINT UNSIGNED     NULL,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_metafields` (`owner_type`, `owner_id`, `namespace`, `meta_key`, `locale`),
  KEY `ix_metafields_owner` (`owner_type`, `owner_id`),
  KEY `ix_metafields_key_number` (`namespace`, `meta_key`, `value_number`),
  CONSTRAINT `fk_metafields_definition`
    FOREIGN KEY (`definition_id`) REFERENCES `metafield_definitions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_metafields_media`
    FOREIGN KEY (`value_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Custom content types (Shopify "metaobjects").
-- Lets the team model something new — press mentions, store locators, founder
-- timeline entries, lab partners — as first-class, listable, referenceable
-- content without any schema change.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_entry_types` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`           VARCHAR(60)     NOT NULL,   -- 'press_mention'
  `name`           VARCHAR(120)    NOT NULL,
  `description`    VARCHAR(500)        NULL,
  `has_own_page`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `url_prefix`     VARCHAR(100)        NULL,   -- '/press'
  `field_schema`   JSON            NOT NULL,   -- ordered field definitions
  `is_active`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_entry_types_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cms_entries` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entry_type_id` BIGINT UNSIGNED NOT NULL,
  `slug`          VARCHAR(191)    NOT NULL,
  `title`         VARCHAR(191)    NOT NULL,
  `data`          JSON            NOT NULL,   -- validated against field_schema
  `status`        ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `published_at`  DATETIME            NULL,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`    DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_entries_slug` (`entry_type_id`, `slug`),
  KEY `ix_cms_entries_status` (`entry_type_id`, `status`, `sort_order`),
  CONSTRAINT `fk_cms_entries_type`
    FOREIGN KEY (`entry_type_id`) REFERENCES `cms_entry_types` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_entries_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ############################################################
-- SOURCE FILE: 07_customers.sql
-- ############################################################

-- =============================================================================
-- File 07 : CUSTOMERS — phone identity, OTP, sessions, consent, addresses
-- =============================================================================
-- Identity is the phone number, not the email. `(country_code, phone)` is the
-- unique key; email is an optional profile field used for invoices and
-- transactional mail. That matches the "mobile + OTP only" flow and means a
-- customer who never gives an email is still a complete, orderable record.
--
-- Nothing here stores a password. The only secret material is:
--   otp_requests.otp_hash            sha256 of the 6-digit code
--   customer_sessions.refresh_token_hash
--
-- Guest browsing works with no row in this table at all — the cart is keyed by
-- a token (file 08) and only linked to a customer at the checkout login step.
-- =============================================================================

USE `veylog`;

CREATE TABLE `customers` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`           CHAR(36)        NOT NULL DEFAULT (UUID()),
  `country_code`        VARCHAR(5)      NOT NULL DEFAULT '+91',
  `phone`               VARCHAR(15)     NOT NULL,      -- digits only, no spaces
  `email`               VARCHAR(191)        NULL,      -- optional throughout
  `first_name`          VARCHAR(80)         NULL,      -- captured after first OTP
  `last_name`           VARCHAR(80)         NULL,
  `gender`              ENUM('female','male','other','undisclosed') NOT NULL DEFAULT 'undisclosed',
  `date_of_birth`       DATE                NULL,
  `avatar_media_id`     BIGINT UNSIGNED     NULL,

  `status`              ENUM('active','blocked','deleted') NOT NULL DEFAULT 'active',
  `phone_verified_at`   DATETIME            NULL,
  `email_verified_at`   DATETIME            NULL,
  `profile_completed_at` DATETIME           NULL,      -- name captured

  -- Fast-read cache of the latest consent state. `customer_consents` remains
  -- the legal record of who consented to what, when, under which notice version.
  `accepts_email_marketing`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `accepts_sms_marketing`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `accepts_whatsapp_marketing` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  -- skin profile, from the quiz or the profile page
  `skin_type_id`        BIGINT UNSIGNED     NULL,
  `primary_concern_id`  BIGINT UNSIGNED     NULL,

  -- CRM aggregates, recalculated on order events
  `orders_count`        INT UNSIGNED    NOT NULL DEFAULT 0,
  `total_spent`         DECIMAL(12,2)   NOT NULL DEFAULT 0.00,
  `average_order_value` DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `first_order_at`      DATETIME            NULL,
  `last_order_at`       DATETIME            NULL,
  `last_seen_at`        DATETIME            NULL,
  -- COD risk: high RTO customers get prepaid-only checkout
  `rto_count`           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `cod_blocked`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  `signup_source`       ENUM('web','mobile_web','whatsapp','import','admin','app')
                                        NOT NULL DEFAULT 'web',
  `signup_utm`          JSON                NULL,
  `referred_by_customer_id` BIGINT UNSIGNED NULL,
  `preferred_language`  VARCHAR(10)     NOT NULL DEFAULT 'en-IN',

  -- DPDP erasure: `deleted_at` plus a scheduled hard-anonymise pass that
  -- scrubs name/email/phone while leaving order rows intact for tax law.
  `anonymised_at`       DATETIME            NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customers_phone` (`country_code`, `phone`),
  UNIQUE KEY `uq_customers_public_id` (`public_id`),
  -- MySQL allows many NULLs in a UNIQUE index, so email stays optional but
  -- cannot be duplicated when present.
  UNIQUE KEY `uq_customers_email` (`email`),
  KEY `ix_customers_status` (`status`, `created_at`),
  KEY `ix_customers_last_order` (`last_order_at`),
  KEY `ix_customers_spend` (`total_spent`),
  CONSTRAINT `fk_customers_avatar`
    FOREIGN KEY (`avatar_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_customers_skin_type`
    FOREIGN KEY (`skin_type_id`) REFERENCES `skin_types` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_customers_concern`
    FOREIGN KEY (`primary_concern_id`) REFERENCES `skin_concerns` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_customers_referrer`
    FOREIGN KEY (`referred_by_customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- deferred FKs from earlier files
ALTER TABLE `media`
  ADD CONSTRAINT `fk_media_uploader_customer`
    FOREIGN KEY (`uploaded_by_customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL;

ALTER TABLE `quiz_submissions`
  ADD CONSTRAINT `fk_quiz_submissions_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- customer_addresses
-- -----------------------------------------------------------------------------
CREATE TABLE `customer_addresses` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id`        BIGINT UNSIGNED NOT NULL,
  `label`              VARCHAR(40)     NOT NULL DEFAULT 'Home',
  `address_type`       ENUM('home','work','other') NOT NULL DEFAULT 'home',
  `first_name`         VARCHAR(80)     NOT NULL,
  `last_name`          VARCHAR(80)         NULL,
  `phone`              VARCHAR(15)     NOT NULL,
  `alternate_phone`    VARCHAR(15)         NULL,
  `line1`              VARCHAR(255)    NOT NULL,
  `line2`              VARCHAR(255)        NULL,
  `landmark`           VARCHAR(120)        NULL,
  `city`               VARCHAR(80)     NOT NULL,
  `state`              VARCHAR(80)     NOT NULL,
  `state_code`         CHAR(2)             NULL,   -- GST state code
  `pincode`            CHAR(6)         NOT NULL,
  `country`            CHAR(2)         NOT NULL DEFAULT 'IN',
  `latitude`           DECIMAL(10,7)       NULL,
  `longitude`          DECIMAL(10,7)       NULL,
  `is_default_shipping` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_default_billing`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_verified`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `delivery_notes`     VARCHAR(255)        NULL,
  `created_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`         DATETIME            NULL,
  PRIMARY KEY (`id`),
  KEY `ix_customer_addresses_customer` (`customer_id`, `deleted_at`),
  KEY `ix_customer_addresses_pincode` (`pincode`),
  CONSTRAINT `fk_customer_addresses_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- otp_requests — one row per code sent
-- -----------------------------------------------------------------------------
-- The plaintext OTP is never stored. `otp_hash` is sha256(otp + pepper), and
-- verification is a hash comparison with `attempts` incremented on every miss.
-- Keep rows for ~90 days for fraud investigation, then purge.
-- -----------------------------------------------------------------------------
CREATE TABLE `otp_requests` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id`          CHAR(36)        NOT NULL DEFAULT (UUID()),  -- returned to client
  `country_code`        VARCHAR(5)      NOT NULL DEFAULT '+91',
  `phone`               VARCHAR(15)     NOT NULL,
  `purpose`             ENUM('login','signup','checkout_verify','phone_change',
                             'order_track','cod_confirm')
                                        NOT NULL DEFAULT 'login',
  `channel`             ENUM('sms','whatsapp') NOT NULL,
  `otp_hash`            CHAR(64)        NOT NULL,
  `otp_length`          TINYINT UNSIGNED NOT NULL DEFAULT 6,
  `attempts`            TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts`        TINYINT UNSIGNED NOT NULL DEFAULT 5,
  `resend_count`        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `status`              ENUM('pending','sent','verified','expired','failed','cancelled')
                                        NOT NULL DEFAULT 'pending',
  `provider`            VARCHAR(40)         NULL,   -- msg91|twilio|gupshup|meta_cloud
  `provider_message_id` VARCHAR(120)        NULL,
  `provider_status`     VARCHAR(60)         NULL,
  `error_message`       VARCHAR(255)        NULL,
  `customer_id`         BIGINT UNSIGNED     NULL,   -- set once matched
  `ip`                  VARBINARY(16)       NULL,
  `user_agent`          VARCHAR(255)        NULL,
  `device_id`           VARCHAR(64)         NULL,
  `sent_at`             DATETIME            NULL,
  `expires_at`          DATETIME        NOT NULL,   -- typically now() + 5 min
  `verified_at`         DATETIME            NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_otp_requests_request_id` (`request_id`),
  -- the rate-limit query: count rows for this phone in the last hour
  KEY `ix_otp_requests_phone_time` (`country_code`, `phone`, `created_at`),
  KEY `ix_otp_requests_status` (`status`, `expires_at`),
  KEY `ix_otp_requests_ip` (`ip`, `created_at`),
  CONSTRAINT `fk_otp_requests_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Sliding-window counters. OTP SMS costs real money, so the limit is enforced
-- here (durable, survives a restart) as well as in memory/Redis.
-- Suggested: 5 per phone per hour, 20 per IP per hour, 10 per device per hour.
CREATE TABLE `otp_throttle` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `identifier`      VARCHAR(120)    NOT NULL,   -- '+919876543210' | ip | device id
  `identifier_type` ENUM('phone','ip','device') NOT NULL,
  `window_start`    DATETIME        NOT NULL,
  `request_count`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `blocked_until`   DATETIME            NULL,
  `block_reason`    VARCHAR(120)        NULL,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_otp_throttle` (`identifier_type`, `identifier`, `window_start`),
  KEY `ix_otp_throttle_blocked` (`blocked_until`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- customer_sessions — refresh-token rotation
-- -----------------------------------------------------------------------------
-- The access JWT is short-lived (10-15 min) and stateless. The refresh token is
-- long-lived, stored here as a hash, and rotated on every use:
-- `rotated_from_session_id` chains the family, so if an old token is replayed
-- the whole family is revoked — the standard defence for the localStorage/XSS
-- risk called out in the brief.
-- -----------------------------------------------------------------------------
CREATE TABLE `customer_sessions` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id`           BIGINT UNSIGNED NOT NULL,
  `refresh_token_hash`    CHAR(64)        NOT NULL,
  `access_token_jti`      CHAR(36)            NULL,
  `rotated_from_session_id` BIGINT UNSIGNED   NULL,
  `device_id`             VARCHAR(64)         NULL,
  `device_name`           VARCHAR(120)        NULL,
  `platform`              ENUM('web','mobile_web','ios','android') NOT NULL DEFAULT 'web',
  `ip`                    VARBINARY(16)       NULL,
  `user_agent`            VARCHAR(255)        NULL,
  `issued_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_used_at`          DATETIME            NULL,
  `expires_at`            DATETIME        NOT NULL,
  `revoked_at`            DATETIME            NULL,
  `revoked_reason`        ENUM('logout','rotation','reuse_detected','admin','expired','password_change')
                                              NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_customer_sessions_refresh` (`refresh_token_hash`),
  KEY `ix_customer_sessions_customer` (`customer_id`, `revoked_at`),
  KEY `ix_customer_sessions_expiry` (`expires_at`),
  CONSTRAINT `fk_customer_sessions_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_customer_sessions_parent`
    FOREIGN KEY (`rotated_from_session_id`) REFERENCES `customer_sessions` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- customer_consents — append-only DPDP record
-- -----------------------------------------------------------------------------
-- Never UPDATE a consent row. Withdrawal is a NEW row with status='withdrawn'.
-- `subject_identifier` covers consent captured before an account exists (footer
-- newsletter, quiz as a guest).
-- BRD §14: "Email/SMS/WhatsApp marketing consent and unsubscribe separate from
-- transactional communication" — hence separate purposes per channel.
-- -----------------------------------------------------------------------------
CREATE TABLE `customer_consents` (
  `id`                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id`        BIGINT UNSIGNED     NULL,
  `subject_identifier` VARCHAR(191)        NULL,   -- phone or email pre-account
  `purpose`            ENUM('transactional','marketing_email','marketing_sms',
                            'marketing_whatsapp','analytics_cookies',
                            'advertising_cookies','quiz_data','review_media',
                            'adverse_event_contact','data_processing')
                                       NOT NULL,
  `status`             ENUM('granted','withdrawn') NOT NULL,
  `notice_version`     VARCHAR(20)     NOT NULL,   -- privacy notice this refers to
  `source`             ENUM('signup','checkout','footer','popup','quiz',
                            'preference_center','admin','import','support')
                                       NOT NULL,
  `ip`                 VARBINARY(16)       NULL,
  `user_agent`         VARCHAR(255)        NULL,
  `evidence`           JSON                NULL,   -- exact wording shown, checkbox state
  `expires_at`         DATETIME            NULL,
  `created_at`         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_customer_consents_customer` (`customer_id`, `purpose`, `created_at`),
  KEY `ix_customer_consents_subject` (`subject_identifier`, `purpose`, `created_at`),
  CONSTRAINT `fk_customer_consents_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `quiz_submissions`
  ADD CONSTRAINT `fk_quiz_submissions_consent`
    FOREIGN KEY (`consent_id`) REFERENCES `customer_consents` (`id`) ON DELETE SET NULL;

-- DPDP rights requests: access, correction, erasure, grievance
CREATE TABLE `data_requests` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `reference`     VARCHAR(20)     NOT NULL,
  `customer_id`   BIGINT UNSIGNED     NULL,
  `contact_value` VARCHAR(191)    NOT NULL,   -- how they reached us
  `request_type`  ENUM('access','correction','erasure','portability','grievance','withdraw_consent')
                                  NOT NULL,
  `status`        ENUM('received','verifying','in_progress','completed','rejected')
                                  NOT NULL DEFAULT 'received',
  `details`       TEXT                NULL,
  `verified_at`   DATETIME            NULL,
  `due_at`        DATETIME            NULL,
  `completed_at`  DATETIME            NULL,
  `outcome_note`  TEXT                NULL,
  `export_media_id` BIGINT UNSIGNED   NULL,
  `handled_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_data_requests_reference` (`reference`),
  KEY `ix_data_requests_status` (`status`, `due_at`),
  CONSTRAINT `fk_data_requests_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_data_requests_admin`
    FOREIGN KEY (`handled_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_data_requests_export`
    FOREIGN KEY (`export_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Wishlist and back-in-stock
-- -----------------------------------------------------------------------------
CREATE TABLE `wishlists` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  `name`        VARCHAR(120)    NOT NULL DEFAULT 'My Wishlist',
  `is_public`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `share_token` CHAR(36)            NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wishlists_customer` (`customer_id`),
  UNIQUE KEY `uq_wishlists_share_token` (`share_token`),
  CONSTRAINT `fk_wishlists_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `wishlist_items` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `wishlist_id` BIGINT UNSIGNED NOT NULL,
  `product_id`  BIGINT UNSIGNED NOT NULL,
  `variant_id`  BIGINT UNSIGNED     NULL,
  `note`        VARCHAR(255)        NULL,
  `added_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_wishlist_items` (`wishlist_id`, `product_id`),
  KEY `ix_wishlist_items_product` (`product_id`),
  CONSTRAINT `fk_wishlist_items_wishlist`
    FOREIGN KEY (`wishlist_id`) REFERENCES `wishlists` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wishlist_items_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wishlist_items_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- BRD FR-12: back-in-stock notification "with explicit marketing consent"
CREATE TABLE `back_in_stock_requests` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `variant_id`  BIGINT UNSIGNED NOT NULL,
  `customer_id` BIGINT UNSIGNED     NULL,
  `email`       VARCHAR(191)        NULL,
  `phone`       VARCHAR(15)         NULL,
  `channel`     ENUM('email','sms','whatsapp') NOT NULL DEFAULT 'email',
  `consent_id`  BIGINT UNSIGNED     NULL,
  `status`      ENUM('pending','notified','cancelled','expired') NOT NULL DEFAULT 'pending',
  `notified_at` DATETIME            NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_back_in_stock_variant` (`variant_id`, `status`),
  KEY `ix_back_in_stock_customer` (`customer_id`),
  CONSTRAINT `fk_back_in_stock_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_back_in_stock_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_back_in_stock_consent`
    FOREIGN KEY (`consent_id`) REFERENCES `customer_consents` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Internal CRM notes, visible only to staff with the customers.view permission
CREATE TABLE `customer_notes` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id`   BIGINT UNSIGNED NOT NULL,
  `admin_user_id` BIGINT UNSIGNED     NULL,
  `note`          TEXT            NOT NULL,
  `is_pinned`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_customer_notes_customer` (`customer_id`, `created_at`),
  CONSTRAINT `fk_customer_notes_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_customer_notes_admin`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ############################################################
-- SOURCE FILE: 08_cart_orders.sql
-- ############################################################

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


-- ############################################################
-- SOURCE FILE: 09_payments_shipping.sql
-- ############################################################

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


-- ############################################################
-- SOURCE FILE: 10_marketing.sql
-- ############################################################

-- =============================================================================
-- File 10 : MARKETING — coupons, loyalty, notifications, subscribers
-- =============================================================================
-- BRD §8.1: "Stacking, minimum order, eligible products, expiry, usage limit
-- and customer eligibility are configurable. Automatic and code discounts
-- resolve deterministically; customer sees why a code failed."
--
-- So every one of those is a column, and the eligibility joins are real tables
-- rather than a JSON blob — because "which coupons apply to this product" has
-- to be answerable by an index at checkout, under time pressure.
-- =============================================================================

USE `veylog`;

CREATE TABLE `coupons` (
  `id`                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code`                    VARCHAR(60)     NOT NULL,
  `title`                   VARCHAR(191)        NULL,   -- shown in cart
  `description`             VARCHAR(500)        NULL,
  `discount_type`           ENUM('percentage','fixed_amount','free_shipping',
                                 'buy_x_get_y','free_gift')
                                            NOT NULL DEFAULT 'percentage',
  `value`                   DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `max_discount_amount`     DECIMAL(10,2)       NULL,   -- caps a % discount

  -- eligibility
  `min_order_amount`        DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `min_quantity`            SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `applies_to`              ENUM('all','products','categories','collections')
                                            NOT NULL DEFAULT 'all',
  `customer_eligibility`    ENUM('all','new_customers','returning','specific')
                                            NOT NULL DEFAULT 'all',

  -- buy X get Y / free gift
  `buy_quantity`            SMALLINT UNSIGNED   NULL,
  `get_quantity`            SMALLINT UNSIGNED   NULL,
  `get_variant_id`          BIGINT UNSIGNED     NULL,
  `gift_variant_id`         BIGINT UNSIGNED     NULL,
  -- BRD §8.1: "Free gifts reserve inventory and disappear cleanly when the
  -- threshold is no longer met."
  `gift_reserves_inventory` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,

  -- usage
  `usage_limit_total`       INT UNSIGNED        NULL,
  `usage_limit_per_customer` SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `used_count`              INT UNSIGNED    NOT NULL DEFAULT 0,

  -- resolution
  `is_stackable`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_automatic`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,  -- no code needed
  `is_visible`              TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,  -- listed on site
  `priority`                SMALLINT UNSIGNED NOT NULL DEFAULT 100,  -- lower wins first
  `starts_at`               DATETIME            NULL,
  `ends_at`                 DATETIME            NULL,
  `is_active`               TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_by_admin_id`     BIGINT UNSIGNED     NULL,
  `created_at`              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`              DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_coupons_code` (`code`),
  KEY `ix_coupons_active` (`is_active`, `starts_at`, `ends_at`),
  KEY `ix_coupons_automatic` (`is_automatic`, `is_active`, `priority`),
  CONSTRAINT `fk_coupons_get_variant`
    FOREIGN KEY (`get_variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_coupons_gift_variant`
    FOREIGN KEY (`gift_variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_coupons_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ck_coupons_value` CHECK (`value` >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- deferred FKs from file 08
ALTER TABLE `orders`
  ADD CONSTRAINT `fk_orders_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE SET NULL;
ALTER TABLE `order_discounts`
  ADD CONSTRAINT `fk_order_discounts_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE SET NULL;
ALTER TABLE `cart_items`
  ADD CONSTRAINT `fk_cart_items_source_coupon`
    FOREIGN KEY (`source_coupon_id`) REFERENCES `coupons` (`id`) ON DELETE SET NULL;

-- `is_excluded` lets one row express both "only these" and "everything but
-- these", which is how most real promo briefs are actually written.
CREATE TABLE `coupon_products` (
  `coupon_id`   BIGINT UNSIGNED NOT NULL,
  `product_id`  BIGINT UNSIGNED NOT NULL,
  `is_excluded` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`coupon_id`, `product_id`),
  KEY `ix_coupon_products_product` (`product_id`),
  CONSTRAINT `fk_coupon_products_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_products_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `coupon_categories` (
  `coupon_id`   BIGINT UNSIGNED NOT NULL,
  `category_id` BIGINT UNSIGNED NOT NULL,
  `is_excluded` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`coupon_id`, `category_id`),
  KEY `ix_coupon_categories_category` (`category_id`),
  CONSTRAINT `fk_coupon_categories_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_categories_category`
    FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `coupon_collections` (
  `coupon_id`     BIGINT UNSIGNED NOT NULL,
  `collection_id` BIGINT UNSIGNED NOT NULL,
  `is_excluded`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`coupon_id`, `collection_id`),
  KEY `ix_coupon_collections_collection` (`collection_id`),
  CONSTRAINT `fk_coupon_collections_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_collections_collection`
    FOREIGN KEY (`collection_id`) REFERENCES `collections` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `coupon_customers` (
  `coupon_id`   BIGINT UNSIGNED NOT NULL,
  `customer_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`coupon_id`, `customer_id`),
  KEY `ix_coupon_customers_customer` (`customer_id`),
  CONSTRAINT `fk_coupon_customers_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_customers_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- UNIQUE(coupon, order) is what enforces per-customer limits reliably even
-- under a double-click, rather than relying on the `used_count` counter.
CREATE TABLE `coupon_redemptions` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `coupon_id`       BIGINT UNSIGNED NOT NULL,
  `order_id`        BIGINT UNSIGNED NOT NULL,
  `customer_id`     BIGINT UNSIGNED     NULL,
  `discount_amount` DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `redeemed_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_coupon_redemptions` (`coupon_id`, `order_id`),
  KEY `ix_coupon_redemptions_customer` (`customer_id`, `coupon_id`),
  CONSTRAINT `fk_coupon_redemptions_coupon`
    FOREIGN KEY (`coupon_id`) REFERENCES `coupons` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_redemptions_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_coupon_redemptions_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Loyalty (BRD P2, but the existing UI already has a points screen)
-- Balance is a cache; loyalty_transactions is the ledger of record.
-- -----------------------------------------------------------------------------
CREATE TABLE `loyalty_accounts` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `customer_id`       BIGINT UNSIGNED NOT NULL,
  `balance`           INT             NOT NULL DEFAULT 0,
  `lifetime_earned`   INT UNSIGNED    NOT NULL DEFAULT 0,
  `lifetime_redeemed` INT UNSIGNED    NOT NULL DEFAULT 0,
  `tier`              ENUM('none','bronze','silver','gold') NOT NULL DEFAULT 'none',
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_loyalty_accounts_customer` (`customer_id`),
  CONSTRAINT `fk_loyalty_accounts_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `loyalty_transactions` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `loyalty_account_id` BIGINT UNSIGNED NOT NULL,
  `order_id`          BIGINT UNSIGNED     NULL,
  `transaction_type`  ENUM('earn','redeem','expire','adjust','reversal') NOT NULL,
  `points`            INT             NOT NULL,   -- signed
  `balance_after`     INT             NOT NULL,
  `description`       VARCHAR(255)        NULL,
  `expires_at`        DATETIME            NULL,
  `admin_user_id`     BIGINT UNSIGNED     NULL,   -- manual adjustments
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_loyalty_transactions_account` (`loyalty_account_id`, `created_at`),
  KEY `ix_loyalty_transactions_order` (`order_id`),
  KEY `ix_loyalty_transactions_expiry` (`expires_at`),
  CONSTRAINT `fk_loyalty_transactions_account`
    FOREIGN KEY (`loyalty_account_id`) REFERENCES `loyalty_accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_loyalty_transactions_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_loyalty_transactions_admin`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `loyalty_rules` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`                VARCHAR(120)    NOT NULL,
  `event`               ENUM('order_delivered','order_placed','review_approved',
                             'signup','referral','birthday')
                                        NOT NULL,
  `points_type`         ENUM('fixed','percentage_of_order') NOT NULL DEFAULT 'fixed',
  `points_value`        DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `min_order_amount`    DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  `max_points_per_event` INT UNSIGNED       NULL,
  `redemption_rate`     DECIMAL(8,2)    NOT NULL DEFAULT 10.00,  -- points per ₹1
  `min_redeem_points`   INT UNSIGNED    NOT NULL DEFAULT 100,
  `max_redeem_percent`  DECIMAL(5,2)    NOT NULL DEFAULT 50.00,  -- of subtotal
  `expiry_days`         SMALLINT UNSIGNED   NULL,
  `is_active`           TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_loyalty_rules_event` (`event`, `is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Newsletter / marketing list
-- consent_id points at the customer_consents row that authorises this, so an
-- audit can trace every send back to a recorded permission.
-- -----------------------------------------------------------------------------
CREATE TABLE `newsletter_subscribers` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`             VARCHAR(191)        NULL,
  `phone`             VARCHAR(15)         NULL,
  `channel`           ENUM('email','sms','whatsapp') NOT NULL DEFAULT 'email',
  `customer_id`       BIGINT UNSIGNED     NULL,
  `status`            ENUM('pending','subscribed','unsubscribed','bounced','complained')
                                      NOT NULL DEFAULT 'pending',
  `source`            VARCHAR(60)         NULL,   -- footer|popup|checkout|quiz
  `consent_id`        BIGINT UNSIGNED     NULL,
  `unsubscribe_token` CHAR(36)        NOT NULL DEFAULT (UUID()),
  `subscribed_at`     DATETIME            NULL,
  `unsubscribed_at`   DATETIME            NULL,
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_newsletter_email_channel` (`email`, `channel`),
  UNIQUE KEY `uq_newsletter_phone_channel` (`phone`, `channel`),
  UNIQUE KEY `uq_newsletter_token` (`unsubscribe_token`),
  KEY `ix_newsletter_status` (`status`, `channel`),
  CONSTRAINT `fk_newsletter_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_newsletter_consent`
    FOREIGN KEY (`consent_id`) REFERENCES `customer_consents` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Transactional messaging (BRD FR-07)
-- Templates are content, so they live in the database and are editable by the
-- content role. WhatsApp templates additionally carry the Meta-approved
-- template name in `provider_template_id`.
-- -----------------------------------------------------------------------------
CREATE TABLE `notification_templates` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_key`            VARCHAR(60)     NOT NULL,   -- otp.login, order.confirmed
  `channel`              ENUM('email','sms','whatsapp','push') NOT NULL,
  `locale`               VARCHAR(10)     NOT NULL DEFAULT 'en-IN',
  `name`                 VARCHAR(120)    NOT NULL,
  `subject`              VARCHAR(255)        NULL,   -- email only
  `body`                 LONGTEXT        NOT NULL,
  `provider`             VARCHAR(40)         NULL,
  `provider_template_id` VARCHAR(120)        NULL,   -- DLT id / WA template name
  `dlt_template_id`      VARCHAR(60)         NULL,   -- TRAI DLT registration
  `variables`            JSON                NULL,
  `is_transactional`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `is_active`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `updated_by_admin_id`  BIGINT UNSIGNED     NULL,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_notification_templates` (`event_key`, `channel`, `locale`),
  CONSTRAINT `fk_notification_templates_admin`
    FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per message attempt. This is the table support looks at when a
-- customer says "I never got my OTP".
CREATE TABLE `notification_logs` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `template_id`         BIGINT UNSIGNED     NULL,
  `event_key`           VARCHAR(60)     NOT NULL,
  `channel`             ENUM('email','sms','whatsapp','push') NOT NULL,
  `recipient`           VARCHAR(191)    NOT NULL,
  `customer_id`         BIGINT UNSIGNED     NULL,
  `order_id`            BIGINT UNSIGNED     NULL,
  `provider`            VARCHAR(40)         NULL,
  `provider_message_id` VARCHAR(120)        NULL,
  `status`              ENUM('queued','sent','delivered','read','failed','bounced')
                                        NOT NULL DEFAULT 'queued',
  `error_message`       VARCHAR(500)        NULL,
  `retry_count`         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `cost`                DECIMAL(8,4)    NOT NULL DEFAULT 0.0000,
  `payload`             JSON                NULL,
  `queued_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `sent_at`             DATETIME            NULL,
  `delivered_at`        DATETIME            NULL,
  `failed_at`           DATETIME            NULL,
  PRIMARY KEY (`id`),
  KEY `ix_notification_logs_customer` (`customer_id`, `queued_at`),
  KEY `ix_notification_logs_order` (`order_id`),
  KEY `ix_notification_logs_status` (`status`, `queued_at`),
  KEY `ix_notification_logs_recipient` (`recipient`, `queued_at`),
  CONSTRAINT `fk_notification_logs_template`
    FOREIGN KEY (`template_id`) REFERENCES `notification_templates` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_notification_logs_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_notification_logs_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ############################################################
-- SOURCE FILE: 11_reviews.sql
-- ############################################################

-- =============================================================================
-- File 11 : REVIEWS AND UGC
-- =============================================================================
-- BRD FR-10: "Reviews require moderation, verified-order attribution and abuse
-- controls." And §14: "Permission, moderation, incentives disclosed, no
-- fabricated reviews."
--
-- Hence: every review starts at status='pending'; verification is proven by a
-- real `order_item_id`, not a boolean someone can flip; and `is_incentivized`
-- exists so a gifted or discounted review can be disclosed on the page.
--
-- Review photos attach through `media_attachments` with
-- attachable_type='review', so UGC lives in the same library as everything
-- else and inherits the same variants, moderation and storage migration.
-- =============================================================================

USE `veylog`;

CREATE TABLE `reviews` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`            CHAR(36)        NOT NULL DEFAULT (UUID()),
  `product_id`           BIGINT UNSIGNED NOT NULL,
  `variant_id`           BIGINT UNSIGNED     NULL,
  `customer_id`          BIGINT UNSIGNED     NULL,
  `order_id`             BIGINT UNSIGNED     NULL,
  -- Non-NULL is the ONLY thing that earns the "verified purchase" badge.
  `order_item_id`        BIGINT UNSIGNED     NULL,

  `author_name`          VARCHAR(120)    NOT NULL,   -- 'Priya S.'
  `author_location`      VARCHAR(120)        NULL,
  `author_email`         VARCHAR(191)        NULL,   -- never displayed
  `rating`               TINYINT UNSIGNED NOT NULL,
  `title`                VARCHAR(200)        NULL,
  `body`                 TEXT                NULL,

  -- review filters on the PDP
  `skin_type_id`         BIGINT UNSIGNED     NULL,
  `concern_id`           BIGINT UNSIGNED     NULL,
  `age_range`            VARCHAR(20)         NULL,
  `usage_duration`       VARCHAR(40)         NULL,   -- '4-8 weeks'
  `would_recommend`      TINYINT(1) UNSIGNED NULL,

  `is_verified_purchase` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_incentivized`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,  -- must be disclosed
  `has_media`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  `status`               ENUM('pending','approved','rejected','spam','hidden')
                                         NOT NULL DEFAULT 'pending',
  `rejection_reason`     VARCHAR(255)        NULL,
  `moderated_by_admin_id` BIGINT UNSIGNED    NULL,
  `moderated_at`         DATETIME            NULL,
  `moderation_note`      VARCHAR(500)        NULL,
  -- A review describing irritation is a safety signal, not just feedback.
  -- Flagging it here routes it into the adverse-event workflow (file 12).
  `flagged_adverse_reaction` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  `helpful_count`        INT UNSIGNED    NOT NULL DEFAULT 0,
  `not_helpful_count`    INT UNSIGNED    NOT NULL DEFAULT 0,
  `report_count`         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `source`               ENUM('web','email_invite','whatsapp','import','admin')
                                         NOT NULL DEFAULT 'web',
  `ip`                   VARBINARY(16)       NULL,
  `published_at`         DATETIME            NULL,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`           DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reviews_public_id` (`public_id`),
  -- one review per purchased line, so a repeat buyer can review again
  UNIQUE KEY `uq_reviews_order_item` (`order_item_id`),
  KEY `ix_reviews_product_display` (`product_id`, `status`, `published_at`),
  KEY `ix_reviews_customer` (`customer_id`, `created_at`),
  KEY `ix_reviews_moderation` (`status`, `created_at`),
  KEY `ix_reviews_rating` (`product_id`, `rating`),
  CONSTRAINT `fk_reviews_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_reviews_variant`
    FOREIGN KEY (`variant_id`) REFERENCES `product_variants` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_order_item`
    FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_skin_type`
    FOREIGN KEY (`skin_type_id`) REFERENCES `skin_types` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_concern`
    FOREIGN KEY (`concern_id`) REFERENCES `skin_concerns` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_reviews_moderator`
    FOREIGN KEY (`moderated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `ck_reviews_rating` CHECK (`rating` BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- voter_hash = sha256(customer_id or ip + salt), so guests can vote once
-- without storing another identifier.
CREATE TABLE `review_votes` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `review_id`   BIGINT UNSIGNED NOT NULL,
  `customer_id` BIGINT UNSIGNED     NULL,
  `voter_hash`  CHAR(64)        NOT NULL,
  `is_helpful`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_review_votes` (`review_id`, `voter_hash`),
  KEY `ix_review_votes_customer` (`customer_id`),
  CONSTRAINT `fk_review_votes_review`
    FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_votes_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Brand response, shown under the review
CREATE TABLE `review_replies` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `review_id`     BIGINT UNSIGNED NOT NULL,
  `admin_user_id` BIGINT UNSIGNED     NULL,
  `display_name`  VARCHAR(120)    NOT NULL DEFAULT 'Veylor',
  `body`          TEXT            NOT NULL,
  `is_public`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `published_at`  DATETIME            NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_review_replies_review` (`review_id`),
  CONSTRAINT `fk_review_replies_review`
    FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_replies_admin`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `review_reports` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `review_id`           BIGINT UNSIGNED NOT NULL,
  `reporter_customer_id` BIGINT UNSIGNED    NULL,
  `reporter_hash`       CHAR(64)            NULL,
  `reason`              ENUM('spam','offensive','fake','off_topic','personal_data','other')
                                        NOT NULL,
  `detail`              VARCHAR(500)        NULL,
  `status`              ENUM('open','reviewed','dismissed','actioned') NOT NULL DEFAULT 'open',
  `handled_by_admin_id` BIGINT UNSIGNED     NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_review_reports_review` (`review_id`, `status`),
  CONSTRAINT `fk_review_reports_review`
    FOREIGN KEY (`review_id`) REFERENCES `reviews` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_reports_customer`
    FOREIGN KEY (`reporter_customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_review_reports_admin`
    FOREIGN KEY (`handled_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Post-delivery review request. The token both authenticates the submission and
-- proves the purchase, so a review can be left without logging in again.
CREATE TABLE `review_invitations` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `order_id`      BIGINT UNSIGNED NOT NULL,
  `order_item_id` BIGINT UNSIGNED NOT NULL,
  `customer_id`   BIGINT UNSIGNED     NULL,
  `token`         CHAR(36)        NOT NULL DEFAULT (UUID()),
  `channel`       ENUM('email','sms','whatsapp') NOT NULL DEFAULT 'email',
  `status`        ENUM('scheduled','sent','opened','submitted','expired')
                                  NOT NULL DEFAULT 'scheduled',
  `scheduled_for` DATETIME            NULL,
  `sent_at`       DATETIME            NULL,
  `opened_at`     DATETIME            NULL,
  `submitted_at`  DATETIME            NULL,
  `expires_at`    DATETIME            NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_review_invitations_token` (`token`),
  UNIQUE KEY `uq_review_invitations_item` (`order_item_id`),
  KEY `ix_review_invitations_status` (`status`, `scheduled_for`),
  CONSTRAINT `fk_review_invitations_order`
    FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_invitations_item`
    FOREIGN KEY (`order_item_id`) REFERENCES `order_items` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_review_invitations_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ############################################################
-- SOURCE FILE: 12_support_ops.sql
-- ############################################################

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


-- ############################################################
-- SOURCE FILE: 13_system.sql
-- ############################################################

-- =============================================================================
-- File 13 : SYSTEM — settings, search, rate limits, import/export, jobs
-- =============================================================================

USE `veylog`;

-- -----------------------------------------------------------------------------
-- settings — every operational number that must change without a deploy:
-- free-shipping threshold, GST rate, OTP expiry, media base URLs, store GSTIN.
-- `is_public` marks what the storefront may read; `is_encrypted` marks values
-- stored via app-level encryption (API keys should still prefer env vars).
-- -----------------------------------------------------------------------------
CREATE TABLE `settings` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `group_key`           VARCHAR(50)     NOT NULL,   -- store|shipping|payment|media|otp|seo
  `setting_key`         VARCHAR(100)    NOT NULL,   -- media.local_base_url
  `label`               VARCHAR(160)        NULL,
  `value`               TEXT                NULL,
  `default_value`       TEXT                NULL,
  `value_type`          ENUM('string','number','boolean','json','media','html','secret')
                                        NOT NULL DEFAULT 'string',
  `description`         VARCHAR(500)        NULL,
  `is_public`           TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_encrypted`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `sort_order`          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `updated_by_admin_id` BIGINT UNSIGNED     NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_settings_key` (`setting_key`),
  KEY `ix_settings_group` (`group_key`, `sort_order`),
  CONSTRAINT `fk_settings_admin`
    FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Search — BRD FR-11: "Search handles product, ingredient and concern synonyms;
-- zero-results page suggests routes."
-- Synonyms are data so the content team can add "vit c" → "vitamin c,
-- ascorbic acid" the moment they see it in search_queries.
-- -----------------------------------------------------------------------------
CREATE TABLE `search_synonyms` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `term`       VARCHAR(120)    NOT NULL,
  `synonyms`   TEXT            NOT NULL,   -- comma separated
  `match_type` ENUM('synonym','typo','concept','redirect') NOT NULL DEFAULT 'synonym',
  `redirect_url` VARCHAR(500)      NULL,   -- 'vitamin c' -> /ingredients/vitamin-c
  `is_active`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_search_synonyms_term` (`term`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Zero-result queries here are the highest-signal content backlog you will get.
CREATE TABLE `search_queries` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `query`             VARCHAR(191)    NOT NULL,
  `normalized_query`  VARCHAR(191)    NOT NULL,   -- lowercased, trimmed
  `results_count`     INT UNSIGNED    NOT NULL DEFAULT 0,
  `customer_id`       BIGINT UNSIGNED     NULL,
  `session_token`     CHAR(36)            NULL,
  `clicked_product_id` BIGINT UNSIGNED    NULL,
  `converted`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `device`            ENUM('mobile','tablet','desktop','unknown') NOT NULL DEFAULT 'unknown',
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_search_queries_normalized` (`normalized_query`, `created_at`),
  KEY `ix_search_queries_zero` (`results_count`, `created_at`),
  CONSTRAINT `fk_search_queries_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_search_queries_product`
    FOREIGN KEY (`clicked_product_id`) REFERENCES `products` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Recently viewed, for the account page and "continue browsing"
CREATE TABLE `product_views` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `product_id`    BIGINT UNSIGNED NOT NULL,
  `customer_id`   BIGINT UNSIGNED     NULL,
  `session_token` CHAR(36)            NULL,
  `source`        VARCHAR(60)         NULL,
  `viewed_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_product_views_customer` (`customer_id`, `viewed_at`),
  KEY `ix_product_views_session` (`session_token`, `viewed_at`),
  KEY `ix_product_views_product` (`product_id`, `viewed_at`),
  CONSTRAINT `fk_product_views_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_product_views_customer`
    FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- rate_limits — durable backstop for OTP, login, tracking, coupon-guessing.
-- Redis is faster; this survives a restart and gives you an audit trail.
-- -----------------------------------------------------------------------------
CREATE TABLE `rate_limits` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `bucket_key`   VARCHAR(80)     NOT NULL,   -- 'otp.send', 'admin.login'
  `identifier`   VARCHAR(120)    NOT NULL,   -- phone, ip, admin id
  `hits`         INT UNSIGNED    NOT NULL DEFAULT 0,
  `window_start` DATETIME        NOT NULL,
  `expires_at`   DATETIME        NOT NULL,
  `blocked_until` DATETIME           NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rate_limits` (`bucket_key`, `identifier`, `window_start`),
  KEY `ix_rate_limits_expiry` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- import_jobs / export_jobs
-- BRD §17: "CSV exports are permissioned, logged and minimized." Every export
-- is a row here with the requesting admin, the columns taken and the filters —
-- so a customer-data export is never invisible.
-- -----------------------------------------------------------------------------
CREATE TABLE `import_jobs` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_type`            ENUM('products','variants','inventory','customers',
                             'orders','pincodes','media','redirects','reviews')
                                        NOT NULL,
  `source_media_id`     BIGINT UNSIGNED     NULL,
  `status`              ENUM('queued','validating','running','completed','failed','cancelled')
                                        NOT NULL DEFAULT 'queued',
  `total_rows`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `processed_rows`      INT UNSIGNED    NOT NULL DEFAULT 0,
  `success_rows`        INT UNSIGNED    NOT NULL DEFAULT 0,
  `error_rows`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `error_report_media_id` BIGINT UNSIGNED   NULL,
  `options`             JSON                NULL,
  `started_by_admin_id` BIGINT UNSIGNED     NULL,
  `started_at`          DATETIME            NULL,
  `finished_at`         DATETIME            NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_import_jobs_status` (`status`, `created_at`),
  CONSTRAINT `fk_import_jobs_source`
    FOREIGN KEY (`source_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_import_jobs_error_report`
    FOREIGN KEY (`error_report_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_import_jobs_admin`
    FOREIGN KEY (`started_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `export_jobs` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_type`              ENUM('products','inventory','customers','orders',
                               'reviews','coupons','gst_report','payouts')
                                          NOT NULL,
  `status`                ENUM('queued','running','completed','failed','expired')
                                          NOT NULL DEFAULT 'queued',
  `filters`               JSON                NULL,
  `columns`               JSON                NULL,   -- data minimisation record
  `contains_personal_data` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `row_count`             INT UNSIGNED    NOT NULL DEFAULT 0,
  `result_media_id`       BIGINT UNSIGNED     NULL,
  `download_count`        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `expires_at`            DATETIME            NULL,   -- link auto-expires
  `requested_by_admin_id` BIGINT UNSIGNED     NULL,
  `justification`         VARCHAR(255)        NULL,
  `started_at`            DATETIME            NULL,
  `finished_at`           DATETIME            NULL,
  `created_at`            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_export_jobs_status` (`status`, `created_at`),
  KEY `ix_export_jobs_admin` (`requested_by_admin_id`, `created_at`),
  CONSTRAINT `fk_export_jobs_result`
    FOREIGN KEY (`result_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_export_jobs_admin`
    FOREIGN KEY (`requested_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Generic background job log: variant generation, abandoned-cart mail,
-- collection recalculation, reservation sweep, retention purge.
CREATE TABLE `job_runs` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_name`     VARCHAR(80)     NOT NULL,
  `status`       ENUM('running','completed','failed') NOT NULL DEFAULT 'running',
  `items_processed` INT UNSIGNED NOT NULL DEFAULT 0,
  `error_message` VARCHAR(500)       NULL,
  `context`      JSON                NULL,
  `started_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `finished_at`  DATETIME            NULL,
  `duration_ms`  INT UNSIGNED        NULL,
  PRIMARY KEY (`id`),
  KEY `ix_job_runs_name` (`job_name`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `feature_flags` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `flag_key`        VARCHAR(80)     NOT NULL,
  `description`     VARCHAR(500)        NULL,
  `is_enabled`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `rollout_percent` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `conditions`      JSON                NULL,
  `updated_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_feature_flags_key` (`flag_key`),
  CONSTRAINT `fk_feature_flags_admin`
    FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ############################################################
-- SOURCE FILE: 99_seed_reference.sql
-- ############################################################

-- =============================================================================
-- File 99 : REFERENCE SEED DATA
-- =============================================================================
-- Only data the application logic depends on: roles, permissions, taxonomy,
-- tax classes, settings, menus, notification event keys. No products, no
-- customers, no fake reviews.
-- Safe to re-run: every insert uses INSERT IGNORE or ON DUPLICATE KEY UPDATE.
-- =============================================================================

USE `veylog`;

-- -----------------------------------------------------------------------------
-- Roles (BRD §17)
-- -----------------------------------------------------------------------------
INSERT INTO `roles` (`slug`, `name`, `description`, `is_system`, `level`) VALUES
  ('founder',   'Founder / Admin', 'Full configuration, catalogue, pricing, orders, users, analytics. MFA required.', 1, 10),
  ('content',   'Content',         'Pages, articles, media, SEO. No payment or refund access.', 1, 40),
  ('operations','Operations',      'Orders, shipments, inventory, cancellation and RTO. Limited customer data.', 1, 30),
  ('support',   'Support',         'Order lookup, notes, approved refunds and escalation. Masked data where possible.', 1, 50),
  ('growth',    'Growth',          'Offers, landing pages, tags and reports. No unrestricted admin.', 1, 45),
  ('developer', 'Developer',       'Technical configuration via controlled environments. Production access is time-boxed.', 1, 20)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Permissions
-- -----------------------------------------------------------------------------
INSERT INTO `permissions` (`slug`, `module`, `action`, `name`, `is_dangerous`) VALUES
  -- catalog
  ('products.view','products','view','View products',0),
  ('products.create','products','create','Create products',0),
  ('products.update','products','update','Edit products',0),
  ('products.publish','products','publish','Publish / unpublish products',0),
  ('products.delete','products','delete','Delete products',1),
  ('products.price_update','products','price_update','Change prices and MRP',1),
  ('inventory.view','inventory','view','View inventory',0),
  ('inventory.adjust','inventory','adjust','Adjust stock levels',1),
  ('claims.manage','claims','manage','Manage claims and evidence',1),
  ('claims.approve','claims','approve','Approve claims for use',1),
  -- cms
  ('cms.view','cms','view','View content',0),
  ('cms.edit','cms','edit','Edit content',0),
  ('cms.publish','cms','publish','Publish content',0),
  ('cms.delete','cms','delete','Delete content',1),
  ('cms.menus','cms','menus','Manage navigation',0),
  ('cms.redirects','cms','redirects','Manage redirects',0),
  ('seo.manage','seo','manage','Manage SEO metadata',0),
  -- media
  ('media.view','media','view','View media library',0),
  ('media.upload','media','upload','Upload media',0),
  ('media.delete','media','delete','Delete media',1),
  ('media.migrate','media','migrate','Run storage migrations',1),
  -- orders
  ('orders.view','orders','view','View orders',0),
  ('orders.update','orders','update','Update order status',0),
  ('orders.cancel','orders','cancel','Cancel orders',1),
  ('orders.refund','orders','refund','Issue refunds',1),
  ('orders.fulfil','orders','fulfil','Create shipments',0),
  ('returns.manage','returns','manage','Approve and process returns',1),
  ('invoices.view','invoices','view','View and download invoices',0),
  -- customers
  ('customers.view','customers','view','View customers',0),
  ('customers.update','customers','update','Edit customers',0),
  ('customers.export','customers','export','Export customer data',1),
  ('customers.delete','customers','delete','Erase customer data',1),
  ('data_requests.manage','privacy','manage','Handle DPDP data requests',1),
  -- marketing
  ('coupons.view','coupons','view','View coupons',0),
  ('coupons.manage','coupons','manage','Create and edit coupons',1),
  ('loyalty.manage','loyalty','manage','Adjust loyalty points',1),
  ('notifications.manage','notifications','manage','Edit message templates',0),
  -- reviews and support
  ('reviews.view','reviews','view','View reviews',0),
  ('reviews.moderate','reviews','moderate','Approve or reject reviews',0),
  ('support.view','support','view','View support tickets',0),
  ('support.respond','support','respond','Respond to tickets',0),
  ('adverse_events.view','safety','view','View adverse event reports',1),
  ('adverse_events.manage','safety','manage','Manage adverse event reports',1),
  -- system
  ('analytics.view','analytics','view','View reports and analytics',0),
  ('settings.view','settings','view','View settings',0),
  ('settings.manage','settings','manage','Change store settings',1),
  ('admins.view','admins','view','View staff accounts',0),
  ('admins.manage','admins','manage','Create and edit staff accounts',1),
  ('roles.manage','roles','manage','Change roles and permissions',1),
  ('audit.view','audit','view','View the audit log',0)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- Role → permission grants
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'founder';

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'content' AND p.slug IN (
  'products.view','cms.view','cms.edit','cms.publish','cms.menus','cms.redirects',
  'seo.manage','media.view','media.upload','media.delete','reviews.view',
  'reviews.moderate','claims.manage','analytics.view');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'operations' AND p.slug IN (
  'products.view','inventory.view','inventory.adjust','orders.view','orders.update',
  'orders.cancel','orders.fulfil','returns.manage','invoices.view','customers.view',
  'support.view','analytics.view');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'support' AND p.slug IN (
  'orders.view','orders.update','invoices.view','customers.view','support.view',
  'support.respond','reviews.view','returns.manage','adverse_events.view');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'growth' AND p.slug IN (
  'products.view','cms.view','cms.edit','cms.publish','seo.manage','media.view',
  'media.upload','coupons.view','coupons.manage','notifications.manage','analytics.view');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'developer' AND p.slug IN (
  'products.view','inventory.view','orders.view','cms.view','media.view',
  'settings.view','settings.manage','analytics.view','audit.view','media.migrate');

-- -----------------------------------------------------------------------------
-- Skin taxonomy
-- -----------------------------------------------------------------------------
INSERT INTO `skin_types` (`slug`,`name`,`sort_order`) VALUES
  ('all','All skin types',0),
  ('normal','Normal',1),
  ('dry','Dry',2),
  ('oily','Oily',3),
  ('combination','Combination',4),
  ('sensitive','Sensitive',5)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- Wording is deliberately appearance-based, per the BRD claims framework.
INSERT INTO `skin_concerns` (`slug`,`name`,`short_label`,`sort_order`,`has_landing_page`) VALUES
  ('dullness','Dullness','Dull-looking skin',0,1),
  ('uneven-tone','Uneven tone','Uneven-looking tone',1,1),
  ('pigmentation','Pigmentation','Dark spots',2,1),
  ('brightening','Brightening','Radiance',3,0),
  ('hydration','Hydration','Dehydrated-looking skin',4,1),
  ('barrier','Barrier support','Barrier discomfort',5,1),
  ('acne','Blemish-prone','Blemish-prone skin',6,0),
  ('aging','Visible ageing','Fine lines',7,0)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Tax (18% GST on cosmetics, HSN 3304). Confirm with your CA before launch.
-- -----------------------------------------------------------------------------
INSERT INTO `tax_classes` (`code`,`name`,`hsn_code`,`gst_rate`,`is_inclusive`,`is_default`) VALUES
  ('GST_18_COSMETICS','GST 18% — Cosmetics','3304',18.00,1,1),
  ('GST_18_SKINCARE_PREP','GST 18% — Skin care preparations','3307',18.00,1,0),
  ('GST_0','Exempt','',0.00,0,0)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

INSERT INTO `tax_rates` (`tax_class_id`,`country`,`state_code`,`tax_type`,`rate`,`effective_from`)
SELECT id,'IN',NULL,'cgst',9.00,'2026-01-01' FROM `tax_classes` WHERE `code`='GST_18_COSMETICS';
INSERT INTO `tax_rates` (`tax_class_id`,`country`,`state_code`,`tax_type`,`rate`,`effective_from`)
SELECT id,'IN',NULL,'sgst',9.00,'2026-01-01' FROM `tax_classes` WHERE `code`='GST_18_COSMETICS';
INSERT INTO `tax_rates` (`tax_class_id`,`country`,`state_code`,`tax_type`,`rate`,`effective_from`)
SELECT id,'IN',NULL,'igst',18.00,'2026-01-01' FROM `tax_classes` WHERE `code`='GST_18_COSMETICS';

-- -----------------------------------------------------------------------------
-- Media folders
-- -----------------------------------------------------------------------------
INSERT INTO `media_folders` (`parent_id`,`name`,`slug`,`path`,`depth`,`sort_order`) VALUES
  (NULL,'Products','products','products',0,0),
  (NULL,'Ingredients','ingredients','ingredients',0,1),
  (NULL,'Editorial','editorial','editorial',0,2),
  (NULL,'Banners','banners','banners',0,3),
  (NULL,'UGC & Reviews','ugc','ugc',0,4),
  (NULL,'Documents','documents','documents',0,5),
  (NULL,'Brand','brand','brand',0,6)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Navigation shells (BRD §6 information architecture)
-- -----------------------------------------------------------------------------
INSERT INTO `cms_menus` (`slug`,`name`) VALUES
  ('main','Main header'),
  ('mobile_drawer','Mobile drawer'),
  ('footer_shop','Footer — Shop'),
  ('footer_learn','Footer — Learn'),
  ('footer_support','Footer — Support'),
  ('footer_legal','Footer — Legal')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

INSERT INTO `cms_blogs` (`slug`,`title`,`description`) VALUES
  ('journal','Journal','Education, routines and ingredient explainers.')
ON DUPLICATE KEY UPDATE `title` = VALUES(`title`);

INSERT INTO `cms_article_categories` (`slug`,`name`,`sort_order`) VALUES
  ('routine','Routine',0),
  ('education','Education',1),
  ('ingredient','Ingredient',2),
  ('safety','Safety',3),
  ('expectation','What to expect',4),
  ('concern','Concern',5)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

INSERT INTO `cms_faq_groups` (`slug`,`name`,`sort_order`) VALUES
  ('general','General',0),
  ('shipping','Shipping & delivery',1),
  ('returns','Returns & refunds',2),
  ('payments','Payments',3),
  ('products','Using our products',4)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Fulfilment defaults
-- -----------------------------------------------------------------------------
INSERT INTO `inventory_locations` (`code`,`name`,`location_type`,`country`,`is_default`,`is_active`) VALUES
  ('MAIN','Primary warehouse','warehouse','IN',1,1)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

INSERT INTO `shipping_rates` (`name`,`zone`,`method`,`min_order_amount`,`rate`,`free_above_amount`,`eta_min_days`,`eta_max_days`,`priority`) VALUES
  ('Standard shipping','all','standard',0.00,99.00,500.00,3,7,0),
  ('Express shipping','metro','express',0.00,199.00,NULL,1,3,10);

INSERT INTO `cod_rules` (`name`,`is_active`,`min_order_amount`,`max_order_amount`,`cod_fee`,`prepaid_discount_amount`,`requires_otp_confirmation`,`max_open_cod_orders`,`block_if_rto_count_gte`) VALUES
  ('Default COD policy',1,299.00,5000.00,49.00,25.00,1,2,2);

-- -----------------------------------------------------------------------------
-- Notification event keys (bodies to be written by the content team)
-- -----------------------------------------------------------------------------
INSERT INTO `notification_templates` (`event_key`,`channel`,`locale`,`name`,`subject`,`body`,`is_transactional`,`is_active`) VALUES
  ('otp.login','sms','en-IN','Login OTP — SMS',NULL,'{{otp}} is your Veylor verification code. Valid for 5 minutes. Do not share it.',1,1),
  ('otp.login','whatsapp','en-IN','Login OTP — WhatsApp',NULL,'{{otp}} is your Veylor verification code. Valid for 5 minutes.',1,1),
  ('order.confirmed','sms','en-IN','Order confirmed — SMS',NULL,'Order {{order_number}} confirmed. Track it at {{tracking_url}}',1,1),
  ('order.confirmed','whatsapp','en-IN','Order confirmed — WhatsApp',NULL,'Thank you. Order {{order_number}} is confirmed.',1,1),
  ('order.confirmed','email','en-IN','Order confirmed — Email','Your Veylor order {{order_number}}','',1,1),
  ('order.shipped','sms','en-IN','Order shipped — SMS',NULL,'Order {{order_number}} has shipped. AWB {{awb}}. Track: {{tracking_url}}',1,1),
  ('order.shipped','whatsapp','en-IN','Order shipped — WhatsApp',NULL,'Your Veylor order is on its way.',1,1),
  ('order.out_for_delivery','sms','en-IN','Out for delivery — SMS',NULL,'Order {{order_number}} is out for delivery today.',1,1),
  ('order.delivered','whatsapp','en-IN','Delivered — WhatsApp',NULL,'Your Veylor order has been delivered.',1,1),
  ('order.cancelled','email','en-IN','Order cancelled — Email','Order {{order_number}} cancelled','',1,1),
  ('payment.failed','email','en-IN','Payment failed — Email','We could not complete your payment','',1,1),
  ('refund.processed','email','en-IN','Refund processed — Email','Your refund for {{order_number}}','',1,1),
  ('cart.abandoned','email','en-IN','Abandoned cart — Email','You left something behind','',0,0),
  ('review.invite','email','en-IN','Review invitation — Email','How is your Veylor routine going?','',0,1),
  ('stock.back_in_stock','email','en-IN','Back in stock — Email','{{product_name}} is back','',0,1)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Settings
-- -----------------------------------------------------------------------------
-- media.* is what makes the local → S3 move a config change plus a copy job.
INSERT INTO `settings` (`group_key`,`setting_key`,`label`,`value`,`value_type`,`is_public`,`description`) VALUES
  ('store','store.name','Store name','Veylor','string',1,NULL),
  ('store','store.legal_name','Legal entity name','','string',0,'As registered, for invoices'),
  ('store','store.gstin','GSTIN','','string',0,NULL),
  ('store','store.support_email','Support email','','string',1,NULL),
  ('store','store.support_phone','Support phone','','string',1,NULL),
  ('store','store.support_hours','Support hours','Mon–Sat, 10:00–18:00 IST','string',1,NULL),
  ('store','store.currency','Currency','INR','string',1,NULL),
  ('store','store.timezone','Timezone','Asia/Kolkata','string',0,NULL),
  ('store','store.grievance_officer','Grievance officer','','json',1,'Name, email and address required by consumer rules'),

  ('media','media.disk','Active storage disk','local','string',0,'local | s3 | r2'),
  ('media','media.local_base_url','Local media base URL','/media','string',1,'Prefix joined to media.storage_key while disk = local'),
  ('media','media.local_root','Local storage root','/storage/media','string',0,'Absolute path on the server, outside the web root'),
  ('media','media.s3_base_url','S3/CDN base URL','','string',1,'Set before switching disk to s3'),
  ('media','media.max_upload_mb','Max upload size (MB)','25','number',0,NULL),
  ('media','media.allowed_mime','Allowed MIME types','["image/jpeg","image/png","image/webp","image/avif","video/mp4","application/pdf"]','json',0,NULL),
  ('media','media.variant_widths','Variant widths','{"thumb":160,"sm":400,"md":800,"lg":1200,"xl":1800}','json',0,NULL),
  ('media','media.variant_formats','Variant formats','["webp","avif"]','json',0,NULL),
  ('media','media.keep_original','Keep original file','1','boolean',0,NULL),

  ('otp','otp.length','OTP length','6','number',0,NULL),
  ('otp','otp.expiry_seconds','OTP expiry (seconds)','300','number',0,NULL),
  ('otp','otp.resend_cooldown_seconds','Resend cooldown','30','number',1,NULL),
  ('otp','otp.max_attempts','Max verify attempts','5','number',0,NULL),
  ('otp','otp.max_per_phone_per_hour','Max sends per phone per hour','5','number',0,'Cost and abuse control'),
  ('otp','otp.max_per_ip_per_hour','Max sends per IP per hour','20','number',0,NULL),
  ('otp','otp.default_channel','Default channel','whatsapp','string',1,NULL),

  ('auth','auth.access_token_minutes','Access token lifetime (min)','15','number',0,NULL),
  ('auth','auth.refresh_token_days','Refresh token lifetime (days)','30','number',0,NULL),
  ('auth','auth.admin_session_hours','Admin session lifetime (hours)','8','number',0,NULL),
  ('auth','auth.admin_mfa_required','Require MFA for admins','1','boolean',0,NULL),

  ('cart','cart.expiry_days','Cart persistence (days)','30','number',0,'BRD FR-03'),
  ('cart','cart.max_line_quantity','Max units per line','10','number',1,NULL),
  ('cart','cart.reservation_minutes','Checkout stock hold (min)','15','number',0,NULL),

  ('shipping','shipping.free_threshold','Free shipping above (₹)','500','number',1,NULL),
  ('shipping','shipping.standard_cost','Standard shipping (₹)','99','number',1,NULL),
  ('shipping','shipping.origin_state_code','Origin state code','','string',0,'Decides CGST+SGST vs IGST'),

  ('payment','payment.gateway','Active gateway','razorpay','string',0,NULL),
  ('payment','payment.cod_enabled','COD enabled','1','boolean',1,NULL),
  ('payment','payment.capture_mode','Capture mode','automatic','string',0,NULL),

  ('privacy','privacy.notice_version','Privacy notice version','1.0','string',1,'Recorded on every consent row'),
  ('privacy','privacy.quiz_retention_days','Quiz answer retention (days)','365','number',0,NULL),
  ('privacy','privacy.otp_log_retention_days','OTP log retention (days)','90','number',0,NULL),

  ('seo','seo.default_title_suffix','Title suffix',' | Veylor','string',1,NULL),
  ('seo','seo.noindex_site','Noindex whole site','1','boolean',0,'Keep 1 on staging, set 0 at launch'),

  ('inventory','inventory.low_stock_threshold','Low stock alert threshold','5','number',0,NULL),
  ('inventory','inventory.allow_backorder','Allow backorders','0','boolean',0,NULL)
ON DUPLICATE KEY UPDATE `label` = VALUES(`label`);

-- -----------------------------------------------------------------------------
-- Metafield definitions — a couple of useful starters
-- -----------------------------------------------------------------------------
INSERT INTO `metafield_definitions` (`owner_type`,`namespace`,`meta_key`,`name`,`value_type`,`is_public`,`is_filterable`) VALUES
  ('product','veylor','clinical_report','Clinical study report (PDF)','media',1,0),
  ('product','veylor','ph_value','Formula pH','decimal',1,1),
  ('product','veylor','spf_rating','SPF rating','integer',1,1),
  ('product','veylor','vegan','Vegan','boolean',1,1),
  ('product','veylor','cruelty_free','Cruelty free','boolean',1,1),
  ('product','veylor','patch_test_required','Patch test recommended','boolean',1,0),
  ('cms_page','veylor','hero_video','Hero video','media',1,0)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Search synonyms (BRD FR-11)
-- -----------------------------------------------------------------------------
INSERT INTO `search_synonyms` (`term`,`synonyms`,`match_type`) VALUES
  ('vitamin c','ascorbic acid,vit c,vitc,l-ascorbic','synonym'),
  ('niacinamide','vitamin b3,nicotinamide,b3','synonym'),
  ('moisturizer','moisturiser,cream,lotion,hydrator','synonym'),
  ('sunscreen','spf,sun screen,sunblock,sun cream','synonym'),
  ('dark spots','pigmentation,hyperpigmentation,melasma,marks','concept'),
  ('dullness','dull skin,glow,radiance,tired skin','concept'),
  ('cica','centella,centella asiatica,tiger grass','synonym'),
  ('serum','seram,cerum','typo')
ON DUPLICATE KEY UPDATE `synonyms` = VALUES(`synonyms`);
