-- =============================================================================
-- File 15 : COLLECTION SEO — search engine listing for collections
-- =============================================================================
-- Collections are landing pages, not just groupings: /collections/brightening
-- is a URL people reach from search, so it needs the same title/description
-- override that products already have. Without these columns a merchandiser
-- can only influence the search snippet by rewriting the collection's real
-- title and description, which are the customer-facing copy.
--
-- Both are nullable on purpose. NULL means "derive it" — the storefront falls
-- back to `title` and a trimmed `description`, which is the right default and
-- keeps every existing row valid without a backfill.
--
-- Idempotent: safe to run against a database that already has the columns.
-- =============================================================================

-- No USE statement: the database name differs per environment (veylog locally,
-- veylor_db on the server). Hardcoding one here made every migration below fail
-- with "Access denied" on the deployed box. Connect to the right database
-- instead: `mysql -D <database> < this-file.sql`.
SET @has_meta_title := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'collections' AND COLUMN_NAME = 'meta_title'
);
SET @sql := IF(
  @has_meta_title = 0,
  'ALTER TABLE `collections`
     ADD COLUMN `meta_title` VARCHAR(191) NULL COMMENT "Search engine title. NULL = derive from title." AFTER `description`,
     ADD COLUMN `meta_description` VARCHAR(320) NULL COMMENT "Search engine description. NULL = derive from description." AFTER `meta_title`',
  'SELECT "collections.meta_title already present" AS note'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
