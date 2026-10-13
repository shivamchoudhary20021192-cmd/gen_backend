-- Does this database have everything the storytelling work needs?
--
-- Run it against veylor_db (EC2) or veylog (local). It changes nothing.
-- Anything reported as MISSING means migration 38_product_storytelling.sql
-- has not been applied to that database.
--
-- Note: the `products` table itself needed no changes. The storytelling data
-- lives on option values (a shade's descriptor and badge), on variants (the
-- size in words), and in five new tables.

SELECT 'product_option_values.descriptor' AS thing,
       IF(COUNT(*) = 1, 'ok', 'MISSING') AS state
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_option_values' AND COLUMN_NAME = 'descriptor'
UNION ALL SELECT 'product_option_values.badge',
       IF(COUNT(*) = 1, 'ok', 'MISSING') FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_option_values' AND COLUMN_NAME = 'badge'
UNION ALL SELECT 'product_option_values.description',
       IF(COUNT(*) = 1, 'ok', 'MISSING') FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_option_values' AND COLUMN_NAME = 'description'
UNION ALL SELECT 'product_option_values.is_active',
       IF(COUNT(*) = 1, 'ok', 'MISSING') FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_option_values' AND COLUMN_NAME = 'is_active'
UNION ALL SELECT 'product_variants.size_description',
       IF(COUNT(*) = 1, 'ok', 'MISSING') FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_variants' AND COLUMN_NAME = 'size_description'
UNION ALL SELECT 'table creators',
       IF(COUNT(*) = 1, 'ok', 'MISSING') FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'creators'
UNION ALL SELECT 'table content_sections',
       IF(COUNT(*) = 1, 'ok', 'MISSING') FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_sections'
UNION ALL SELECT 'table content_section_assignments',
       IF(COUNT(*) = 1, 'ok', 'MISSING') FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_section_assignments'
UNION ALL SELECT 'table content_section_blocks',
       IF(COUNT(*) = 1, 'ok', 'MISSING') FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_section_blocks'
UNION ALL SELECT 'table content_block_hotspots',
       IF(COUNT(*) = 1, 'ok', 'MISSING') FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_block_hotspots'
UNION ALL SELECT 'menu row content.sections (migration 40)',
       IF(COUNT(*) = 1, 'ok', 'MISSING') FROM menu_items WHERE menu_key = 'content.sections'
UNION ALL SELECT 'menu row content.creators (migration 39)',
       IF(COUNT(*) = 1, 'ok', 'MISSING') FROM menu_items WHERE menu_key = 'content.creators';

-- What is actually attached to what, right now.
-- A section with usage_count 0 is written but on no product, so no product
-- page will show it. That is the usual reason nothing appears on the site.
SELECT s.id, s.name, s.section_key, s.layout,
       (SELECT COUNT(*) FROM content_section_blocks b WHERE b.section_id = s.id) AS blocks,
       (SELECT COUNT(*) FROM content_section_assignments a
         WHERE a.section_id = s.id AND a.owner_type = 'product') AS on_products
  FROM content_sections s
 WHERE s.deleted_at IS NULL
 ORDER BY s.id;

-- And, for one product, exactly what the storefront will render.
-- Replace 8 with the product id. `is_enabled` must be 1 and the visible_from /
-- visible_until window must be open, or the section is skipped on the site.
SELECT a.id AS assignment_id, a.section_id, s.name, a.sort_order,
       a.is_enabled, a.visible_from, a.visible_until
  FROM content_section_assignments a
  JOIN content_sections s ON s.id = a.section_id
 WHERE a.owner_type = 'product' AND a.owner_id = 8
 ORDER BY a.sort_order;
