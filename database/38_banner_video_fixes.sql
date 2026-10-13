-- =============================================================================
-- File 38: Banner Video Support Enhancement
-- =============================================================================
-- Ensures proper video playback support for banners by:
-- 1. Confirming poster_media_id column exists (from file 37)
-- 2. Auto-generating poster frames for existing video banners without them
-- 3. Adding helpful indexes for video banner queries
--
-- This fixes the issue where videos weren't displaying in the webapp banner
-- carousel due to missing poster frames and frontend conditions.
-- =============================================================================

USE `veylog`;

-- -----------------------------------------------------------------------------
-- Step 1: Verify poster_media_id column exists (should be from file 37)
-- -----------------------------------------------------------------------------
SET @column_exists = (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'cms_banners'
     AND COLUMN_NAME = 'poster_media_id'
);

-- Add column if it doesn't exist (safety check)
SET @add_poster_column = IF(
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

PREPARE stmt FROM @add_poster_column;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- -----------------------------------------------------------------------------
-- Step 2: Auto-assign poster frames to video banners that lack them
-- -----------------------------------------------------------------------------
-- For any banner where:
-- - desktop_media_id points to a video file
-- - poster_media_id is NULL
-- - The video has auto-generated poster frames in media_variants
--
-- We'll set poster_media_id to the same as desktop_media_id so the backend
-- query can find the auto_poster_key via the media_variants join.
--
-- Note: The backend query already handles finding the widest webp variant:
--   SELECT v.storage_key FROM media_variants v
--    WHERE v.media_id = desktop_media_id AND v.format = 'webp'
--    ORDER BY v.width DESC LIMIT 1
-- -----------------------------------------------------------------------------

UPDATE cms_banners b
  JOIN media m ON m.id = b.desktop_media_id
   SET b.poster_media_id = b.desktop_media_id
 WHERE b.poster_media_id IS NULL
   AND m.media_type = 'video'
   AND EXISTS (
     SELECT 1 FROM media_variants v
      WHERE v.media_id = m.id
        AND v.format = 'webp'
        AND v.variant_type = 'poster'
   );

-- Report affected rows
SELECT CONCAT('Auto-assigned poster frames to ', ROW_COUNT(), ' video banner(s)') AS result;

-- -----------------------------------------------------------------------------
-- Step 3: Add helpful indexes for video banner performance
-- -----------------------------------------------------------------------------

-- Index for finding active video banners by placement
SET @placement_media_index = (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'cms_banners'
     AND INDEX_NAME = 'ix_cms_banners_placement_media'
);

SET @add_placement_media_idx = IF(
  @placement_media_index = 0,
  'ALTER TABLE `cms_banners`
     ADD KEY `ix_cms_banners_placement_media` (`placement`, `is_active`, `desktop_media_id`)',
  'SELECT ''ix_cms_banners_placement_media already exists.'' AS note'
);

PREPARE stmt FROM @add_placement_media_idx;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- -----------------------------------------------------------------------------
-- Step 4: Verify banner configuration for video support
-- -----------------------------------------------------------------------------
SELECT 
  b.id,
  b.name,
  b.placement,
  m.media_type AS desktop_type,
  m.mime_type AS desktop_mime,
  CASE 
    WHEN b.poster_media_id IS NOT NULL THEN 'Manual poster set'
    WHEN EXISTS (
      SELECT 1 FROM media_variants v
       WHERE v.media_id = b.desktop_media_id
         AND v.format = 'webp'
         AND v.variant_type = 'poster'
    ) THEN 'Auto poster available'
    ELSE 'No poster'
  END AS poster_status,
  (SELECT COUNT(*) FROM media_variants v
    WHERE v.media_id = b.desktop_media_id
      AND v.format = 'webp'
      AND v.variant_type = 'poster'
  ) AS poster_variant_count
FROM cms_banners b
LEFT JOIN media m ON m.id = b.desktop_media_id
WHERE b.is_active = 1
  AND m.media_type = 'video'
ORDER BY b.placement, b.priority DESC, b.id DESC;

-- -----------------------------------------------------------------------------
-- Notes for Frontend Integration:
-- -----------------------------------------------------------------------------
-- The webapp frontend (BannerCarousel.tsx) has been updated to:
-- 1. Change phone detection from 640px to 768px for better tablet support
-- 2. Remove prefersReducedMotion() blocking (let browser handle autoplay)
-- 3. Improve fallback image logic (poster → mobile → image)
-- 4. Better video element management
--
-- Backend API (contentPublic.service.ts) already provides:
-- - image: The desktop file URL (video or image)
-- - media_type: 'video' or 'image'
-- - poster: Chosen poster OR auto-extracted frame
-- - mime_type: Full MIME type
-- - duration_ms: Video duration
--
-- The fix ensures videos play on desktop (>768px) while showing poster/image
-- on mobile devices or when autoplay is blocked by browser.
-- =============================================================================
