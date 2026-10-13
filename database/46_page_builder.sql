-- ────────────────────────────────────────────────────────────────────────────
-- 46 · The page builder
--
--   mysql -u <user> -p <database> < database/46_page_builder.sql
--
-- The home page is written in HomePage.tsx: a hero, a promise strip, a brand
-- story panel, collection tiles. Changing a word in any of them is a deploy.
-- This migration makes the page a row of rows.
--
-- ── what is NOT being built ─────────────────────────────────────────────────
--
-- No new section table. `content_sections`, `content_section_blocks` and
-- `content_section_assignments` already are a page builder — a library of
-- typed sections, typed blocks with their own order, JSON settings, and
-- polymorphic ordered assignments with a schedule. They were built for product
-- storytelling and have twenty-two sections in them today. Building a second
-- set of three tables beside them is how a codebase ends up with three ways to
-- put a heading on a page, each with its own bugs.
--
-- So this migration adds the two things that were genuinely missing:
--
--   page_templates   something for a page's sections to be assigned *to*. The
--                    home page is not a CMS page and never will be; it needs a
--                    row of its own to hang an ordered list from.
--
--   surface          which editor a section belongs to. Product-story sections
--                    and page sections share a table and must not share a list,
--                    or the story editor grows fourteen kinds it cannot render.
--
-- Everything else is vocabulary — `section_key` and `block_type` are already
-- free text, `settings` is already JSON — and vocabulary lives in
-- `sectionSchema.ts`, not in the schema.
--
-- ── and what it seeds ───────────────────────────────────────────────────────
--
-- Today's home page, section by section, with its exact words. The page looks
-- identical on the first load after this runs. That is the point: a builder
-- that starts empty asks a merchandiser to rebuild their own front page before
-- they can change one line of it, and nobody does.
--
-- Idempotent: safe to run twice.
-- ────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

-- ── a thing to assign sections to ───────────────────────────────────────────
--
-- Deliberately not a `cms_pages` row. The home page is not a CMS page: it has
-- no body, no legal review, no slug of its own, and it must never appear in the
-- page index or be deletable from the Pages screen. A template is a different
-- noun and gets a different table — three columns of one.
CREATE TABLE IF NOT EXISTS page_templates (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- 'home' today; 'shop', 'product', 'collection' or 'page:<slug>' later. The
  -- storefront asks by this key, so it is the contract and it is unique.
  template_key VARCHAR(60) NOT NULL,
  name         VARCHAR(120) NOT NULL,
  description  VARCHAR(255) NULL,

  -- A system template cannot be deleted: the storefront has a route that asks
  -- for it by name, and a missing one is a blank page rather than an error.
  is_system    TINYINT(1) NOT NULL DEFAULT 0,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,

  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_page_templates_key (template_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO page_templates (template_key, name, description, is_system)
SELECT 'home', 'Home page', 'The front page of the storefront', 1
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM page_templates WHERE template_key = 'home');

-- ── the two additive columns ────────────────────────────────────────────────
--
-- `owner_type` gains 'template'. Adding a value to the end of an ENUM does not
-- touch a single existing row — the four assignments already there keep their
-- meaning exactly.
SET @has_template := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_section_assignments'
     AND COLUMN_NAME = 'owner_type' AND COLUMN_TYPE LIKE '%template%'
);
SET @sql := IF(@has_template = 0,
  'ALTER TABLE content_section_assignments MODIFY COLUMN owner_type ENUM(''product'',''page'',''collection'',''template'') NOT NULL',
  'SELECT ''owner_type already knows about templates'' AS note');
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

-- `surface` says which editor a section belongs to. Existing rows default to
-- 'product', which is what all twenty-two of them are.
SET @has_surface := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_sections' AND COLUMN_NAME = 'surface'
);
SET @sql := IF(@has_surface = 0,
  'ALTER TABLE content_sections ADD COLUMN surface ENUM(''product'',''page'') NOT NULL DEFAULT ''product'' AFTER section_key',
  'SELECT ''surface already present'' AS note');
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

SET @has_surface_index := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_sections' AND INDEX_NAME = 'idx_content_sections_surface'
);
SET @sql := IF(@has_surface_index = 0,
  'ALTER TABLE content_sections ADD KEY idx_content_sections_surface (surface, deleted_at)',
  'SELECT ''surface index already present'' AS note');
PREPARE statement FROM @sql; EXECUTE statement; DEALLOCATE PREPARE statement;

-- ── today's home page, as rows ──────────────────────────────────────────────
--
-- Guarded as a whole: if the home template already has sections, this has run
-- before and the merchandiser has almost certainly edited them since. Seeding
-- again would hand them a duplicate page.

SET @home := (SELECT id FROM page_templates WHERE template_key = 'home');
SET @already := (SELECT COUNT(*) FROM content_section_assignments WHERE owner_type = 'template' AND owner_id = @home);

-- 1 · the hero ──────────────────────────────────────────────────────────────
INSERT INTO content_sections (section_key, surface, name, settings)
SELECT 'hero', 'page', 'Home — hero', JSON_OBJECT(
  'eyebrow', 'Small batch · Made in India',
  'heading', 'Skincare that',
  'heading_accent', 'earns its place',
  'heading_tail', 'on your shelf.',
  'body', 'Nine formulas. No filler ingredients, no borrowed claims. Every active is dosed at the level the research actually used — and we print the number on the box.',
  'cta_label', 'Shop the range',
  'cta_link', JSON_OBJECT('type', 'url', 'ref_id', NULL, 'url', '/shop'),
  'cta_secondary_label', 'What''s new',
  'cta_secondary_link', JSON_OBJECT('type', 'url', 'ref_id', NULL, 'url', '/shop?sort=newest'),
  'align', 'left',
  'height', 'tall',
  'background', 'ivory'
) FROM DUAL WHERE @already = 0;
SET @hero := LAST_INSERT_ID();

INSERT INTO content_section_assignments (section_id, owner_type, owner_id, sort_order, is_enabled)
SELECT @hero, 'template', @home, 10, 1 FROM DUAL WHERE @already = 0;

-- 2 · the promise strip ─────────────────────────────────────────────────────
INSERT INTO content_sections (section_key, surface, name, settings)
SELECT 'promises', 'page', 'Home — promises', JSON_OBJECT('columns', 4, 'background', 'cream', 'spacing', 'tight')
  FROM DUAL WHERE @already = 0;
SET @promises := LAST_INSERT_ID();

INSERT INTO content_section_blocks (section_id, block_type, sort_order, is_enabled, settings)
SELECT @promises, 'item', 0, 1, JSON_OBJECT('icon', 'flask', 'title', 'Clinically dosed', 'body', 'Actives at the percentage the study used, printed on the box.') FROM DUAL WHERE @already = 0
UNION ALL
SELECT @promises, 'item', 1, 1, JSON_OBJECT('icon', 'leaf', 'title', 'Made for this climate', 'body', 'Formulated for Indian heat, humidity and hard water.') FROM DUAL WHERE @already = 0
UNION ALL
SELECT @promises, 'item', 2, 1, JSON_OBJECT('icon', 'shield', 'title', 'Dermatologist tested', 'body', 'Patch tested on Indian skin tones before it reaches you.') FROM DUAL WHERE @already = 0
UNION ALL
SELECT @promises, 'item', 3, 1, JSON_OBJECT('icon', 'truck', 'title', 'Delivered in 2–4 days', 'body', 'Complimentary above ₹999, across 19,000+ PIN codes.') FROM DUAL WHERE @already = 0;

INSERT INTO content_section_assignments (section_id, owner_type, owner_id, sort_order, is_enabled)
SELECT @promises, 'template', @home, 20, 1 FROM DUAL WHERE @already = 0;

-- 3 · the bestsellers shelf ─────────────────────────────────────────────────
-- Points at the shelf migration 44 created, so the rule behind it keeps working
-- and the shelf is still edited in Merchandising. The page only says where.
SET @shelf_best := (SELECT id FROM shelves WHERE title = 'The ones people come back for' AND deleted_at IS NULL LIMIT 1);

INSERT INTO content_sections (section_key, surface, name, settings)
SELECT 'shelf_embed', 'page', 'Home — bestsellers shelf', JSON_OBJECT('shelf', @shelf_best)
  FROM DUAL WHERE @already = 0 AND @shelf_best IS NOT NULL;
SET @best := LAST_INSERT_ID();

INSERT INTO content_section_assignments (section_id, owner_type, owner_id, sort_order, is_enabled)
SELECT @best, 'template', @home, 30, 1 FROM DUAL WHERE @already = 0 AND @shelf_best IS NOT NULL;

-- 4 · the brand story ───────────────────────────────────────────────────────
INSERT INTO content_sections (section_key, surface, name, settings)
SELECT 'story_panel', 'page', 'Home — our promise', JSON_OBJECT(
  'panel_quote', 'Every percentage on the front of the box is the percentage in the bottle.',
  'panel_icon', 'leaf',
  'media_side', 'left',
  'eyebrow', 'Our promise',
  'heading', 'We would rather make nine things properly',
  'body', '<p>Most brands launch forty products in a year. We have nine, because every one has to answer a question the other eight could not.</p><p>Each formula names its actives and their percentages on the front of the box. If a claim is not backed by a study we can point you to, it does not go on the label.</p>',
  'cta_label', 'Read the formulations',
  'cta_link', JSON_OBJECT('type', 'url', 'ref_id', NULL, 'url', '/shop'),
  'background', 'ivory'
) FROM DUAL WHERE @already = 0;
SET @story := LAST_INSERT_ID();

INSERT INTO content_section_blocks (section_id, block_type, sort_order, is_enabled, settings)
SELECT @story, 'stat', 0, 1, JSON_OBJECT('value', '9', 'label', 'Formulas') FROM DUAL WHERE @already = 0
UNION ALL
SELECT @story, 'stat', 1, 1, JSON_OBJECT('value', '0', 'label', 'Filler actives') FROM DUAL WHERE @already = 0
UNION ALL
SELECT @story, 'stat', 2, 1, JSON_OBJECT('value', '100%', 'label', 'Made in India') FROM DUAL WHERE @already = 0;

INSERT INTO content_section_assignments (section_id, owner_type, owner_id, sort_order, is_enabled)
SELECT @story, 'template', @home, 40, 1 FROM DUAL WHERE @already = 0;

-- 5 · the collection tiles ──────────────────────────────────────────────────
-- Automatic, as the page does it today: the first three collections shown in
-- the menu. A merchandiser who wants to choose them switches the setting and
-- adds tiles; until then the row keeps itself current.
INSERT INTO content_sections (section_key, surface, name, settings)
SELECT 'collection_tiles', 'page', 'Home — shop by edit', JSON_OBJECT(
  'eyebrow', 'Curated',
  'heading', 'Shop by edit',
  'source', 'auto',
  'columns', 3,
  'background', 'none'
) FROM DUAL WHERE @already = 0;
SET @tiles := LAST_INSERT_ID();

INSERT INTO content_section_assignments (section_id, owner_type, owner_id, sort_order, is_enabled)
SELECT @tiles, 'template', @home, 50, 1 FROM DUAL WHERE @already = 0;

-- 6 · the mid-page campaign slot ────────────────────────────────────────────
INSERT INTO content_sections (section_key, surface, name, settings)
SELECT 'banner_slot', 'page', 'Home — campaign slot', JSON_OBJECT('placement', 'home_carousel')
  FROM DUAL WHERE @already = 0;
SET @slot := LAST_INSERT_ID();

INSERT INTO content_section_assignments (section_id, owner_type, owner_id, sort_order, is_enabled)
SELECT @slot, 'template', @home, 60, 1 FROM DUAL WHERE @already = 0;

-- 7 · the new arrivals shelf ────────────────────────────────────────────────
SET @shelf_new := (SELECT id FROM shelves WHERE title = 'New in' AND deleted_at IS NULL LIMIT 1);

INSERT INTO content_sections (section_key, surface, name, settings)
SELECT 'shelf_embed', 'page', 'Home — new in shelf', JSON_OBJECT('shelf', @shelf_new)
  FROM DUAL WHERE @already = 0 AND @shelf_new IS NOT NULL;
SET @new := LAST_INSERT_ID();

INSERT INTO content_section_assignments (section_id, owner_type, owner_id, sort_order, is_enabled)
SELECT @new, 'template', @home, 70, 1 FROM DUAL WHERE @already = 0 AND @shelf_new IS NOT NULL;

SELECT CONCAT('Migration 46 applied. Home sections: ',
  (SELECT COUNT(*) FROM content_section_assignments WHERE owner_type = 'template' AND owner_id = @home)) AS result;
