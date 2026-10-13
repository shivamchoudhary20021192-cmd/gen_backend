/**
 * Repository for CMS Navigation (Storefront Menus)
 * Handles database operations for cms_menus and cms_menu_items
 */

import { query, queryOne, execute, insert, type Executor, type RowDataPacket, pool } from '../../db/pool'
import type {
  MenuRow,
  MenuItemRow,
  MenuItemWithMediaRow,
  MenuItemWithCountRow,
  ListMenusParams,
  ListMenuItemsParams,
  CreateMenuItemDto,
  UpdateMenuItemDto,
  MenuItemPosition,
} from './cms-navigation.types'
import { shopId } from '../../platform/tenancy/context'

// ══════════════════════════════════════════════════════════════════════════════
// MENUS REPOSITORY
// ══════════════════════════════════════════════════════════════════════════════

export const cmsMenusRepository = {
  /**
   * List all menus with item counts
   */
  async list(params: ListMenusParams = {}, conn: Executor = pool): Promise<MenuRow[]> {
    const conditions: string[] = ['m.shop_id = ?']
    const values: unknown[] = [shopId()]

    if (params.is_active !== undefined) {
      conditions.push('m.is_active = ?')
      values.push(params.is_active ? 1 : 0)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    return query<MenuRow>(
      `SELECT m.*
       FROM cms_menus m
       ${whereClause}
       ORDER BY m.slug ASC`,
      values,
      conn
    )
  },

  /**
   * List menus with item counts
   */
  async listWithCounts(params: ListMenusParams = {}, conn: Executor = pool): Promise<(MenuRow & { item_count: number })[]> {
    const conditions: string[] = ['m.shop_id = ?']
    const values: unknown[] = [shopId()]

    if (params.is_active !== undefined) {
      conditions.push('m.is_active = ?')
      values.push(params.is_active ? 1 : 0)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    return query<MenuRow & { item_count: number }>(
      `SELECT m.*,
              COUNT(mi.id) as item_count
       FROM cms_menus m
       LEFT JOIN cms_menu_items mi ON mi.menu_id = m.id AND mi.is_active = 1
       ${whereClause}
       GROUP BY m.id
       ORDER BY m.slug ASC`,
      values,
      conn
    )
  },

  /**
   * Get menu by ID
   */
  async getById(id: number, conn: Executor = pool): Promise<MenuRow | null> {
    return queryOne<MenuRow>(
      'SELECT * FROM cms_menus WHERE shop_id = ? AND id = ?',
      [shopId(), id],
      conn
    )
  },

  /**
   * Get menu by slug
   */
  async getBySlug(slug: string, conn: Executor = pool): Promise<MenuRow | null> {
    return queryOne<MenuRow>(
      'SELECT * FROM cms_menus WHERE shop_id = ? AND slug = ?',
      [shopId(), slug],
      conn
    )
  },

  /**
   * Create menu
   */
  async create(data: { slug: string; name: string; is_active: boolean }, conn: Executor = pool): Promise<number> {
    return insert(
      'INSERT INTO cms_menus (shop_id, slug, name, is_active) VALUES (?, ?, ?, ?)',
      [shopId(), data.slug, data.name, data.is_active ? 1 : 0],
      conn
    )
  },

  /**
   * Update menu
   */
  async update(id: number, data: Record<string, unknown>, conn: Executor = pool): Promise<void> {
    const keys = Object.keys(data)
    if (keys.length === 0) return

    const assignments = keys.map((k) => `${k} = ?`).join(', ')
    await execute(
      `UPDATE cms_menus SET ${assignments} WHERE shop_id = ? AND id = ?`,
      [...Object.values(data), shopId(), id],
      conn
    )
  },

  /**
   * Delete menu (CASCADE will delete items)
   */
  async delete(id: number, conn: Executor = pool): Promise<void> {
    await execute('DELETE FROM cms_menus WHERE shop_id = ? AND id = ?', [shopId(), id], conn)
  },

  /**
   * Check if slug exists (for another menu)
   */
  async slugExists(slug: string, excludeId?: number, conn: Executor = pool): Promise<boolean> {
    const row = await queryOne<RowDataPacket & { cnt: number }>(
      excludeId
        ? 'SELECT COUNT(*) as cnt FROM cms_menus WHERE shop_id = ? AND slug = ? AND id != ?'
        : 'SELECT COUNT(*) as cnt FROM cms_menus WHERE shop_id = ? AND slug = ?',
      excludeId ? [shopId(), slug, excludeId] : [shopId(), slug],
      conn
    )
    return (row?.cnt ?? 0) > 0
  },
}

// ══════════════════════════════════════════════════════════════════════════════
// MENU ITEMS REPOSITORY
// ══════════════════════════════════════════════════════════════════════════════

export const cmsMenuItemsRepository = {
  /**
   * List menu items with optional filtering
   */
  async list(params: ListMenuItemsParams = {}, conn: Executor = pool): Promise<MenuItemRow[]> {
    const conditions: string[] = ['mi.shop_id = ?']
    const values: unknown[] = [shopId()]

    if (params.menu_id !== undefined) {
      conditions.push('mi.menu_id = ?')
      values.push(params.menu_id)
    }

    if (params.parent_id !== undefined) {
      if (params.parent_id === null) {
        conditions.push('mi.parent_id IS NULL')
      } else {
        conditions.push('mi.parent_id = ?')
        values.push(params.parent_id)
      }
    }

    if (params.link_type !== undefined) {
      conditions.push('mi.link_type = ?')
      values.push(params.link_type)
    }

    if (params.is_active !== undefined) {
      conditions.push('mi.is_active = ?')
      values.push(params.is_active ? 1 : 0)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    return query<MenuItemRow>(
      `SELECT mi.*
       FROM cms_menu_items mi
       ${whereClause}
       ORDER BY mi.sort_order ASC, mi.id ASC`,
      values,
      conn
    )
  },

  /**
   * List menu items with media relations
   */
  async listWithMedia(params: ListMenuItemsParams = {}, conn: Executor = pool): Promise<MenuItemWithMediaRow[]> {
    const conditions: string[] = ['mi.shop_id = ?']
    const values: unknown[] = [shopId()]

    if (params.menu_id !== undefined) {
      conditions.push('mi.menu_id = ?')
      values.push(params.menu_id)
    }

    if (params.parent_id !== undefined) {
      if (params.parent_id === null) {
        conditions.push('mi.parent_id IS NULL')
      } else {
        conditions.push('mi.parent_id = ?')
        values.push(params.parent_id)
      }
    }

    if (params.link_type !== undefined) {
      conditions.push('mi.link_type = ?')
      values.push(params.link_type)
    }

    if (params.is_active !== undefined) {
      conditions.push('mi.is_active = ?')
      values.push(params.is_active ? 1 : 0)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    return query<MenuItemWithMediaRow>(
      `SELECT mi.*,
              icon_media.storage_key as icon_storage_key,
              icon_media.alt_text as icon_alt_text,
              image_media.storage_key as image_storage_key,
              image_media.alt_text as image_alt_text
       FROM cms_menu_items mi
       LEFT JOIN media icon_media ON icon_media.id = mi.icon_media_id AND icon_media.shop_id = mi.shop_id
       LEFT JOIN media image_media ON image_media.id = mi.image_media_id AND image_media.shop_id = mi.shop_id
       ${whereClause}
       ORDER BY mi.sort_order ASC, mi.id ASC`,
      values,
      conn
    )
  },

  /**
   * Get all items for a menu (hierarchical fetch)
   */
  async getAllForMenu(menuId: number, conn: Executor = pool): Promise<MenuItemWithMediaRow[]> {
    return query<MenuItemWithMediaRow>(
      `SELECT mi.*,
              icon_media.storage_key as icon_storage_key,
              icon_media.alt_text as icon_alt_text,
              image_media.storage_key as image_storage_key,
              image_media.alt_text as image_alt_text
       FROM cms_menu_items mi
       LEFT JOIN media icon_media ON icon_media.id = mi.icon_media_id AND icon_media.shop_id = mi.shop_id
       LEFT JOIN media image_media ON image_media.id = mi.image_media_id AND image_media.shop_id = mi.shop_id
       WHERE mi.shop_id = ? AND mi.menu_id = ? AND mi.is_active = 1
       ORDER BY mi.parent_id ASC, mi.sort_order ASC, mi.id ASC`,
      [shopId(), menuId],
      conn
    )
  },

  /**
   * Get menu item by ID
   */
  async getById(id: number, conn: Executor = pool): Promise<MenuItemRow | null> {
    return queryOne<MenuItemRow>(
      'SELECT * FROM cms_menu_items WHERE shop_id = ? AND id = ?',
      [shopId(), id],
      conn
    )
  },

  /**
   * Get menu item by ID with media
   */
  async getByIdWithMedia(id: number, conn: Executor = pool): Promise<MenuItemWithMediaRow | null> {
    return queryOne<MenuItemWithMediaRow>(
      `SELECT mi.*,
              icon_media.storage_key as icon_storage_key,
              icon_media.alt_text as icon_alt_text,
              image_media.storage_key as image_storage_key,
              image_media.alt_text as image_alt_text
       FROM cms_menu_items mi
       LEFT JOIN media icon_media ON icon_media.id = mi.icon_media_id AND icon_media.shop_id = mi.shop_id
       LEFT JOIN media image_media ON image_media.id = mi.image_media_id AND image_media.shop_id = mi.shop_id
       WHERE mi.shop_id = ? AND mi.id = ?`,
      [shopId(), id],
      conn
    )
  },

  /**
   * Get children of a menu item
   */
  async getChildren(parentId: number, conn: Executor = pool): Promise<MenuItemRow[]> {
    return query<MenuItemRow>(
      `SELECT * FROM cms_menu_items
       WHERE shop_id = ? AND parent_id = ? AND is_active = 1
       ORDER BY sort_order ASC, id ASC`,
      [shopId(), parentId],
      conn
    )
  },

  /**
   * Count children of a menu item
   */
  async countChildren(parentId: number, conn: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { cnt: number }>(
      'SELECT COUNT(*) as cnt FROM cms_menu_items WHERE shop_id = ? AND parent_id = ?',
      [shopId(), parentId],
      conn
    )
    return row?.cnt ?? 0
  },

  /**
   * Get max sort order for siblings
   */
  async getMaxSortOrder(menuId: number, parentId: number | null, conn: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { max_order: number | null }>(
      parentId === null
        ? 'SELECT MAX(sort_order) as max_order FROM cms_menu_items WHERE shop_id = ? AND menu_id = ? AND parent_id IS NULL'
        : 'SELECT MAX(sort_order) as max_order FROM cms_menu_items WHERE shop_id = ? AND menu_id = ? AND parent_id = ?',
      parentId === null ? [shopId(), menuId] : [shopId(), menuId, parentId],
      conn
    )
    return row?.max_order ?? 0
  },

  /**
   * Create menu item
   */
  async create(data: CreateMenuItemDto, conn: Executor = pool): Promise<number> {
    return insert(
      `INSERT INTO cms_menu_items
       (shop_id, menu_id, parent_id, label, link_type, link_ref_id, url, icon_media_id, image_media_id,
        badge_label, description, sort_order, opens_new_tab, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.menu_id,
        data.parent_id ?? null,
        data.label,
        data.link_type,
        data.link_ref_id ?? null,
        data.url ?? null,
        data.icon_media_id ?? null,
        data.image_media_id ?? null,
        data.badge_label ?? null,
        data.description ?? null,
        data.sort_order ?? 0,
        data.opens_new_tab ? 1 : 0,
        data.is_active !== false ? 1 : 0,
      ],
      conn
    )
  },

  /**
   * Update menu item
   */
  async update(id: number, data: UpdateMenuItemDto, conn: Executor = pool): Promise<void> {
    const keys = Object.keys(data)
    if (keys.length === 0) return

    // MySQL wants tinyints where the DTO declares booleans. The copy sent to the
    // driver is typed loosely for exactly that reason — the DTO keeps its honest
    // boolean shape for callers.
    const processedData: Record<string, unknown> = { ...data }
    if ('is_active' in processedData) {
      processedData.is_active = processedData.is_active ? 1 : 0
    }
    if ('opens_new_tab' in processedData) {
      processedData.opens_new_tab = processedData.opens_new_tab ? 1 : 0
    }

    const assignments = Object.keys(processedData).map((k) => `${k} = ?`).join(', ')
    await execute(
      `UPDATE cms_menu_items SET ${assignments} WHERE shop_id = ? AND id = ?`,
      [...Object.values(processedData), shopId(), id],
      conn
    )
  },

  /**
   * Delete menu item (CASCADE will delete children)
   */
  async delete(id: number, conn: Executor = pool): Promise<void> {
    await execute('DELETE FROM cms_menu_items WHERE shop_id = ? AND id = ?', [shopId(), id], conn)
  },

  /**
   * Bulk reorder menu items
   */
  async bulkReorder(updates: MenuItemPosition[], conn: Executor = pool): Promise<void> {
    for (const update of updates) {
      await execute(
        'UPDATE cms_menu_items SET parent_id = ?, sort_order = ? WHERE shop_id = ? AND id = ?',
        [update.parent_id, update.sort_order, shopId(), update.id],
        conn
      )
    }
  },

  /**
   * Check if menu item would create circular reference
   */
  async wouldCreateCycle(itemId: number, newParentId: number, conn: Executor = pool): Promise<boolean> {
    // Walk up the tree from newParentId to see if we hit itemId
    let currentId: number | null = newParentId

    while (currentId !== null) {
      if (currentId === itemId) {
        return true // Circular reference detected
      }

      // Annotated rather than inferred: this method sits inside the repository
      // object literal and walks the tree by calling back into it, which is
      // enough for TypeScript to give up and infer `any` here.
      const parent: (RowDataPacket & { parent_id: number | null }) | null = await queryOne<
        RowDataPacket & { parent_id: number | null }
      >(
        'SELECT parent_id FROM cms_menu_items WHERE shop_id = ? AND id = ?',
        [shopId(), currentId],
        conn
      )

      currentId = parent?.parent_id ?? null
    }

    return false
  },
}

// ══════════════════════════════════════════════════════════════════════════════
// LINK RESOLUTION REPOSITORY
// ══════════════════════════════════════════════════════════════════════════════

export const linkResolutionRepository = {
  /**
   * Resolve page link
   */
  async resolvePage(refId: number, conn: Executor = pool) {
    return queryOne<RowDataPacket & { slug: string; title: string; is_published: number }>(
      // cms_pages has no is_published column; published is a status.
      "SELECT slug, title, (status = 'published') AS is_published FROM cms_pages WHERE shop_id = ? AND id = ?",
      [shopId(), refId],
      conn
    )
  },

  /**
   * Resolve category link
   */
  async resolveCategory(refId: number, conn: Executor = pool) {
    return queryOne<RowDataPacket & { slug: string; name: string; is_active: number }>(
      'SELECT slug, name, is_active FROM categories WHERE shop_id = ? AND id = ?',
      [shopId(), refId],
      conn
    )
  },

  /**
   * Resolve collection link
   */
  async resolveCollection(refId: number, conn: Executor = pool) {
    return queryOne<RowDataPacket & { slug: string; title: string; is_active: number }>(
      'SELECT slug, title, is_active FROM collections WHERE shop_id = ? AND id = ?',
      [shopId(), refId],
      conn
    )
  },

  /**
   * Resolve product link
   */
  async resolveProduct(refId: number, conn: Executor = pool) {
    return queryOne<RowDataPacket & { slug: string; name: string; is_published: number }>(
      // products has no is_published column either: live means status active.
      "SELECT slug, name, (status = 'active') AS is_published FROM products WHERE shop_id = ? AND id = ? AND deleted_at IS NULL",
      [shopId(), refId],
      conn
    )
  },

  /**
   * Resolve article link
   */
  async resolveArticle(refId: number, conn: Executor = pool) {
    return queryOne<RowDataPacket & { slug: string; title: string; status: string }>(
      'SELECT slug, title, status FROM cms_articles WHERE shop_id = ? AND id = ?',
      [shopId(), refId],
      conn
    )
  },
}
