/**
 * Banners Routes
 * 
 * Express router configuration for CMS Banners endpoints.
 * All routes require authentication and appropriate permissions.
 */

import { Router } from 'express'
import * as bannersController from './banners.controller'
import { authenticate } from '../../../middleware/authenticate'
import { requirePermission } from '../../../middleware/requirePermission'
import { validate } from '../../../middleware/validate'
import {
  createBannerSchema,
  updateBannerSchema,
  listBannersQuerySchema,
  updateBannerStatsSchema,
  bulkUpdateBannersSchema,
  bannerIdParamSchema,
  placementParamSchema,
  getByPlacementQuerySchema,
} from './banners.schemas'

const router = Router()

// All routes require authentication
router.use(authenticate)

/**
 * GET /admin/api/v1/content/banners/stats/summary
 * Get banner statistics summary
 */
router.get(
  '/stats/summary',
  requirePermission('cms.view'),
  bannersController.getStatsSummary
)

/**
 * GET /admin/api/v1/content/banners/placement/:placement
 * Get active banners by placement (for storefront preview)
 */
router.get(
  '/placement/:placement',
  requirePermission('cms.view'),
  validate({ params: placementParamSchema }),
  validate({ query: getByPlacementQuerySchema }),
  bannersController.getByPlacement
)

/**
 * POST /admin/api/v1/content/banners/bulk-activate
 * Bulk activate banners
 */
router.post(
  '/bulk-activate',
  requirePermission('cms.edit'),
  validate({ body: bulkUpdateBannersSchema }),
  bannersController.bulkActivate
)

/**
 * POST /admin/api/v1/content/banners/bulk-deactivate
 * Bulk deactivate banners
 */
router.post(
  '/bulk-deactivate',
  requirePermission('cms.edit'),
  validate({ body: bulkUpdateBannersSchema }),
  bannersController.bulkDeactivate
)

/**
 * GET /admin/api/v1/content/banners
 * List all banners with filters and pagination
 */
router.get(
  '/',
  requirePermission('cms.view'),
  validate({ query: listBannersQuerySchema }),
  bannersController.list
)

/**
 * POST /admin/api/v1/content/banners
 * Create new banner
 */
router.post(
  '/',
  requirePermission('cms.edit'),
  validate({ body: createBannerSchema }),
  bannersController.create
)

/**
 * GET /admin/api/v1/content/banners/:id
 * Get banner by ID
 */
router.get(
  '/:id',
  requirePermission('cms.view'),
  validate({ params: bannerIdParamSchema }),
  bannersController.getById
)

/**
 * PUT /admin/api/v1/content/banners/:id
 * Update banner
 */
router.put(
  '/:id',
  requirePermission('cms.edit'),
  validate({ params: bannerIdParamSchema }),
  validate({ body: updateBannerSchema }),
  bannersController.update
)

/**
 * DELETE /admin/api/v1/content/banners/:id
 * Delete banner
 */
router.delete(
  '/:id',
  requirePermission('cms.delete'),
  validate({ params: bannerIdParamSchema }),
  bannersController.deleteBanner
)

/**
 * POST /admin/api/v1/content/banners/:id/activate
 * Activate banner
 */
router.post(
  '/:id/activate',
  requirePermission('cms.edit'),
  validate({ params: bannerIdParamSchema }),
  bannersController.activate
)

/**
 * POST /admin/api/v1/content/banners/:id/deactivate
 * Deactivate banner
 */
router.post(
  '/:id/deactivate',
  requirePermission('cms.edit'),
  validate({ params: bannerIdParamSchema }),
  bannersController.deactivate
)

/**
 * POST /admin/api/v1/content/banners/:id/duplicate
 * Duplicate banner
 */
router.post(
  '/:id/duplicate',
  requirePermission('cms.edit'),
  validate({ params: bannerIdParamSchema }),
  bannersController.duplicate
)

/**
 * POST /admin/api/v1/content/banners/:id/stats
 * Update banner stats (impressions/clicks)
 */
router.post(
  '/:id/stats',
  requirePermission('cms.edit'),
  validate({ params: bannerIdParamSchema }),
  validate({ body: updateBannerStatsSchema }),
  bannersController.updateStats
)

/**
 * POST /admin/api/v1/content/banners/:id/track/impression
 * Track impression (can be public or require minimal permission)
 */
router.post(
  '/:id/track/impression',
  validate({ params: bannerIdParamSchema }),
  bannersController.trackImpression
)

/**
 * POST /admin/api/v1/content/banners/:id/track/click
 * Track click (can be public or require minimal permission)
 */
router.post(
  '/:id/track/click',
  validate({ params: bannerIdParamSchema }),
  bannersController.trackClick
)

export default router
