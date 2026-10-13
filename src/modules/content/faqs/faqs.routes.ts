/**
 * Routes for FAQs module
 * Defines HTTP routes for FAQ Groups and FAQs
 */

import { Router } from 'express'
import { authenticate } from '../../../middleware/authenticate'
import { requirePermission } from '../../../middleware/requirePermission'
import { validate } from '../../../middleware/validate'
import { faqGroupsController, faqsController } from './faqs.controller'
import {
  createFAQGroupSchema,
  updateFAQGroupSchema,
  listFAQGroupsQuerySchema,
  faqGroupIdParamSchema,
  faqGroupSlugParamSchema,
  createFAQSchema,
  updateFAQSchema,
  listFAQsQuerySchema,
  faqIdParamSchema,
  bulkUpdateSortOrderSchema,
} from './faqs.schemas'

const router = Router()

// All routes require authentication
router.use(authenticate)

// ══════════════════════════════════════════════════════════════════════════════
// FAQ GROUPS ROUTES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/api/v1/content/faq-groups
 * List FAQ groups
 */
router.get(
  '/faq-groups',
  requirePermission('cms.view'),
  validate({ query: listFAQGroupsQuerySchema }),
  faqGroupsController.list
)

/**
 * POST /admin/api/v1/content/faq-groups
 * Create new FAQ group
 */
router.post(
  '/faq-groups',
  requirePermission('cms.edit'),
  validate({ body: createFAQGroupSchema }),
  faqGroupsController.create
)

/**
 * GET /admin/api/v1/content/faq-groups/slug/:slug
 * Get FAQ group by slug
 */
router.get(
  '/faq-groups/slug/:slug',
  requirePermission('cms.view'),
  validate({ params: faqGroupSlugParamSchema }),
  faqGroupsController.getBySlug
)

/**
 * GET /admin/api/v1/content/faq-groups/:id
 * Get FAQ group by ID
 */
router.get(
  '/faq-groups/:id',
  requirePermission('cms.view'),
  validate({ params: faqGroupIdParamSchema }),
  faqGroupsController.getById
)

/**
 * PUT /admin/api/v1/content/faq-groups/:id
 * Update FAQ group
 */
router.put(
  '/faq-groups/:id',
  requirePermission('cms.edit'),
  validate({ params: faqGroupIdParamSchema, body: updateFAQGroupSchema }),
  faqGroupsController.update
)

/**
 * DELETE /admin/api/v1/content/faq-groups/:id
 * Delete FAQ group
 */
router.delete(
  '/faq-groups/:id',
  requirePermission('cms.delete'),
  validate({ params: faqGroupIdParamSchema }),
  faqGroupsController.delete
)

// ══════════════════════════════════════════════════════════════════════════════
// FAQS ROUTES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /admin/api/v1/content/faqs
 * List FAQs
 */
router.get(
  '/faqs',
  requirePermission('cms.view'),
  validate({ query: listFAQsQuerySchema }),
  faqsController.list
)

/**
 * POST /admin/api/v1/content/faqs
 * Create new FAQ
 */
router.post(
  '/faqs',
  requirePermission('cms.edit'),
  validate({ body: createFAQSchema }),
  faqsController.create
)

/**
 * GET /admin/api/v1/content/faqs/:id
 * Get FAQ by ID
 */
router.get(
  '/faqs/:id',
  requirePermission('cms.view'),
  validate({ params: faqIdParamSchema }),
  faqsController.getById
)

/**
 * PUT /admin/api/v1/content/faqs/:id
 * Update FAQ
 */
router.put(
  '/faqs/:id',
  requirePermission('cms.edit'),
  validate({ params: faqIdParamSchema, body: updateFAQSchema }),
  faqsController.update
)

/**
 * DELETE /admin/api/v1/content/faqs/:id
 * Delete FAQ
 */
router.delete(
  '/faqs/:id',
  requirePermission('cms.delete'),
  validate({ params: faqIdParamSchema }),
  faqsController.delete
)

/**
 * POST /admin/api/v1/content/faqs/:id/helpful
 * Mark FAQ as helpful
 */
router.post(
  '/faqs/:id/helpful',
  requirePermission('cms.view'),
  validate({ params: faqIdParamSchema }),
  faqsController.markHelpful
)

/**
 * POST /admin/api/v1/content/faqs/:id/publish
 * Publish FAQ
 */
router.post(
  '/faqs/:id/publish',
  requirePermission('cms.edit'),
  validate({ params: faqIdParamSchema }),
  faqsController.publish
)

/**
 * POST /admin/api/v1/content/faqs/:id/unpublish
 * Unpublish FAQ
 */
router.post(
  '/faqs/:id/unpublish',
  requirePermission('cms.edit'),
  validate({ params: faqIdParamSchema }),
  faqsController.unpublish
)

/**
 * POST /admin/api/v1/content/faqs/bulk-sort
 * Bulk update sort order
 */
router.post(
  '/faqs/bulk-sort',
  requirePermission('cms.edit'),
  validate({ body: bulkUpdateSortOrderSchema }),
  faqsController.bulkUpdateSortOrder
)

export default router
