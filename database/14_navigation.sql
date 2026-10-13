-- =============================================================================
-- File 14 : NAVIGATION — the admin sidebar, stored and editable
-- =============================================================================
-- The menu is data, not code: a super admin can rename, reorder, hide or
-- re-permission any item without a deploy.
--
-- Two guard rails make that safe rather than merely flexible:
--
--   `menu_key`  a stable handle the frontend maps to a route component. The
--               DB stores `route` for display and deep-linking, but the client
--               only renders items whose key it can actually resolve. A row
--               pointing at a screen this build does not contain therefore
--               degrades to a disabled item, never a dead link.
--
--   `status`    'available' renders normally; 'coming_soon' renders greyed with
--               a chip so a half-built section is visible on the roadmap
--               without being clickable; 'hidden' is omitted entirely.
--
-- Visibility for a given admin =
--     is_active
--     AND status <> 'hidden'
--     AND (requires_super_admin = 0 OR admin is super)
--     AND (item has no permissions OR admin holds at least one of them)
--
-- A parent with no visible children is dropped, so an Operations user never
-- sees an empty "Settings" group.
--
-- IMPORTANT: this table is presentation only. Hiding a menu item does not
-- protect an endpoint — every route still enforces its own permission. Treat
-- the menu as a convenience, never as access control.
-- =============================================================================

-- No USE statement: the database name differs per environment (veylog locally,
-- veylor_db on the server). Hardcoding one here made every migration below fail
-- with "Access denied" on the deployed box. Connect to the right database
-- instead: `mysql -D <database> < this-file.sql`.
CREATE TABLE `menu_items` (
  `id`                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `parent_id`            BIGINT UNSIGNED     NULL,
  -- Code handle. The frontend's route registry is keyed on this.
  `menu_key`             VARCHAR(60)     NOT NULL,
  `title`                VARCHAR(120)    NOT NULL,
  `subtitle`             VARCHAR(191)        NULL,
  -- Logical icon name (e.g. 'products'), mapped to a component client-side.
  -- Storing a component name here would couple the database to one UI library.
  `icon`                 VARCHAR(60)         NULL,
  `route`                VARCHAR(191)        NULL,   -- NULL = group header
  -- Extra prefixes that should light this item up, comma separated.
  -- e.g. '/products/new,/products/:id' keeps Products active on the edit form.
  `active_match`         VARCHAR(500)        NULL,
  `section`              VARCHAR(60)         NULL,   -- sidebar group label
  -- Named counter the API resolves at request time (open tickets, low stock…).
  `badge_key`            VARCHAR(40)         NULL,
  `badge_variant`        ENUM('default','info','warning','error','success')
                                         NOT NULL DEFAULT 'default',
  `sort_order`           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `status`               ENUM('available','coming_soon','hidden')
                                         NOT NULL DEFAULT 'available',
  `is_active`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `requires_super_admin` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  -- Gate a whole branch behind a feature flag without deleting the rows.
  `feature_flag`         VARCHAR(80)         NULL,
  `is_external`          TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `opens_new_tab`        TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  -- System rows are seeded with the app; the UI blocks deleting them so a
  -- mis-click cannot orphan a whole section.
  `is_system`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 1,
  `created_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`           DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_menu_items_key` (`menu_key`),
  KEY `ix_menu_items_parent` (`parent_id`, `sort_order`),
  KEY `ix_menu_items_visible` (`is_active`, `status`, `sort_order`),
  CONSTRAINT `fk_menu_items_parent`
    FOREIGN KEY (`parent_id`) REFERENCES `menu_items` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Many-to-many: an item can be reachable by several permissions ("any of").
-- No rows at all means the item is visible to every signed-in admin.
CREATE TABLE `menu_item_permissions` (
  `menu_item_id` BIGINT UNSIGNED NOT NULL,
  `permission_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`menu_item_id`, `permission_id`),
  KEY `ix_menu_item_permissions_permission` (`permission_id`),
  CONSTRAINT `fk_menu_item_permissions_item`
    FOREIGN KEY (`menu_item_id`) REFERENCES `menu_items` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_menu_item_permissions_permission`
    FOREIGN KEY (`permission_id`) REFERENCES `permissions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- Per-admin preferences: pinned favourites and collapsed sections. Small, but
-- it is the difference between a 40-item menu and a usable one.
-- -----------------------------------------------------------------------------
CREATE TABLE `admin_menu_preferences` (
  `id`                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `admin_user_id`     BIGINT UNSIGNED NOT NULL,
  `menu_item_id`      BIGINT UNSIGNED NOT NULL,
  `is_pinned`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `is_collapsed`      TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `pin_order`         SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `last_visited_at`   DATETIME            NULL,
  `visit_count`       INT UNSIGNED    NOT NULL DEFAULT 0,
  `updated_at`        DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_menu_preferences` (`admin_user_id`, `menu_item_id`),
  CONSTRAINT `fk_admin_menu_prefs_admin`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_admin_menu_prefs_item`
    FOREIGN KEY (`menu_item_id`) REFERENCES `menu_items` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
