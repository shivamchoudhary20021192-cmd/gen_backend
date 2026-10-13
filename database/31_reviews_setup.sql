-- =============================================================================
-- File 31 : Product reviews — enable the screen, and make the ratings true
-- =============================================================================
-- No USE statement: the database name differs per environment (veylog locally,
-- veylor_db on the server). Connect to the right one instead:
--   mysql -D <database> < database/31_reviews_setup.sql
--
-- Additive only. The five review tables (reviews, review_replies, review_votes,
-- review_reports, review_invitations) and both permissions (reviews.view,
-- reviews.moderate) were created back in file 11 and seeded in 99; nothing here
-- creates, drops or alters a table.
--
-- Safe to re-run.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Let the moderation queue appear in the sidebar
-- ─────────────────────────────────────────────────────────────────────────────
-- Seeded as 'coming_soon' in 99b_navigation_seed.sql. The route and the
-- registry key land on the same commit as this, which is the pairing that stops
-- a menu row pointing at a screen the deployed bundle does not contain.

UPDATE `menu_items`
   SET `status` = 'available'
 WHERE `menu_key` = 'products.reviews';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Replace the seeded rating figures with derived ones
-- ─────────────────────────────────────────────────────────────────────────────
-- `scripts/seed-catalogue.ts` wrote plausible-looking values — 4.8 average over
-- 1,264 reviews and so on — so the storefront had something to render before the
-- review system existed. The reviews table is empty, so every one of those
-- numbers is a claim about customer sentiment that no customer made.
--
-- Showing fabricated review counts to shoppers is the thing India's IS
-- 19000:2022 standard for online consumer reviews exists to stop, and for a
-- skincare brand an invented efficacy signal is a liability rather than a
-- marketing win. So they are recomputed from real approved rows: today that
-- means zero, and every product correctly shows "no reviews yet" until someone
-- who actually bought it writes one.
--
-- This is the same expression the application uses in
-- reviewsRepository.refreshProductAggregates, so the migration and the runtime
-- can never disagree about what these columns mean:
--   rating_count = approved reviews (all carry a star rating)
--   review_count = approved reviews that also wrote something
--   rating_average = mean of the approved ratings, 0 when there are none

UPDATE `products` p
   SET p.`rating_average` = COALESCE((
         SELECT ROUND(AVG(r.`rating`), 2) FROM `reviews` r
          WHERE r.`product_id` = p.`id` AND r.`status` = 'approved' AND r.`deleted_at` IS NULL), 0),
       p.`rating_count` = (
         SELECT COUNT(*) FROM `reviews` r
          WHERE r.`product_id` = p.`id` AND r.`status` = 'approved' AND r.`deleted_at` IS NULL),
       p.`review_count` = (
         SELECT COUNT(*) FROM `reviews` r
          WHERE r.`product_id` = p.`id` AND r.`status` = 'approved' AND r.`deleted_at` IS NULL
            AND r.`body` IS NOT NULL AND TRIM(r.`body`) <> '')
 WHERE p.`deleted_at` IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Report
-- ─────────────────────────────────────────────────────────────────────────────

SELECT 'Reviews enabled. Product ratings now derived from approved reviews.' AS message,
       (SELECT COUNT(*) FROM `menu_items`
         WHERE `menu_key` = 'products.reviews' AND `status` = 'available') AS menu_enabled,
       (SELECT COUNT(*) FROM `reviews` WHERE `deleted_at` IS NULL) AS reviews_total,
       (SELECT COUNT(*) FROM `products`
         WHERE `deleted_at` IS NULL AND `rating_count` > 0) AS products_with_ratings;
