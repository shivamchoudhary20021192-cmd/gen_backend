-- =============================================================================
-- 135 — The announcement bar, grown up: how it moves, how big it is, what it
--       looks like, where each line shows, and whether anyone reads it.
--
-- Content → Announcement bar already had lines (a sentence, a code, a link, a
-- schedule) and three switches. The market's announcement bars — Shopify's
-- theme slideshow and the apps merchants add on top of it — do a good deal
-- more, and merchants ask for it by name:
--
--   the bar      rotating lines or a scrolling ticker (marquee); how a line
--                changes (fade, slide, slide up, typewriter); speed, pause on
--                hover; a height that fits each line, fits the tallest line
--                (so the page never jumps), or is fixed; font size per device;
--                colours and a gradient; previous/next arrows and the link
--                arrow shown on desktop, mobile, both or neither; the whole
--                bar on desktop, mobile or both; how long "close" is remembered.
--   each line    its own colours; desktop-only or mobile-only; a countdown to
--                its end date; a free-shipping progress line that follows the
--                cart; and who sees it — which pages, guests or signed-in
--                customers, which countries.
--   the numbers  views and clicks per line per day (counted only with the
--                visitor's analytics consent), for the admin's list.
--
-- Idempotent: safe to run again, and safe to run by hand on an existing
-- database (npm run db:migrate running it afterwards changes nothing).
-- =============================================================================

SET NAMES utf8mb4;

-- ── the bar ──────────────────────────────────────────────────────────────────

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'announcement_settings' AND column_name = 'display_mode') = 0,
  'ALTER TABLE `announcement_settings`
     ADD COLUMN `display_mode` ENUM(''rotate'',''marquee'') NOT NULL DEFAULT ''rotate'' AFTER `is_enabled`,
     ADD COLUMN `transition` ENUM(''fade'',''slide'',''slide_up'',''typewriter'',''none'') NOT NULL DEFAULT ''fade'' AFTER `display_mode`,
     ADD COLUMN `autoplay` TINYINT(1) NOT NULL DEFAULT 1 AFTER `transition`,
     ADD COLUMN `pause_on_hover` TINYINT(1) NOT NULL DEFAULT 1 AFTER `rotation_seconds`,
     ADD COLUMN `marquee_speed` SMALLINT UNSIGNED NOT NULL DEFAULT 60 AFTER `pause_on_hover`,
     ADD COLUMN `marquee_direction` ENUM(''left'',''right'') NOT NULL DEFAULT ''left'' AFTER `marquee_speed`,
     ADD COLUMN `marquee_separator` VARCHAR(8) NOT NULL DEFAULT ''•'' AFTER `marquee_direction`,
     ADD COLUMN `height_mode` ENUM(''auto'',''uniform'',''fixed'') NOT NULL DEFAULT ''uniform'' AFTER `marquee_separator`,
     ADD COLUMN `fixed_height_desktop` SMALLINT UNSIGNED NOT NULL DEFAULT 40 AFTER `height_mode`,
     ADD COLUMN `fixed_height_mobile` SMALLINT UNSIGNED NOT NULL DEFAULT 44 AFTER `fixed_height_desktop`,
     ADD COLUMN `max_lines` TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER `fixed_height_mobile`,
     ADD COLUMN `font_size_desktop` TINYINT UNSIGNED NOT NULL DEFAULT 13 AFTER `max_lines`,
     ADD COLUMN `font_size_mobile` TINYINT UNSIGNED NOT NULL DEFAULT 12 AFTER `font_size_desktop`,
     ADD COLUMN `font_weight` ENUM(''regular'',''medium'',''bold'') NOT NULL DEFAULT ''medium'' AFTER `font_size_mobile`,
     ADD COLUMN `text_transform` ENUM(''none'',''uppercase'') NOT NULL DEFAULT ''none'' AFTER `font_weight`,
     ADD COLUMN `text_align` ENUM(''center'',''left'') NOT NULL DEFAULT ''center'' AFTER `text_transform`,
     ADD COLUMN `background_gradient_hex` VARCHAR(7) NULL AFTER `background_hex`,
     ADD COLUMN `bar_visibility` ENUM(''all'',''desktop'',''mobile'') NOT NULL DEFAULT ''all'' AFTER `text_hex`,
     ADD COLUMN `arrows_visibility` ENUM(''all'',''desktop'',''mobile'',''none'') NOT NULL DEFAULT ''desktop'' AFTER `bar_visibility`,
     ADD COLUMN `link_arrow_visibility` ENUM(''all'',''desktop'',''mobile'',''none'') NOT NULL DEFAULT ''all'' AFTER `arrows_visibility`,
     ADD COLUMN `dismiss_days` SMALLINT UNSIGNED NOT NULL DEFAULT 7 AFTER `is_dismissible`',
  'DO 0'
);
PREPARE `stmt135a` FROM @ddl;
EXECUTE `stmt135a`;
DEALLOCATE PREPARE `stmt135a`;

-- ── each line ────────────────────────────────────────────────────────────────

-- Room for a ticker's longer sentences; the admin still counts characters.
ALTER TABLE `announcements` MODIFY `message` VARCHAR(255) NOT NULL;

SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'announcements' AND column_name = 'visibility') = 0,
  'ALTER TABLE `announcements`
     ADD COLUMN `kind` ENUM(''message'',''free_shipping'') NOT NULL DEFAULT ''message'' AFTER `message`,
     ADD COLUMN `success_message` VARCHAR(255) NULL AFTER `kind`,
     ADD COLUMN `free_shipping_threshold` DECIMAL(12,2) NULL AFTER `success_message`,
     ADD COLUMN `show_countdown` TINYINT(1) NOT NULL DEFAULT 0 AFTER `ends_at`,
     ADD COLUMN `background_hex` VARCHAR(7) NULL AFTER `show_countdown`,
     ADD COLUMN `text_hex` VARCHAR(7) NULL AFTER `background_hex`,
     ADD COLUMN `visibility` ENUM(''all'',''desktop'',''mobile'') NOT NULL DEFAULT ''all'' AFTER `text_hex`,
     ADD COLUMN `show_on` JSON NULL AFTER `visibility`,
     ADD COLUMN `audience` ENUM(''all'',''guests'',''customers'') NOT NULL DEFAULT ''all'' AFTER `show_on`,
     ADD COLUMN `countries` JSON NULL AFTER `audience`',
  'DO 0'
);
PREPARE `stmt135b` FROM @ddl;
EXECUTE `stmt135b`;
DEALLOCATE PREPARE `stmt135b`;

-- ── the numbers ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `announcement_stats` (
  `shop_id`          BIGINT UNSIGNED NOT NULL,
  `announcement_id`  BIGINT UNSIGNED NOT NULL,
  `day`              DATE            NOT NULL,
  `views`            INT UNSIGNED    NOT NULL DEFAULT 0,
  `clicks`           INT UNSIGNED    NOT NULL DEFAULT 0,
  PRIMARY KEY (`shop_id`, `announcement_id`, `day`),
  KEY `ix_announcement_stats_day` (`shop_id`, `day`),
  CONSTRAINT `fk_announcement_stats_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_announcement_stats_line` FOREIGN KEY (`announcement_id`) REFERENCES `announcements` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
