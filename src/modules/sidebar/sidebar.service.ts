import { sidebarRepository, type MenuItem, type SidebarSection, type UserSidebarPreference } from './sidebar.repository'

interface MenuTree {
  items: MenuItem[]
  sections: SidebarSection[]
  preferences: UserSidebarPreference | null
}

export const sidebarService = {
  /**
   * Get complete menu tree for a user
   * Returns hierarchical menu with sections and user preferences
   */
  async getMenuTree(userId: number, isSuperAdmin: boolean): Promise<MenuTree> {
    const roleIds = await sidebarRepository.roleIdsFor(userId)

    // Fetch in parallel
    const [menuItems, sections, preferences] = await Promise.all([
      sidebarRepository.getUserMenu(userId, isSuperAdmin, roleIds),
      sidebarRepository.getSections(),
      sidebarRepository.getUserPreferences(userId),
    ])

    // Build hierarchical tree
    const tree = buildTree(menuItems)

    // Group by sections
    const groupedItems = groupBySection(tree, sections)

    return {
      items: groupedItems,
      sections,
      preferences: preferences || getDefaultPreferences(userId),
    }
  },

  /**
   * Get only collapsed/mini menu items (icon-only mode)
   */
  async getCollapsedMenu(userId: number, isSuperAdmin: boolean): Promise<MenuItem[]> {
    const roleIds = await sidebarRepository.roleIdsFor(userId)
    const allItems = await sidebarRepository.getUserMenu(userId, isSuperAdmin, roleIds)
    
    // Filter only items that should show in collapsed mode
    return allItems.filter(item => item.show_in_collapsed && !item.parent_id)
  },

  /**
   * Update user sidebar preferences
   */
  async updatePreferences(
    userId: number,
    preferences: Partial<Omit<UserSidebarPreference, 'id' | 'user_id'>>
  ): Promise<UserSidebarPreference> {
    await sidebarRepository.upsertUserPreferences(userId, preferences)
    
    const updated = await sidebarRepository.getUserPreferences(userId)
    return updated || getDefaultPreferences(userId)
  },

  /**
   * Toggle sidebar pin state
   */
  async togglePin(userId: number): Promise<{ is_pinned: boolean }> {
    const current = await sidebarRepository.getUserPreferences(userId)
    const newState = !current?.is_pinned
    
    await sidebarRepository.upsertUserPreferences(userId, {
      is_pinned: newState,
    })
    
    return { is_pinned: newState }
  },

  /**
   * Toggle sidebar collapsed state
   */
  async toggleCollapse(userId: number): Promise<{ is_collapsed: boolean }> {
    const current = await sidebarRepository.getUserPreferences(userId)
    const newState = !current?.is_collapsed
    
    await sidebarRepository.upsertUserPreferences(userId, {
      is_collapsed: newState,
    })
    
    return { is_collapsed: newState }
  },

  /**
   * Pin a menu item to top
   */
  async pinItem(userId: number, menuItemId: number): Promise<void> {
    const prefs = await sidebarRepository.getUserPreferences(userId)
    const pinned = prefs?.pinned_items || []
    
    if (!pinned.includes(menuItemId)) {
      pinned.unshift(menuItemId) // Add to start
    }
    
    await sidebarRepository.upsertUserPreferences(userId, {
      pinned_items: pinned.slice(0, 10), // Max 10 pinned items
    })
  },

  /**
   * Unpin a menu item
   */
  async unpinItem(userId: number, menuItemId: number): Promise<void> {
    const prefs = await sidebarRepository.getUserPreferences(userId)
    const pinned = prefs?.pinned_items || []
    
    await sidebarRepository.upsertUserPreferences(userId, {
      pinned_items: pinned.filter(id => id !== menuItemId),
    })
  },

  /**
   * Add item to favorites
   */
  async addFavorite(userId: number, menuItemId: number): Promise<void> {
    const prefs = await sidebarRepository.getUserPreferences(userId)
    const favorites = prefs?.favorite_items || []
    
    if (!favorites.includes(menuItemId)) {
      favorites.push(menuItemId)
    }
    
    await sidebarRepository.upsertUserPreferences(userId, {
      favorite_items: favorites,
    })
  },

  /**
   * Remove item from favorites
   */
  async removeFavorite(userId: number, menuItemId: number): Promise<void> {
    const prefs = await sidebarRepository.getUserPreferences(userId)
    const favorites = prefs?.favorite_items || []
    
    await sidebarRepository.upsertUserPreferences(userId, {
      favorite_items: favorites.filter(id => id !== menuItemId),
    })
  },

  /**
   * Track menu item click
   */
  async trackClick(
    menuItemId: number,
    userId: number,
    sessionId: string,
    referrerRoute?: string,
    deviceType: 'desktop' | 'tablet' | 'mobile' = 'desktop'
  ): Promise<void> {
    await sidebarRepository.trackClick(
      menuItemId,
      userId,
      sessionId,
      referrerRoute || null,
      deviceType
    )

    // Update recent items
    const prefs = await sidebarRepository.getUserPreferences(userId)
    const recent = prefs?.recent_items || []
    
    // Add to start, remove duplicates, keep last 10
    const updated = [menuItemId, ...recent.filter(id => id !== menuItemId)].slice(0, 10)
    
    await sidebarRepository.upsertUserPreferences(userId, {
      recent_items: updated,
    })
  },

  /**
   * Get menu analytics
   */
  async getAnalytics(filters: {
    menuItemId?: number
    userId?: number
    startDate?: Date
    endDate?: Date
  }): Promise<any> {
    return sidebarRepository.getMenuAnalytics(
      filters.menuItemId,
      filters.userId,
      filters.startDate,
      filters.endDate
    )
  },

  /**
   * Get all sections
   */
  async getSections(): Promise<SidebarSection[]> {
    return sidebarRepository.getSections()
  },
}

/**
 * Build hierarchical tree from flat menu items
 */
function buildTree(items: MenuItem[]): MenuItem[] {
  const map = new Map<number, MenuItem>()
  const roots: MenuItem[] = []

  // First pass: create map
  items.forEach(item => {
    map.set(item.id, { ...item, children: [] })
  })

  // Second pass: build tree
  items.forEach(item => {
    const node = map.get(item.id)!
    if (item.parent_id === null) {
      roots.push(node)
    } else {
      const parent = map.get(item.parent_id)
      if (parent) {
        parent.children = parent.children || []
        parent.children.push(node)
      }
    }
  })

  return roots
}

/**
 * Group menu items by sections
 */
function groupBySection(items: MenuItem[], sections: SidebarSection[]): MenuItem[] {
  // Sort items by section order
  const sectionOrder = new Map(sections.map((s, i) => [s.key, i]))
  
  return items.sort((a, b) => {
    const aOrder = sectionOrder.get(a.section || '') ?? 999
    const bOrder = sectionOrder.get(b.section || '') ?? 999
    if (aOrder !== bOrder) return aOrder - bOrder
    return a.sort_order - b.sort_order
  })
}

/**
 * Get default preferences for new users
 */
function getDefaultPreferences(userId: number): UserSidebarPreference {
  return {
    id: 0,
    user_id: userId,
    is_collapsed: false,
    is_pinned: true,
    width: 280,
    collapsed_width: 64,
    pinned_items: [],
    hidden_items: [],
    collapsed_groups: [],
    recent_items: [],
    favorite_items: [],
    auto_collapse: false,
    show_tooltips: true,
    show_badges: true,
    animation_speed: 'normal',
    most_used_item_id: null,
    total_clicks: 0,
  }
}
