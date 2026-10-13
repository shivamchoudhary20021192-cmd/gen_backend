/**
 * Routes for CMS Navigation (Storefront Menus)
 * Admin API for managing menus and menu items
 */

import { Router } from 'express'
import { authenticate } from '../../middleware/authenticate'
import { requirePermission } from '../../middleware/requirePermission'
import { validate } from '../../middleware/validate'
import { cmsMenusController, cmsMenuItemsController } from './cms-navigation.controller'
import {
  createMenuSchema,
  updateMenuSchema,
  listMenusQuerySchema,
  menuIdParamSchema,
  menuSlugParamSchema,
  createMenuItemSchema,
  updateMenuItemSchema,
  listMenuItemsQuerySchema,
  menuItemIdParamSchema,
  bulkReorderMenuItemsSchema,
} from './cms-navigation.schemas'

const router = Router()

// All routes require authentication
router.use(authenticate)

// ══════════════════════════════════════════════════════════════════════════════
// MENUS ROUTES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/api/v1/cms/menus
 * List all menus
 */
router.get(
  '/menus',
  requirePermission('content.navigation.read'),
  validate({ query: listMenusQuerySchema }),
  cmsMenusController.list
)

/**
 * POST /admin/api/v1/cms/menus
 * Create new menu
 */
router.post(
  '/menus',
  requirePermission('content.navigation.create'),
  validate({ body: createMenuSchema }),
  cmsMenusController.create
)

/**
 * GET /admin/api/v1/cms/menus/slug/:slug
 * Get menu by slug
 */
router.get(
  '/menus/slug/:slug',
  requirePermission('content.navigation.read'),
  validate({ params: menuSlugParamSchema }),
  cmsMenusController.getBySlug
)

/**
 * GET /admin/api/v1/cms/menus/:id
 * Get menu by ID
 */
router.get(
  '/menus/:id',
  requirePermission('content.navigation.read'),
  validate({ params: menuIdParamSchema }),
  cmsMenusController.getById
)

/**
 * GET /admin/api/v1/cms/menus/:id/items
 * Get menu with all items (tree structure)
 */
router.get(
  '/menus/:id/items',
  requirePermission('content.navigation.read'),
  validate({ params: menuIdParamSchema }),
  cmsMenusController.getWithItems
)

/**
 * PUT /admin/api/v1/cms/menus/:id
 * Update menu
 */
router.put(
  '/menus/:id',
  requirePermission('content.navigation.update'),
  validate({ params: menuIdParamSchema, body: updateMenuSchema }),
  cmsMenusController.update
)

/**
 * DELETE /admin/api/v1/cms/menus/:id
 * Delete menu
 */
router.delete(
  '/menus/:id',
  requirePermission('content.navigation.delete'),
  validate({ params: menuIdParamSchema }),
  cmsMenusController.delete
)

// ══════════════════════════════════════════════════════════════════════════════
// MENU ITEMS ROUTES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/api/v1/cms/menu-items
 * List menu items with filtering
 */
router.get(
  '/menu-items',
  requirePermission('content.navigation.read'),
  validate({ query: listMenuItemsQuerySchema }),
  cmsMenuItemsController.list
)

/**
 * POST /admin/api/v1/cms/menu-items
 * Create new menu item
 */
router.post(
  '/menu-items',
  requirePermission('content.navigation.create'),
  validate({ body: createMenuItemSchema }),
  cmsMenuItemsController.create
)

/**
 * POST /admin/api/v1/cms/menu-items/bulk-reorder
 * Bulk reorder menu items (for drag-and-drop)
 */
router.post(
  '/menu-items/bulk-reorder',
  requirePermission('content.navigation.update'),
  validate({ body: bulkReorderMenuItemsSchema }),
  cmsMenuItemsController.bulkReorder
)

/**
 * GET /admin/api/v1/cms/menu-items/:id
 * Get menu item by ID
 */
router.get(
  '/menu-items/:id',
  requirePermission('content.navigation.read'),
  validate({ params: menuItemIdParamSchema }),
  cmsMenuItemsController.getById
)

/**
 * PUT /admin/api/v1/cms/menu-items/:id
 * Update menu item
 */
router.put(
  '/menu-items/:id',
  requirePermission('content.navigation.update'),
  validate({ params: menuItemIdParamSchema, body: updateMenuItemSchema }),
  cmsMenuItemsController.update
)

/**
 * DELETE /admin/api/v1/cms/menu-items/:id
 * Delete menu item
 */
router.delete(
  '/menu-items/:id',
  requirePermission('content.navigation.delete'),
  validate({ params: menuItemIdParamSchema }),
  cmsMenuItemsController.delete
)

export default router
