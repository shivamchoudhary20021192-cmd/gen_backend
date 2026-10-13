/**
 * Repository layer for FAQs module
 * Handles SQL queries for FAQ Groups and FAQs
 */

import type { PoolConnection } from 'mysql2/promise'
import { pool } from '../../../db/pool'
import type {
  FAQGroup,
  FAQGroupListItem,
  FAQ,
  FAQListItem,
  FAQWithRelations,
  CreateFAQGroupDto,
  UpdateFAQGroupDto,
  CreateFAQDto,
  UpdateFAQDto,
  ListFAQsParams,
  ListFAQGroupsParams,
} from './faqs.types'
import { shopId } from '../../../platform/tenancy/context'

// ══════════════════════════════════════════════════════════════════════════════
// FAQ GROUPS
// ══════════════════════════════════════════════════════════════════════════════

export const faqGroupsRepository = {
  /**
   * List FAQ groups with pagination and filtering
   */
  async list(params: ListFAQGroupsParams, connection?: PoolConnection) {
    const conn = connection || (await pool.getConnection())
    try {
      const {
        page = 1,
        limit = 25,
        sort_by = 'sort_order',
        sort_order = 'asc',
        search,
        is_active,
      } = params

      const offset = (page - 1) * limit
      const conditions: string[] = ['g.shop_id = ?']
      const queryParams: any[] = [shopId()]

      // Filters
      if (search) {
        conditions.push('(g.name LIKE ? OR g.slug LIKE ? OR g.description LIKE ?)')
        const searchPattern = `%${search}%`
        queryParams.push(searchPattern, searchPattern, searchPattern)
      }

      if (is_active !== undefined) {
        conditions.push('g.is_active = ?')
        queryParams.push(is_active ? 1 : 0)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // Validate sort column
      const validSortColumns = ['name', 'sort_order']
      const orderColumn = validSortColumns.includes(sort_by) ? `g.${sort_by}` : 'g.sort_order'
      const orderDirection = sort_order === 'desc' ? 'DESC' : 'ASC'

      // Count total
      const [countRows] = await conn.query<any[]>(
        `SELECT COUNT(*) as total FROM cms_faq_groups g ${whereClause}`,
        queryParams
      )
      const total = countRows[0]?.total || 0

      // Get rows with FAQ count
      const [rows] = await conn.query<any[]>(
        `
        SELECT
          g.id,
          g.slug,
          g.name,
          g.description,
          g.sort_order,
          g.is_active,
          COUNT(f.id) as faq_count
        FROM cms_faq_groups g
        LEFT JOIN cms_faqs f ON f.group_id = g.id AND f.shop_id = g.shop_id
        ${whereClause}
        GROUP BY g.id, g.slug, g.name, g.description, g.sort_order, g.is_active
        ORDER BY ${orderColumn} ${orderDirection}
        LIMIT ? OFFSET ?
      `,
        [...queryParams, limit, offset]
      )

      const totalPages = Math.ceil(total / limit)

      return {
        data: rows as FAQGroupListItem[],
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
      if (!connection) conn.release()
    }
  },

  /**
   * Get single FAQ group by ID
   */
  async getById(id: number, connection?: PoolConnection): Promise<FAQGroup | null> {
    const conn = connection || (await pool.getConnection())
    try {
      const [rows] = await conn.query<any[]>(
        `SELECT id, slug, name, description, sort_order, is_active
         FROM cms_faq_groups
         WHERE shop_id = ? AND id = ?`,
        [shopId(), id]
      )
      return rows.length > 0 ? (rows[0] as FAQGroup) : null
    } finally {
      if (!connection) conn.release()
    }
  },

  /**
   * Get FAQ group by slug
   */
  async getBySlug(slug: string, connection?: PoolConnection): Promise<FAQGroup | null> {
    const conn = connection || (await pool.getConnection())
    try {
      const [rows] = await conn.query<any[]>(
        `SELECT id, slug, name, description, sort_order, is_active
         FROM cms_faq_groups
         WHERE shop_id = ? AND slug = ?`,
        [shopId(), slug]
      )
      return rows.length > 0 ? (rows[0] as FAQGroup) : null
    } finally {
      if (!connection) conn.release()
    }
  },

  /**
   * Create new FAQ group
   */
  async create(data: CreateFAQGroupDto, connection?: PoolConnection): Promise<FAQGroup> {
    const conn = connection || (await pool.getConnection())
    try {
      const [result] = await conn.query<any>(
        `INSERT INTO cms_faq_groups (shop_id, slug, name, description, sort_order, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          shopId(),
          data.slug,
          data.name,
          data.description || null,
          data.sort_order ?? 0,
          data.is_active ?? true ? 1 : 0,
        ]
      )

      const group = await this.getById(result.insertId, conn)
      if (!group) throw new Error('Failed to retrieve created FAQ group')
      return group
    } finally {
      if (!connection) conn.release()
    }
  },

  /**
   * Update FAQ group
   */
  async update(
    id: number,
    data: UpdateFAQGroupDto,
    connection?: PoolConnection
  ): Promise<FAQGroup> {
    const conn = connection || (await pool.getConnection())
    try {
      const updates: string[] = []
      const params: any[] = []

      if (data.slug !== undefined) {
        updates.push('slug = ?')
        params.push(data.slug)
      }
      if (data.name !== undefined) {
        updates.push('name = ?')
        params.push(data.name)
      }
      if (data.description !== undefined) {
        updates.push('description = ?')
        params.push(data.description)
      }
      if (data.sort_order !== undefined) {
        updates.push('sort_order = ?')
        params.push(data.sort_order)
      }
      if (data.is_active !== undefined) {
        updates.push('is_active = ?')
        params.push(data.is_active ? 1 : 0)
      }

      if (updates.length === 0) {
        const group = await this.getById(id, conn)
        if (!group) throw new Error('FAQ group not found')
        return group
      }

      params.push(shopId(), id)
      await conn.query(`UPDATE cms_faq_groups SET ${updates.join(', ')} WHERE shop_id = ? AND id = ?`, params)

      const group = await this.getById(id, conn)
      if (!group) throw new Error('FAQ group not found')
      return group
    } finally {
      if (!connection) conn.release()
    }
  },

  /**
   * Delete FAQ group
   */
  async delete(id: number, connection?: PoolConnection): Promise<void> {
    const conn = connection || (await pool.getConnection())
    try {
      await conn.query('DELETE FROM cms_faq_groups WHERE shop_id = ? AND id = ?', [shopId(), id])
    } finally {
      if (!connection) conn.release()
    }
  },
}

// ══════════════════════════════════════════════════════════════════════════════
// FAQS
// ══════════════════════════════════════════════════════════════════════════════

export const faqsRepository = {
  /**
   * List FAQs with pagination and filtering
   */
  async list(params: ListFAQsParams, connection?: PoolConnection) {
    const conn = connection || (await pool.getConnection())
    try {
      const {
        page = 1,
        limit = 25,
        sort_by = 'sort_order',
        sort_order = 'asc',
        search,
        group_id,
        entity_type,
        entity_id,
        is_published,
        is_indexable,
      } = params

      const offset = (page - 1) * limit
      const conditions: string[] = ['f.shop_id = ?']
      const queryParams: any[] = [shopId()]

      // Filters
      if (search) {
        conditions.push('(f.question LIKE ? OR f.answer LIKE ?)')
        const searchPattern = `%${search}%`
        queryParams.push(searchPattern, searchPattern)
      }

      if (group_id !== undefined) {
        if (group_id === null || group_id === 0) {
          conditions.push('f.group_id IS NULL')
        } else {
          conditions.push('f.group_id = ?')
          queryParams.push(group_id)
        }
      }

      if (entity_type) {
        conditions.push('f.entity_type = ?')
        queryParams.push(entity_type)
      }

      if (entity_id !== undefined) {
        conditions.push('f.entity_id = ?')
        queryParams.push(entity_id)
      }

      if (is_published !== undefined) {
        conditions.push('f.is_published = ?')
        queryParams.push(is_published ? 1 : 0)
      }

      if (is_indexable !== undefined) {
        conditions.push('f.is_indexable = ?')
        queryParams.push(is_indexable ? 1 : 0)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      // Validate sort column
      const validSortColumns = ['question', 'group_id', 'sort_order', 'helpful_count', 'created_at', 'updated_at']
      const orderColumn = validSortColumns.includes(sort_by) ? `f.${sort_by}` : 'f.sort_order'
      const orderDirection = sort_order === 'desc' ? 'DESC' : 'ASC'

      // Count total
      const [countRows] = await conn.query<any[]>(
        `SELECT COUNT(*) as total FROM cms_faqs f ${whereClause}`,
        queryParams
      )
      const total = countRows[0]?.total || 0

      // Get rows with group info
      const [rows] = await conn.query<any[]>(
        `
        SELECT
          f.id,
          f.group_id,
          f.entity_type,
          f.entity_id,
          f.question,
          f.answer,
          f.claim_id,
          f.sort_order,
          f.is_published,
          f.is_indexable,
          f.helpful_count,
          f.created_at,
          f.updated_at,
          g.name as group_name,
          g.slug as group_slug
        FROM cms_faqs f
        LEFT JOIN cms_faq_groups g ON g.id = f.group_id AND g.shop_id = f.shop_id
        ${whereClause}
        ORDER BY ${orderColumn} ${orderDirection}
        LIMIT ? OFFSET ?
      `,
        [...queryParams, limit, offset]
      )

      const totalPages = Math.ceil(total / limit)

      return {
        data: rows as FAQListItem[],
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
      if (!connection) conn.release()
    }
  },

  /**
   * Get single FAQ by ID with group relation
   */
  async getById(id: number, connection?: PoolConnection): Promise<FAQWithRelations | null> {
    const conn = connection || (await pool.getConnection())
    try {
      const [rows] = await conn.query<any[]>(
        `
        SELECT
          f.id,
          f.group_id,
          f.entity_type,
          f.entity_id,
          f.question,
          f.answer,
          f.claim_id,
          f.sort_order,
          f.is_published,
          f.is_indexable,
          f.helpful_count,
          f.created_at,
          f.updated_at,
          g.id as group_obj_id,
          g.name as group_name,
          g.slug as group_slug
        FROM cms_faqs f
        LEFT JOIN cms_faq_groups g ON g.id = f.group_id AND g.shop_id = f.shop_id
        WHERE f.shop_id = ? AND f.id = ?
      `,
        [shopId(), id]
      )

      if (rows.length === 0) return null

      const row = rows[0]
      const faq: FAQWithRelations = {
        id: row.id,
        group_id: row.group_id,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        question: row.question,
        answer: row.answer,
        claim_id: row.claim_id,
        sort_order: row.sort_order,
        is_published: Boolean(row.is_published),
        is_indexable: Boolean(row.is_indexable),
        helpful_count: row.helpful_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
        group: row.group_obj_id
          ? {
              id: row.group_obj_id,
              name: row.group_name,
              slug: row.group_slug,
            }
          : null,
      }

      return faq
    } finally {
      if (!connection) conn.release()
    }
  },

  /**
   * Create new FAQ
   */
  async create(data: CreateFAQDto, connection?: PoolConnection): Promise<FAQ> {
    const conn = connection || (await pool.getConnection())
    try {
      const [result] = await conn.query<any>(
        `INSERT INTO cms_faqs (
          shop_id, group_id, entity_type, entity_id, question, answer, claim_id,
          sort_order, is_published, is_indexable
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          shopId(),
          data.group_id || null,
          data.entity_type || null,
          data.entity_id || null,
          data.question,
          data.answer,
          data.claim_id || null,
          data.sort_order ?? 0,
          data.is_published ?? true ? 1 : 0,
          data.is_indexable ?? true ? 1 : 0,
        ]
      )

      const faq = await this.getById(result.insertId, conn)
      if (!faq) throw new Error('Failed to retrieve created FAQ')
      return faq
    } finally {
      if (!connection) conn.release()
    }
  },

  /**
   * Update FAQ
   */
  async update(id: number, data: UpdateFAQDto, connection?: PoolConnection): Promise<FAQ> {
    const conn = connection || (await pool.getConnection())
    try {
      const updates: string[] = []
      const params: any[] = []

      if (data.group_id !== undefined) {
        updates.push('group_id = ?')
        params.push(data.group_id)
      }
      if (data.entity_type !== undefined) {
        updates.push('entity_type = ?')
        params.push(data.entity_type)
      }
      if (data.entity_id !== undefined) {
        updates.push('entity_id = ?')
        params.push(data.entity_id)
      }
      if (data.question !== undefined) {
        updates.push('question = ?')
        params.push(data.question)
      }
      if (data.answer !== undefined) {
        updates.push('answer = ?')
        params.push(data.answer)
      }
      if (data.claim_id !== undefined) {
        updates.push('claim_id = ?')
        params.push(data.claim_id)
      }
      if (data.sort_order !== undefined) {
        updates.push('sort_order = ?')
        params.push(data.sort_order)
      }
      if (data.is_published !== undefined) {
        updates.push('is_published = ?')
        params.push(data.is_published ? 1 : 0)
      }
      if (data.is_indexable !== undefined) {
        updates.push('is_indexable = ?')
        params.push(data.is_indexable ? 1 : 0)
      }

      if (updates.length === 0) {
        const faq = await this.getById(id, conn)
        if (!faq) throw new Error('FAQ not found')
        return faq
      }

      params.push(shopId(), id)
      await conn.query(`UPDATE cms_faqs SET ${updates.join(', ')} WHERE shop_id = ? AND id = ?`, params)

      const faq = await this.getById(id, conn)
      if (!faq) throw new Error('FAQ not found')
      return faq
    } finally {
      if (!connection) conn.release()
    }
  },

  /**
   * Delete FAQ
   */
  async delete(id: number, connection?: PoolConnection): Promise<void> {
    const conn = connection || (await pool.getConnection())
    try {
      await conn.query('DELETE FROM cms_faqs WHERE shop_id = ? AND id = ?', [shopId(), id])
    } finally {
      if (!connection) conn.release()
    }
  },

  /**
   * Increment helpful count
   */
  async incrementHelpful(id: number, connection?: PoolConnection): Promise<void> {
    const conn = connection || (await pool.getConnection())
    try {
      await conn.query('UPDATE cms_faqs SET helpful_count = helpful_count + 1 WHERE shop_id = ? AND id = ?', [shopId(), id])
    } finally {
      if (!connection) conn.release()
    }
  },

  /**
   * Bulk update sort order
   */
  async bulkUpdateSortOrder(
    updates: Array<{ id: number; sort_order: number }>,
    connection?: PoolConnection
  ): Promise<void> {
    const conn = connection || (await pool.getConnection())
    try {
      for (const update of updates) {
        await conn.query('UPDATE cms_faqs SET sort_order = ? WHERE shop_id = ? AND id = ?', [
          update.sort_order,
          shopId(),
          update.id,
        ])
      }
    } finally {
      if (!connection) conn.release()
    }
  },
}
