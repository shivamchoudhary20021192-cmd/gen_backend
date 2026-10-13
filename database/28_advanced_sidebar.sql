-- ============================================================================
-- ADVANCED SIDEBAR SYSTEM - INDUSTRY STANDARD
-- Enhanced menu system with full control and user preferences
-- ============================================================================

-- NOTE: MySQL 8 has no `DROP FOREIGN KEY IF EXISTS`, and this migration only
-- ADDs columns and CREATEs tables, so no constraint needs dropping. The two
-- ALTER ... DROP FOREIGN KEY IF EXISTS statements that used to sit here aborted
-- the whole migration on line 7, which is why none of the columns below existed.

-- ============================================================================
-- STEP 1: Enhance menu_items table with advanced columns
-- ============================================================================

-- Helpers so this migration can be re-run safely. MySQL 8 has no
-- `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`, and a migration that
-- aborts halfway (as this one did) otherwise leaves the database in a state where
-- every later attempt fails with "Duplicate column name".
DROP PROCEDURE IF EXISTS veylog_add_column;
DROP PROCEDURE IF EXISTS veylog_add_index;
DROP PROCEDURE IF EXISTS veylog_add_fk;

DELIMITER $$
CREATE PROCEDURE veylog_add_column(IN p_table VARCHAR(64), IN p_column VARCHAR(64), IN p_def TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = p_table AND column_name = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_def);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

CREATE PROCEDURE veylog_add_index(IN p_table VARCHAR(64), IN p_name VARCHAR(64), IN p_cols TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = p_table AND index_name = p_name
  ) THEN
    SET @sql = CONCAT('CREATE INDEX `', p_name, '` ON `', p_table, '` (', p_cols, ')');
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$

CREATE PROCEDURE veylog_add_fk(IN p_table VARCHAR(64), IN p_name VARCHAR(64), IN p_spec TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema = DATABASE() AND table_name = p_table AND constraint_name = p_name
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD CONSTRAINT `', p_name, '` FOREIGN KEY ', p_spec);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- Add the advanced menu_items columns (each skipped if already present)
CALL veylog_add_column('menu_items', 'is_visible', 'TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT ''If 0, hidden from all users'' AFTER `is_active`');
CALL veylog_add_column('menu_items', 'show_in_collapsed', 'TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT ''Show in mini/icon-only sidebar'' AFTER `is_visible`');
CALL veylog_add_column('menu_items', 'is_pinnable', 'TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT ''Can user pin this item'' AFTER `show_in_collapsed`');
CALL veylog_add_column('menu_items', 'icon_color', 'VARCHAR(20) NULL COMMENT ''Icon color (hex or theme color)'' AFTER `icon`');
CALL veylog_add_column('menu_items', 'icon_type', 'ENUM(''material'', ''custom'', ''emoji'') NOT NULL DEFAULT ''material'' AFTER `icon_color`');
CALL veylog_add_column('menu_items', 'hover_description', 'VARCHAR(255) NULL COMMENT ''Tooltip on hover'' AFTER `subtitle`');
CALL veylog_add_column('menu_items', 'keyboard_shortcut', 'VARCHAR(20) NULL COMMENT ''e.g., "Ctrl+Shift+P"'' AFTER `hover_description`');
CALL veylog_add_column('menu_items', 'group_key', 'VARCHAR(60) NULL COMMENT ''Group items together (collapsible groups)'' AFTER `section`');
CALL veylog_add_column('menu_items', 'divider_after', 'TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''Show divider after this item'' AFTER `group_key`');
CALL veylog_add_column('menu_items', 'min_role_level', 'TINYINT UNSIGNED NULL COMMENT ''Minimum role level (1=viewer, 5=admin, 10=superadmin)'' AFTER `requires_super_admin`');
CALL veylog_add_column('menu_items', 'allowed_roles', 'JSON NULL COMMENT ''Array of role IDs that can see this'' AFTER `min_role_level`');
CALL veylog_add_column('menu_items', 'prefetch_data', 'TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT ''Prefetch route data on hover'' AFTER `route`');
CALL veylog_add_column('menu_items', 'cache_duration', 'INT UNSIGNED NULL COMMENT ''Cache duration in seconds'' AFTER `prefetch_data`');
CALL veylog_add_column('menu_items', 'analytics_key', 'VARCHAR(60) NULL COMMENT ''Track clicks in analytics'' AFTER `badge_key`');
CALL veylog_add_column('menu_items', 'show_if_feature', 'VARCHAR(80) NULL COMMENT ''Only show if feature enabled'' AFTER `feature_flag`');
CALL veylog_add_column('menu_items', 'hide_if_feature', 'VARCHAR(80) NULL COMMENT ''Hide if feature enabled'' AFTER `show_if_feature`');
CALL veylog_add_column('menu_items', 'show_if_permission', 'VARCHAR(80) NULL COMMENT ''Only show if user has permission'' AFTER `hide_if_feature`');
CALL veylog_add_column('menu_items', 'metadata', 'JSON NULL COMMENT ''Additional flexible data'' AFTER `analytics_key`');


-- Add indexes for performance
CALL veylog_add_index('menu_items', 'idx_menu_items_is_visible', 'is_visible');
CALL veylog_add_index('menu_items', 'idx_menu_items_section', 'section');
CALL veylog_add_index('menu_items', 'idx_menu_items_group_key', 'group_key');
CALL veylog_add_index('menu_items', 'idx_menu_items_sort_order', 'sort_order');
CALL veylog_add_index('menu_items', 'idx_menu_items_parent_active', 'parent_id, is_active');

-- Recreate foreign key
CALL veylog_add_fk('menu_items', 'menu_items_parent_id_foreign', '(parent_id) REFERENCES menu_items(id) ON DELETE CASCADE');

-- ============================================================================
-- STEP 2: Create user sidebar preferences table
-- ============================================================================

CREATE TABLE IF NOT EXISTS `user_sidebar_preferences` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` BIGINT UNSIGNED NOT NULL,
  
  -- Sidebar State
  `is_collapsed` TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Mini/icon-only mode',
  `is_pinned` TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Stay open vs auto-hide',
  `width` SMALLINT UNSIGNED NULL DEFAULT 280 COMMENT 'Sidebar width in pixels',
  `collapsed_width` SMALLINT UNSIGNED NULL DEFAULT 64 COMMENT 'Mini mode width',
  
  -- User Customization
  `pinned_items` JSON NULL COMMENT 'Array of menu_item IDs user pinned to top',
  `hidden_items` JSON NULL COMMENT 'Array of menu_item IDs user hid',
  `collapsed_groups` JSON NULL COMMENT 'Array of section/group keys that are collapsed',
  `recent_items` JSON NULL COMMENT 'Recently accessed menu items (max 10)',
  `favorite_items` JSON NULL COMMENT 'User-favorited menu items',
  
  -- Behavior Preferences
  `auto_collapse` TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Auto-collapse on route change',
  `show_tooltips` TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Show hover tooltips',
  `show_badges` TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Show notification badges',
  `animation_speed` ENUM('none', 'fast', 'normal', 'slow') NOT NULL DEFAULT 'normal',
  
  -- Analytics
  `most_used_item_id` BIGINT UNSIGNED NULL COMMENT 'Most frequently clicked item',
  `total_clicks` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_reset_at` DATETIME NULL COMMENT 'When click count was last reset',
  
  -- Timestamps
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  UNIQUE KEY `user_sidebar_preferences_user_id_unique` (`user_id`),
  FOREIGN KEY (`user_id`) REFERENCES `admin_users`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`most_used_item_id`) REFERENCES `menu_items`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CALL veylog_add_index('user_sidebar_preferences', 'idx_user_sidebar_user_id', 'user_id');

-- ============================================================================
-- STEP 3: Create menu item click analytics table
-- ============================================================================

CREATE TABLE IF NOT EXISTS `menu_item_analytics` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `menu_item_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `clicked_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `session_id` VARCHAR(100) NULL,
  `referrer_route` VARCHAR(255) NULL COMMENT 'Where user came from',
  `device_type` ENUM('desktop', 'tablet', 'mobile') NULL,
  
  FOREIGN KEY (`menu_item_id`) REFERENCES `menu_items`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `admin_users`(`id`) ON DELETE CASCADE,
  
  INDEX idx_analytics_menu_item (menu_item_id),
  INDEX idx_analytics_user (user_id),
  INDEX idx_analytics_clicked_at (clicked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- STEP 4: Create sidebar groups/sections configuration
-- ============================================================================

CREATE TABLE IF NOT EXISTS `sidebar_sections` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `key` VARCHAR(60) NOT NULL UNIQUE COMMENT 'Unique section identifier',
  `title` VARCHAR(120) NOT NULL,
  `description` VARCHAR(255) NULL,
  `icon` VARCHAR(60) NULL,
  `color` VARCHAR(20) NULL COMMENT 'Section accent color',
  
  -- Display
  `is_collapsible` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `is_collapsed_by_default` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `show_header` TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Show section header or just items',
  
  -- Access
  `is_active` TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `requires_super_admin` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `min_role_level` TINYINT UNSIGNED NULL,
  
  -- Order
  `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  
  -- Meta
  `metadata` JSON NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  
  INDEX idx_sections_key (`key`),
  INDEX idx_sections_sort_order (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- STEP 5: Seed sidebar sections
-- ============================================================================

INSERT INTO sidebar_sections (id, `key`, title, description, icon, color, is_collapsible, sort_order) VALUES
(1, 'overview', 'Overview', 'Dashboard and quick stats', 'dashboard', '#3b82f6', 1, 10),
(2, 'commerce', 'Commerce', 'Orders, products, and customers', 'shopping_cart', '#10b981', 1, 20),
(3, 'marketing', 'Marketing', 'Promotions and campaigns', 'campaign', '#f59e0b', 1, 30),
(4, 'content', 'Content', 'Pages, media, and navigation', 'article', '#8b5cf6', 1, 40),
(5, 'insights', 'Insights', 'Analytics and reports', 'analytics', '#ec4899', 1, 50),
(6, 'support', 'Support', 'Customer support and tickets', 'support_agent', '#06b6d4', 1, 60),
(7, 'settings', 'Settings', 'Store and system configuration', 'settings', '#6b7280', 1, 70)
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- ============================================================================
-- STEP 6: Update existing menu items with new columns
-- ============================================================================

-- Update all items to be visible by default
UPDATE menu_items SET is_visible = 1 WHERE is_visible IS NULL;

-- Set show_in_collapsed for top-level important items only
UPDATE menu_items SET show_in_collapsed = 1 WHERE parent_id IS NULL AND menu_key IN ('dashboard', 'orders', 'products', 'customers');
UPDATE menu_items SET show_in_collapsed = 0 WHERE parent_id IS NOT NULL OR menu_key NOT IN ('dashboard', 'orders', 'products', 'customers');

-- Add hover descriptions
UPDATE menu_items SET hover_description = 'Overview of your store performance' WHERE menu_key = 'dashboard';
UPDATE menu_items SET hover_description = 'Manage orders and fulfillment' WHERE menu_key = 'orders';
UPDATE menu_items SET hover_description = 'Your product catalog' WHERE menu_key = 'products';
UPDATE menu_items SET hover_description = 'Customer database and segments' WHERE menu_key = 'customers';
UPDATE menu_items SET hover_description = 'Discount codes and promotions' WHERE menu_key = 'discounts';
UPDATE menu_items SET hover_description = 'CMS content management' WHERE menu_key = 'content';
UPDATE menu_items SET hover_description = 'Media library' WHERE menu_key = 'media';
UPDATE menu_items SET hover_description = 'Store configuration' WHERE menu_key = 'settings';

-- Add keyboard shortcuts for common items
UPDATE menu_items SET keyboard_shortcut = 'Ctrl+Shift+D' WHERE menu_key = 'dashboard';
UPDATE menu_items SET keyboard_shortcut = 'Ctrl+Shift+O' WHERE menu_key = 'orders';
UPDATE menu_items SET keyboard_shortcut = 'Ctrl+Shift+P' WHERE menu_key = 'products';
UPDATE menu_items SET keyboard_shortcut = 'Ctrl+Shift+C' WHERE menu_key = 'customers';

-- Set dividers after major sections
UPDATE menu_items SET divider_after = 1 WHERE menu_key IN ('dashboard', 'orders', 'products', 'customers', 'discounts', 'content', 'media', 'analytics', 'support');

-- Set icon colors for visual hierarchy
UPDATE menu_items SET icon_color = '#3b82f6' WHERE menu_key = 'dashboard';
UPDATE menu_items SET icon_color = '#f59e0b' WHERE menu_key = 'orders';
UPDATE menu_items SET icon_color = '#10b981' WHERE menu_key = 'products';
UPDATE menu_items SET icon_color = '#8b5cf6' WHERE menu_key = 'customers';
UPDATE menu_items SET icon_color = '#ef4444' WHERE menu_key = 'discounts';

-- Set analytics keys
UPDATE menu_items SET analytics_key = CONCAT('menu.', menu_key);

-- ============================================================================
-- STEP 7: Create view for efficient menu fetching
-- ============================================================================

CREATE OR REPLACE VIEW menu_items_with_section AS
SELECT 
  mi.*,
  ss.title as section_title,
  ss.color as section_color,
  ss.is_collapsible as section_is_collapsible
FROM menu_items mi
LEFT JOIN sidebar_sections ss ON mi.section COLLATE utf8mb4_unicode_ci = ss.key;

-- ============================================================================
-- STEP 8: Create stored procedure for getting user's menu
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS GetUserMenu$$
CREATE PROCEDURE GetUserMenu(
  IN p_user_id BIGINT,
  IN p_is_super_admin TINYINT,
  IN p_user_role_ids JSON
)
BEGIN
  -- Get menu items filtered by user permissions and visibility
  SELECT 
    mi.id,
    mi.parent_id,
    mi.menu_key,
    mi.title,
    mi.subtitle,
    mi.hover_description,
    mi.icon,
    mi.icon_color,
    mi.icon_type,
    mi.route,
    mi.active_match,
    mi.section,
    mi.group_key,
    mi.badge_key,
    mi.badge_variant,
    mi.sort_order,
    mi.status,
    mi.is_active,
    mi.is_visible,
    mi.show_in_collapsed,
    mi.is_pinnable,
    mi.requires_super_admin,
    mi.feature_flag,
    mi.show_if_feature,
    mi.hide_if_feature,
    mi.show_if_permission,
    mi.is_external,
    mi.opens_new_tab,
    mi.keyboard_shortcut,
    mi.divider_after,
    mi.analytics_key,
    mi.metadata,
    -- Check if user has pinned this item
    CASE 
      WHEN JSON_CONTAINS(
        COALESCE(usp.pinned_items, '[]'),
        CAST(mi.id AS JSON)
      ) THEN 1
      ELSE 0
    END as is_pinned_by_user,
    -- Check if user has hidden this item
    CASE 
      WHEN JSON_CONTAINS(
        COALESCE(usp.hidden_items, '[]'),
        CAST(mi.id AS JSON)
      ) THEN 1
      ELSE 0
    END as is_hidden_by_user
  FROM menu_items mi
  LEFT JOIN user_sidebar_preferences usp ON usp.user_id = p_user_id
  WHERE 
    mi.is_active = 1
    AND mi.is_visible = 1
    AND (mi.requires_super_admin = 0 OR p_is_super_admin = 1)
    AND (
      mi.allowed_roles IS NULL 
      OR JSON_OVERLAPS(mi.allowed_roles, p_user_role_ids)
    )
  ORDER BY 
    mi.sort_order ASC,
    mi.id ASC;
END$$

DELIMITER ;

-- ============================================================================
-- STEP 9: Create function to track menu click
-- ============================================================================

DELIMITER $$

DROP PROCEDURE IF EXISTS TrackMenuClick$$
CREATE PROCEDURE TrackMenuClick(
  IN p_menu_item_id BIGINT,
  IN p_user_id BIGINT,
  IN p_session_id VARCHAR(100),
  IN p_referrer_route VARCHAR(255),
  IN p_device_type VARCHAR(20)
)
BEGIN
  -- Insert click record
  INSERT INTO menu_item_analytics 
    (menu_item_id, user_id, session_id, referrer_route, device_type, clicked_at)
  VALUES 
    (p_menu_item_id, p_user_id, p_session_id, p_referrer_route, p_device_type, NOW());
  
  -- Update user preferences total clicks
  INSERT INTO user_sidebar_preferences (user_id, total_clicks)
  VALUES (p_user_id, 1)
  ON DUPLICATE KEY UPDATE total_clicks = total_clicks + 1;
  
  -- Update recent items (keep last 10)
  UPDATE user_sidebar_preferences
  SET recent_items = JSON_ARRAY_INSERT(
    COALESCE(recent_items, '[]'),
    '$[0]',
    p_menu_item_id
  )
  WHERE user_id = p_user_id;
END$$

DELIMITER ;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Check new columns
-- SELECT * FROM menu_items LIMIT 1;

-- Check sections
-- SELECT * FROM sidebar_sections ORDER BY sort_order;

-- Check user preferences structure
-- DESCRIBE user_sidebar_preferences;

-- Test the stored procedure (replace with actual user ID)
-- CALL GetUserMenu(1, 1, '[1,2,3]');

-- ============================================================================
-- DONE!
-- ============================================================================

SELECT 
  'Advanced sidebar system installed successfully!' as message,
  (SELECT COUNT(*) FROM menu_items WHERE is_visible = 1) as visible_menu_items,
  (SELECT COUNT(*) FROM sidebar_sections) as total_sections;

-- Clean up the helpers so they do not linger as schema objects.
DROP PROCEDURE IF EXISTS veylog_add_column;
DROP PROCEDURE IF EXISTS veylog_add_index;
DROP PROCEDURE IF EXISTS veylog_add_fk;
