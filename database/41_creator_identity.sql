-- ────────────────────────────────────────────────────────────────────────────
-- 41 · Whether a model's identity is shown with their photograph
--
-- A face on a product page is not the same as a name beside it. Some shoots
-- are booked with a credit, and naming the person is the point — it is why a
-- creator was chosen. Others are booked without one, and the model's name,
-- handle and profile link must never appear anywhere a shopper can reach,
-- including in the JSON behind the page.
--
-- Two flags, because the two questions are different and the stricter one has
-- to win:
--
--   creators.is_identity_public
--     May this person ever be named on the site? A contractual fact about the
--     person, set once on their record. Off means off everywhere, whatever any
--     individual block says.
--
--   content_section_blocks.credit_creator
--     Should this particular use carry the credit? The same model may be named
--     on a campaign and left anonymous on a texture shot.
--
-- The storefront reveals a name only when both are true. A block flag can
-- withhold a credit that is allowed; it can never grant one that is not.
--
-- Both default to 1 so nothing already published loses its credit on migration.
-- Idempotent: safe to run twice.
-- ────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

DROP PROCEDURE IF EXISTS veylor_add_column;
DELIMITER $$
CREATE PROCEDURE veylor_add_column(
  IN table_name_in VARCHAR(64),
  IN column_name_in VARCHAR(64),
  IN definition_in VARCHAR(512)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = table_name_in
       AND COLUMN_NAME = column_name_in
  ) THEN
    SET @statement = CONCAT('ALTER TABLE `', table_name_in, '` ADD COLUMN `',
                            column_name_in, '` ', definition_in);
    PREPARE stmt FROM @statement;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL veylor_add_column(
  'creators',
  'is_identity_public',
  "TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'May this person be named on the site at all' AFTER is_active"
);

CALL veylor_add_column(
  'content_section_blocks',
  'credit_creator',
  "TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'Carry the credit on this particular use' AFTER creator_id"
);

DROP PROCEDURE IF EXISTS veylor_add_column;
