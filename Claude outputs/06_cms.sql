-- =============================================================================
-- File 06 : CONTENT MANAGEMENT SYSTEM  (Shopify-equivalent)
-- =============================================================================
-- Mapping to the Shopify concepts you asked for:
--
--   Shopify                         here
--   ------------------------------  ------------------------------------------
--   Pages                           cms_pages
--   Theme sections & blocks         cms_page_sections + cms_section_blocks
--   Blogs / Articles                cms_blogs + cms_articles
--   Navigation menus                cms_menus + cms_menu_items
--   Metafields / Metaobjects        metafield_definitions + metafields
--   Metaobject entries              cms_entries + cms_entry_values
--   URL redirects                   cms_redirects
--   SEO fields on every resource    seo_meta (polymorphic)
--   Files                           media (file 02)
--   Theme settings                  settings (file 13)
--
-- The section/block model is the important one. A homepage is not a blob of
-- HTML — it is an ordered list of typed sections, each with JSON settings and
-- its own ordered blocks. That is what lets the content team reorder the
-- homepage modules in BRD §7.2 (hero → trust strip → routine → ingredient
-- story → texture → evidence → reviews → education → founder note → opt-in)
-- without a deploy, and lets a developer add a new section type by shipping one
-- React component plus a settings schema.
--
-- Every content entity here supports: draft → in_review → scheduled →
-- published → archived, plus versioned snapshots for rollback. BRD §18 makes
-- "preview, SEO fields, scheduled publish, author/reviewer and
-- rollback/version" a definition of done.
-- =============================================================================

USE `veylog`;

-- -----------------------------------------------------------------------------
-- cms_pages
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_pages` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`           CHAR(36)        NOT NULL DEFAULT (UUID()),
  `parent_id`           BIGINT UNSIGNED     NULL,
  `slug`                VARCHAR(191)    NOT NULL,
  `full_path`           VARCHAR(500)    NOT NULL,   -- '/policies/shipping'
  `title`               VARCHAR(191)    NOT NULL,
  `subtitle`            VARCHAR(255)        NULL,
  `page_type`           ENUM('home','standard','landing','policy','about',
                             'support','concern','ingredient_library','custom')
                                        NOT NULL DEFAULT 'standard',
  `template`            VARCHAR(60)     NOT NULL DEFAULT 'default',
  `locale`              VARCHAR(10)     NOT NULL DEFAULT 'en-IN',

  -- Pages are either section-composed (page_type home/landing) or a single
  -- rich-text body (policies, about). Both are supported; use one or the other.
  `body_html`           LONGTEXT            NULL,
  `body_json`           JSON                NULL,
  `hero_media_id`       BIGINT UNSIGNED     NULL,

  `status`              ENUM('draft','in_review','scheduled','published','archived')
                                        NOT NULL DEFAULT 'draft',
  `published_at`        DATETIME            NULL,
  `scheduled_at`        DATETIME            NULL,
  `unpublish_at`        DATETIME            NULL,

  -- BRD §17: "Staging/preview and approval workflow exist for claims-sensitive
  -- pages." A page flagged here cannot move to `published` without a reviewer.
  `requires_legal_review` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `reviewed_by_admin_id` BIGINT UNSIGNED    NULL,
  `reviewed_at`         DATETIME            NULL,
  `review_due_at`       DATE                NULL,

  `is_indexable`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `show_in_sitemap`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `preview_token`       CHAR(36)            NULL,   -- share an unpublished draft
  `current_version`     INT UNSIGNED    NOT NULL DEFAULT 1,
  `view_count`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `author_admin_id`     BIGINT UNSIGNED     NULL,
  `updated_by_admin_id` BIGINT UNSIGNED     NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_pages_slug_locale` (`slug`, `locale`),
  UNIQUE KEY `uq_cms_pages_public_id` (`public_id`),
  KEY `ix_cms_pages_status` (`status`, `published_at`),
  KEY `ix_cms_pages_type` (`page_type`),
  KEY `ix_cms_pages_parent` (`parent_id`),
  KEY `ix_cms_pages_scheduled` (`status`, `scheduled_at`),
  CONSTRAINT `fk_cms_pages_parent`
    FOREIGN KEY (`parent_id`) REFERENCES `cms_pages` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_pages_hero`
    FOREIGN KEY (`hero_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_pages_author`
    FOREIGN KEY (`author_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_pages_reviewer`
    FOREIGN KEY (`reviewed_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_pages_updater`
    FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- cms_page_sections — the ordered modules on a page
-- -----------------------------------------------------------------------------
-- section_key is the React component name the renderer resolves. Launch set,
-- straight from BRD §7.2 / §10.3:
--   announcement_bar, hero, trust_strip, two_product_routine,
--   ingredient_story, texture_proof, evidence_results, reviews_ugc,
--   education_articles, founder_note, optin, faq, rich_text, image_with_text,
--   product_grid, collection_banner, comparison_table, support_panel
--
-- `settings` holds whatever that component needs (headline, CTA label, layout
-- variant, background token). It is JSON because the shape differs per section
-- type and is validated by a per-type schema in application code — this is the
-- exact same trade-off Shopify makes with section settings.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_page_sections` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `page_id`        BIGINT UNSIGNED NOT NULL,
  `section_key`    VARCHAR(60)     NOT NULL,
  `name`           VARCHAR(120)        NULL,   -- admin-facing label
  `sort_order`     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_enabled`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `settings`       JSON                NULL,
  `background`     VARCHAR(40)         NULL,   -- design token: ivory|sand|ink|white
  `padding_top`    ENUM('none','sm','md','lg','xl') NOT NULL DEFAULT 'md',
  `padding_bottom` ENUM('none','sm','md','lg','xl') NOT NULL DEFAULT 'md',
  -- optional scheduling of a single module (campaign strip, launch banner)
  `visible_from`   DATETIME            NULL,
  `visible_until`  DATETIME            NULL,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_cms_page_sections_page` (`page_id`, `sort_order`),
  KEY `ix_cms_page_sections_key` (`section_key`),
  CONSTRAINT `fk_cms_page_sections_page`
    FOREIGN KEY (`page_id`) REFERENCES `cms_pages` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Repeatable children within a section: the three ingredient cards, the four
-- trust claims, the five slides in a carousel.
CREATE TABLE `cms_section_blocks` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `section_id`  BIGINT UNSIGNED NOT NULL,
  `block_type`  VARCHAR(60)     NOT NULL,   -- claim_tile|ingredient_card|slide|step|faq_item
  `sort_order`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_enabled`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `heading`     VARCHAR(255)        NULL,
  `body`        TEXT                NULL,
  `media_id`    BIGINT UNSIGNED     NULL,
  `link_type`   ENUM('none','url','page','product','collection','category','article')
                                NOT NULL DEFAULT 'none',
  `link_ref_id` BIGINT UNSIGNED     NULL,
  `link_url`    VARCHAR(500)        NULL,
  `cta_label`   VARCHAR(60)         NULL,
  -- Every efficacy line rendered on the site should point at an approved claim.
  `claim_id`    BIGINT UNSIGNED     NULL,
  `settings`    JSON                NULL,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_cms_section_blocks_section` (`section_id`, `sort_order`),
  CONSTRAINT `fk_cms_section_blocks_section`
    FOREIGN KEY (`section_id`) REFERENCES `cms_page_sections` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_section_blocks_media`
    FOREIGN KEY (`media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_section_blocks_claim`
    FOREIGN KEY (`claim_id`) REFERENCES `claims` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- cms_revisions — rollback for any content entity
-- Snapshot is the fully composed JSON of the entity plus its children, so a
-- restore is a single deterministic write and does not depend on the current
-- schema of the live tables.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_revisions` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entity_type`     ENUM('page','article','product','banner','menu','entry','ingredient')
                                    NOT NULL,
  `entity_id`       BIGINT UNSIGNED NOT NULL,
  `version`         INT UNSIGNED    NOT NULL,
  `snapshot`        JSON            NOT NULL,
  `change_note`     VARCHAR(255)        NULL,
  `is_published_version` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_revisions` (`entity_type`, `entity_id`, `version`),
  KEY `ix_cms_revisions_entity` (`entity_type`, `entity_id`, `created_at`),
  CONSTRAINT `fk_cms_revisions_admin`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Blogs and articles (the Journal)
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_blogs` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`        VARCHAR(140)    NOT NULL,   -- 'journal'
  `title`       VARCHAR(160)    NOT NULL,
  `description` VARCHAR(500)        NULL,
  `is_active`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_blogs_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cms_article_categories` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`       VARCHAR(140)    NOT NULL,
  `name`       VARCHAR(120)    NOT NULL,
  `description` VARCHAR(500)       NULL,
  `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_active`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_article_categories_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cms_articles` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`           CHAR(36)        NOT NULL DEFAULT (UUID()),
  `blog_id`             BIGINT UNSIGNED NOT NULL,
  `category_id`         BIGINT UNSIGNED     NULL,
  `slug`                VARCHAR(191)    NOT NULL,
  `title`               VARCHAR(191)    NOT NULL,
  `subtitle`            VARCHAR(255)        NULL,
  `excerpt`             VARCHAR(500)        NULL,
  `body_html`           LONGTEXT            NULL,
  `body_json`           JSON                NULL,
  `cover_media_id`      BIGINT UNSIGNED     NULL,
  `locale`              VARCHAR(10)     NOT NULL DEFAULT 'en-IN',

  -- Byline is free text: a guest dermatologist is not an admin_user.
  `author_name`         VARCHAR(120)        NULL,
  `author_title`        VARCHAR(160)        NULL,
  `author_media_id`     BIGINT UNSIGNED     NULL,
  `author_admin_id`     BIGINT UNSIGNED     NULL,
  -- BRD §16 SEO + §9 claims: medical-adjacent education needs a named reviewer
  -- and a visible review date.
  `medically_reviewed_by` VARCHAR(160)      NULL,
  `reviewed_at`         DATE                NULL,
  `next_review_due`     DATE                NULL,

  `read_time_minutes`   TINYINT UNSIGNED    NULL,
  `status`              ENUM('draft','in_review','scheduled','published','archived')
                                        NOT NULL DEFAULT 'draft',
  `is_featured`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `published_at`        DATETIME            NULL,
  `scheduled_at`        DATETIME            NULL,
  `is_indexable`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `view_count`          INT UNSIGNED    NOT NULL DEFAULT 0,
  `current_version`     INT UNSIGNED    NOT NULL DEFAULT 1,
  `preview_token`       CHAR(36)            NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`          DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_articles_slug_locale` (`slug`, `locale`),
  UNIQUE KEY `uq_cms_articles_public_id` (`public_id`),
  KEY `ix_cms_articles_blog` (`blog_id`, `status`, `published_at`),
  KEY `ix_cms_articles_featured` (`is_featured`, `published_at`),
  KEY `ix_cms_articles_category` (`category_id`),
  FULLTEXT KEY `ft_cms_articles_search` (`title`, `excerpt`, `body_html`),
  CONSTRAINT `fk_cms_articles_blog`
    FOREIGN KEY (`blog_id`) REFERENCES `cms_blogs` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_articles_category`
    FOREIGN KEY (`category_id`) REFERENCES `cms_article_categories` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_articles_cover`
    FOREIGN KEY (`cover_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_articles_author_media`
    FOREIGN KEY (`author_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_articles_author_admin`
    FOREIGN KEY (`author_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Articles → products ("shop this routine" inside an editorial piece)
CREATE TABLE `cms_article_products` (
  `article_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`article_id`, `product_id`),
  KEY `ix_cms_article_products_product` (`product_id`),
  CONSTRAINT `fk_cms_article_products_article`
    FOREIGN KEY (`article_id`) REFERENCES `cms_articles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_article_products_product`
    FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Navigation menus — header, footer, mobile drawer, support
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_menus` (
  `id`        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`      VARCHAR(60)     NOT NULL,   -- main|footer_shop|footer_support|mobile_drawer
  `name`      VARCHAR(120)    NOT NULL,
  `is_active` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_menus_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- link_type + link_ref_id instead of a hardcoded URL, so renaming a product
-- slug never leaves a dead nav item. `url` is used only for link_type='url'.
CREATE TABLE `cms_menu_items` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `menu_id`       BIGINT UNSIGNED NOT NULL,
  `parent_id`     BIGINT UNSIGNED     NULL,
  `label`         VARCHAR(120)    NOT NULL,
  `link_type`     ENUM('url','page','category','collection','product','article',
                       'policy','ingredient','routine','none')
                                  NOT NULL DEFAULT 'url',
  `link_ref_id`   BIGINT UNSIGNED     NULL,
  `url`           VARCHAR(500)        NULL,
  `icon_media_id` BIGINT UNSIGNED     NULL,
  `image_media_id` BIGINT UNSIGNED    NULL,   -- mega-menu promo tile
  `badge_label`   VARCHAR(30)         NULL,   -- 'New'
  `description`   VARCHAR(255)        NULL,
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `opens_new_tab` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_active`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  KEY `ix_cms_menu_items_menu` (`menu_id`, `parent_id`, `sort_order`),
  CONSTRAINT `fk_cms_menu_items_menu`
    FOREIGN KEY (`menu_id`) REFERENCES `cms_menus` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_menu_items_parent`
    FOREIGN KEY (`parent_id`) REFERENCES `cms_menu_items` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_menu_items_icon`
    FOREIGN KEY (`icon_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_menu_items_image`
    FOREIGN KEY (`image_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- cms_banners — announcement bar, hero carousel, promo strips
-- BRD §7.1 warns against rotating three offers, so `priority` + date windows
-- exist to make exactly one win at a time rather than to build a carousel.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_banners` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`              VARCHAR(120)    NOT NULL,   -- internal
  `placement`         ENUM('announcement_bar','home_hero','home_carousel',
                           'category_top','pdp_strip','cart_drawer','checkout',
                           'popup','footer')
                                      NOT NULL,
  `title`             VARCHAR(191)        NULL,
  `subtitle`          VARCHAR(255)        NULL,
  `body`              VARCHAR(500)        NULL,
  `cta_label`         VARCHAR(60)         NULL,
  `cta_link_type`     ENUM('url','page','category','collection','product','article','none')
                                      NOT NULL DEFAULT 'none',
  `cta_link_ref_id`   BIGINT UNSIGNED     NULL,
  `cta_url`           VARCHAR(500)        NULL,
  `desktop_media_id`  BIGINT UNSIGNED     NULL,
  `mobile_media_id`   BIGINT UNSIGNED     NULL,   -- art-directed mobile crop
  `background_hex`    CHAR(7)             NULL,
  `text_hex`          CHAR(7)             NULL,
  `audience`          ENUM('all','new_visitors','returning','logged_in','guests')
                                      NOT NULL DEFAULT 'all',
  `starts_at`         DATETIME            NULL,
  `ends_at`           DATETIME            NULL,
  `priority`          SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_active`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `is_dismissible`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `impression_count`  INT UNSIGNED    NOT NULL DEFAULT 0,
  `click_count`       INT UNSIGNED    NOT NULL DEFAULT 0,
  `created_by_admin_id` BIGINT UNSIGNED   NULL,
  `created_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_cms_banners_slot` (`placement`, `is_active`, `priority`),
  KEY `ix_cms_banners_window` (`starts_at`, `ends_at`),
  CONSTRAINT `fk_cms_banners_desktop_media`
    FOREIGN KEY (`desktop_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_banners_mobile_media`
    FOREIGN KEY (`mobile_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_banners_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- FAQs — global groups, or attached to any entity (product, policy, shipping)
-- BRD §7.3 requires product FAQs to be server-rendered and indexable.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_faq_groups` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`       VARCHAR(140)    NOT NULL,
  `name`       VARCHAR(160)    NOT NULL,
  `description` VARCHAR(500)       NULL,
  `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_active`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_faq_groups_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cms_faqs` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `group_id`     BIGINT UNSIGNED     NULL,
  `entity_type`  VARCHAR(40)         NULL,   -- 'product','cms_page', NULL = global
  `entity_id`    BIGINT UNSIGNED     NULL,
  `question`     VARCHAR(500)    NOT NULL,
  `answer`       TEXT            NOT NULL,
  `claim_id`     BIGINT UNSIGNED     NULL,
  `sort_order`   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_published` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `is_indexable` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,   -- FAQPage schema
  `helpful_count` INT UNSIGNED   NOT NULL DEFAULT 0,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_cms_faqs_group` (`group_id`, `sort_order`),
  KEY `ix_cms_faqs_entity` (`entity_type`, `entity_id`, `sort_order`),
  CONSTRAINT `fk_cms_faqs_group`
    FOREIGN KEY (`group_id`) REFERENCES `cms_faq_groups` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_cms_faqs_claim`
    FOREIGN KEY (`claim_id`) REFERENCES `claims` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- cms_redirects — BRD §16 "Redirect map protects URLs during renaming"
-- The app should also auto-insert a row whenever a product/page slug changes.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_redirects` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `from_path`    VARCHAR(500)    NOT NULL,
  `to_path`      VARCHAR(500)    NOT NULL,
  `status_code`  SMALLINT UNSIGNED NOT NULL DEFAULT 301,
  `is_active`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `is_auto`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,   -- created by slug change
  `hit_count`    INT UNSIGNED    NOT NULL DEFAULT 0,
  `last_hit_at`  DATETIME            NULL,
  `note`         VARCHAR(255)        NULL,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_redirects_from` (`from_path`),
  KEY `ix_cms_redirects_active` (`is_active`),
  CONSTRAINT `fk_cms_redirects_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- seo_meta — one polymorphic table instead of six sets of near-identical
-- columns on products, collections, categories, pages, articles, ingredients.
-- BRD §16: "Unique title, meta description, H1 and canonical for every
-- indexable route."
-- -----------------------------------------------------------------------------
CREATE TABLE `seo_meta` (
  `id`               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entity_type`      VARCHAR(40)     NOT NULL,   -- product|collection|category|cms_page|cms_article|ingredient|routine
  `entity_id`        BIGINT UNSIGNED NOT NULL,
  `locale`           VARCHAR(10)     NOT NULL DEFAULT 'en-IN',
  `meta_title`       VARCHAR(200)        NULL,
  `meta_description` VARCHAR(320)        NULL,
  `h1_override`      VARCHAR(191)        NULL,
  `canonical_url`    VARCHAR(500)        NULL,
  `og_title`         VARCHAR(200)        NULL,
  `og_description`   VARCHAR(320)        NULL,
  `og_media_id`      BIGINT UNSIGNED     NULL,
  `twitter_card`     ENUM('summary','summary_large_image') NOT NULL DEFAULT 'summary_large_image',
  `robots_index`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `robots_follow`    TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  -- Extra or overriding JSON-LD. Product/Article/Breadcrumb schema is generated
  -- from live data; this is for anything the generator cannot know.
  `structured_data`  JSON                NULL,
  `sitemap_priority` DECIMAL(2,1)        NULL,
  `sitemap_changefreq` ENUM('always','hourly','daily','weekly','monthly','yearly','never') NULL,
  `updated_by_admin_id` BIGINT UNSIGNED  NULL,
  `updated_at`       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_seo_meta` (`entity_type`, `entity_id`, `locale`),
  CONSTRAINT `fk_seo_meta_og_media`
    FOREIGN KEY (`og_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_seo_meta_updater`
    FOREIGN KEY (`updated_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Metafields — Shopify's escape hatch, and the reason this CMS will not need a
-- migration every time marketing invents a new field.
--
-- Define once in metafield_definitions ("product / veylor / clinical_study_pdf,
-- type media"), then store values per entity in metafields. The typed value
-- columns (rather than one JSON blob) mean you can still filter and sort:
-- "all products where veylor.spf_rating >= 50" is an indexed query.
-- -----------------------------------------------------------------------------
CREATE TABLE `metafield_definitions` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `owner_type`  VARCHAR(40)     NOT NULL,   -- product|variant|collection|cms_page|customer|order
  `namespace`   VARCHAR(50)     NOT NULL DEFAULT 'veylor',
  `meta_key`    VARCHAR(60)     NOT NULL,
  `name`        VARCHAR(120)    NOT NULL,
  `description` VARCHAR(500)        NULL,
  `value_type`  ENUM('single_line_text','multi_line_text','rich_text','integer',
                     'decimal','boolean','date','datetime','json','url','color',
                     'media','media_list','product_ref','collection_ref','entry_ref')
                                NOT NULL DEFAULT 'single_line_text',
  `validations` JSON                NULL,   -- {"min":0,"max":100,"choices":[...]}
  `is_required` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_public`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,   -- exposed to storefront API
  `is_filterable` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `sort_order`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `created_at`  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_metafield_definitions` (`owner_type`, `namespace`, `meta_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `metafields` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `definition_id`  BIGINT UNSIGNED     NULL,
  `owner_type`     VARCHAR(40)     NOT NULL,
  `owner_id`       BIGINT UNSIGNED NOT NULL,
  `namespace`      VARCHAR(50)     NOT NULL DEFAULT 'veylor',
  `meta_key`       VARCHAR(60)     NOT NULL,
  `locale`         VARCHAR(10)     NOT NULL DEFAULT 'en-IN',
  `value_text`     LONGTEXT            NULL,
  `value_number`   DECIMAL(20,6)       NULL,
  `value_boolean`  TINYINT(1) UNSIGNED NULL,
  `value_datetime` DATETIME            NULL,
  `value_json`     JSON                NULL,
  `value_media_id` BIGINT UNSIGNED     NULL,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_metafields` (`owner_type`, `owner_id`, `namespace`, `meta_key`, `locale`),
  KEY `ix_metafields_owner` (`owner_type`, `owner_id`),
  KEY `ix_metafields_key_number` (`namespace`, `meta_key`, `value_number`),
  CONSTRAINT `fk_metafields_definition`
    FOREIGN KEY (`definition_id`) REFERENCES `metafield_definitions` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_metafields_media`
    FOREIGN KEY (`value_media_id`) REFERENCES `media` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Custom content types (Shopify "metaobjects").
-- Lets the team model something new — press mentions, store locators, founder
-- timeline entries, lab partners — as first-class, listable, referenceable
-- content without any schema change.
-- -----------------------------------------------------------------------------
CREATE TABLE `cms_entry_types` (
  `id`             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`           VARCHAR(60)     NOT NULL,   -- 'press_mention'
  `name`           VARCHAR(120)    NOT NULL,
  `description`    VARCHAR(500)        NULL,
  `has_own_page`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `url_prefix`     VARCHAR(100)        NULL,   -- '/press'
  `field_schema`   JSON            NOT NULL,   -- ordered field definitions
  `is_active`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_entry_types_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `cms_entries` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entry_type_id` BIGINT UNSIGNED NOT NULL,
  `slug`          VARCHAR(191)    NOT NULL,
  `title`         VARCHAR(191)    NOT NULL,
  `data`          JSON            NOT NULL,   -- validated against field_schema
  `status`        ENUM('draft','published','archived') NOT NULL DEFAULT 'draft',
  `sort_order`    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `published_at`  DATETIME            NULL,
  `created_by_admin_id` BIGINT UNSIGNED NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`    DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_cms_entries_slug` (`entry_type_id`, `slug`),
  KEY `ix_cms_entries_status` (`entry_type_id`, `status`, `sort_order`),
  CONSTRAINT `fk_cms_entries_type`
    FOREIGN KEY (`entry_type_id`) REFERENCES `cms_entry_types` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cms_entries_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
