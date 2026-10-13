/**
 * Pages Controller
 * 
 * HTTP request handlers for CMS Pages endpoints.
 */

import type { Request, Response } from 'express'
import { pagesService } from './pages.service'
import type { CreatePageDto, UpdatePageDto, PublishPageDto, CreateSectionDto, UpdateSectionDto } from './pages.types'

export const pagesController = {
  /**
   * GET /admin/api/v1/content/pages
   * List pages with pagination and filters
   */
  async list(req: Request, res: Response): Promise<void> {
    const {
      page = 1,
      limit = 20,
      sort_by = 'updated_at',
      sort_order = 'desc',
      ...filters
    } = req.query as any

    const result = await pagesService.list(filters, {
      page: Number(page),
      limit: Number(limit),
      sort_by,
      sort_order,
    })

    res.status(200).json(result)
  },

  /**
   * GET /admin/api/v1/content/pages/:id
   * Get single page by ID
   */
  async getById(req: Request, res: Response): Promise<void> {
    const { id } = req.params

    const page = await pagesService.getById(Number(id))

    res.status(200).json(page)
  },

  /**
   * GET /admin/api/v1/content/pages/slug/:slug
   * Get page by slug
   */
  async getBySlug(req: Request, res: Response): Promise<void> {
    const { slug } = req.params
    const { locale = 'en-IN' } = req.query

    const page = await pagesService.getBySlug(slug, locale as string)

    res.status(200).json(page)
  },

  /**
   * POST /admin/api/v1/content/pages
   * Create new page
   */
  async create(req: Request, res: Response): Promise<void> {
    const adminId = req.admin!.id
    const data: CreatePageDto = req.body

    // Convert ISO string dates to Date objects
    if (data.scheduled_at) {
      data.scheduled_at = new Date(data.scheduled_at)
    }
    if (data.unpublish_at) {
      data.unpublish_at = new Date(data.unpublish_at)
    }

    const page = await pagesService.create(data, adminId)

    res.status(201).json(page)
  },

  /**
   * PUT /admin/api/v1/content/pages/:id
   * Update existing page
   */
  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params
    const adminId = req.admin!.id
    const data: UpdatePageDto = req.body

    // Convert ISO string dates to Date objects
    if (data.published_at) {
      data.published_at = new Date(data.published_at)
    }
    if (data.scheduled_at) {
      data.scheduled_at = new Date(data.scheduled_at)
    }
    if (data.unpublish_at) {
      data.unpublish_at = new Date(data.unpublish_at)
    }
    if (data.reviewed_at) {
      data.reviewed_at = new Date(data.reviewed_at)
    }

    const page = await pagesService.update(Number(id), data, adminId)

    res.status(200).json(page)
  },

  /**
   * DELETE /admin/api/v1/content/pages/:id
   * Soft delete page
   */
  async delete(req: Request, res: Response): Promise<void> {
    const { id } = req.params

    await pagesService.delete(Number(id))

    res.status(204).send()
  },

  /**
   * POST /admin/api/v1/content/pages/:id/publish
   * Publish page (immediately or scheduled)
   */
  async publish(req: Request, res: Response): Promise<void> {
    const { id } = req.params
    const adminId = req.admin!.id
    const data: PublishPageDto = req.body

    // Convert ISO string dates to Date objects
    if (data.scheduled_at) {
      data.scheduled_at = new Date(data.scheduled_at)
    }
    if (data.unpublish_at) {
      data.unpublish_at = new Date(data.unpublish_at)
    }

    const page = await pagesService.publish(Number(id), data, adminId)

    res.status(200).json(page)
  },

  /**
   * POST /admin/api/v1/content/pages/:id/unpublish
   * Unpublish page (set to draft)
   */
  async unpublish(req: Request, res: Response): Promise<void> {
    const { id } = req.params
    const adminId = req.admin!.id

    const page = await pagesService.unpublish(Number(id), adminId)

    res.status(200).json(page)
  },

  /**
   * POST /admin/api/v1/content/pages/:id/archive
   * Archive page
   */
  async archive(req: Request, res: Response): Promise<void> {
    const { id } = req.params
    const adminId = req.admin!.id

    const page = await pagesService.archive(Number(id), adminId)

    res.status(200).json(page)
  },

  /**
   * POST /admin/api/v1/content/pages/:id/restore
   * Restore archived page
   */
  async restore(req: Request, res: Response): Promise<void> {
    const { id } = req.params
    const adminId = req.admin!.id

    const page = await pagesService.restore(Number(id), adminId)

    res.status(200).json(page)
  },

  /**
   * POST /admin/api/v1/content/pages/:id/duplicate
   * Duplicate page
   */
  async duplicate(req: Request, res: Response): Promise<void> {
    const { id } = req.params
    const adminId = req.admin!.id

    const page = await pagesService.duplicate(Number(id), adminId)

    res.status(201).json(page)
  },

  /**
   * POST /admin/api/v1/content/pages/:id/review
   * Mark page as reviewed
   */
  async markReviewed(req: Request, res: Response): Promise<void> {
    const { id } = req.params
    const adminId = req.admin!.id

    const page = await pagesService.markReviewed(Number(id), adminId)

    res.status(200).json(page)
  },

  /**
   * POST /admin/api/v1/content/pages/:id/sections
   * Add section to page
   */
  async addSection(req: Request, res: Response): Promise<void> {
    const { id } = req.params
    const data: CreateSectionDto = req.body

    // Convert ISO string dates to Date objects
    if (data.visible_from) {
      data.visible_from = new Date(data.visible_from)
    }
    if (data.visible_until) {
      data.visible_until = new Date(data.visible_until)
    }

    const sectionId = await pagesService.addSection(Number(id), data)

    // Return the full page with sections
    const page = await pagesService.getById(Number(id))

    res.status(201).json({ sectionId, page })
  },

  /**
   * PUT /admin/api/v1/content/pages/:id/sections/:sectionId
   * Update section
   */
  async updateSection(req: Request, res: Response): Promise<void> {
    const { id, sectionId } = req.params
    const data: UpdateSectionDto = req.body

    // Convert ISO string dates to Date objects
    if (data.visible_from) {
      data.visible_from = new Date(data.visible_from)
    }
    if (data.visible_until) {
      data.visible_until = new Date(data.visible_until)
    }

    await pagesService.updateSection(Number(id), Number(sectionId), data)

    // Return the full page with sections
    const page = await pagesService.getById(Number(id))

    res.status(200).json(page)
  },

  /**
   * DELETE /admin/api/v1/content/pages/:id/sections/:sectionId
   * Delete section
   */
  async deleteSection(req: Request, res: Response): Promise<void> {
    const { id, sectionId } = req.params

    await pagesService.deleteSection(Number(id), Number(sectionId))

    res.status(204).send()
  },

  /**
   * PUT /admin/api/v1/content/pages/:id/sections/reorder
   * Reorder sections
   */
  async reorderSections(req: Request, res: Response): Promise<void> {
    const { id } = req.params
    const { sections } = req.body

    await pagesService.reorderSections(Number(id), sections)

    // Return the full page with reordered sections
    const page = await pagesService.getById(Number(id))

    res.status(200).json(page)
  },

  /**
   * POST /admin/api/v1/content/pages/bulk-update
   * Bulk update pages (status change)
   */
  async bulkUpdate(req: Request, res: Response): Promise<void> {
    const { ids, status } = req.body
    const adminId = req.admin!.id

    const successCount = await pagesService.bulkUpdateStatus(ids, status, adminId)

    res.status(200).json({
      success: true,
      updatedCount: successCount,
      totalCount: ids.length,
    })
  },
}
