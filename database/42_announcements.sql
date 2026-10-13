-- ────────────────────────────────────────────────────────────────────────────
-- 42 · The announcement strip above the header
--
-- The dark line at the very top of every page. Until now it was one banner in
-- the CMS with `placement = 'announcement_bar'`, and a banner is the wrong
-- shape for it: a banner carries a photograph, a desktop and a mobile crop, a
-- background colour and a call to action, because a banner is a hero. This is
-- a sentence.
--
-- What a shop actually wants there is several sentences, rotating: free
-- delivery, the student offer, the festival code, "dermatologist tested". They
-- are peers, not a queue with one winner, and one of them is on at a time only
-- because there is room for one at a time.
--
-- Two tables:
--
--   announcements          the lines themselves, ordered, each optionally
--                          carrying a coupon and a link
--   announcement_settings   one row, because the rotation speed and the colours
--                          belong to the strip rather than to any line in it
--
-- A line may point at a coupon. The code is never copied into the message: it
-- is read live from `coupons` at request time, so a code that has expired, been
-- switched off or run out of uses stops being advertised without anyone
-- remembering to take the line down. A storefront promising STUDENT20 three
-- weeks after it died is a support ticket, not a campaign.
--
-- Idempotent: safe to run twice.
-- ────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

-- No explicit COLLATE on either table: they inherit the database's, which is
-- what every other table here uses. Pinning `utf8mb4_unicode_ci` while the rest
-- of the schema is on `utf8mb4_0900_ai_ci` makes every comparison against
-- another table an "Illegal mix of collations" error — which is exactly how the
-- carry-over below failed the first time it was written.

CREATE TABLE IF NOT EXISTS announcements (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The sentence. Short on purpose: this strip is one line tall on a phone,
  -- and anything that wraps to three lines pushes the shop down the screen.
  message       VARCHAR(160) NOT NULL,

  -- The offer this line is advertising, if any. ON DELETE SET NULL rather than
  -- CASCADE: deleting a coupon should not silently delete the merchandiser's
  -- copy — the line survives, loses its code, and stops being shown until
  -- someone attaches a live one or rewrites it.
  coupon_id     BIGINT UNSIGNED NULL,

  -- Where the line goes when clicked, in the same vocabulary the banners and
  -- menu items already use, so one admin control can serve all three.
  link_type     ENUM('none','url','page','category','collection','product','article','policy') NOT NULL DEFAULT 'none',
  link_url      VARCHAR(500) NULL,
  link_ref_id   BIGINT UNSIGNED NULL,
  cta_label     VARCHAR(40) NULL,

  -- Scheduling, so a festival line can be written in September and appear in
  -- October without anyone being awake at midnight.
  starts_at     DATETIME NULL,
  ends_at       DATETIME NULL,

  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  sort_order    SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at    DATETIME NULL,

  PRIMARY KEY (id),
  -- The exact shape of the public query: live rows, in order.
  KEY idx_announcements_live (deleted_at, is_active, sort_order),
  KEY idx_announcements_coupon (coupon_id),
  CONSTRAINT fk_announcements_coupon FOREIGN KEY (coupon_id) REFERENCES coupons (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row, id = 1, enforced by the CHECK below. A settings table that can grow
-- a second row is a settings table that eventually has two disagreeing ones.
CREATE TABLE IF NOT EXISTS announcement_settings (
  id                BIGINT UNSIGNED NOT NULL DEFAULT 1,

  is_enabled        TINYINT(1) NOT NULL DEFAULT 1,

  -- How long each line is held before the next one. Bounded in the API as well
  -- as here: a strip that changes every second is unreadable, and one that
  -- changes every ten minutes is not rotating at all.
  rotation_seconds  SMALLINT UNSIGNED NOT NULL DEFAULT 30,

  is_dismissible    TINYINT(1) NOT NULL DEFAULT 0,
  background_hex    VARCHAR(7) NULL,
  text_hex          VARCHAR(7) NULL,

  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  CONSTRAINT chk_announcement_settings_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO announcement_settings (id) VALUES (1);

-- The line the storefront has always shown, so the strip is not empty the
-- moment this ships. It is an ordinary row and can be edited or removed.
INSERT INTO announcements (message, link_type, is_active, sort_order)
SELECT 'Complimentary delivery on orders over ₹999 · Dermatologist tested', 'none', 1, 0
  FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM announcements WHERE deleted_at IS NULL);

-- ── carrying over what was already published ────────────────────────────────
--
-- The strip used to be served by a CMS banner with `placement =
-- 'announcement_bar'`. Anything scheduled there is copied across rather than
-- left to disappear the moment the storefront stops reading that placement —
-- a merchandiser should not lose a live line because the implementation behind
-- it changed.
--
-- Title and subtitle are joined into the one sentence this strip holds, and the
-- banner's schedule comes with it. Matched on the message so a second run does
-- not duplicate the lines the first one made.
INSERT INTO announcements (message, link_type, link_url, cta_label, starts_at, ends_at, is_active, sort_order)
SELECT
  LEFT(TRIM(CONCAT(COALESCE(b.title, b.name), COALESCE(CONCAT(' · ', b.subtitle), ''))), 160),
  CASE WHEN b.cta_url IS NOT NULL THEN 'url' ELSE 'none' END,
  b.cta_url,
  b.cta_label,
  b.starts_at,
  b.ends_at,
  b.is_active,
  10 + b.priority
FROM cms_banners b
WHERE b.placement = 'announcement_bar'
  AND COALESCE(b.title, b.name) IS NOT NULL
  AND NOT EXISTS (
        SELECT 1 FROM announcements a
         WHERE a.deleted_at IS NULL
           AND a.message = LEFT(TRIM(CONCAT(COALESCE(b.title, b.name), COALESCE(CONCAT(' · ', b.subtitle), ''))), 160)
      );

-- And switched off where they were, so the CMS does not keep offering a slot
-- nothing reads. The rows are left in place rather than deleted: they are
-- someone's work, and the copy has just been carried across, not destroyed.
UPDATE cms_banners SET is_active = 0 WHERE placement = 'announcement_bar' AND is_active = 1;
