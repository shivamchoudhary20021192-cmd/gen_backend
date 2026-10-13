import type { ResultSetHeader, RowDataPacket } from 'mysql2'
import { shopId } from '../../platform/tenancy/context'
import { pool, query } from '../../db/pool'

export interface MenuItem {
  id: number
  parent_id: number | null
  menu_key: string
  title: string
  subtitle: string | null
  hover_description: string | null
  icon: string | null
  icon_color: string | null
  icon_type: 'material' | 'custom' | 'emoji'
  route: string | null
  active_match: string | null
  section: string | null
  group_key: string | null
  badge_key: string | null
  badge_variant: 'default' | 'info' | 'warning' | 'error' | 'success'
  sort_order: number
  status: 'available' | 'coming_soon' | 'hidden'
  is_active: boolean
  is_visible: boolean
  show_in_collapsed: boolean
  is_pinnable: boolean
  requires_super_admin: boolean
  feature_flag: string | null
  show_if_feature: string | null
  hide_if_feature: string | null
  show_if_permission: string | null
  is_external: boolean
  opens_new_tab: boolean
  keyboard_shortcut: string | null
  divider_after: boolean
  analytics_key: string | null
  metadata: Record<string, any> | null
  is_pinned_by_user?: boolean
  is_hidden_by_user?: boolean
  children?: MenuItem[]
}

export interface SidebarSection {
  id: number
  key: string
  title: string
  description: string | null
  icon: string | null
  color: string | null
  is_collapsible: boolean
  is_collapsed_by_default: boolean
  show_header: boolean
  is_active: boolean
  requires_super_admin: boolean
  min_role_level: number | null
  sort_order: number
  metadata: Record<string, any> | null
}

export interface UserSidebarPreference {
  id: number
  user_id: number
  is_collapsed: boolean
  is_pinned: boolean
  width: number
  collapsed_width: number
  pinned_items: number[]
  hidden_items: number[]
  collapsed_groups: string[]
  recent_items: number[]
  favorite_items: number[]
  auto_collapse: boolean
  show_tooltips: boolean
  show_badges: boolean
  animation_speed: 'none' | 'fast' | 'normal' | 'slow'
  most_used_item_id: number | null
  total_clicks: number
}

interface MenuItemRow extends RowDataPacket {
  id: number
  parent_id: number | null
  menu_key: string
  title: string
  subtitle: string | null
  hover_description: string | null
  icon: string | null
  icon_color: string | null
  icon_type: 'material' | 'custom' | 'emoji'
  route: string | null
  active_match: string | null
  section: string | null
  group_key: string | null
  badge_key: string | null
  badge_variant: string
  sort_order: number
  status: string
  is_active: number
  is_visible: number
  show_in_collapsed: number
  is_pinnable: number
  requires_super_admin: number
  feature_flag: string | null
  show_if_feature: string | null
  hide_if_feature: string | null
  show_if_permission: string | null
  is_external: number
  opens_new_tab: number
  keyboard_shortcut: string | null
  divider_after: number
  analytics_key: string | null
  metadata: string | null
  is_pinned_by_user?: number
  is_hidden_by_user?: number
}

export const sidebarRepository = {
  /**
   * The roles an admin holds in the current shop, by slug.
   *
   * Slugs rather than ids: the admin menu is shared by every shop, but role
   * rows are per shop — "founder" is id 1 in one store and id 40 in the next.
   * `menu_items.allowed_roles` therefore lists slugs, and this is what it is
   * matched against. Read per request, so a role change shows at once.
   */
  async roleIdsFor(adminId: number): Promise<string[]> {
    const rows = await query<RowDataPacket & { slug: string }>(
      `SELECT r.slug FROM admin_user_roles aur
         JOIN roles r ON r.id = aur.role_id AND r.shop_id = aur.shop_id
        WHERE aur.shop_id = ? AND aur.admin_user_id = ?`,
      [shopId(), adminId],
    )
    return rows.map((row) => row.slug)
  },

  /**
   * Get user's menu items filtered by permissions
   */
  async getUserMenu(
    userId: number,
    isSuperAdmin: boolean,
    roleIds: string[]
  ): Promise<MenuItem[]> {
    const [rows] = await pool.query<MenuItemRow[]>(
      `CALL GetUserMenu(?, ?, ?)`,
      [userId, isSuperAdmin ? 1 : 0, JSON.stringify(roleIds)]
    )
    
    // GetUserMenu returns result set in first element
    const menuRows = Array.isArray(rows[0]) ? rows[0] : []
    
    return menuRows.map(row => ({
      id: row.id,
      parent_id: row.parent_id,
      menu_key: row.menu_key,
      title: row.title,
      subtitle: row.subtitle,
      hover_description: row.hover_description,
      icon: row.icon,
      icon_color: row.icon_color,
      icon_type: row.icon_type as any,
      route: row.route,
      active_match: row.active_match,
      section: row.section,
      group_key: row.group_key,
      badge_key: row.badge_key,
      badge_variant: row.badge_variant as any,
      sort_order: row.sort_order,
      status: row.status as any,
      is_active: Boolean(row.is_active),
      is_visible: Boolean(row.is_visible),
      show_in_collapsed: Boolean(row.show_in_collapsed),
      is_pinnable: Boolean(row.is_pinnable),
      requires_super_admin: Boolean(row.requires_super_admin),
      feature_flag: row.feature_flag,
      show_if_feature: row.show_if_feature,
      hide_if_feature: row.hide_if_feature,
      show_if_permission: row.show_if_permission,
      is_external: Boolean(row.is_external),
      opens_new_tab: Boolean(row.opens_new_tab),
      keyboard_shortcut: row.keyboard_shortcut,
      divider_after: Boolean(row.divider_after),
      analytics_key: row.analytics_key,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      is_pinned_by_user: Boolean(row.is_pinned_by_user),
      is_hidden_by_user: Boolean(row.is_hidden_by_user),
    }))
  },

  /**
   * Get all sidebar sections
   */
  async getSections(): Promise<SidebarSection[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM sidebar_sections WHERE is_active = 1 ORDER BY sort_order`
    )
    
    return rows.map(row => ({
      id: row.id,
      key: row.key,
      title: row.title,
      description: row.description,
      icon: row.icon,
      color: row.color,
      is_collapsible: Boolean(row.is_collapsible),
      is_collapsed_by_default: Boolean(row.is_collapsed_by_default),
      show_header: Boolean(row.show_header),
      is_active: Boolean(row.is_active),
      requires_super_admin: Boolean(row.requires_super_admin),
      min_role_level: row.min_role_level,
      sort_order: row.sort_order,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    }))
  },

  /**
   * Get user's sidebar preferences
   */
  async getUserPreferences(userId: number): Promise<UserSidebarPreference | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT * FROM user_sidebar_preferences WHERE user_id = ?`,
      [userId]
    )
    
    if (rows.length === 0) return null
    
    const row = rows[0]
    return {
      id: row.id,
      user_id: row.user_id,
      is_collapsed: Boolean(row.is_collapsed),
      is_pinned: Boolean(row.is_pinned),
      width: row.width,
      collapsed_width: row.collapsed_width,
      pinned_items: row.pinned_items ? JSON.parse(row.pinned_items) : [],
      hidden_items: row.hidden_items ? JSON.parse(row.hidden_items) : [],
      collapsed_groups: row.collapsed_groups ? JSON.parse(row.collapsed_groups) : [],
      recent_items: row.recent_items ? JSON.parse(row.recent_items) : [],
      favorite_items: row.favorite_items ? JSON.parse(row.favorite_items) : [],
      auto_collapse: Boolean(row.auto_collapse),
      show_tooltips: Boolean(row.show_tooltips),
      show_badges: Boolean(row.show_badges),
      animation_speed: row.animation_speed,
      most_used_item_id: row.most_used_item_id,
      total_clicks: row.total_clicks,
    }
  },

  /**
   * Create or update user preferences
   */
  async upsertUserPreferences(
    userId: number,
    preferences: Partial<Omit<UserSidebarPreference, 'id' | 'user_id'>>
  ): Promise<void> {
    const sets: string[] = []
    const values: any[] = []

    if (preferences.is_collapsed !== undefined) {
      sets.push('is_collapsed = ?')
      values.push(preferences.is_collapsed ? 1 : 0)
    }
    if (preferences.is_pinned !== undefined) {
      sets.push('is_pinned = ?')
      values.push(preferences.is_pinned ? 1 : 0)
    }
    if (preferences.width !== undefined) {
      sets.push('width = ?')
      values.push(preferences.width)
    }
    if (preferences.collapsed_width !== undefined) {
      sets.push('collapsed_width = ?')
      values.push(preferences.collapsed_width)
    }
    if (preferences.pinned_items !== undefined) {
      sets.push('pinned_items = ?')
      values.push(JSON.stringify(preferences.pinned_items))
    }
    if (preferences.hidden_items !== undefined) {
      sets.push('hidden_items = ?')
      values.push(JSON.stringify(preferences.hidden_items))
    }
    if (preferences.collapsed_groups !== undefined) {
      sets.push('collapsed_groups = ?')
      values.push(JSON.stringify(preferences.collapsed_groups))
    }
    if (preferences.recent_items !== undefined) {
      sets.push('recent_items = ?')
      values.push(JSON.stringify(preferences.recent_items))
    }
    if (preferences.favorite_items !== undefined) {
      sets.push('favorite_items = ?')
      values.push(JSON.stringify(preferences.favorite_items))
    }
    if (preferences.auto_collapse !== undefined) {
      sets.push('auto_collapse = ?')
      values.push(preferences.auto_collapse ? 1 : 0)
    }
    if (preferences.show_tooltips !== undefined) {
      sets.push('show_tooltips = ?')
      values.push(preferences.show_tooltips ? 1 : 0)
    }
    if (preferences.show_badges !== undefined) {
      sets.push('show_badges = ?')
      values.push(preferences.show_badges ? 1 : 0)
    }
    if (preferences.animation_speed !== undefined) {
      sets.push('animation_speed = ?')
      values.push(preferences.animation_speed)
    }

    if (sets.length === 0) return

    await pool.query(
      `INSERT INTO user_sidebar_preferences (user_id, ${sets.map(s => s.split(' = ')[0]).join(', ')})
       VALUES (?, ${sets.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${sets.join(', ')}`,
      [userId, ...values, ...values]
    )
  },

  /**
   * Track menu item click
   */
  async trackClick(
    menuItemId: number,
    userId: number,
    sessionId: string,
    referrerRoute: string | null,
    deviceType: 'desktop' | 'tablet' | 'mobile'
  ): Promise<void> {
    await pool.query(
      `CALL TrackMenuClick(?, ?, ?, ?, ?)`,
      [menuItemId, userId, sessionId, referrerRoute, deviceType]
    )
  },

  /**
   * Get menu item analytics
   */
  async getMenuAnalytics(
    menuItemId?: number,
    userId?: number,
    startDate?: Date,
    endDate?: Date
  ): Promise<any[]> {
    let query = `
      SELECT 
        menu_item_id,
        user_id,
        COUNT(*) as click_count,
        DATE(clicked_at) as date
      FROM menu_item_analytics
      WHERE 1=1
    `
    const params: any[] = []

    if (menuItemId) {
      query += ` AND menu_item_id = ?`
      params.push(menuItemId)
    }
    if (userId) {
      query += ` AND user_id = ?`
      params.push(userId)
    }
    if (startDate) {
      query += ` AND clicked_at >= ?`
      params.push(startDate)
    }
    if (endDate) {
      query += ` AND clicked_at <= ?`
      params.push(endDate)
    }

    query += ` GROUP BY menu_item_id, user_id, DATE(clicked_at)`
    query += ` ORDER BY clicked_at DESC`

    const [rows] = await pool.query<RowDataPacket[]>(query, params)
    return rows
  },
}
