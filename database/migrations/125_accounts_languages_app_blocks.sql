-- =============================================================================
-- 125 — The rest of the Online Store: customer accounts, languages and
--       translations, and app blocks (theme app extensions).
--
--   shop_languages          the languages a store is offered in (tenant). The
--                           primary language is the shop's own locale; every
--                           other published one is served under /<code>/.
--   translations            a store's translated content (tenant): products,
--                           collections, pages, articles, menu links and the
--                           live theme's text settings — Shopify's
--                           Translate & Adapt, one row per field.
--   app_theme_extensions    an app's theme extension (control plane): the
--                           Liquid blocks and assets it ships. Blocks target
--                           a section ("@app" blocks the merchant adds in the
--                           editor) or the page head/body (app embeds).
--
-- Customer accounts need no table: they are the phone-code sign-in the
-- Storefront API already has (`customer_sessions`), and the switch lives in
-- `settings` as online_store.customer_accounts.
-- =============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `shop_languages` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`     BIGINT UNSIGNED NOT NULL,
  -- BCP 47, lower-case language with an optional region: 'hi', 'fr', 'pt-br'.
  `locale`      VARCHAR(10)  NOT NULL,
  `published`   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_shop_languages_locale` (`shop_id`, `locale`),
  UNIQUE KEY `uq_shop_languages_tenant` (`shop_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `translations` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`        BIGINT UNSIGNED NOT NULL,
  -- product | collection | page | article | link | theme
  `resource_type`  VARCHAR(30)  NOT NULL,
  -- The resource's id; for theme content, the installed theme's id.
  `resource_id`    BIGINT UNSIGNED NOT NULL,
  `locale`         VARCHAR(10)  NOT NULL,
  -- 'title', 'body_html'… or, for theme content, where the text lives:
  -- 'templates/index.json::hero::heading'.
  `field`          VARCHAR(191) NOT NULL,
  `value`          MEDIUMTEXT   NOT NULL,
  -- A digest of the original text when it was translated, so the editor can
  -- flag a translation whose source has changed since ("outdated").
  `source_digest`  CHAR(64)     NULL,
  `created_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_translations_field` (`shop_id`, `resource_type`, `resource_id`, `locale`, `field`),
  UNIQUE KEY `uq_translations_tenant` (`shop_id`, `id`),
  KEY `ix_translations_locale` (`shop_id`, `locale`, `resource_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `app_theme_extensions` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `app_id`      BIGINT UNSIGNED NOT NULL,
  -- Bumped on every deploy; part of every asset URL, so browsers never keep an old file.
  `version`     INT UNSIGNED NOT NULL DEFAULT 1,
  -- { "blocks/rating.liquid": "…", "assets/rating.css": "…" }
  `files`       JSON NOT NULL,
  `checksum`    CHAR(64) NOT NULL,
  `deployed_by` VARCHAR(191) NULL,
  `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_app_theme_extensions_app` (`app_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── the admin's sidebar ───────────────────────────────────────────────────

INSERT INTO `menu_items` (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
)
SELECT parent.id, entry.menu_key, entry.title, entry.icon, 'material', entry.route, 0,
       entry.route, CONCAT('menu.', entry.menu_key), 'default', entry.sort_order, 'available',
       1, 1, 0, 1, 0, 0, 0, 1
  FROM (SELECT id FROM `menu_items` WHERE `menu_key` = 'settings' LIMIT 1) AS parent,
       (
    SELECT 'settings.customer_accounts' AS menu_key, 'Customer accounts' AS title, 'account' AS icon, '/settings/customer-accounts' AS route, 32 AS sort_order
    UNION ALL
    SELECT 'settings.languages', 'Languages', 'language', '/settings/languages', 27
       ) AS entry
ON DUPLICATE KEY UPDATE
  parent_id    = VALUES(parent_id),
  title        = VALUES(title),
  icon         = VALUES(icon),
  route        = VALUES(route),
  active_match = VALUES(active_match),
  sort_order   = VALUES(sort_order),
  status       = VALUES(status);

INSERT INTO `menu_item_permissions` (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM `menu_items` mi
  JOIN `permissions` p ON p.slug = 'settings.view'
 WHERE mi.menu_key IN ('settings.customer_accounts', 'settings.languages')
   AND NOT EXISTS (
         SELECT 1 FROM `menu_item_permissions` existing
          WHERE existing.menu_item_id = mi.id AND existing.permission_id = p.id
       );
