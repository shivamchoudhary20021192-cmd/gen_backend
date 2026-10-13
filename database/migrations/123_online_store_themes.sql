-- =============================================================================
-- 123 — Online Store 2.0: themes as files.
--
-- Until now a theme was a set of design tokens (colours, fonts) that one
-- hand-built React storefront read. A store's Online Store is now rendered on
-- the server from a theme exactly the way Shopify's is: a bundle of files —
--
--   layout/theme.liquid            the page shell
--   templates/<type>[.<suffix>].json   which sections a page type shows, in order
--   sections/<name>.liquid         a section's markup and its {% schema %}
--   sections/<group>.json          section groups (header, footer)
--   snippets/<name>.liquid         partials, {% render %}ed
--   assets/<file>                  CSS, JS, SVG, images
--   config/settings_schema.json    the theme's global settings
--   config/settings_data.json      the merchant's values for them
--   locales/<locale>[.default].json    translations
--
-- The merchant's customisations live in those files (JSON templates and
-- settings_data.json), as they do on Shopify, so "customise", "edit code",
-- "duplicate", "download" and "upgrade" are all operations on files.
--
--   theme_library_files      the files of each built-in (theme store) theme
--   shop_theme_files         each installed theme's own copy, per store
--   shop_theme_drafts        the editor's unsaved changes, previewable
--   shop_theme_file_versions every saved change, for undo and rollback
--
-- Existing token-only themes stay readable (`architecture = 'tokens'`) and are
-- converted to file themes by the application at boot.
-- =============================================================================

ALTER TABLE `theme_library`
  ADD COLUMN `architecture` ENUM('tokens','liquid') NOT NULL DEFAULT 'tokens' AFTER `version`,
  -- The sha-256 of every file, sorted: a library sync only rewrites what changed.
  ADD COLUMN `files_checksum` CHAR(64) NULL AFTER `architecture`,
  -- "Mega menu", "Quick buy", "Age verifier": what the theme store lists.
  ADD COLUMN `features` JSON NULL AFTER `verticals`,
  ADD COLUMN `industries` JSON NULL AFTER `features`;

CREATE TABLE IF NOT EXISTS `theme_library_files` (
  `library_theme_id` INT UNSIGNED NOT NULL,
  `path`             VARCHAR(255) NOT NULL,
  `content`          MEDIUMTEXT NOT NULL,
  `content_type`     VARCHAR(100) NOT NULL,
  `checksum`         CHAR(64) NOT NULL,
  `size`             INT UNSIGNED NOT NULL,
  `created_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`library_theme_id`, `path`),
  CONSTRAINT `fk_theme_library_files_theme` FOREIGN KEY (`library_theme_id`) REFERENCES `theme_library` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE `shop_themes`
  ADD COLUMN `architecture` ENUM('tokens','liquid') NOT NULL DEFAULT 'tokens' AFTER `library_handle`,
  -- Bumped on every saved file change; the renderer's cache key.
  ADD COLUMN `files_version` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `settings_data`,
  -- Where the files came from: the theme store, a copy of another theme, an upload.
  ADD COLUMN `source` ENUM('library','duplicate','upload') NOT NULL DEFAULT 'library' AFTER `files_version`,
  ADD COLUMN `processing` ENUM('ready','installing','failed') NOT NULL DEFAULT 'ready' AFTER `source`;

CREATE TABLE IF NOT EXISTS `shop_theme_files` (
  `shop_id`             BIGINT UNSIGNED NOT NULL,
  `theme_id`            BIGINT UNSIGNED NOT NULL,
  `path`                VARCHAR(255) NOT NULL,
  -- Text files (Liquid, JSON, CSS, JS, SVG) are stored here…
  `content`             MEDIUMTEXT NULL,
  -- …binary assets (images, fonts) in object storage.
  `storage_key`         VARCHAR(500) NULL,
  `content_type`        VARCHAR(100) NOT NULL,
  `checksum`            CHAR(64) NOT NULL,
  `size`                INT UNSIGNED NOT NULL,
  `updated_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`shop_id`, `theme_id`, `path`),
  KEY `ix_shop_theme_files_theme` (`theme_id`),
  CONSTRAINT `fk_shop_theme_files_theme` FOREIGN KEY (`shop_id`, `theme_id`) REFERENCES `shop_themes` (`shop_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The theme editor's unsaved work. Preview renders files with these laid over
-- them; Save moves them into shop_theme_files, Discard deletes them.
CREATE TABLE IF NOT EXISTS `shop_theme_drafts` (
  `shop_id`             BIGINT UNSIGNED NOT NULL,
  `theme_id`            BIGINT UNSIGNED NOT NULL,
  `path`                VARCHAR(255) NOT NULL,
  `content`             MEDIUMTEXT NULL,
  -- A draft can also delete a file (a removed alternate template).
  `is_deleted`          TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `updated_by_admin_id` BIGINT UNSIGNED NULL,
  `updated_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`shop_id`, `theme_id`, `path`),
  CONSTRAINT `fk_shop_theme_drafts_theme` FOREIGN KEY (`shop_id`, `theme_id`) REFERENCES `shop_themes` (`shop_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every saved version of every file: "Older versions" in the code editor, and
-- a rollback that cannot lose the thing being rolled back from.
CREATE TABLE IF NOT EXISTS `shop_theme_file_versions` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`             BIGINT UNSIGNED NOT NULL,
  `theme_id`            BIGINT UNSIGNED NOT NULL,
  `path`                VARCHAR(255) NOT NULL,
  `content`             MEDIUMTEXT NULL,
  `checksum`            CHAR(64) NOT NULL,
  `source`              ENUM('install','editor','code','upgrade','restore','api') NOT NULL,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_shop_theme_file_versions_file` (`shop_id`, `theme_id`, `path`, `id`),
  CONSTRAINT `fk_shop_theme_file_versions_theme` FOREIGN KEY (`shop_id`, `theme_id`) REFERENCES `shop_themes` (`shop_id`, `id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Alternate templates, as on Shopify: a product or collection can be shown
-- with templates/product.<suffix>.json instead of the default. (cms_pages
-- already has `template` for the same purpose.)
ALTER TABLE `products`    ADD COLUMN `template_suffix` VARCHAR(60) NULL AFTER `visibility`;
ALTER TABLE `collections` ADD COLUMN `template_suffix` VARCHAR(60) NULL AFTER `sort_type`;

-- Online Store → Preferences: the home page's title and description for search
-- engines, and the image social networks show when the store is shared.
ALTER TABLE `shop_brand`
  ADD COLUMN `seo_title`             VARCHAR(70)  NULL AFTER `social_links`,
  ADD COLUMN `seo_description`       VARCHAR(320) NULL AFTER `seo_title`,
  ADD COLUMN `social_image_media_id` BIGINT UNSIGNED NULL AFTER `seo_description`;

-- The Online Store's contact form ({% form 'contact' %}): the merchant's
-- inbox of messages from shoppers.
CREATE TABLE IF NOT EXISTS `contact_messages` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`     BIGINT UNSIGNED NOT NULL,
  `name`        VARCHAR(120) NULL,
  `email`       VARCHAR(191) NOT NULL,
  `phone`       VARCHAR(40)  NULL,
  `body`        TEXT NOT NULL,
  -- Any other contact[...] fields the theme's form asked for.
  `fields`      JSON NULL,
  `page_path`   VARCHAR(255) NULL,
  `status`      ENUM('new','read','archived') NOT NULL DEFAULT 'new',
  `ip_address`  VARCHAR(45)  NULL,
  `user_agent`  VARCHAR(255) NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_contact_messages_inbox` (`shop_id`, `status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
