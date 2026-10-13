-- ────────────────────────────────────────────────────────────────────────────
-- 37 — a poster image for video banners
--
--   mysql -u <user> -p <database> < database/37_banner_video_poster.sql
--
-- A banner's desktop slot can now hold a video as well as an image, because
-- `cms_banners.desktop_media_id` points at `media` and `media` has always had a
-- media_type. Nothing had to change for that.
--
-- What is new is the still frame. The server pulls one out of the video on
-- upload and stores it as an ordinary image variant, so every video already has
-- a usable poster. This column is the override: the auto-picked frame is one
-- second in, and one second into a shoot is sometimes a blink or a turn of the
-- head. On a cosmetics site the first frame is the photograph, so whoever is
-- merchandising the page needs to be able to choose it.
--
-- ON DELETE SET NULL, matching the desktop and mobile slots: deleting an image
-- from the library should cost a banner its poster, not its existence.
--
-- Idempotent: the column is added only when it is not already there.
-- ────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

SET @column_exists := (
  SELECT COUNT(*)
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'cms_banners'
     AND COLUMN_NAME = 'poster_media_id'
);

SET @ddl := IF(
  @column_exists = 0,
  'ALTER TABLE `cms_banners`
     ADD COLUMN `poster_media_id` BIGINT UNSIGNED NULL DEFAULT NULL
       COMMENT ''Still shown before a video banner plays; falls back to the auto-extracted frame''
       AFTER `mobile_media_id`,
     ADD KEY `ix_cms_banners_poster_media` (`poster_media_id`),
     ADD CONSTRAINT `fk_cms_banners_poster_media`
       FOREIGN KEY (`poster_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL',
  'SELECT ''cms_banners.poster_media_id already exists.'' AS note'
);

PREPARE statement FROM @ddl;
EXECUTE statement;
DEALLOCATE PREPARE statement;

SELECT 'Migration 37 applied.' AS result;
