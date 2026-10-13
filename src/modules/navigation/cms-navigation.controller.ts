/**
 * Controllers for CMS Navigation (Storefront Menus)
 * HTTP request handlers
 */

import type { Request, Response } from 'express'
import { asyncHandler } from '../../core/asyncHandler'
import { cmsMenusService, cmsMenuItemsService } from './cms-navigation.service'
import type {
  CreateMenuDto,
  UpdateMenuDto,
  CreateMenuItemDto,
  UpdateMenuItemDto,
  BulkReorderMenuItemDto,
  ListMenusParams,
  ListMenuItemsParams,
} from './cms-navigation.types'

// ══════════════════════════════════════════════════════════════════════════════
// MENUS CONTROLLER
// ══════════════════════════════════════════════════════════════════════════════

export const cmsMenusController = {
  /**
   * GET /admin/api/v1/cms/menus
   * List all menus
   */
  list: asyncHandler(async (req: Request, res: Response) => {
    const params: ListMenusParams = {}

    if (req.query.is_active !== undefined) {
      params.is_active = req.query.is_active === 'true'
    }

    const menus = await cmsMenusService.list(params)

    res.status(200).json({
      success: true,
      data: menus,
    })
  }),

  /**
   * GET /admin/api/v1/cms/menus/:id
   * Get menu by ID
   */
  getById: asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const menu = await cmsMenusService.getById(id)

    res.status(200).json({
      success: true,
      data: menu,
    })
  }),

  /**
   * GET /admin/api/v1/cms/menus/slug/:slug
   * Get menu by slug
   */
  getBySlug: asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params
    const menu = await cmsMenusService.getBySlug(slug)

    res.status(200).json({
      success: true,
      data: menu,
    })
  }),

  /**
   * GET /admin/api/v1/cms/menus/:id/items
   * Get menu with all items (tree structure)
   */
  getWithItems: asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const menuWithItems = await cmsMenusService.getWithItems(id)

    res.status(200).json({
      success: true,
      data: menuWithItems,
    })
  }),

  /**
   * POST /admin/api/v1/cms/menus
   * Create menu
   */
  create: asyncHandler(async (req: Request, res: Response) => {
    const data: CreateMenuDto = req.body
    const menu = await cmsMenusService.create(data)

    res.status(201).json({
      success: true,
      data: menu,
      message: 'Menu created successfully',
    })
  }),

  /**
   * PUT /admin/api/v1/cms/menus/:id
   * Update menu
   */
  update: asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const data: UpdateMenuDto = req.body
    const menu = await cmsMenusService.update(id, data)

    res.status(200).json({
      success: true,
      data: menu,
      message: 'Menu updated successfully',
    })
  }),

  /**
   * DELETE /admin/api/v1/cms/menus/:id
   * Delete menu
   */
  delete: asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10)
    await cmsMenusService.delete(id)

    res.status(200).json({
      success: true,
      message: 'Menu deleted successfully',
    })
  }),
}

// ══════════════════════════════════════════════════════════════════════════════
// MENU ITEMS CONTROLLER
// ══════════════════════════════════════════════════════════════════════════════

export const cmsMenuItemsController = {
  /**
   * GET /admin/api/v1/cms/menu-items
   * List menu items with filtering
   */
  list: asyncHandler(async (req: Request, res: Response) => {
    const params: ListMenuItemsParams = {}

    if (req.query.menu_id) {
      params.menu_id = parseInt(req.query.menu_id as string, 10)
    }

    if (req.query.parent_id !== undefined) {
      const parentId = req.query.parent_id as string
      params.parent_id = parentId === 'null' ? null : parseInt(parentId, 10)
    }

    if (req.query.link_type) {
      params.link_type = req.query.link_type as any
    }

    if (req.query.is_active !== undefined) {
      params.is_active = req.query.is_active === 'true'
    }

    const items = await cmsMenuItemsService.list(params)

    res.status(200).json({
      success: true,
      data: items,
    })
  }),

  /**
   * GET /admin/api/v1/cms/menu-items/:id
   * Get menu item by ID
   */
  getById: asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const item = await cmsMenuItemsService.getById(id)

    res.status(200).json({
      success: true,
      data: item,
    })
  }),

  /**
   * POST /admin/api/v1/cms/menu-items
   * Create menu item
   */
  create: asyncHandler(async (req: Request, res: Response) => {
    const data: CreateMenuItemDto = req.body
    const item = await cmsMenuItemsService.create(data)

    res.status(201).json({
      success: true,
      data: item,
      message: 'Menu item created successfully',
    })
  }),

  /**
   * PUT /admin/api/v1/cms/menu-items/:id
   * Update menu item
   */
  update: asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const data: UpdateMenuItemDto = req.body
    const item = await cmsMenuItemsService.update(id, data)

    res.status(200).json({
      success: true,
      data: item,
      message: 'Menu item updated successfully',
    })
  }),

  /**
   * DELETE /admin/api/v1/cms/menu-items/:id
   * Delete menu item
   */
  delete: asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10)
    await cmsMenuItemsService.delete(id)

    res.status(200).json({
      success: true,
      message: 'Menu item deleted successfully',
    })
  }),

  /**
   * POST /admin/api/v1/cms/menu-items/bulk-reorder
   * Bulk reorder menu items (for drag-and-drop)
   */
  bulkReorder: asyncHandler(async (req: Request, res: Response) => {
    const data: BulkReorderMenuItemDto = req.body
    await cmsMenuItemsService.bulkReorder(data)

    res.status(200).json({
      success: true,
      message: 'Menu items reordered successfully',
    })
  }),
}
