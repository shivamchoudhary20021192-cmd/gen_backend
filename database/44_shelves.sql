-- ────────────────────────────────────────────────────────────────────────────
-- 44 · Shelves — the merchandised rows of products
--
--   mysql -u <user> -p <database> < database/44_shelves.sql
--
-- A shelf is one band of products on a storefront page: "Bestsellers", "New
-- in", "The ones people come back for". Until now the home page held two of
-- them, hard-coded in HomePage.tsx with a fixed four-up grid and a fixed sort.
-- Changing the heading meant a deploy; adding a third meant a developer.
--
-- Two things are being made editable, and they are genuinely separate:
--
--   LAYOUT   how the row is drawn — a swipe carousel, a grid, a spotlight, a
--            ranked chart. This is a presentation choice and belongs to the
--            shelf, not to the products in it.
--
--   SOURCE   which products are in it. Either hand-picked, or a rule the shop
--            states once and the shelf keeps answering for itself: best
--            selling, newly arrived, most saved, most repurchased.
--
-- The pairing is the point. "Top 5 most repurchased, as a ranked chart" and
-- "everything in the Diwali edit, as a carousel" are the same feature.
--
-- ── pinning ─────────────────────────────────────────────────────────────────
--
-- `shelf_products` is not only for manual shelves. A row there is a *pin*: it
-- goes first, in its own order, and the rule fills whatever is left. So a shop
-- can run "Bestsellers" automatically and still hold the new launch in
-- position one for a fortnight. Shopify makes you choose between manual and
-- automatic; the choice is false, and merchandisers work around it by going
-- manual and then never updating it.
--
-- ── why no cached product list ──────────────────────────────────────────────
--
-- A rule is evaluated at request time against a small, bounded window and
-- cached in the service for a few minutes. The tempting alternative — a
-- nightly job that writes the winners into a table — needs a scheduler this
-- system does not have yet, and a stale "Bestsellers" is worse than a slightly
-- expensive one. When the shop is big enough for that to hurt, the rule map in
-- `shelfRules.ts` is the one place to change.
--
-- Idempotent: safe to run twice.
-- ────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

-- No explicit COLLATE: these inherit the database's `utf8mb4_0900_ai_ci`, which
-- every other table here uses. Pinning a different one turns every join against
-- `products` into an "Illegal mix of collations" error.

CREATE TABLE IF NOT EXISTS shelves (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The heading, and the small line above it. Both are the merchandiser's
  -- words: "New in" under "Just landed" says something a sort key cannot.
  title           VARCHAR(120) NOT NULL,
  eyebrow         VARCHAR(60) NULL,
  subtitle        VARCHAR(240) NULL,

  -- Which kind of page this shelf belongs on.
  --   home        the front page
  --   shop        the main product listing
  --   category    a category page
  --   collection  a collection page
  --   product     a product page, below the detail
  placement       ENUM('home','shop','category','collection','product') NOT NULL DEFAULT 'home',

  -- Which *one* of those pages, when the placement has many. A category id for
  -- 'category', a collection id for 'collection'. NULL means every page of that
  -- placement, which is how "Bestsellers" appears under every category at once
  -- without thirty rows saying the same thing.
  --
  -- Deliberately not a foreign key: the column means different things for
  -- different placements, and a constraint can only point at one table. The
  -- service resolves and validates it.
  scope_ref_id    BIGINT UNSIGNED NULL,

  -- How the row is drawn.
  --   carousel  swipe on a phone, arrows on a desktop, the next card peeking
  --   grid      everything at once, two up on a phone and four on a desktop
  --   spotlight one product large with its story, the rest small beside it
  --   ranked    numbered 1..n, which is what makes a chart read as a chart
  layout          ENUM('carousel','grid','spotlight','ranked') NOT NULL DEFAULT 'carousel',

  -- Which products. See `shelfRules.ts` — this column and that map are one
  -- thing in two places, and the service refuses a value the map does not know.
  source          ENUM(
                    'manual',
                    'bestselling',
                    'new_arrivals',
                    'most_loved',
                    'most_repurchased',
                    'trending',
                    'top_rated',
                    'featured',
                    'collection'
                  ) NOT NULL DEFAULT 'manual',

  -- For source = 'collection'. ON DELETE SET NULL rather than CASCADE: deleting
  -- a collection should not silently delete a shelf someone built around it —
  -- the shelf survives, empties, and stops being served until it is repointed.
  source_collection_id BIGINT UNSIGNED NULL,

  -- How far back a windowed rule looks. Best selling over 30 days is a shop's
  -- current taste; over all time it is a monument to whatever sold in year one,
  -- and it stops moving. NULL means the rule's own default.
  window_days     SMALLINT UNSIGNED NULL,

  -- How many products the shelf shows. Small on purpose: a shelf is an
  -- invitation to a page, not the page.
  max_products    TINYINT UNSIGNED NOT NULL DEFAULT 8,

  -- Whether a product that cannot be bought today may still appear. Off by
  -- default: a sold-out product at the top of "Bestsellers" is an accurate
  -- statement and a bad shelf.
  include_sold_out TINYINT(1) NOT NULL DEFAULT 0,

  -- Alternating page bands, which is how the home page already reads.
  tone            ENUM('ivory','cream') NOT NULL DEFAULT 'ivory',

  -- "View all", and where it goes — the same link vocabulary the banners,
  -- menus and announcement lines use, so one admin control serves all four.
  cta_label       VARCHAR(40) NULL,
  link_type       ENUM('none','url','page','category','collection','product','article','policy') NOT NULL DEFAULT 'none',
  link_url        VARCHAR(500) NULL,
  link_ref_id     BIGINT UNSIGNED NULL,

  -- So a festival shelf can be built in September and appear in October
  -- without anyone being awake at midnight.
  starts_at       DATETIME NULL,
  ends_at         DATETIME NULL,

  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  sort_order      SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      DATETIME NULL,

  PRIMARY KEY (id),
  -- The exact shape of the public query: live shelves for one placement, in
  -- order, optionally narrowed to one page.
  KEY idx_shelves_live (deleted_at, is_active, placement, scope_ref_id, sort_order),
  KEY idx_shelves_collection (source_collection_id),
  CONSTRAINT fk_shelves_collection FOREIGN KEY (source_collection_id)
    REFERENCES collections (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The hand-picked products, and the pins on an automatic shelf.
CREATE TABLE IF NOT EXISTS shelf_products (
  shelf_id    BIGINT UNSIGNED NOT NULL,
  product_id  BIGINT UNSIGNED NOT NULL,
  sort_order  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  added_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Composite key rather than a surrogate id: the same product twice on one
  -- shelf is never meaningful, and this makes it impossible rather than merely
  -- discouraged.
  PRIMARY KEY (shelf_id, product_id),
  KEY idx_shelf_products_order (shelf_id, sort_order),
  KEY idx_shelf_products_product (product_id),
  CONSTRAINT fk_shelf_products_shelf FOREIGN KEY (shelf_id)
    REFERENCES shelves (id) ON DELETE CASCADE,
  CONSTRAINT fk_shelf_products_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── the two shelves the home page already had ───────────────────────────────
--
-- Carried across rather than left to disappear when HomePage.tsx stops drawing
-- them itself. Same words, same order, same tone — the page is identical on
-- the first load after this migration, and every part of it is now editable.
--
-- Matched on title so a second run does not duplicate them.

INSERT INTO shelves (title, eyebrow, placement, layout, source, max_products, tone,
                     cta_label, link_type, link_url, sort_order, is_active)
SELECT 'The ones people come back for', 'Most loved', 'home', 'carousel', 'bestselling', 8, 'cream',
       'View all', 'url', '/shop', 10, 1
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM shelves WHERE title = 'The ones people come back for' AND deleted_at IS NULL);

INSERT INTO shelves (title, eyebrow, placement, layout, source, window_days, max_products, tone,
                     cta_label, link_type, link_url, sort_order, is_active)
SELECT 'New in', 'Just landed', 'home', 'carousel', 'new_arrivals', 120, 8, 'ivory',
       'View all', 'url', '/shop?sort=newest', 20, 1
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM shelves WHERE title = 'New in' AND deleted_at IS NULL);

SELECT 'Migration 44 applied.' AS result;
