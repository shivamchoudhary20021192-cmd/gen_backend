/**
 * Controller layer for FAQs module
 * Handles HTTP request/response for FAQ Groups and FAQs
 */

import type { Response } from 'express'
import type { AuthRequest } from '../../../middleware/authenticate'
import { asyncHandler } from '../../../core/asyncHandler'
import { faqGroupsService, faqsService } from './faqs.service'

// ══════════════════════════════════════════════════════════════════════════════
// FAQ GROUPS CONTROLLER
// ══════════════════════════════════════════════════════════════════════════════

export const faqGroupsController = {
  /**
   * List FAQ groups
   * GET /admin/api/v1/content/faq-groups
   */
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const params = {
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      sort_by: req.query.sort_by as any,
      sort_order: req.query.sort_order as any,
      search: req.query.search as string,
      is_active: req.query.is_active === 'true' ? true : req.query.is_active === 'false' ? false : undefined,
    }

    const result = await faqGroupsService.list(params)
    res.json({ success: true, data: result.data, pagination: result.pagination })
  }),

  /**
   * Get FAQ group by ID
   * GET /admin/api/v1/content/faq-groups/:id
   */
  getById: asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const group = await faqGroupsService.getById(id)
    res.json({ success: true, data: group })
  }),

  /**
   * Get FAQ group by slug
   * GET /admin/api/v1/content/faq-groups/slug/:slug
   */
  getBySlug: asyncHandler(async (req: AuthRequest, res: Response) => {
    const group = await faqGroupsService.getBySlug(req.params.slug)
    res.json({ success: true, data: group })
  }),

  /**
   * Create FAQ group
   * POST /admin/api/v1/content/faq-groups
   */
  create: asyncHandler(async (req: AuthRequest, res: Response) => {
    const group = await faqGroupsService.create(req.body)
    res.status(201).json({ success: true, data: group, message: 'FAQ group created successfully' })
  }),

  /**
   * Update FAQ group
   * PUT /admin/api/v1/content/faq-groups/:id
   */
  update: asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const group = await faqGroupsService.update(id, req.body)
    res.json({ success: true, data: group, message: 'FAQ group updated successfully' })
  }),

  /**
   * Delete FAQ group
   * DELETE /admin/api/v1/content/faq-groups/:id
   */
  delete: asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id, 10)
    await faqGroupsService.delete(id)
    res.json({ success: true, message: 'FAQ group deleted successfully' })
  }),
}

// ══════════════════════════════════════════════════════════════════════════════
// FAQS CONTROLLER
// ══════════════════════════════════════════════════════════════════════════════

export const faqsController = {
  /**
   * List FAQs
   * GET /admin/api/v1/content/faqs
   */
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const params = {
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      sort_by: req.query.sort_by as any,
      sort_order: req.query.sort_order as any,
      search: req.query.search as string,
      group_id: req.query.group_id ? parseInt(req.query.group_id as string, 10) : undefined,
      entity_type: req.query.entity_type as string,
      entity_id: req.query.entity_id ? parseInt(req.query.entity_id as string, 10) : undefined,
      is_published: req.query.is_published === 'true' ? true : req.query.is_published === 'false' ? false : undefined,
      is_indexable: req.query.is_indexable === 'true' ? true : req.query.is_indexable === 'false' ? false : undefined,
    }

    const result = await faqsService.list(params)
    res.json({ success: true, data: result.data, pagination: result.pagination })
  }),

  /**
   * Get FAQ by ID
   * GET /admin/api/v1/content/faqs/:id
   */
  getById: asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const faq = await faqsService.getById(id)
    res.json({ success: true, data: faq })
  }),

  /**
   * Create FAQ
   * POST /admin/api/v1/content/faqs
   */
  create: asyncHandler(async (req: AuthRequest, res: Response) => {
    const faq = await faqsService.create(req.body)
    res.status(201).json({ success: true, data: faq, message: 'FAQ created successfully' })
  }),

  /**
   * Update FAQ
   * PUT /admin/api/v1/content/faqs/:id
   */
  update: asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const faq = await faqsService.update(id, req.body)
    res.json({ success: true, data: faq, message: 'FAQ updated successfully' })
  }),

  /**
   * Delete FAQ
   * DELETE /admin/api/v1/content/faqs/:id
   */
  delete: asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id, 10)
    await faqsService.delete(id)
    res.json({ success: true, message: 'FAQ deleted successfully' })
  }),

  /**
   * Mark FAQ as helpful
   * POST /admin/api/v1/content/faqs/:id/helpful
   */
  markHelpful: asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id, 10)
    await faqsService.markHelpful(id)
    res.json({ success: true, message: 'Thank you for your feedback' })
  }),

  /**
   * Publish FAQ
   * POST /admin/api/v1/content/faqs/:id/publish
   */
  publish: asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const faq = await faqsService.publish(id)
    res.json({ success: true, data: faq, message: 'FAQ published successfully' })
  }),

  /**
   * Unpublish FAQ
   * POST /admin/api/v1/content/faqs/:id/unpublish
   */
  unpublish: asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = parseInt(req.params.id, 10)
    const faq = await faqsService.unpublish(id)
    res.json({ success: true, data: faq, message: 'FAQ unpublished successfully' })
  }),

  /**
   * Bulk update sort order
   * POST /admin/api/v1/content/faqs/bulk-sort
   */
  bulkUpdateSortOrder: asyncHandler(async (req: AuthRequest, res: Response) => {
    await faqsService.bulkUpdateSortOrder(req.body.updates)
    res.json({ success: true, message: 'Sort order updated successfully' })
  }),
}
