-- =============================================================================
-- 130 — Blog comments, as on Shopify.
--
-- Each blog chooses: comments off (the default, as on Shopify), allowed but
-- held for a person to approve, or published straight away. Shoppers post
-- with the theme's {% form 'new_comment', article %}; staff moderate in
-- Content → Comments (publish, mark as spam, remove).
-- =============================================================================

ALTER TABLE `cms_blogs`
  ADD COLUMN `comments_policy` ENUM('disabled','moderated','published') NOT NULL DEFAULT 'disabled' AFTER `description`;

CREATE TABLE IF NOT EXISTS `blog_comments` (
  `id`                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `shop_id`                BIGINT UNSIGNED NOT NULL,
  `article_id`             BIGINT UNSIGNED NOT NULL,
  `customer_id`            BIGINT UNSIGNED NULL,
  `author`                 VARCHAR(120)    NOT NULL,
  `email`                  VARCHAR(191)    NOT NULL,
  `body`                   TEXT            NOT NULL,
  `status`                 ENUM('pending','published','spam','removed') NOT NULL DEFAULT 'pending',
  `ip`                     VARBINARY(16)   NULL,
  `user_agent`             VARCHAR(255)    NULL,
  `published_at`           DATETIME        NULL,
  `moderated_by_admin_id`  BIGINT UNSIGNED NULL,
  `moderated_at`           DATETIME        NULL,
  `created_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_blog_comments_article` (`shop_id`, `article_id`, `status`, `created_at`),
  KEY `ix_blog_comments_queue` (`shop_id`, `status`, `created_at`),
  CONSTRAINT `fk_blog_comments_shop` FOREIGN KEY (`shop_id`) REFERENCES `shops` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_blog_comments_article` FOREIGN KEY (`article_id`) REFERENCES `cms_articles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Content → Comments.
INSERT INTO `menu_items` (
  parent_id, menu_key, title, icon, icon_type, route, prefetch_data,
  active_match, analytics_key, badge_variant, sort_order, status,
  is_active, is_visible, show_in_collapsed, is_pinnable,
  requires_super_admin, is_external, opens_new_tab, is_system
)
SELECT parent.id, 'content.comments', 'Comments', 'comment', 'material', '/content/comments', 0,
       '/content/comments', 'menu.content.comments', 'default', 27, 'available',
       1, 1, 0, 1, 0, 0, 0, 1
  FROM (SELECT id FROM `menu_items` WHERE `menu_key` = 'content' LIMIT 1) AS parent
ON DUPLICATE KEY UPDATE
  parent_id = VALUES(parent_id), title = VALUES(title), icon = VALUES(icon), route = VALUES(route),
  active_match = VALUES(active_match), sort_order = VALUES(sort_order), status = VALUES(status);

INSERT INTO `menu_item_permissions` (menu_item_id, permission_id)
SELECT mi.id, p.id
  FROM `menu_items` mi
  JOIN `permissions` p ON p.slug = 'cms.view'
 WHERE mi.menu_key = 'content.comments'
   AND NOT EXISTS (
         SELECT 1 FROM `menu_item_permissions` existing
          WHERE existing.menu_item_id = mi.id AND existing.permission_id = p.id
       );
