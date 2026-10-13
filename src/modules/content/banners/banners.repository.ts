/**
 * Banners Repository
 * 
 * Data access layer for CMS Banners with SQL queries.
 * Handles all database operations for banners including stats tracking.
 */

import type { PoolConnection } from 'mysql2/promise'
import { pool } from '../../../db/pool'
import type {
  Banner,
  BannerWithRelations,
  BannerListItem,
  BannerFilters,
  PaginationParams,
  PaginatedResponse,
  CreateBannerDto,
  UpdateBannerDto,
} from './banners.types'
import { shopId } from '../../../platform/tenancy/context'

export const bannersRepository = {
  /**
   * Get paginated list of banners with filters
   */
  async list(
    filters: BannerFilters = {},
    pagination: PaginationParams
  ): Promise<PaginatedResponse<BannerListItem>> {
    const conn = await pool.getConnection()
    try {
      const { page = 1, limit = 20, sort_by = 'priority', sort_order = 'desc' } = pagination

      // Build WHERE clause
      const conditions: string[] = ['b.shop_id = ?']
      const params: any[] = [shopId()]

      if (filters.search) {
        conditions.push('(b.name LIKE ? OR b.title LIKE ?)')
        const searchTerm = `%${filters.search}%`
        params.push(searchTerm, searchTerm)
      }

      if (filters.placement) {
        if (Array.isArray(filters.placement)) {
          conditions.push(`b.placement IN (${filters.placement.map(() => '?').join(',')})`)
          params.push(...filters.placement)
        } else {
          conditions.push('b.placement = ?')
          params.push(filters.placement)
        }
      }

      if (filters.audience) {
        if (Array.isArray(filters.audience)) {
          conditions.push(`b.audience IN (${filters.audience.map(() => '?').join(',')})`)
          params.push(...filters.audience)
        } else {
          conditions.push('b.audience = ?')
          params.push(filters.audience)
        }
      }

      if (filters.is_active !== undefined) {
        conditions.push('b.is_active = ?')
        params.push(filters.is_active ? 1 : 0)
      }

      // Status filter (computed from dates)
      if (filters.status) {
        const now = new Date()
        switch (filters.status) {
          case 'scheduled':
            conditions.push('b.is_active = 1 AND b.starts_at > ?')
            params.push(now)
            break
          case 'active':
            conditions.push('b.is_active = 1 AND (b.starts_at IS NULL OR b.starts_at <= ?) AND (b.ends_at IS NULL OR b.ends_at > ?)')
            params.push(now, now)
            break
          case 'expired':
            conditions.push('b.ends_at IS NOT NULL AND b.ends_at <= ?')
            params.push(now)
            break
          case 'inactive':
            conditions.push('b.is_active = 0')
            break
        }
      }

      if (filters.creator_id) {
        conditions.push('b.created_by_admin_id = ?')
        params.push(filters.creator_id)
      }

      if (filters.starts_after) {
        conditions.push('b.starts_at >= ?')
        params.push(filters.starts_after)
      }

      if (filters.starts_before) {
        conditions.push('b.starts_at <= ?')
        params.push(filters.starts_before)
      }

      if (filters.ends_after) {
        conditions.push('b.ends_at >= ?')
        params.push(filters.ends_after)
      }

      if (filters.ends_before) {
        conditions.push('b.ends_at <= ?')
        params.push(filters.ends_before)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // Get total count
      const [countRows] = await conn.query<any[]>(
        `SELECT COUNT(*) as total FROM cms_banners b ${whereClause}`,
        params
      )
      const total = countRows[0].total

      // Get paginated data
      const offset = (page - 1) * limit
      const orderColumn = sort_by === 'name' ? 'b.name' 
        : sort_by === 'placement' ? 'b.placement'
        : sort_by === 'priority' ? 'b.priority'
        : sort_by === 'created_at' ? 'b.created_at'
        : 'b.updated_at'
      const orderDirection = sort_order.toUpperCase()

      const [rows] = await conn.query<any[]>(
        `
        SELECT
          b.id,
          b.name,
          b.placement,
          b.title,
          b.audience,
          b.starts_at,
          b.ends_at,
          b.priority,
          b.is_active,
          b.impression_count,
          b.click_count,
          CASE 
            WHEN b.impression_count > 0 THEN ROUND((b.click_count / b.impression_count) * 100, 2)
            ELSE NULL
          END as ctr,
          CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, '')) AS creator_name,
          b.created_at,
          b.updated_at,
          CASE
            WHEN b.is_active = 0 THEN 'inactive'
            WHEN b.starts_at IS NOT NULL AND b.starts_at > NOW() THEN 'scheduled'
            WHEN b.ends_at IS NOT NULL AND b.ends_at <= NOW() THEN 'expired'
            ELSE 'active'
          END as status
        FROM cms_banners b
        LEFT JOIN admin_users a ON a.id = b.created_by_admin_id
        ${whereClause}
        ORDER BY ${orderColumn} ${orderDirection}
        LIMIT ? OFFSET ?
      `,
        [...params, limit, offset]
      )

      const totalPages = Math.ceil(total / limit)

      return {
        /**
         * `ctr` is a DECIMAL expression, and mysql2 hands DECIMAL back as a
         * string to keep the precision it cannot promise in a float. Passed
         * through untouched it reached the admin as "3.03", where a formatter
         * called .toFixed on it and white-screened the whole page. A numeric
         * field on the wire should be a number.
         */
        data: rows.map((row) => ({
          ...row,
          ctr: row.ctr === null || row.ctr === undefined ? null : Number(row.ctr),
          impression_count: Number(row.impression_count ?? 0),
          click_count: Number(row.click_count ?? 0),
        })) as BannerListItem[],
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
   * Get single banner by ID with relationships
   */
  async getById(id: number, connection?: PoolConnection): Promise<BannerWithRelations | null> {
    const conn = connection || await pool.getConnection()
    try {
      const [rows] = await conn.query<any[]>(
        `
        SELECT
          b.id,
          b.name,
          b.placement,
          b.title,
          b.subtitle,
          b.body,
          b.cta_label,
          b.cta_link_type,
          b.cta_link_ref_id,
          b.cta_url,
          b.desktop_media_id,
          b.mobile_media_id,
          b.poster_media_id,
          b.background_hex,
          b.text_hex,
          b.audience,
          b.starts_at,
          b.ends_at,
          b.priority,
          b.is_active,
          b.is_dismissible,
          b.impression_count,
          b.click_count,
          b.created_by_admin_id,
          b.created_at,
          b.updated_at,
          -- Creator
          a.id as creator_id,
          CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, '')) as creator_name,
          a.email as creator_email,
          -- Desktop media
          dm.id as desktop_media_id_full,
          COALESCE(dm.absolute_url, CONCAT('/media/', dm.storage_key)) as desktop_media_url,
          dm.alt_text as desktop_media_alt,
          dm.media_type as desktop_media_type,
          dm.duration_ms as desktop_media_duration_ms,
          dm.size_bytes as desktop_media_size_bytes,
          (SELECT v.storage_key
             FROM media_variants v
            WHERE v.shop_id = dm.shop_id AND v.media_id = dm.id AND v.format = 'webp'
            ORDER BY v.width DESC
            LIMIT 1) as desktop_media_poster_key,
          -- Mobile media
          mm.id as mobile_media_id_full,
          COALESCE(mm.absolute_url, CONCAT('/media/', mm.storage_key)) as mobile_media_url,
          mm.alt_text as mobile_media_alt,
          mm.media_type as mobile_media_type,
          -- Poster override
          pm.id as poster_media_id_full,
          COALESCE(pm.absolute_url, CONCAT('/media/', pm.storage_key)) as poster_media_url,
          pm.alt_text as poster_media_alt
        FROM cms_banners b
        LEFT JOIN admin_users a ON a.id = b.created_by_admin_id
        LEFT JOIN media dm ON dm.id = b.desktop_media_id AND dm.shop_id = b.shop_id
        LEFT JOIN media mm ON mm.id = b.mobile_media_id AND mm.shop_id = b.shop_id
        LEFT JOIN media pm ON pm.id = b.poster_media_id AND pm.shop_id = b.shop_id
        WHERE b.shop_id = ? AND b.id = ?
      `,
        [shopId(), id]
      )

      if (rows.length === 0) return null

      const row = rows[0]

      const banner: BannerWithRelations = {
        id: row.id,
        name: row.name,
        placement: row.placement,
        title: row.title,
        subtitle: row.subtitle,
        body: row.body,
        cta_label: row.cta_label,
        cta_link_type: row.cta_link_type,
        cta_link_ref_id: row.cta_link_ref_id,
        cta_url: row.cta_url,
        desktop_media_id: row.desktop_media_id,
        mobile_media_id: row.mobile_media_id,
        poster_media_id: row.poster_media_id,
        background_hex: row.background_hex,
        text_hex: row.text_hex,
        audience: row.audience,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        priority: row.priority,
        is_active: row.is_active === 1,
        is_dismissible: row.is_dismissible === 1,
        impression_count: row.impression_count,
        click_count: row.click_count,
        created_by_admin_id: row.created_by_admin_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        creator: row.creator_id ? {
          id: row.creator_id,
          name: row.creator_name,
          email: row.creator_email,
        } : null,
        desktop_media: row.desktop_media_id_full ? {
          id: row.desktop_media_id_full,
          url: row.desktop_media_url,
          alt_text: row.desktop_media_alt,
          media_type: row.desktop_media_type ?? 'image',
          duration_ms: row.desktop_media_duration_ms === null ? null : Number(row.desktop_media_duration_ms),
          size_bytes: row.desktop_media_size_bytes === null ? null : Number(row.desktop_media_size_bytes),
          // The frame pulled out of the video on upload, shown in the form so
          // whoever is merchandising can see what it picked before deciding
          // whether to override it.
          auto_poster_url: row.desktop_media_poster_key ? `/media/${row.desktop_media_poster_key}` : null,
        } : null,
        mobile_media: row.mobile_media_id_full ? {
          id: row.mobile_media_id_full,
          url: row.mobile_media_url,
          alt_text: row.mobile_media_alt,
          media_type: row.mobile_media_type ?? 'image',
        } : null,
        poster_media: row.poster_media_id_full ? {
          id: row.poster_media_id_full,
          url: row.poster_media_url,
          alt_text: row.poster_media_alt,
        } : null,
      }

      return banner
    } finally {
      if (!connection) conn.release()
    }
  },

  /**
   * Create new banner
   */
  async create(data: CreateBannerDto, adminId: number): Promise<number> {
    const conn = await pool.getConnection()
    try {
      const [result] = await conn.query<any>(
        `
        INSERT INTO cms_banners (
          shop_id, name, placement, title, subtitle, body,
          cta_label, cta_link_type, cta_link_ref_id, cta_url,
          desktop_media_id, mobile_media_id, poster_media_id,
          background_hex, text_hex, audience,
          starts_at, ends_at, priority,
          is_active, is_dismissible, created_by_admin_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          shopId(),
          data.name,
          data.placement,
          data.title || null,
          data.subtitle || null,
          data.body || null,
          data.cta_label || null,
          data.cta_link_type || 'none',
          data.cta_link_ref_id || null,
          data.cta_url || null,
          data.desktop_media_id || null,
          data.mobile_media_id || null,
          data.poster_media_id || null,
          data.background_hex || null,
          data.text_hex || null,
          data.audience || 'all',
          data.starts_at || null,
          data.ends_at || null,
          data.priority ?? 0,
          data.is_active !== false ? 1 : 0,
          data.is_dismissible !== false ? 1 : 0,
          adminId,
        ]
      )

      return result.insertId
    } finally {
      conn.release()
    }
  },

  /**
   * Update existing banner
   */
  async update(id: number, data: UpdateBannerDto): Promise<boolean> {
    const conn = await pool.getConnection()
    try {
      const updates: string[] = []
      const params: any[] = []

      if (data.name !== undefined) {
        updates.push('name = ?')
        params.push(data.name)
      }

      if (data.placement !== undefined) {
        updates.push('placement = ?')
        params.push(data.placement)
      }

      if (data.title !== undefined) {
        updates.push('title = ?')
        params.push(data.title)
      }

      if (data.subtitle !== undefined) {
        updates.push('subtitle = ?')
        params.push(data.subtitle)
      }

      if (data.body !== undefined) {
        updates.push('body = ?')
        params.push(data.body)
      }

      if (data.cta_label !== undefined) {
        updates.push('cta_label = ?')
        params.push(data.cta_label)
      }

      if (data.cta_link_type !== undefined) {
        updates.push('cta_link_type = ?')
        params.push(data.cta_link_type)
      }

      if (data.cta_link_ref_id !== undefined) {
        updates.push('cta_link_ref_id = ?')
        params.push(data.cta_link_ref_id)
      }

      if (data.cta_url !== undefined) {
        updates.push('cta_url = ?')
        params.push(data.cta_url)
      }

      if (data.desktop_media_id !== undefined) {
        updates.push('desktop_media_id = ?')
        params.push(data.desktop_media_id)
      }

      if (data.mobile_media_id !== undefined) {
        updates.push('mobile_media_id = ?')
        params.push(data.mobile_media_id)
      }

      if (data.poster_media_id !== undefined) {
        updates.push('poster_media_id = ?')
        params.push(data.poster_media_id)
      }

      if (data.background_hex !== undefined) {
        updates.push('background_hex = ?')
        params.push(data.background_hex)
      }

      if (data.text_hex !== undefined) {
        updates.push('text_hex = ?')
        params.push(data.text_hex)
      }

      if (data.audience !== undefined) {
        updates.push('audience = ?')
        params.push(data.audience)
      }

      if (data.starts_at !== undefined) {
        updates.push('starts_at = ?')
        params.push(data.starts_at)
      }

      if (data.ends_at !== undefined) {
        updates.push('ends_at = ?')
        params.push(data.ends_at)
      }

      if (data.priority !== undefined) {
        updates.push('priority = ?')
        params.push(data.priority)
      }

      if (data.is_active !== undefined) {
        updates.push('is_active = ?')
        params.push(data.is_active ? 1 : 0)
      }

      if (data.is_dismissible !== undefined) {
        updates.push('is_dismissible = ?')
        params.push(data.is_dismissible ? 1 : 0)
      }

      if (updates.length === 0) return true

      params.push(shopId(), id)

      const [result] = await conn.query<any>(
        `UPDATE cms_banners SET ${updates.join(', ')} WHERE shop_id = ? AND id = ?`,
        params
      )

      return result.affectedRows > 0
    } finally {
      conn.release()
    }
  },

  /**
   * Delete banner
   */
  async delete(id: number): Promise<boolean> {
    const conn = await pool.getConnection()
    try {
      const [result] = await conn.query<any>(
        'DELETE FROM cms_banners WHERE shop_id = ? AND id = ?',
        [shopId(), id]
      )

      return result.affectedRows > 0
    } finally {
      conn.release()
    }
  },

  /**
   * Increment impression count
   */
  async incrementImpressions(id: number, count: number = 1): Promise<void> {
    const conn = await pool.getConnection()
    try {
      await conn.query(
        'UPDATE cms_banners SET impression_count = impression_count + ? WHERE shop_id = ? AND id = ?',
        [count, shopId(), id]
      )
    } finally {
      conn.release()
    }
  },

  /**
   * Increment click count
   */
  async incrementClicks(id: number, count: number = 1): Promise<void> {
    const conn = await pool.getConnection()
    try {
      await conn.query(
        'UPDATE cms_banners SET click_count = click_count + ? WHERE shop_id = ? AND id = ?',
        [count, shopId(), id]
      )
    } finally {
      conn.release()
    }
  },

  /**
   * Get active banners for a placement
   * Used by storefront to fetch banners to display
   */
  async getActiveByPlacement(
    placement: string,
    audience: string = 'all'
  ): Promise<Banner[]> {
    const conn = await pool.getConnection()
    try {
      const now = new Date()

      const [rows] = await conn.query<any[]>(
        `
        SELECT *
        FROM cms_banners
        WHERE shop_id = ?
          AND placement = ?
          AND is_active = 1
          AND (audience = 'all' OR audience = ?)
          AND (starts_at IS NULL OR starts_at <= ?)
          AND (ends_at IS NULL OR ends_at > ?)
        ORDER BY priority DESC, id DESC
      `,
        [shopId(), placement, audience, now, now]
      )

      return rows
    } finally {
      conn.release()
    }
  },

  /**
   * Bulk activate/deactivate banners
   */
  async bulkUpdateStatus(ids: number[], is_active: boolean): Promise<number> {
    const conn = await pool.getConnection()
    try {
      if (ids.length === 0) return 0

      const placeholders = ids.map(() => '?').join(',')
      const [result] = await conn.query<any>(
        `UPDATE cms_banners SET is_active = ? WHERE shop_id = ? AND id IN (${placeholders})`,
        [is_active ? 1 : 0, shopId(), ...ids]
      )

      return result.affectedRows
    } finally {
      conn.release()
    }
  },
}
