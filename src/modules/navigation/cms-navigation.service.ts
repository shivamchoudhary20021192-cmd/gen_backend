/**
 * Service for CMS Navigation (Storefront Menus)
 * Business logic, validation, and tree building
 */

import { ApiError } from '../../core/ApiError'
import { slugify as makeSlug } from '../../core/slug'
import { storage } from '../media/storage'
import {
  cmsMenusRepository,
  cmsMenuItemsRepository,
  linkResolutionRepository,
} from './cms-navigation.repository'
import type {
  Menu,
  MenuListItem,
  MenuItem,
  MenuItemWithMedia,
  MenuItemTreeNode,
  MenuWithItems,
  CreateMenuDto,
  UpdateMenuDto,
  CreateMenuItemDto,
  UpdateMenuItemDto,
  BulkReorderMenuItemDto,
  ListMenusParams,
  ListMenuItemsParams,
  MenuItemWithMediaRow,
  ResolvedLink,
  LinkType,
  MenuItemWithResolvedLink,
} from './cms-navigation.types'

// ══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

function presentMenu(row: any): Menu {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    is_active: row.is_active === 1,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }
}

function presentMenuListItem(row: any): MenuListItem {
  return {
    ...presentMenu(row),
    item_count: row.item_count,
  }
}

function presentMenuItem(row: any): MenuItem {
  return {
    id: row.id,
    menu_id: row.menu_id,
    parent_id: row.parent_id,
    label: row.label,
    link_type: row.link_type,
    link_ref_id: row.link_ref_id,
    url: row.url,
    icon_media_id: row.icon_media_id,
    image_media_id: row.image_media_id,
    badge_label: row.badge_label,
    description: row.description,
    sort_order: row.sort_order,
    opens_new_tab: row.opens_new_tab === 1,
    is_active: row.is_active === 1,
  }
}

function presentMenuItemWithMedia(row: MenuItemWithMediaRow): MenuItemWithMedia {
  return {
    ...presentMenuItem(row),
    icon_media: row.icon_media_id && row.icon_storage_key
      ? {
          id: row.icon_media_id,
          url: storage.publicUrl(row.icon_storage_key),
          alt_text: row.icon_alt_text,
        }
      : null,
    image_media: row.image_media_id && row.image_storage_key
      ? {
          id: row.image_media_id,
          url: storage.publicUrl(row.image_storage_key),
          alt_text: row.image_alt_text,
        }
      : null,
  }
}

function buildTree(items: MenuItemWithMedia[]): MenuItemTreeNode[] {
  const itemMap = new Map<number, MenuItemTreeNode>()
  const roots: MenuItemTreeNode[] = []

  // Create nodes
  for (const item of items) {
    itemMap.set(item.id, { ...item, children: [] })
  }

  // Build tree
  for (const item of items) {
    const node = itemMap.get(item.id)!
    if (item.parent_id === null) {
      roots.push(node)
    } else {
      const parent = itemMap.get(item.parent_id)
      if (parent) {
        parent.children.push(node)
      } else {
        // Orphaned item - add to root
        roots.push(node)
      }
    }
  }

  return roots
}

// ══════════════════════════════════════════════════════════════════════════════
// MENUS SERVICE
// ══════════════════════════════════════════════════════════════════════════════

export const cmsMenusService = {
  /**
   * List menus
   */
  async list(params: ListMenusParams = {}): Promise<MenuListItem[]> {
    const rows = await cmsMenusRepository.listWithCounts(params)
    return rows.map(presentMenuListItem)
  },

  /**
   * Get menu by ID
   */
  async getById(id: number): Promise<Menu> {
    const row = await cmsMenusRepository.getById(id)
    if (!row) throw ApiError.notFound('Menu')
    return presentMenu(row)
  },

  /**
   * Get menu by slug
   */
  async getBySlug(slug: string): Promise<Menu> {
    const row = await cmsMenusRepository.getBySlug(slug)
    if (!row) throw ApiError.notFound('Menu')
    return presentMenu(row)
  },

  /**
   * Get menu with all items (tree structure)
   */
  async getWithItems(id: number): Promise<MenuWithItems> {
    const menuRow = await cmsMenusRepository.getById(id)
    if (!menuRow) throw ApiError.notFound('Menu')

    const itemRows = await cmsMenuItemsRepository.getAllForMenu(id)
    const items = itemRows.map(presentMenuItemWithMedia)
    const tree = buildTree(items)

    return {
      ...presentMenu(menuRow),
      items: tree,
    }
  },

  /**
   * Create menu
   */
  async create(data: CreateMenuDto): Promise<Menu> {
    // Validate required fields
    if (!data.name?.trim()) {
      throw ApiError.badRequest('Menu name is required')
    }

    // Generate slug if not provided
    let slug = data.slug?.trim()
    if (!slug) {
      slug = makeSlug(data.name)
    }

    // Validate slug format
    if (!/^[a-z0-9-]+$/.test(slug)) {
      throw ApiError.badRequest('Slug must contain only lowercase letters, numbers, and hyphens')
    }

    // Check slug uniqueness
    const exists = await cmsMenusRepository.slugExists(slug)
    if (exists) {
      throw ApiError.conflict('Menu slug already exists')
    }

    const id = await cmsMenusRepository.create({
      slug,
      name: data.name.trim(),
      is_active: data.is_active !== false,
    })

    return this.getById(id)
  },

  /**
   * Update menu
   */
  async update(id: number, data: UpdateMenuDto): Promise<Menu> {
    const existing = await cmsMenusRepository.getById(id)
    if (!existing) throw ApiError.notFound('Menu')

    const updates: Record<string, unknown> = {}

    if (data.name !== undefined) {
      if (!data.name.trim()) {
        throw ApiError.badRequest('Menu name cannot be empty')
      }
      updates.name = data.name.trim()
    }

    if (data.slug !== undefined) {
      const slug = data.slug.trim()
      if (!slug) {
        throw ApiError.badRequest('Menu slug cannot be empty')
      }
      if (!/^[a-z0-9-]+$/.test(slug)) {
        throw ApiError.badRequest('Slug must contain only lowercase letters, numbers, and hyphens')
      }
      if (slug !== existing.slug) {
        const exists = await cmsMenusRepository.slugExists(slug, id)
        if (exists) {
          throw ApiError.conflict('Menu slug already exists')
        }
        updates.slug = slug
      }
    }

    if (data.is_active !== undefined) {
      updates.is_active = data.is_active ? 1 : 0
    }

    if (Object.keys(updates).length > 0) {
      await cmsMenusRepository.update(id, updates)
    }

    return this.getById(id)
  },

  /**
   * Delete menu
   */
  async delete(id: number): Promise<void> {
    const existing = await cmsMenusRepository.getById(id)
    if (!existing) throw ApiError.notFound('Menu')

    // Check if it's a system menu (main, footer, mobile_drawer)
    if (['main', 'footer', 'mobile_drawer', 'footer_shop', 'footer_support'].includes(existing.slug)) {
      throw ApiError.forbidden('Cannot delete system menu')
    }

    await cmsMenusRepository.delete(id)
  },
}

// ══════════════════════════════════════════════════════════════════════════════
// MENU ITEMS SERVICE
// ══════════════════════════════════════════════════════════════════════════════

export const cmsMenuItemsService = {
  /**
   * List menu items
   */
  async list(params: ListMenuItemsParams = {}): Promise<MenuItemWithMedia[]> {
    const rows = await cmsMenuItemsRepository.listWithMedia(params)
    return rows.map(presentMenuItemWithMedia)
  },

  /**
   * Get menu item by ID
   */
  async getById(id: number): Promise<MenuItemWithMedia> {
    const row = await cmsMenuItemsRepository.getByIdWithMedia(id)
    if (!row) throw ApiError.notFound('Menu item')
    return presentMenuItemWithMedia(row)
  },

  /**
   * Create menu item
   */
  async create(data: CreateMenuItemDto): Promise<MenuItemWithMedia> {
    // Validate required fields
    if (!data.label?.trim()) {
      throw ApiError.badRequest('Menu item label is required')
    }

    // Validate menu exists
    const menu = await cmsMenusRepository.getById(data.menu_id)
    if (!menu) throw ApiError.notFound('Menu')

    // Validate parent exists if provided
    if (data.parent_id !== undefined && data.parent_id !== null) {
      const parent = await cmsMenuItemsRepository.getById(data.parent_id)
      if (!parent) throw ApiError.notFound('Parent menu item')
      if (parent.menu_id !== data.menu_id) {
        throw ApiError.badRequest('Parent must belong to the same menu')
      }
    }

    // Validate link type and ref_id
    this.validateLink(data.link_type, data.link_ref_id, data.url)

    // Get max sort order if not provided
    let sortOrder = data.sort_order ?? 0
    if (sortOrder === 0) {
      const maxOrder = await cmsMenuItemsRepository.getMaxSortOrder(data.menu_id, data.parent_id ?? null)
      sortOrder = maxOrder + 10
    }

    const id = await cmsMenuItemsRepository.create({
      ...data,
      label: data.label.trim(),
      sort_order: sortOrder,
    })

    return this.getById(id)
  },

  /**
   * Update menu item
   */
  async update(id: number, data: UpdateMenuItemDto): Promise<MenuItemWithMedia> {
    const existing = await cmsMenuItemsRepository.getById(id)
    if (!existing) throw ApiError.notFound('Menu item')

    const updates: Record<string, unknown> = {}

    if (data.label !== undefined) {
      if (!data.label.trim()) {
        throw ApiError.badRequest('Menu item label cannot be empty')
      }
      updates.label = data.label.trim()
    }

    if (data.parent_id !== undefined) {
      if (data.parent_id !== null) {
        // Check parent exists
        const parent = await cmsMenuItemsRepository.getById(data.parent_id)
        if (!parent) throw ApiError.notFound('Parent menu item')
        if (parent.menu_id !== existing.menu_id) {
          throw ApiError.badRequest('Parent must belong to the same menu')
        }

        // Check for circular reference
        const wouldCycle = await cmsMenuItemsRepository.wouldCreateCycle(id, data.parent_id)
        if (wouldCycle) {
          throw ApiError.badRequest('Cannot move item under its own descendant')
        }
      }
      updates.parent_id = data.parent_id
    }

    if (data.link_type !== undefined) {
      this.validateLink(
        data.link_type,
        data.link_ref_id !== undefined ? data.link_ref_id : existing.link_ref_id,
        data.url !== undefined ? data.url : existing.url
      )
      updates.link_type = data.link_type
    }

    if (data.link_ref_id !== undefined) {
      updates.link_ref_id = data.link_ref_id
    }

    if (data.url !== undefined) {
      updates.url = data.url
    }

    if (data.icon_media_id !== undefined) {
      updates.icon_media_id = data.icon_media_id
    }

    if (data.image_media_id !== undefined) {
      updates.image_media_id = data.image_media_id
    }

    if (data.badge_label !== undefined) {
      updates.badge_label = data.badge_label
    }

    if (data.description !== undefined) {
      updates.description = data.description
    }

    if (data.sort_order !== undefined) {
      updates.sort_order = data.sort_order
    }

    if (data.opens_new_tab !== undefined) {
      updates.opens_new_tab = data.opens_new_tab ? 1 : 0
    }

    if (data.is_active !== undefined) {
      updates.is_active = data.is_active ? 1 : 0
    }

    if (Object.keys(updates).length > 0) {
      await cmsMenuItemsRepository.update(id, updates)
    }

    return this.getById(id)
  },

  /**
   * Delete menu item
   */
  async delete(id: number): Promise<void> {
    const existing = await cmsMenuItemsRepository.getById(id)
    if (!existing) throw ApiError.notFound('Menu item')

    // Check if has children
    const childrenCount = await cmsMenuItemsRepository.countChildren(id)
    if (childrenCount > 0) {
      throw ApiError.conflict('Cannot delete menu item with children. Delete children first.')
    }

    await cmsMenuItemsRepository.delete(id)
  },

  /**
   * Bulk reorder menu items
   */
  async bulkReorder(data: BulkReorderMenuItemDto): Promise<void> {
    if (!data.updates || data.updates.length === 0) {
      throw ApiError.badRequest('No updates provided')
    }

    // Validate all items exist
    for (const update of data.updates) {
      const item = await cmsMenuItemsRepository.getById(update.id)
      if (!item) {
        throw ApiError.notFound(`Menu item ${update.id}`)
      }

      // Validate parent if provided
      if (update.parent_id !== null) {
        const parent = await cmsMenuItemsRepository.getById(update.parent_id)
        if (!parent) {
          throw ApiError.notFound(`Parent menu item ${update.parent_id}`)
        }
        if (parent.menu_id !== item.menu_id) {
          throw ApiError.badRequest('Parent must belong to the same menu')
        }

        // Check for circular reference
        const wouldCycle = await cmsMenuItemsRepository.wouldCreateCycle(update.id, update.parent_id)
        if (wouldCycle) {
          throw ApiError.badRequest('Cannot move item under its own descendant')
        }
      }
    }

    await cmsMenuItemsRepository.bulkReorder(data.updates)
  },

  /**
   * Validate link type consistency
   */
  validateLink(linkType: LinkType, refId: number | null | undefined, url: string | null | undefined): void {
    if (linkType === 'url') {
      if (!url?.trim()) {
        throw ApiError.badRequest('URL is required when link type is "url"')
      }
    } else if (linkType !== 'none') {
      if (!refId) {
        throw ApiError.badRequest(`Reference ID is required for link type "${linkType}"`)
      }
    }
  },

  /**
   * Resolve link for display
   */
  async resolveLink(item: MenuItem): Promise<ResolvedLink> {
    const resolved: ResolvedLink = {
      type: item.link_type,
      url: null,
      ref_id: item.link_ref_id,
      ref_slug: null,
      ref_title: null,
      is_available: true,
    }

    if (item.link_type === 'url') {
      resolved.url = item.url
      return resolved
    }

    if (item.link_type === 'none') {
      return resolved
    }

    if (!item.link_ref_id) {
      resolved.is_available = false
      return resolved
    }

    try {
      switch (item.link_type) {
        case 'page': {
          const page = await linkResolutionRepository.resolvePage(item.link_ref_id)
          if (page) {
            resolved.ref_slug = page.slug
            resolved.ref_title = page.title
            resolved.url = `/pages/${page.slug}`
            resolved.is_available = page.is_published === 1
          } else {
            resolved.is_available = false
          }
          break
        }
        case 'category': {
          const category = await linkResolutionRepository.resolveCategory(item.link_ref_id)
          if (category) {
            resolved.ref_slug = category.slug
            resolved.ref_title = category.name
            resolved.url = `/shop/categories/${category.slug}`
            resolved.is_available = category.is_active === 1
          } else {
            resolved.is_available = false
          }
          break
        }
        case 'collection': {
          const collection = await linkResolutionRepository.resolveCollection(item.link_ref_id)
          if (collection) {
            resolved.ref_slug = collection.slug
            resolved.ref_title = collection.title
            resolved.url = `/collections/${collection.slug}`
            resolved.is_available = collection.is_active === 1
          } else {
            resolved.is_available = false
          }
          break
        }
        case 'product': {
          const product = await linkResolutionRepository.resolveProduct(item.link_ref_id)
          if (product) {
            resolved.ref_slug = product.slug
            resolved.ref_title = product.name
            resolved.url = `/products/${product.slug}`
            resolved.is_available = product.is_published === 1
          } else {
            resolved.is_available = false
          }
          break
        }
        case 'article': {
          const article = await linkResolutionRepository.resolveArticle(item.link_ref_id)
          if (article) {
            resolved.ref_slug = article.slug
            resolved.ref_title = article.title
            resolved.url = `/blog/${article.slug}`
            resolved.is_available = article.status === 'published'
          } else {
            resolved.is_available = false
          }
          break
        }
        default:
          // policy, ingredient, routine - would need additional resolution
          resolved.is_available = false
      }
    } catch {
      resolved.is_available = false
    }

    return resolved
  },
}
