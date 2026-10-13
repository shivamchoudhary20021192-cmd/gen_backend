import { RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { pool as db } from '../../db/pool'
import { shopId } from '../../platform/tenancy/context'

export interface SegmentRow extends RowDataPacket {
  id: number
  name: string
  description: string | null
  segment_type: 'manual' | 'auto' | 'imported'
  rules: any | null
  rules_operator: 'all' | 'any'
  customer_count: number
  last_calculated_at: string | null
  color: string | null
  icon: string | null
  created_by_admin_id: number | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface SegmentMemberRow extends RowDataPacket {
  id: number
  segment_id: number
  customer_id: number
  added_by_admin_id: number | null
  auto_added_at: string | null
  created_at: string
}

export interface CustomerTagRow extends RowDataPacket {
  id: number
  name: string
  color: string | null
  description: string | null
  usage_count: number
  created_at: string
  updated_at: string
}

export interface SegmentFilters {
  segment_type?: 'manual' | 'auto' | 'imported'
  search?: string
}

export async function findSegments(filters: SegmentFilters = {}) {
  let sql = `
    SELECT
      cs.*,
      CONCAT(au.first_name, ' ', au.last_name) as created_by_name
    FROM customer_segments cs
    LEFT JOIN admin_users au ON cs.created_by_admin_id = au.id
    WHERE cs.shop_id = ? AND cs.deleted_at IS NULL
  `
  const params: any[] = [shopId()]

  if (filters.segment_type) {
    sql += ` AND cs.segment_type = ?`
    params.push(filters.segment_type)
  }

  if (filters.search) {
    sql += ` AND (cs.name LIKE ? OR cs.description LIKE ?)`
    const term = `%${filters.search}%`
    params.push(term, term)
  }

  sql += ` ORDER BY cs.created_at DESC`

  const [rows] = await db.query<SegmentRow[]>(sql, params)
  return rows
}

export async function findSegmentById(id: number) {
  const sql = `
    SELECT
      cs.*,
      CONCAT(au.first_name, ' ', au.last_name) as created_by_name
    FROM customer_segments cs
    LEFT JOIN admin_users au ON cs.created_by_admin_id = au.id
    WHERE cs.shop_id = ? AND cs.id = ? AND cs.deleted_at IS NULL
  `
  const [rows] = await db.query<SegmentRow[]>(sql, [shopId(), id])
  return rows[0] || null
}

export async function createSegment(data: {
  name: string
  description?: string | null
  segment_type: 'manual' | 'auto' | 'imported'
  rules?: any | null
  rules_operator?: 'all' | 'any'
  color?: string | null
  icon?: string | null
  created_by_admin_id: number
}) {
  const sql = `
    INSERT INTO customer_segments
      (shop_id, name, description, segment_type, rules, rules_operator, color, icon, created_by_admin_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  const [result] = await db.query<ResultSetHeader>(sql, [
    shopId(),
    data.name,
    data.description || null,
    data.segment_type,
    data.rules ? JSON.stringify(data.rules) : null,
    data.rules_operator || 'all',
    data.color || null,
    data.icon || null,
    data.created_by_admin_id,
  ])
  return result.insertId
}

export async function updateSegment(
  id: number,
  data: {
    name?: string
    description?: string | null
    rules?: any | null
    rules_operator?: 'all' | 'any'
    color?: string | null
    icon?: string | null
  },
) {
  const fields: string[] = []
  const params: any[] = []

  if (data.name !== undefined) {
    fields.push('name = ?')
    params.push(data.name)
  }
  if (data.description !== undefined) {
    fields.push('description = ?')
    params.push(data.description)
  }
  if (data.rules !== undefined) {
    fields.push('rules = ?')
    params.push(data.rules ? JSON.stringify(data.rules) : null)
  }
  if (data.rules_operator !== undefined) {
    fields.push('rules_operator = ?')
    params.push(data.rules_operator)
  }
  if (data.color !== undefined) {
    fields.push('color = ?')
    params.push(data.color)
  }
  if (data.icon !== undefined) {
    fields.push('icon = ?')
    params.push(data.icon)
  }

  if (fields.length === 0) return

  params.push(shopId(), id)
  const sql = `UPDATE customer_segments SET ${fields.join(', ')} WHERE shop_id = ? AND id = ?`
  await db.query(sql, params)
}

export async function deleteSegment(id: number) {
  const sql = `UPDATE customer_segments SET deleted_at = NOW() WHERE shop_id = ? AND id = ?`
  await db.query(sql, [shopId(), id])
}

// Segment members
export async function findSegmentMembers(segmentId: number, limit = 100, offset = 0) {
  const sql = `
    SELECT
      csm.*,
      c.first_name,
      c.last_name,
      c.email,
      c.phone,
      c.country_code,
      c.total_spent,
      c.orders_count,
      c.last_order_at
    FROM customer_segment_members csm
    INNER JOIN customers c ON csm.customer_id = c.id
    WHERE csm.shop_id = ? AND csm.segment_id = ?
    ORDER BY csm.created_at DESC
    LIMIT ? OFFSET ?
  `
  const [rows] = await db.query<RowDataPacket[]>(sql, [shopId(), segmentId, limit, offset])
  return rows
}

export async function countSegmentMembers(segmentId: number) {
  const sql = `SELECT COUNT(*) as total FROM customer_segment_members WHERE shop_id = ? AND segment_id = ?`
  const [rows] = await db.query<RowDataPacket[]>(sql, [shopId(), segmentId])
  return rows[0].total
}

export async function addCustomerToSegment(
  segmentId: number,
  customerId: number,
  adminId?: number,
) {
  const sql = `
    INSERT INTO customer_segment_members (shop_id, segment_id, customer_id, added_by_admin_id)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE segment_id = segment_id
  `
  await db.query(sql, [shopId(), segmentId, customerId, adminId || null])

  // Update count
  await updateSegmentCount(segmentId)
}

export async function removeCustomerFromSegment(segmentId: number, customerId: number) {
  const sql = `DELETE FROM customer_segment_members WHERE shop_id = ? AND segment_id = ? AND customer_id = ?`
  await db.query(sql, [shopId(), segmentId, customerId])

  // Update count
  await updateSegmentCount(segmentId)
}

export async function updateSegmentCount(segmentId: number) {
  const sql = `
    UPDATE customer_segments
    SET customer_count = (
      SELECT COUNT(*) FROM customer_segment_members WHERE shop_id = ? AND segment_id = ?
    ),
    last_calculated_at = NOW()
    WHERE shop_id = ? AND id = ?
  `
  await db.query(sql, [shopId(), segmentId, shopId(), segmentId])
}

// Customer tags
export async function findAllTags() {
  const sql = `SELECT * FROM customer_tags WHERE shop_id = ? ORDER BY name ASC`
  const [rows] = await db.query<CustomerTagRow[]>(sql, [shopId()])
  return rows
}

export async function findTagById(id: number) {
  const sql = `SELECT * FROM customer_tags WHERE shop_id = ? AND id = ?`
  const [rows] = await db.query<CustomerTagRow[]>(sql, [shopId(), id])
  return rows[0] || null
}

export async function createTag(data: {
  name: string
  color?: string | null
  description?: string | null
}) {
  const sql = `INSERT INTO customer_tags (shop_id, name, color, description) VALUES (?, ?, ?, ?)`
  const [result] = await db.query<ResultSetHeader>(sql, [
    shopId(),
    data.name,
    data.color || null,
    data.description || null,
  ])
  return result.insertId
}

export async function updateTag(
  id: number,
  data: { name?: string; color?: string | null; description?: string | null },
) {
  const fields: string[] = []
  const params: any[] = []

  if (data.name !== undefined) {
    fields.push('name = ?')
    params.push(data.name)
  }
  if (data.color !== undefined) {
    fields.push('color = ?')
    params.push(data.color)
  }
  if (data.description !== undefined) {
    fields.push('description = ?')
    params.push(data.description)
  }

  if (fields.length === 0) return

  params.push(shopId(), id)
  const sql = `UPDATE customer_tags SET ${fields.join(', ')} WHERE shop_id = ? AND id = ?`
  await db.query(sql, params)
}

export async function deleteTag(id: number) {
  await db.query(`DELETE FROM customer_tags WHERE shop_id = ? AND id = ?`, [shopId(), id])
}

export async function findCustomerTags(customerId: number) {
  const sql = `
    SELECT ct.*
    FROM customer_tags ct
    INNER JOIN customer_tag_assignments cta ON ct.id = cta.tag_id
    WHERE cta.shop_id = ? AND cta.customer_id = ?
    ORDER BY ct.name ASC
  `
  const [rows] = await db.query<CustomerTagRow[]>(sql, [shopId(), customerId])
  return rows
}

export async function assignTagToCustomer(tagId: number, customerId: number, adminId?: number) {
  const sql = `
    INSERT INTO customer_tag_assignments (shop_id, customer_id, tag_id, added_by_admin_id)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE tag_id = tag_id
  `
  await db.query(sql, [shopId(), customerId, tagId, adminId || null])

  await refreshTagUsage(tagId)
}

export async function removeTagFromCustomer(tagId: number, customerId: number) {
  await db.query(
    `DELETE FROM customer_tag_assignments WHERE shop_id = ? AND customer_id = ? AND tag_id = ?`,
    [shopId(), customerId, tagId],
  )

  await refreshTagUsage(tagId)
}

async function refreshTagUsage(tagId: number) {
  await db.query(
    `UPDATE customer_tags SET usage_count = (
      SELECT COUNT(*) FROM customer_tag_assignments WHERE shop_id = ? AND tag_id = ?
    ) WHERE shop_id = ? AND id = ?`,
    [shopId(), tagId, shopId(), tagId],
  )
}
