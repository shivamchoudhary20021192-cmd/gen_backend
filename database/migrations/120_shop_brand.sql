-- =============================================================================
-- 120 — A store's brand, for any storefront to draw.
--
-- A storefront needs more than the shop's name to look like its store: a
-- logo, the one-line slogan under it, a sentence about the business for the
-- footer, and where to find the store elsewhere. Shopify keeps these under
-- Settings → Brand, apart from the theme, so a theme change never loses them
-- and every sales channel (storefront, checkout, emails, a headless app)
-- reads the same values.
--
-- One row per shop, created on first save; a store without one uses its name.
-- Logos are media rows in the store's own library.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `shop_brand` (
  `shop_id`              BIGINT UNSIGNED NOT NULL,
  `slogan`               VARCHAR(160) NULL,
  `short_description`    VARCHAR(500) NULL,
  -- The wide logo for headers, and a square one for favicons and app icons.
  `logo_media_id`        BIGINT UNSIGNED NULL,
  `square_logo_media_id` BIGINT UNSIGNED NULL,
  -- [{"platform":"instagram","url":"https://…"}], in display order.
  `social_links`         JSON NULL,
  `updated_by_admin_id`  BIGINT UNSIGNED NULL,
  `created_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`shop_id`),
  CONSTRAINT `fk_shop_brand_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
