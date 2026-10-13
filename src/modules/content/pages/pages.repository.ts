/**
 * Pages Repository
 * 
 * Data access layer for CMS Pages with SQL queries.
 * Handles all database operations for pages, sections, and blocks.
 */

import type { PoolConnection } from 'mysql2/promise'
import { pool } from '../../../db/pool'
import type {
  Page,
  PageWithRelations,
  PageListItem,
  PageFilters,
  PaginationParams,
  PaginatedResponse,
  CreatePageDto,
  UpdatePageDto,
  PageSection,
  CreateSectionDto,
  UpdateSectionDto,
} from './pages.types'
import { shopId } from '../../../platform/tenancy/context'

export const pagesRepository = {
  /**
   * Get paginated list of pages with filters
   */
  async list(
    filters: PageFilters = {},
    pagination: PaginationParams
  ): Promise<PaginatedResponse<PageListItem>> {
    const conn = await pool.getConnection()
    try {
      const { page = 1, limit = 20, sort_by: sortBy = 'updated_at', sort_order: sortOrder = 'desc' } = pagination

      // Build WHERE clause
      const conditions: string[] = ['p.shop_id = ?', 'p.deleted_at IS NULL']
      const params: any[] = [shopId()]

      if (filters.search) {
        conditions.push('(p.title LIKE ? OR p.slug LIKE ? OR p.full_path LIKE ?)')
        const searchTerm = `%${filters.search}%`
        params.push(searchTerm, searchTerm, searchTerm)
      }

      if (filters.status) {
        if (Array.isArray(filters.status)) {
          conditions.push(`p.status IN (${filters.status.map(() => '?').join(',')})`)
          params.push(...filters.status)
        } else {
          conditions.push('p.status = ?')
          params.push(filters.status)
        }
      }

      if (filters.page_type) {
        if (Array.isArray(filters.page_type)) {
          conditions.push(`p.page_type IN (${filters.page_type.map(() => '?').join(',')})`)
          params.push(...filters.page_type)
        } else {
          conditions.push('p.page_type = ?')
          params.push(filters.page_type)
        }
      }

      if (filters.author_id) {
        conditions.push('p.author_admin_id = ?')
        params.push(filters.author_id)
      }

      if (filters.requires_legal_review !== undefined) {
        conditions.push('p.requires_legal_review = ?')
        params.push(filters.requires_legal_review ? 1 : 0)
      }

      if (filters.is_indexable !== undefined) {
        conditions.push('p.is_indexable = ?')
        params.push(filters.is_indexable ? 1 : 0)
      }

      if (filters.created_after) {
        conditions.push('p.created_at >= ?')
        params.push(filters.created_after)
      }

      if (filters.created_before) {
        conditions.push('p.created_at <= ?')
        params.push(filters.created_before)
      }

      if (filters.published_after) {
        conditions.push('p.published_at >= ?')
        params.push(filters.published_after)
      }

      if (filters.published_before) {
        conditions.push('p.published_at <= ?')
        params.push(filters.published_before)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // Get total count
      const [countRows] = await conn.query<any[]>(
        `SELECT COUNT(*) as total FROM cms_pages p ${whereClause}`,
        params
      )
      const total = countRows[0].total

      // Get paginated data
      const offset = (page - 1) * limit
      const orderColumn = sortBy === 'title' ? 'p.title' : sortBy === 'status' ? 'p.status' : 'p.updated_at'
      const orderDirection = sortOrder.toUpperCase()

      const [rows] = await conn.query<any[]>(
        `
        SELECT
          p.id,
          p.public_id AS publicId,
          p.slug,
          p.full_path AS fullPath,
          p.title,
          p.page_type AS pageType,
          p.status,
          p.published_at AS publishedAt,
          p.scheduled_at AS scheduledAt,
          p.view_count AS viewCount,
          p.updated_at AS updatedAt,
          CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, '')) AS authorName,
          COUNT(DISTINCT ps.id) AS sectionCount
        FROM cms_pages p
        LEFT JOIN admin_users a ON a.id = p.author_admin_id
        LEFT JOIN cms_page_sections ps ON ps.page_id = p.id AND ps.shop_id = p.shop_id
        ${whereClause}
        GROUP BY p.id, p.public_id, p.slug, p.full_path, p.title, p.page_type, p.status,
                 p.published_at, p.scheduled_at, p.view_count, p.updated_at, a.first_name, a.last_name
        ORDER BY ${orderColumn} ${orderDirection}
        LIMIT ? OFFSET ?
      `,
        [...params, limit, offset]
      )

      const totalPages = Math.ceil(total / limit)

      return {
        data: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      }
    } finally {
      conn.release()
    }
  },

  /**
   * Get single page by ID with full details
   */
  async getById(id: number): Promise<PageWithRelations | null> {
    const conn = await pool.getConnection()
    try {
      const [rows] = await conn.query<any[]>(
        `
        SELECT
          p.id,
          p.public_id AS publicId,
          p.parent_id AS parentId,
          p.slug,
          p.full_path AS fullPath,
          p.title,
          p.subtitle,
          p.page_type AS pageType,
          p.template,
          p.locale,
          p.body_html AS bodyHtml,
          p.body_json AS bodyJson,
          p.hero_media_id AS heroMediaId,
          p.status,
          p.published_at AS publishedAt,
          p.scheduled_at AS scheduledAt,
          p.unpublish_at AS unpublishAt,
          p.requires_legal_review AS requiresLegalReview,
          p.reviewed_by_admin_id AS reviewedByAdminId,
          p.reviewed_at AS reviewedAt,
          p.review_due_at AS reviewDueAt,
          p.is_indexable AS isIndexable,
          p.show_in_sitemap AS showInSitemap,
          p.preview_token AS previewToken,
          p.current_version AS currentVersion,
          p.view_count AS viewCount,
          p.author_admin_id AS authorAdminId,
          p.updated_by_admin_id AS updatedByAdminId,
          p.created_at AS createdAt,
          p.updated_at AS updatedAt,
          p.deleted_at AS deletedAt,
          -- Author
          a.id AS author_id,
          CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, '')) AS author_name,
          a.email AS author_email,
          -- Reviewer
          r.id AS reviewer_id,
          CONCAT(COALESCE(r.first_name, ''), ' ', COALESCE(r.last_name, '')) AS reviewer_name,
          r.email AS reviewer_email,
          -- Hero Media
          m.id AS hero_media_id,
          m.storage_key AS hero_media_storage_key,
          m.alt_text AS hero_media_alt_text
        FROM cms_pages p
        LEFT JOIN admin_users a ON a.id = p.author_admin_id
        LEFT JOIN admin_users r ON r.id = p.reviewed_by_admin_id
        LEFT JOIN media m ON m.id = p.hero_media_id AND m.shop_id = p.shop_id
        WHERE p.shop_id = ? AND p.id = ? AND p.deleted_at IS NULL
      `,
        [shopId(), id]
      )

      if (rows.length === 0) return null

      const row = rows[0]

      // Get sections for this page
      const sections = await this.getSectionsByPageId(id, conn)

      return {
        ...row,
        sections,
        author: row.author_id ? {
          id: row.author_id,
          name: row.author_name?.trim() || 'Unknown',
          email: row.author_email,
        } : null,
        reviewer: row.reviewer_id ? {
          id: row.reviewer_id,
          name: row.reviewer_name?.trim() || 'Unknown',
          email: row.reviewer_email,
        } : null,
        heroMedia: row.hero_media_id ? {
          id: row.hero_media_id,
          storageKey: row.hero_media_storage_key,
          url: `/media/${row.hero_media_storage_key}`,
          altText: row.hero_media_alt_text,
        } : null,
      }
    } finally {
      conn.release()
    }
  },

  /**
   * Get page by slug
   */
  async getBySlug(slug: string, locale: string = 'en-IN'): Promise<PageWithRelations | null> {
    const conn = await pool.getConnection()
    try {
      const [rows] = await conn.query<any[]>(
        'SELECT id FROM cms_pages WHERE shop_id = ? AND slug = ? AND locale = ? AND deleted_at IS NULL',
        [shopId(), slug, locale]
      )

      if (rows.length === 0) return null

      return this.getById(rows[0].id)
    } finally {
      conn.release()
    }
  },

  /**
   * Get sections for a page
   */
  async getSectionsByPageId(pageId: number, conn?: PoolConnection): Promise<PageSection[]> {
    const connection = conn || await pool.getConnection()
    try {
      const [rows] = await connection.query<any[]>(
        `
        SELECT
          id,
          page_id AS pageId,
          section_key AS sectionKey,
          name,
          sort_order AS sortOrder,
          is_enabled AS isEnabled,
          settings,
          background,
          padding_top AS paddingTop,
          padding_bottom AS paddingBottom,
          visible_from AS visibleFrom,
          visible_until AS visibleUntil,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM cms_page_sections
        WHERE shop_id = ? AND page_id = ?
        ORDER BY sort_order ASC
      `,
        [shopId(), pageId]
      )

      return rows
    } finally {
      if (!conn) connection.release()
    }
  },

  /**
   * Create new page
   */
  async create(data: CreatePageDto, adminId: number): Promise<number> {
    const conn = await pool.getConnection()
    try {
      // Generate full path
      const fullPath = data.parent_id 
        ? await this.buildFullPath(data.slug, data.parent_id, conn)
        : `/${data.slug}`

      const [result] = await conn.query<any>(
        `
        INSERT INTO cms_pages (
          shop_id, slug, full_path, title, subtitle, page_type, template, locale,
          body_html, body_json, hero_media_id, status, scheduled_at, unpublish_at,
          requires_legal_review, review_due_at, is_indexable, show_in_sitemap,
          parent_id, author_admin_id, current_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `,
        [
          shopId(),
          data.slug,
          fullPath,
          data.title,
          data.subtitle || null,
          data.page_type,
          data.template || 'default',
          data.locale || 'en-IN',
          data.body_html || null,
          data.body_json ? JSON.stringify(data.body_json) : null,
          data.hero_media_id || null,
          data.status || 'draft',
          data.scheduled_at || null,
          data.unpublish_at || null,
          data.requires_legal_review ? 1 : 0,
          data.review_due_at || null,
          data.is_indexable !== false ? 1 : 0,
          data.show_in_sitemap !== false ? 1 : 0,
          data.parent_id || null,
          adminId,
        ]
      )

      return result.insertId
    } finally {
      conn.release()
    }
  },

  /**
   * Update existing page
   */
  async update(id: number, data: UpdatePageDto, adminId: number): Promise<boolean> {
    const conn = await pool.getConnection()
    try {
      const updates: string[] = []
      const params: any[] = []

      if (data.slug !== undefined) {
        updates.push('slug = ?')
        params.push(data.slug)

        // Regenerate full path if slug changes
        const page = await this.getById(id)
        if (page) {
          const fullPath = page.parent_id
            ? await this.buildFullPath(data.slug, page.parent_id, conn)
            : `/${data.slug}`
          updates.push('full_path = ?')
          params.push(fullPath)
        }
      }

      if (data.title !== undefined) {
        updates.push('title = ?')
        params.push(data.title)
      }

      if (data.subtitle !== undefined) {
        updates.push('subtitle = ?')
        params.push(data.subtitle)
      }

      if (data.page_type !== undefined) {
        updates.push('page_type = ?')
        params.push(data.page_type)
      }

      if (data.template !== undefined) {
        updates.push('template = ?')
        params.push(data.template)
      }

      if (data.body_html !== undefined) {
        updates.push('body_html = ?')
        params.push(data.body_html)
      }

      if (data.body_json !== undefined) {
        updates.push('body_json = ?')
        params.push(data.body_json ? JSON.stringify(data.body_json) : null)
      }

      if (data.hero_media_id !== undefined) {
        updates.push('hero_media_id = ?')
        params.push(data.hero_media_id)
      }

      if (data.status !== undefined) {
        updates.push('status = ?')
        params.push(data.status)
      }

      if (data.published_at !== undefined) {
        updates.push('published_at = ?')
        params.push(data.published_at)
      }

      if (data.scheduled_at !== undefined) {
        updates.push('scheduled_at = ?')
        params.push(data.scheduled_at)
      }

      if (data.unpublish_at !== undefined) {
        updates.push('unpublish_at = ?')
        params.push(data.unpublish_at)
      }

      if (data.requires_legal_review !== undefined) {
        updates.push('requires_legal_review = ?')
        params.push(data.requires_legal_review ? 1 : 0)
      }

      if (data.reviewed_by_admin_id !== undefined) {
        updates.push('reviewed_by_admin_id = ?')
        params.push(data.reviewed_by_admin_id)
      }

      if (data.reviewed_at !== undefined) {
        updates.push('reviewed_at = ?')
        params.push(data.reviewed_at)
      }

      if (data.review_due_at !== undefined) {
        updates.push('review_due_at = ?')
        params.push(data.review_due_at)
      }

      if (data.is_indexable !== undefined) {
        updates.push('is_indexable = ?')
        params.push(data.is_indexable ? 1 : 0)
      }

      if (data.show_in_sitemap !== undefined) {
        updates.push('show_in_sitemap = ?')
        params.push(data.show_in_sitemap ? 1 : 0)
      }

      if (data.parent_id !== undefined) {
        updates.push('parent_id = ?')
        params.push(data.parent_id)
      }

      if (updates.length === 0) return true

      updates.push('updated_by_admin_id = ?')
      params.push(adminId)

      params.push(shopId(), id)

      const [result] = await conn.query<any>(
        `UPDATE cms_pages SET ${updates.join(', ')} WHERE shop_id = ? AND id = ? AND deleted_at IS NULL`,
        params
      )

      return result.affectedRows > 0
    } finally {
      conn.release()
    }
  },

  /**
   * Soft delete page
   */
  async delete(id: number): Promise<boolean> {
    const conn = await pool.getConnection()
    try {
      const [result] = await conn.query<any>(
        'UPDATE cms_pages SET deleted_at = NOW() WHERE shop_id = ? AND id = ? AND deleted_at IS NULL',
        [shopId(), id]
      )

      return result.affectedRows > 0
    } finally {
      conn.release()
    }
  },

  /**
   * Increment view count
   */
  async incrementViewCount(id: number): Promise<void> {
    const conn = await pool.getConnection()
    try {
      await conn.query(
        'UPDATE cms_pages SET view_count = view_count + 1 WHERE shop_id = ? AND id = ?',
        [shopId(), id]
      )
    } finally {
      conn.release()
    }
  },

  /**
   * Build full path from parent hierarchy
   */
  async buildFullPath(slug: string, parentId: number, conn: PoolConnection): Promise<string> {
    const [rows] = await conn.query<any[]>(
      'SELECT full_path FROM cms_pages WHERE shop_id = ? AND id = ?',
      [shopId(), parentId]
    )

    if (rows.length === 0) return `/${slug}`

    return `${rows[0].full_path}/${slug}`
  },

  /**
   * Create section for a page
   */
  async createSection(pageId: number, data: CreateSectionDto): Promise<number> {
    const conn = await pool.getConnection()
    try {
      const [result] = await conn.query<any>(
        `
        INSERT INTO cms_page_sections (
          shop_id, page_id, section_key, name, sort_order, is_enabled, settings,
          background, padding_top, padding_bottom, visible_from, visible_until
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          shopId(),
          pageId,
          data.section_key,
          data.name || null,
          data.sort_order || 0,
          data.is_enabled !== false ? 1 : 0,
          data.settings ? JSON.stringify(data.settings) : null,
          data.background || null,
          data.padding_top || 'md',
          data.padding_bottom || 'md',
          data.visible_from || null,
          data.visible_until || null,
        ]
      )

      return result.insertId
    } finally {
      conn.release()
    }
  },

  /**
   * Update section
   */
  async updateSection(sectionId: number, data: UpdateSectionDto): Promise<boolean> {
    const conn = await pool.getConnection()
    try {
      const updates: string[] = []
      const params: any[] = []

      if (data.section_key !== undefined) {
        updates.push('section_key = ?')
        params.push(data.section_key)
      }

      if (data.name !== undefined) {
        updates.push('name = ?')
        params.push(data.name)
      }

      if (data.sort_order !== undefined) {
        updates.push('sort_order = ?')
        params.push(data.sort_order)
      }

      if (data.is_enabled !== undefined) {
        updates.push('is_enabled = ?')
        params.push(data.is_enabled ? 1 : 0)
      }

      if (data.settings !== undefined) {
        updates.push('settings = ?')
        params.push(data.settings ? JSON.stringify(data.settings) : null)
      }

      if (data.background !== undefined) {
        updates.push('background = ?')
        params.push(data.background)
      }

      if (data.padding_top !== undefined) {
        updates.push('padding_top = ?')
        params.push(data.padding_top)
      }

      if (data.padding_bottom !== undefined) {
        updates.push('padding_bottom = ?')
        params.push(data.padding_bottom)
      }

      if (data.visible_from !== undefined) {
        updates.push('visible_from = ?')
        params.push(data.visible_from)
      }

      if (data.visible_until !== undefined) {
        updates.push('visible_until = ?')
        params.push(data.visible_until)
      }

      if (updates.length === 0) return true

      params.push(shopId(), sectionId)

      const [result] = await conn.query<any>(
        `UPDATE cms_page_sections SET ${updates.join(', ')} WHERE shop_id = ? AND id = ?`,
        params
      )

      return result.affectedRows > 0
    } finally {
      conn.release()
    }
  },

  /**
   * Delete section
   */
  async deleteSection(sectionId: number): Promise<boolean> {
    const conn = await pool.getConnection()
    try {
      const [result] = await conn.query<any>(
        'DELETE FROM cms_page_sections WHERE shop_id = ? AND id = ?',
        [shopId(), sectionId]
      )

      return result.affectedRows > 0
    } finally {
      conn.release()
    }
  },
}
