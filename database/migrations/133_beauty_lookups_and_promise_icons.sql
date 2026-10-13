-- =============================================================================
-- 133 — Beauty product lookups for shops opened through sign-up, and promise
--       icons the storefront can actually draw.
--
-- 1. The product form asks for nineteen lookups (gender, coverage, shade
--    family, season, claims, packaging, …). The beauty template seeded seven,
--    so the other dropdowns were empty in every beauty shop opened through
--    sign-up (the admin logged "out-of-range value `unisex`"). The template
--    now has all nineteen; this adds whichever of them a beauty shop lacks.
--    A list a shop already has is left exactly as it is: values are only
--    written into the lists this migration creates, never into ones the
--    merchant or the legacy seed curated.
--
-- 2. Promise icons neither the storefront nor the admin can draw (rabbit, gift,
--    return, lock, …) — the storefront showed a leaf for every one of them.
--    They become the nearest of the six that exist:
--    leaf, flask, shield, truck, star, check.
--
-- Idempotent: safe to run again, and safe to run by hand on an existing
-- database (npm run db:migrate running it afterwards changes nothing).
-- =============================================================================

-- ── the beauty template's lookup lists and their values ─────────────────────

DROP TEMPORARY TABLE IF EXISTS `tmp133_lists`;
CREATE TEMPORARY TABLE `tmp133_lists` (
  `code`          VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `name`          VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `allow_custom`  TINYINT(1)   NOT NULL,
  `position`      SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tmp133_lists` (`code`, `name`, `allow_custom`, `position`) VALUES
  ('skin_types', 'Skin type', 0, 1),
  ('skin_concerns', 'Skin concern', 1, 2),
  ('benefits', 'Benefit', 1, 3),
  ('formulation_type', 'Formulation', 1, 4),
  ('free_from', 'Free from', 0, 5),
  ('certification_type', 'Certification', 0, 6),
  ('finish', 'Finish', 0, 7),
  ('gender_target', 'Gender', 0, 8),
  ('age_range', 'Age range', 0, 9),
  ('coverage', 'Coverage', 0, 10),
  ('shade_family', 'Shade family', 0, 11),
  ('absorption_rate', 'Absorption', 0, 12),
  ('feel_on_skin', 'Feel on skin', 1, 13),
  ('pregnancy_safe', 'Pregnancy safety', 0, 14),
  ('season', 'Season', 0, 15),
  ('claims', 'Claims', 1, 16),
  ('packaging_type', 'Packaging', 1, 17),
  ('application_method', 'Application method', 1, 18),
  ('usage_instructions', 'Usage instructions', 1, 19);

DROP TEMPORARY TABLE IF EXISTS `tmp133_values`;
CREATE TEMPORARY TABLE `tmp133_values` (
  `list_code`   VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `code`        VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `label`       VARCHAR(191) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sort_order`  SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (`list_code`, `code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tmp133_values` (`list_code`, `code`, `label`, `sort_order`) VALUES
  ('skin_types', 'dry', 'Dry', 1),
  ('skin_types', 'oily', 'Oily', 2),
  ('skin_types', 'combination', 'Combination', 3),
  ('skin_types', 'normal', 'Normal', 4),
  ('skin_types', 'sensitive', 'Sensitive', 5),
  ('skin_types', 'mature', 'Mature', 6),
  ('skin_concerns', 'fine_lines', 'Fine lines', 1),
  ('skin_concerns', 'dark_spots', 'Dark spots', 2),
  ('skin_concerns', 'dullness', 'Dullness', 3),
  ('skin_concerns', 'uneven_tone', 'Uneven tone', 4),
  ('skin_concerns', 'acne', 'Acne', 5),
  ('skin_concerns', 'large_pores', 'Large pores', 6),
  ('skin_concerns', 'redness', 'Redness', 7),
  ('skin_concerns', 'dehydration', 'Dehydration', 8),
  ('skin_concerns', 'texture', 'Texture', 9),
  ('skin_concerns', 'dark_circles', 'Dark circles', 10),
  ('benefits', 'hydrating', 'Hydrating', 1),
  ('benefits', 'brightening', 'Brightening', 2),
  ('benefits', 'firming', 'Firming', 3),
  ('benefits', 'soothing', 'Soothing', 4),
  ('benefits', 'exfoliating', 'Exfoliating', 5),
  ('benefits', 'oil_control', 'Oil control', 6),
  ('benefits', 'protecting', 'Protecting', 7),
  ('benefits', 'nourishing', 'Nourishing', 8),
  ('formulation_type', 'cream', 'Cream', 1),
  ('formulation_type', 'gel', 'Gel', 2),
  ('formulation_type', 'serum', 'Serum', 3),
  ('formulation_type', 'oil', 'Oil', 4),
  ('formulation_type', 'lotion', 'Lotion', 5),
  ('formulation_type', 'balm', 'Balm', 6),
  ('formulation_type', 'foam', 'Foam', 7),
  ('formulation_type', 'powder', 'Powder', 8),
  ('formulation_type', 'liquid', 'Liquid', 9),
  ('free_from', 'parabens', 'Parabens', 1),
  ('free_from', 'sulfates', 'Sulfates', 2),
  ('free_from', 'phthalates', 'Phthalates', 3),
  ('free_from', 'mineral_oil', 'Mineral oil', 4),
  ('free_from', 'fragrance', 'Fragrance', 5),
  ('free_from', 'silicones', 'Silicones', 6),
  ('free_from', 'alcohol', 'Alcohol', 7),
  ('certification_type', 'cruelty_free', 'Cruelty free', 1),
  ('certification_type', 'vegan', 'Vegan', 2),
  ('certification_type', 'organic', 'Organic', 3),
  ('certification_type', 'dermatologist_tested', 'Dermatologist tested', 4),
  ('certification_type', 'halal', 'Halal', 5),
  ('finish', 'matte', 'Matte', 1),
  ('finish', 'dewy', 'Dewy', 2),
  ('finish', 'natural', 'Natural', 3),
  ('finish', 'satin', 'Satin', 4),
  ('finish', 'radiant', 'Radiant', 5),
  ('gender_target', 'unisex', 'Unisex', 1),
  ('gender_target', 'female', 'Female', 2),
  ('gender_target', 'male', 'Male', 3),
  ('gender_target', 'non_binary', 'Non-Binary', 4),
  ('age_range', 'all_ages', 'All Ages', 1),
  ('age_range', '18_24', '18-24', 2),
  ('age_range', '25_35', '25-35', 3),
  ('age_range', '35_45', '35-45', 4),
  ('age_range', '45_plus', '45+', 5),
  ('age_range', '55_plus', '55+', 6),
  ('coverage', 'sheer', 'Sheer', 1),
  ('coverage', 'light', 'Light', 2),
  ('coverage', 'medium', 'Medium', 3),
  ('coverage', 'full', 'Full', 4),
  ('coverage', 'buildable', 'Buildable', 5),
  ('shade_family', 'warm', 'Warm', 1),
  ('shade_family', 'cool', 'Cool', 2),
  ('shade_family', 'neutral', 'Neutral', 3),
  ('shade_family', 'olive', 'Olive', 4),
  ('absorption_rate', 'instant', 'Instant', 1),
  ('absorption_rate', 'fast', 'Fast', 2),
  ('absorption_rate', 'medium', 'Medium', 3),
  ('absorption_rate', 'slow', 'Slow', 4),
  ('feel_on_skin', 'lightweight', 'Lightweight', 1),
  ('feel_on_skin', 'silky', 'Silky', 2),
  ('feel_on_skin', 'velvety', 'Velvety', 3),
  ('feel_on_skin', 'smooth', 'Smooth', 4),
  ('feel_on_skin', 'cooling', 'Cooling', 5),
  ('feel_on_skin', 'soothing', 'Soothing', 6),
  ('feel_on_skin', 'non_sticky', 'Non-Sticky', 7),
  ('feel_on_skin', 'non_greasy', 'Non-Greasy', 8),
  ('feel_on_skin', 'fast_absorbing', 'Fast Absorbing', 9),
  ('feel_on_skin', 'hydrating', 'Hydrating', 10),
  ('feel_on_skin', 'nourishing', 'Nourishing', 11),
  ('feel_on_skin', 'cushiony', 'Cushiony', 12),
  ('feel_on_skin', 'weightless', 'Weightless', 13),
  ('feel_on_skin', 'comfortable', 'Comfortable', 14),
  ('feel_on_skin', 'breathable', 'Breathable', 15),
  ('feel_on_skin', 'tightening', 'Tightening', 16),
  ('pregnancy_safe', 'safe', 'Safe', 1),
  ('pregnancy_safe', 'consult_doctor', 'Consult Doctor', 2),
  ('pregnancy_safe', 'not_recommended', 'Not Recommended', 3),
  ('season', 'spring', 'Spring', 1),
  ('season', 'summer', 'Summer', 2),
  ('season', 'fall', 'Fall', 3),
  ('season', 'winter', 'Winter', 4),
  ('season', 'all_year', 'All Year', 5),
  ('claims', 'dermatologist_tested', 'Dermatologist Tested', 1),
  ('claims', 'clinically_proven', 'Clinically Proven', 2),
  ('claims', 'allergy_tested', 'Allergy Tested', 3),
  ('claims', 'ophthalmologist_tested', 'Ophthalmologist Tested', 4),
  ('claims', 'non_irritating', 'Non-Irritating', 5),
  ('claims', 'fragrance_free', 'Fragrance Free', 6),
  ('claims', 'oil_free', 'Oil Free', 7),
  ('claims', 'water_resistant', 'Water Resistant', 8),
  ('claims', 'long_lasting', 'Long Lasting', 9),
  ('packaging_type', 'pump_bottle', 'Pump Bottle', 1),
  ('packaging_type', 'dropper_bottle', 'Dropper Bottle', 2),
  ('packaging_type', 'jar', 'Jar', 3),
  ('packaging_type', 'tube', 'Tube', 4),
  ('packaging_type', 'spray_bottle', 'Spray Bottle', 5),
  ('packaging_type', 'stick', 'Stick', 6),
  ('packaging_type', 'compact', 'Compact', 7),
  ('packaging_type', 'pen', 'Pen', 8),
  ('packaging_type', 'sachet', 'Sachet', 9),
  ('packaging_type', 'ampoule', 'Ampoule', 10),
  ('application_method', 'fingertips', 'Fingertips', 1),
  ('application_method', 'palms', 'Palms', 2),
  ('application_method', 'cotton_pad', 'Cotton Pad', 3),
  ('application_method', 'brush', 'Brush', 4),
  ('application_method', 'sponge', 'Sponge', 5),
  ('application_method', 'applicator', 'Applicator', 6),
  ('application_method', 'roller', 'Roller', 7),
  ('application_method', 'spray', 'Spray', 8),
  ('usage_instructions', 'apply_am_pm', 'Apply morning and evening', 1),
  ('usage_instructions', 'apply_clean_skin', 'Apply to clean, dry skin', 2),
  ('usage_instructions', 'apply_damp_skin', 'Apply to clean, damp skin', 3),
  ('usage_instructions', 'apply_2_3_drops', 'Apply 2-3 drops', 4),
  ('usage_instructions', 'apply_thin_layer', 'Apply a thin layer', 5),
  ('usage_instructions', 'apply_generous_amount', 'Apply a generous amount', 6),
  ('usage_instructions', 'massage_gently', 'Massage gently into skin', 7),
  ('usage_instructions', 'pat_until_absorbed', 'Pat until fully absorbed', 8),
  ('usage_instructions', 'use_before_moisturizer', 'Use before moisturizer', 9),
  ('usage_instructions', 'use_after_serum', 'Use after serum', 10),
  ('usage_instructions', 'avoid_eye_area', 'Avoid eye area', 11),
  ('usage_instructions', 'use_sunscreen_after', 'Follow with sunscreen (AM)', 12),
  ('usage_instructions', 'use_2_3_times_week', 'Use 2-3 times per week', 13),
  ('usage_instructions', 'leave_on_overnight', 'Leave on overnight', 14),
  ('usage_instructions', 'rinse_after_10_min', 'Rinse after 10-15 minutes', 15);

-- ── which beauty shops lack which lists; new lists go after the shop's own ───

DROP TEMPORARY TABLE IF EXISTS `tmp133_missing`;
CREATE TEMPORARY TABLE `tmp133_missing` (
  `shop_id`     BIGINT UNSIGNED NOT NULL,
  `code`        VARCHAR(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `sort_order`  SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (`shop_id`, `code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `tmp133_missing` (`shop_id`, `code`, `sort_order`)
SELECT s.`id`,
       l.`code`,
       COALESCE(last.`max_sort`, 0) + ROW_NUMBER() OVER (PARTITION BY s.`id` ORDER BY l.`position`)
  FROM `shops` s
  JOIN `tmp133_lists` l
  LEFT JOIN (SELECT `shop_id`, MAX(`sort_order`) AS `max_sort` FROM `lookup_categories` GROUP BY `shop_id`) last
         ON last.`shop_id` = s.`id`
 WHERE s.`vertical` = 'beauty'
   AND NOT EXISTS (SELECT 1 FROM `lookup_categories` c WHERE c.`shop_id` = s.`id` AND c.`code` = l.`code`);

INSERT INTO `lookup_categories` (`shop_id`, `code`, `name`, `description`, `is_active`, `allow_custom`, `sort_order`)
SELECT m.`shop_id`, m.`code`, l.`name`, NULL, 1, l.`allow_custom`, m.`sort_order`
  FROM `tmp133_missing` m
  JOIN `tmp133_lists` l ON l.`code` = m.`code`;

INSERT IGNORE INTO `lookup_values` (`shop_id`, `category_id`, `code`, `label`, `is_active`, `sort_order`)
SELECT c.`shop_id`, c.`id`, v.`code`, v.`label`, 1, v.`sort_order`
  FROM `tmp133_missing` m
  JOIN `lookup_categories` c ON c.`shop_id` = m.`shop_id` AND c.`code` = m.`code`
  JOIN `tmp133_values` v ON v.`list_code` = m.`code`;

DROP TEMPORARY TABLE IF EXISTS `tmp133_missing`;
DROP TEMPORARY TABLE IF EXISTS `tmp133_values`;
DROP TEMPORARY TABLE IF EXISTS `tmp133_lists`;

-- ── promise icons: only the six the storefront and the admin can draw ────────

UPDATE `content_section_blocks`
   SET `settings` = JSON_SET(`settings`, '$.icon', CASE JSON_UNQUOTE(JSON_EXTRACT(`settings`, '$.icon'))
         WHEN 'return' THEN 'check'
         WHEN 'lock' THEN 'shield'
         WHEN 'ruler' THEN 'check'
         WHEN 'rabbit' THEN 'shield'
         WHEN 'badge' THEN 'star'
         WHEN 'headset' THEN 'check'
         WHEN 'clock' THEN 'truck'
         WHEN 'snowflake' THEN 'shield'
         WHEN 'tool' THEN 'check'
         WHEN 'gift' THEN 'star'
         WHEN 'book' THEN 'star'
         WHEN 'heart' THEN 'check'
         WHEN 'repeat' THEN 'star'
       END)
 WHERE JSON_UNQUOTE(JSON_EXTRACT(`settings`, '$.icon')) IN ('return', 'lock', 'ruler', 'rabbit', 'badge', 'headset', 'clock', 'snowflake', 'tool', 'gift', 'book', 'heart', 'repeat');
