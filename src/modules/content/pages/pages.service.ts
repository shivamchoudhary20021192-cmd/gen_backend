/**
 * Pages Service
 * 
 * Business logic layer for CMS Pages.
 * Handles validation, workflow management, slug generation, and orchestration.
 */

import { randomUUID } from 'node:crypto'
import { pagesRepository } from './pages.repository'
import { ApiError } from '../../../core/ApiError'
import { slugify } from '../../../core/slug'
import type {
  Page,
  PageWithRelations,
  PageListItem,
  PageFilters,
  PaginationParams,
  PaginatedResponse,
  CreatePageDto,
  UpdatePageDto,
  PublishPageDto,
  PageStatus,
  CreateSectionDto,
  UpdateSectionDto,
} from './pages.types'
import { PAGE_STATUS_TRANSITIONS } from './pages.types'

const toCamel = (key: string) => key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())

/**
 * A field of a page or section row, whichever casing it arrived in.
 *
 * pagesRepository aliases columns to camelCase (`requiresLegalReview`,
 * `bodyHtml`, `sectionKey`) — the shape the admin screens read — while the
 * types declare snake_case. Rules that read the declared name saw
 * `undefined`: the legal-review gate never fired, and duplicating a page
 * failed on a NULL page_type. Business rules read through this instead.
 */
function read<T extends object, K extends keyof T>(row: T, key: K): T[K] {
  const record = row as unknown as Record<string, unknown>
  const name = String(key)
  return (record[name] !== undefined ? record[name] : record[toCamel(name)]) as T[K]
}

/** MySQL hands booleans back as 0/1. */
const flag = (value: unknown): boolean => value === true || Number(value) === 1
import { nowForDb } from '../../../core/now'

export const pagesService = {
  /**
   * Get paginated list of pages
   */
  async list(
    filters: PageFilters = {},
    pagination: PaginationParams
  ): Promise<PaginatedResponse<PageListItem>> {
    return pagesRepository.list(filters, pagination)
  },

  /**
   * Get single page by ID
   */
  async getById(id: number): Promise<PageWithRelations> {
    const page = await pagesRepository.getById(id)

    if (!page) {
      throw new ApiError(404, 'NOT_FOUND', 'Page not found')
    }

    return page
  },

  /**
   * Get page by slug
   */
  async getBySlug(slug: string, locale: string = 'en-IN'): Promise<PageWithRelations> {
    const page = await pagesRepository.getBySlug(slug, locale)

    if (!page) {
      throw new ApiError(404, 'NOT_FOUND', 'Page not found')
    }

    return page
  },

  /**
   * Create new page
   */
  async create(data: CreatePageDto, adminId: number): Promise<PageWithRelations> {
    // Generate slug from title if not provided
    if (!data.slug) {
      data.slug = slugify(data.title)
    } else {
      // Validate and normalize provided slug
      data.slug = slugify(data.slug)
    }

    // Check slug uniqueness
    const existing = await pagesRepository.getBySlug(data.slug, data.locale || 'en-IN')
    if (existing) {
      throw new ApiError(400, 'SLUG_TAKEN', `Page with slug '${data.slug}' already exists`)
    }

    // Validate page type
    const validPageTypes = ['home', 'standard', 'landing', 'policy', 'about', 'support', 'concern', 'ingredient_library', 'custom']
    if (!validPageTypes.includes(data.page_type)) {
      throw new ApiError(400, 'BAD_REQUEST', `Invalid page type: ${data.page_type}`)
    }

    // Validate parent exists if provided
    if (data.parent_id) {
      const parent = await pagesRepository.getById(data.parent_id)
      if (!parent) {
        throw new ApiError(404, 'NOT_FOUND', 'Parent page not found')
      }
    }

    // Validate scheduled publishing
    if (data.scheduled_at && data.status !== 'scheduled') {
      data.status = 'scheduled'
    }

    // Create page
    const pageId = await pagesRepository.create(data, adminId)

    // Return created page
    return this.getById(pageId)
  },

  /**
   * Update existing page
   */
  async update(id: number, data: UpdatePageDto, adminId: number): Promise<PageWithRelations> {
    // Check page exists
    const existingPage = await this.getById(id)

    // Validate slug if changing
    if (data.slug && data.slug !== existingPage.slug) {
      data.slug = slugify(data.slug)

      // Check new slug doesn't conflict
      const conflict = await pagesRepository.getBySlug(data.slug, existingPage.locale)
      if (conflict && conflict.id !== id) {
        throw new ApiError(400, 'SLUG_TAKEN', `Page with slug '${data.slug}' already exists`)
      }
    }

    // Validate status transition
    if (data.status && data.status !== existingPage.status) {
      this.validateStatusTransition(existingPage.status, data.status)
    }

    // Check legal review requirement
    if (flag(read(existingPage, 'requires_legal_review')) && data.status === 'published') {
      if (!read(existingPage, 'reviewed_at')) {
        throw new ApiError(400, 'INVALID_TRANSITION', 'Page requires legal review before publishing')
      }
    }

    // Update page
    const updated = await pagesRepository.update(id, data, adminId)

    if (!updated) {
      throw new ApiError(404, 'NOT_FOUND', 'Page not found')
    }

    // Return updated page
    return this.getById(id)
  },

  /**
   * Publish page
   */
  async publish(id: number, data: PublishPageDto, adminId: number): Promise<PageWithRelations> {
    const page = await this.getById(id)

    // Check legal review if required
    if (flag(read(page, 'requires_legal_review')) && !read(page, 'reviewed_at')) {
      throw new ApiError(400, 'INVALID_TRANSITION', 'Page requires legal review before publishing')
    }

    // Validate status transition
    this.validateStatusTransition(page.status, 'published')

    const updateData: UpdatePageDto = {
      status: data.scheduled_at ? 'scheduled' : 'published',
      published_at: data.scheduled_at ? undefined : nowForDb(),
      scheduled_at: data.scheduled_at || undefined,
      unpublish_at: data.unpublish_at || undefined,
    }

    await pagesRepository.update(id, updateData, adminId)

    return this.getById(id)
  },

  /**
   * Unpublish page
   */
  async unpublish(id: number, adminId: number): Promise<PageWithRelations> {
    const page = await this.getById(id)

    if (page.status !== 'published') {
      throw new ApiError(400, 'INVALID_TRANSITION', 'Only published pages can be unpublished')
    }

    const updateData: UpdatePageDto = {
      status: 'draft',
      published_at: undefined,
    }

    await pagesRepository.update(id, updateData, adminId)

    return this.getById(id)
  },

  /**
   * Archive page
   */
  async archive(id: number, adminId: number): Promise<PageWithRelations> {
    const page = await this.getById(id)

    this.validateStatusTransition(page.status, 'archived')

    const updateData: UpdatePageDto = {
      status: 'archived',
    }

    await pagesRepository.update(id, updateData, adminId)

    return this.getById(id)
  },

  /**
   * Restore archived page
   */
  async restore(id: number, adminId: number): Promise<PageWithRelations> {
    const page = await this.getById(id)

    if (page.status !== 'archived') {
      throw new ApiError(400, 'INVALID_TRANSITION', 'Only archived pages can be restored')
    }

    const updateData: UpdatePageDto = {
      status: 'draft',
    }

    await pagesRepository.update(id, updateData, adminId)

    return this.getById(id)
  },

  /**
   * Delete page (soft delete)
   */
  async delete(id: number): Promise<void> {
    const page = await this.getById(id)

    // Don't allow deletion of published pages
    if (page.status === 'published') {
      throw new ApiError(400, 'INVALID_TRANSITION', 'Cannot delete published page. Archive it first.')
    }

    const deleted = await pagesRepository.delete(id)

    if (!deleted) {
      throw new ApiError(404, 'NOT_FOUND', 'Page not found')
    }
  },

  /**
   * Duplicate page
   */
  async duplicate(id: number, adminId: number): Promise<PageWithRelations> {
    const original = await this.getById(id)

    // Create duplicate with modified title and slug
    const duplicateData: CreatePageDto = {
      slug: `${original.slug}-copy`,
      title: `${original.title} (Copy)`,
      subtitle: original.subtitle || undefined,
      page_type: read(original, 'page_type'),
      template: original.template,
      locale: original.locale,
      body_html: read(original, 'body_html') || undefined,
      body_json: read(original, 'body_json') || undefined,
      hero_media_id: read(original, 'hero_media_id') || undefined,
      status: 'draft',
      requires_legal_review: flag(read(original, 'requires_legal_review')),
      is_indexable: flag(read(original, 'is_indexable')),
      show_in_sitemap: flag(read(original, 'show_in_sitemap')),
      parent_id: read(original, 'parent_id') || undefined,
    }

    const newPageId = await pagesRepository.create(duplicateData, adminId)

    // Duplicate sections
    if (original.sections && original.sections.length > 0) {
      for (const section of original.sections) {
        const sectionData: CreateSectionDto = {
          section_key: read(section, 'section_key'),
          name: section.name || undefined,
          sort_order: read(section, 'sort_order'),
          is_enabled: flag(read(section, 'is_enabled')),
          settings: section.settings,
          background: section.background || undefined,
          padding_top: read(section, 'padding_top'),
          padding_bottom: read(section, 'padding_bottom'),
          visible_from: read(section, 'visible_from') || undefined,
          visible_until: read(section, 'visible_until') || undefined,
        }
        await pagesRepository.createSection(newPageId, sectionData)
      }
    }

    return this.getById(newPageId)
  },

  /**
   * Mark page as reviewed
   */
  async markReviewed(id: number, adminId: number): Promise<PageWithRelations> {
    const page = await this.getById(id)

    if (!flag(read(page, 'requires_legal_review'))) {
      throw new ApiError(400, 'BAD_REQUEST', 'Page does not require legal review')
    }

    const updateData: UpdatePageDto = {
      reviewed_by_admin_id: adminId,
      reviewed_at: new Date(),
    }

    await pagesRepository.update(id, updateData, adminId)

    return this.getById(id)
  },

  /**
   * Increment view count
   */
  async incrementViewCount(id: number): Promise<void> {
    await pagesRepository.incrementViewCount(id)
  },

  /**
   * Add section to page
   */
  async addSection(pageId: number, data: CreateSectionDto): Promise<number> {
    // Verify page exists
    await this.getById(pageId)

    // Validate section key
    const validSectionTypes = [
      'announcement_bar', 'hero', 'trust_strip', 'two_product_routine',
      'ingredient_story', 'texture_proof', 'evidence_results', 'reviews_ugc',
      'education_articles', 'founder_note', 'optin', 'faq', 'rich_text',
      'image_with_text', 'product_grid', 'collection_banner', 'comparison_table',
      'support_panel'
    ]

    if (!validSectionTypes.includes(data.section_key)) {
      throw new ApiError(400, 'BAD_REQUEST', `Invalid section type: ${data.section_key}`)
    }

    return pagesRepository.createSection(pageId, data)
  },

  /**
   * Update section
   */
  async updateSection(pageId: number, sectionId: number, data: UpdateSectionDto): Promise<void> {
    // Verify page exists
    await this.getById(pageId)

    // Validate section key if provided
    if (data.section_key) {
      const validSectionTypes = [
        'announcement_bar', 'hero', 'trust_strip', 'two_product_routine',
        'ingredient_story', 'texture_proof', 'evidence_results', 'reviews_ugc',
        'education_articles', 'founder_note', 'optin', 'faq', 'rich_text',
        'image_with_text', 'product_grid', 'collection_banner', 'comparison_table',
        'support_panel'
      ]

      if (!validSectionTypes.includes(data.section_key)) {
        throw new ApiError(400, 'BAD_REQUEST', `Invalid section type: ${data.section_key}`)
      }
    }

    const updated = await pagesRepository.updateSection(sectionId, data)

    if (!updated) {
      throw new ApiError(404, 'NOT_FOUND', 'Section not found')
    }
  },

  /**
   * Delete section
   */
  async deleteSection(pageId: number, sectionId: number): Promise<void> {
    // Verify page exists
    await this.getById(pageId)

    const deleted = await pagesRepository.deleteSection(sectionId)

    if (!deleted) {
      throw new ApiError(404, 'NOT_FOUND', 'Section not found')
    }
  },

  /**
   * Reorder sections
   */
  async reorderSections(pageId: number, sectionOrders: { id: number; sort_order: number }[]): Promise<void> {
    // Verify page exists
    await this.getById(pageId)

    // Update each section's sort order
    for (const { id, sort_order } of sectionOrders) {
      await pagesRepository.updateSection(id, { sort_order })
    }
  },

  /**
   * Validate status transition
   */
  validateStatusTransition(currentStatus: PageStatus, newStatus: PageStatus): void {
    const allowedTransitions = PAGE_STATUS_TRANSITIONS[currentStatus]

    if (!allowedTransitions.includes(newStatus)) {
      throw new ApiError(
        400,
        'INVALID_TRANSITION',
        `Invalid status transition from '${currentStatus}' to '${newStatus}'. Allowed: ${allowedTransitions.join(', ')}`
      )
    }
  },

  /**
   * Get published pages (for public API)
   */
  async getPublishedPages(filters: PageFilters = {}, pagination: PaginationParams): Promise<PaginatedResponse<PageListItem>> {
    // Force published status
    filters.status = 'published'

    return pagesRepository.list(filters, pagination)
  },

  /**
   * Issue a preview link for a page in any state but archived, so a draft can
   * be read by someone without admin access (legal, a client) before it is
   * published. Issuing again replaces the token, which is also how a link that
   * was shared too widely is killed without losing the ability to preview.
   */
  async issuePreviewToken(id: number): Promise<{ preview_token: string; preview_path: string }> {
    const page = await this.getById(id)

    if (page.status === 'archived') {
      throw new ApiError(409, 'INVALID_TRANSITION', 'An archived page cannot be previewed. Restore it first.')
    }

    const token = randomUUID()
    await pagesRepository.setPreviewToken(id, token)

    return { preview_token: token, preview_path: `/api/v1/content/pages/preview/${token}` }
  },

  /** Revoke the page's preview link; anyone holding it gets a 404 from now on. */
  async revokePreviewToken(id: number): Promise<void> {
    await this.getById(id)
    await pagesRepository.setPreviewToken(id, null)
  },

  /**
   * Bulk update pages (e.g., bulk publish, bulk archive)
   */
  async bulkUpdateStatus(ids: number[], status: PageStatus, adminId: number): Promise<number> {
    let successCount = 0

    for (const id of ids) {
      try {
        await pagesRepository.update(id, { status }, adminId)
        successCount++
      } catch (error) {
        // Continue with other pages even if one fails
        console.error(`Failed to update page ${id}:`, error)
      }
    }

    return successCount
  },
}
