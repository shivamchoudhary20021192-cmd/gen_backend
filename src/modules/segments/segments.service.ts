import * as repo from './segments.repository'

export async function listSegments(filters: { segment_type?: string; search?: string } = {}) {
  const segments = await repo.findSegments(filters as any)
  return segments.map((s: repo.SegmentRow) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    segment_type: s.segment_type,
    rules: s.rules,
    rules_operator: s.rules_operator,
    customer_count: s.customer_count,
    last_calculated_at: s.last_calculated_at,
    color: s.color,
    icon: s.icon,
    created_by_name: (s as any).created_by_name,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }))
}

export async function getSegment(id: number) {
  const segment = await repo.findSegmentById(id)
  if (!segment) return null

  return {
    id: segment.id,
    name: segment.name,
    description: segment.description,
    segment_type: segment.segment_type,
    rules: segment.rules,
    rules_operator: segment.rules_operator,
    customer_count: segment.customer_count,
    last_calculated_at: segment.last_calculated_at,
    color: segment.color,
    icon: segment.icon,
    created_by_name: (segment as any).created_by_name,
    created_at: segment.created_at,
    updated_at: segment.updated_at,
  }
}

export async function createSegment(
  data: {
    name: string
    description?: string
    segment_type: 'manual' | 'auto' | 'imported'
    rules?: any
    rules_operator?: 'all' | 'any'
    color?: string
    icon?: string
  },
  adminId: number,
) {
  const id = await repo.createSegment({
    ...data,
    created_by_admin_id: adminId,
  })

  return { id }
}

export async function updateSegment(
  id: number,
  data: {
    name?: string
    description?: string
    rules?: any
    rules_operator?: 'all' | 'any'
    color?: string
    icon?: string
  },
) {
  await repo.updateSegment(id, data)
  return { success: true }
}

export async function deleteSegment(id: number) {
  await repo.deleteSegment(id)
  return { success: true }
}

export async function getSegmentMembers(segmentId: number, page = 1, limit = 50) {
  const offset = (page - 1) * limit
  const members = await repo.findSegmentMembers(segmentId, limit, offset)
  const total = await repo.countSegmentMembers(segmentId)

  return {
    data: members.map((m: any) => ({
      id: m.id,
      customer_id: m.customer_id,
      first_name: m.first_name,
      last_name: m.last_name,
      email: m.email,
      phone: m.phone,
      country_code: m.country_code,
      total_spent: m.total_spent,
      orders_count: m.orders_count,
      last_order_at: m.last_order_at,
      added_at: m.created_at,
    })),
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  }
}

export async function addCustomerToSegment(
  segmentId: number,
  customerId: number,
  adminId: number,
) {
  await repo.addCustomerToSegment(segmentId, customerId, adminId)
  return { success: true }
}

export async function removeCustomerFromSegment(segmentId: number, customerId: number) {
  await repo.removeCustomerFromSegment(segmentId, customerId)
  return { success: true }
}

// Tags
export async function listTags() {
  const tags = await repo.findAllTags()
  return tags.map((t: any) => ({
    id: t.id,
    name: t.name,
    color: t.color,
    description: t.description,
    usage_count: t.usage_count,
    created_at: t.created_at,
  }))
}

export async function createTag(data: { name: string; color?: string; description?: string }) {
  const id = await repo.createTag(data)
  return { id }
}

export async function updateTag(
  id: number,
  data: { name?: string; color?: string; description?: string },
) {
  await repo.updateTag(id, data)
  return { success: true }
}

export async function deleteTag(id: number) {
  await repo.deleteTag(id)
  return { success: true }
}

export async function getCustomerTags(customerId: number) {
  const tags = await repo.findCustomerTags(customerId)
  return tags.map((t: any) => ({
    id: t.id,
    name: t.name,
    color: t.color,
  }))
}

export async function assignTagToCustomer(tagId: number, customerId: number, adminId: number) {
  await repo.assignTagToCustomer(tagId, customerId, adminId)
  return { success: true }
}

export async function removeTagFromCustomer(tagId: number, customerId: number) {
  await repo.removeTagFromCustomer(tagId, customerId)
  return { success: true }
}
