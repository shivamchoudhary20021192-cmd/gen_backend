/**
 * Pages Routes
 * 
 * Route definitions for CMS Pages API endpoints.
 */

import { Router, type RequestHandler } from 'express'
import { asyncHandler } from '../../../core/asyncHandler'
import { authenticate } from '../../../middleware/authenticate'
import { requirePermission } from '../../../middleware/requirePermission'
import { validate } from '../../../middleware/validate'
import { pagesController } from './pages.controller'
import {
  createPageSchema,
  updatePageSchema,
  listPagesQuerySchema,
  publishPageSchema,
  createSectionSchema,
  updateSectionSchema,
  reorderSectionsSchema,
  bulkUpdatePagesSchema,
  pageIdParamSchema,
  sectionIdParamSchema,
} from './pages.schemas'

export const pagesRouter = Router()

/**
 * Making a page public takes cms.publish wherever it happens. Create, update
 * and bulk-update all accept a status, and checking only POST /:id/publish
 * let anyone with cms.edit publish through them instead.
 */
const PUBLIC_STATUSES: ReadonlySet<unknown> = new Set(['published', 'scheduled'])
const publishingNeedsPublish: RequestHandler = (req, res, next) => {
  if (PUBLIC_STATUSES.has((req.body as { status?: unknown } | undefined)?.status)) {
    requirePermission('cms.publish')(req, res, next)
    return
  }
  next()
}

// All routes require authentication
pagesRouter.use(authenticate)

/**
 * List pages with pagination and filters
 * GET /admin/api/v1/content/pages
 * Permission: cms.view
 */
pagesRouter.get(
  '/',
  requirePermission('cms.view'),
  validate({ query: listPagesQuerySchema }),
  asyncHandler(pagesController.list)
)

/**
 * Get page by slug
 * GET /admin/api/v1/content/pages/slug/:slug
 * Permission: cms.view
 */
pagesRouter.get(
  '/slug/:slug',
  requirePermission('cms.view'),
  asyncHandler(pagesController.getBySlug)
)

/**
 * Get single page by ID
 * GET /admin/api/v1/content/pages/:id
 * Permission: cms.view
 */
pagesRouter.get(
  '/:id',
  requirePermission('cms.view'),
  validate({ params: pageIdParamSchema }),
  asyncHandler(pagesController.getById)
)

/**
 * Create new page
 * POST /admin/api/v1/content/pages
 * Permission: cms.edit
 */
pagesRouter.post(
  '/',
  requirePermission('cms.edit'),
  validate({ body: createPageSchema }),
  publishingNeedsPublish,
  asyncHandler(pagesController.create)
)

/**
 * Update existing page
 * PUT /admin/api/v1/content/pages/:id
 * Permission: cms.edit
 */
pagesRouter.put(
  '/:id',
  requirePermission('cms.edit'),
  validate({ params: pageIdParamSchema, body: updatePageSchema }),
  publishingNeedsPublish,
  asyncHandler(pagesController.update)
)

/**
 * Delete page
 * DELETE /admin/api/v1/content/pages/:id
 * Permission: cms.delete
 */
pagesRouter.delete(
  '/:id',
  requirePermission('cms.delete'),
  validate({ params: pageIdParamSchema }),
  asyncHandler(pagesController.delete)
)

/**
 * Publish page
 * POST /admin/api/v1/content/pages/:id/publish
 * Permission: cms.publish
 */
pagesRouter.post(
  '/:id/publish',
  requirePermission('cms.publish'),
  validate({ params: pageIdParamSchema, body: publishPageSchema }),
  asyncHandler(pagesController.publish)
)

/**
 * Unpublish page
 * POST /admin/api/v1/content/pages/:id/unpublish
 * Permission: cms.publish
 */
pagesRouter.post(
  '/:id/unpublish',
  requirePermission('cms.publish'),
  validate({ params: pageIdParamSchema }),
  asyncHandler(pagesController.unpublish)
)

/**
 * Archive page
 * POST /admin/api/v1/content/pages/:id/archive
 * Permission: cms.edit
 */
pagesRouter.post(
  '/:id/archive',
  requirePermission('cms.edit'),
  validate({ params: pageIdParamSchema }),
  asyncHandler(pagesController.archive)
)

/**
 * Restore archived page
 * POST /admin/api/v1/content/pages/:id/restore
 * Permission: cms.edit
 */
pagesRouter.post(
  '/:id/restore',
  requirePermission('cms.edit'),
  validate({ params: pageIdParamSchema }),
  asyncHandler(pagesController.restore)
)

/**
 * Duplicate page
 * POST /admin/api/v1/content/pages/:id/duplicate
 * Permission: cms.edit
 */
pagesRouter.post(
  '/:id/duplicate',
  requirePermission('cms.edit'),
  validate({ params: pageIdParamSchema }),
  asyncHandler(pagesController.duplicate)
)

/**
 * Issue (or replace) a shareable preview link for a draft
 * POST /admin/api/v1/content/pages/:id/preview-link
 * Permission: cms.edit
 */
pagesRouter.post(
  '/:id/preview-link',
  requirePermission('cms.edit'),
  validate({ params: pageIdParamSchema }),
  asyncHandler(pagesController.issuePreviewLink)
)

/**
 * Revoke the preview link
 * DELETE /admin/api/v1/content/pages/:id/preview-link
 * Permission: cms.edit
 */
pagesRouter.delete(
  '/:id/preview-link',
  requirePermission('cms.edit'),
  validate({ params: pageIdParamSchema }),
  asyncHandler(pagesController.revokePreviewLink)
)

/**
 * Mark page as reviewed
 * POST /admin/api/v1/content/pages/:id/review
 * Permission: cms.review — separate from cms.edit, so the person who wrote a
 * regulated page need not be the one who signs it off
 */
pagesRouter.post(
  '/:id/review',
  requirePermission('cms.review'),
  validate({ params: pageIdParamSchema }),
  asyncHandler(pagesController.markReviewed)
)

/**
 * Add section to page
 * POST /admin/api/v1/content/pages/:id/sections
 * Permission: cms.edit
 */
pagesRouter.post(
  '/:id/sections',
  requirePermission('cms.edit'),
  validate({ params: pageIdParamSchema, body: createSectionSchema }),
  asyncHandler(pagesController.addSection)
)

/**
 * Update section
 * PUT /admin/api/v1/content/pages/:id/sections/:sectionId
 * Permission: cms.edit
 */
pagesRouter.put(
  '/:id/sections/:sectionId',
  requirePermission('cms.edit'),
  validate({ params: pageIdParamSchema.merge(sectionIdParamSchema), body: updateSectionSchema }),
  asyncHandler(pagesController.updateSection)
)

/**
 * Delete section
 * DELETE /admin/api/v1/content/pages/:id/sections/:sectionId
 * Permission: cms.edit
 */
pagesRouter.delete(
  '/:id/sections/:sectionId',
  requirePermission('cms.edit'),
  validate({ params: pageIdParamSchema.merge(sectionIdParamSchema) }),
  asyncHandler(pagesController.deleteSection)
)

/**
 * Reorder sections
 * PUT /admin/api/v1/content/pages/:id/sections/reorder
 * Permission: cms.edit
 */
pagesRouter.put(
  '/:id/sections/reorder',
  requirePermission('cms.edit'),
  validate({ params: pageIdParamSchema, body: reorderSectionsSchema }),
  asyncHandler(pagesController.reorderSections)
)

/**
 * Bulk update pages
 * POST /admin/api/v1/content/pages/bulk-update
 * Permission: cms.edit
 */
pagesRouter.post(
  '/bulk-update',
  requirePermission('cms.edit'),
  validate({ body: bulkUpdatePagesSchema }),
  publishingNeedsPublish,
  asyncHandler(pagesController.bulkUpdate)
)
