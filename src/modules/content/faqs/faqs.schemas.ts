/**
 * Zod validation schemas for FAQs module
 * Validates request payloads for FAQ Groups and FAQs
 */

import { z } from 'zod'

// ══════════════════════════════════════════════════════════════════════════════
// FAQ GROUPS SCHEMAS
// ══════════════════════════════════════════════════════════════════════════════

export const createFAQGroupSchema = z.object({
  slug: z.string().min(1).max(140).regex(/^[a-z0-9-]+$/).optional(),
  name: z.string().min(1).max(160),
  description: z.string().max(500).nullable().optional(),
  sort_order: z.number().int().min(0).max(65535).optional(),
  is_active: z.boolean().optional(),
})

export const updateFAQGroupSchema = z.object({
  slug: z.string().min(1).max(140).regex(/^[a-z0-9-]+$/).optional(),
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(500).nullable().optional(),
  sort_order: z.number().int().min(0).max(65535).optional(),
  is_active: z.boolean().optional(),
})

export const listFAQGroupsQuerySchema = z.object({
  page: z.string().transform(Number).pipe(z.number().int().min(1)).optional(),
  limit: z.string().transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  sort_by: z.enum(['name', 'sort_order', 'created_at']).optional(),
  sort_order: z.enum(['asc', 'desc']).optional(),
  search: z.string().optional(),
  is_active: z.enum(['true', 'false']).optional(),
})

export const faqGroupIdParamSchema = z.object({
  id: z.string().transform(Number).pipe(z.number().int().positive()),
})

export const faqGroupSlugParamSchema = z.object({
  slug: z.string().min(1).max(140),
})

// ══════════════════════════════════════════════════════════════════════════════
// FAQS SCHEMAS
// ══════════════════════════════════════════════════════════════════════════════

const entityTypeEnum = z.enum(['product', 'cms_page', 'collection', 'category', 'article'])

export const createFAQSchema = z.object({
  group_id: z.number().int().positive().nullable().optional(),
  entity_type: entityTypeEnum.nullable().optional(),
  entity_id: z.number().int().positive().nullable().optional(),
  question: z.string().min(1).max(500),
  answer: z.string().min(1),
  claim_id: z.number().int().positive().nullable().optional(),
  sort_order: z.number().int().min(0).max(65535).optional(),
  is_published: z.boolean().optional(),
  is_indexable: z.boolean().optional(),
})

export const updateFAQSchema = z.object({
  group_id: z.number().int().positive().nullable().optional(),
  entity_type: entityTypeEnum.nullable().optional(),
  entity_id: z.number().int().positive().nullable().optional(),
  question: z.string().min(1).max(500).optional(),
  answer: z.string().min(1).optional(),
  claim_id: z.number().int().positive().nullable().optional(),
  sort_order: z.number().int().min(0).max(65535).optional(),
  is_published: z.boolean().optional(),
  is_indexable: z.boolean().optional(),
})

export const listFAQsQuerySchema = z.object({
  page: z.string().transform(Number).pipe(z.number().int().min(1)).optional(),
  limit: z.string().transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  sort_by: z.enum(['question', 'group_id', 'sort_order', 'helpful_count', 'created_at', 'updated_at']).optional(),
  sort_order: z.enum(['asc', 'desc']).optional(),
  search: z.string().optional(),
  group_id: z.string().transform(Number).pipe(z.number().int()).optional(),
  entity_type: entityTypeEnum.optional(),
  entity_id: z.string().transform(Number).pipe(z.number().int().positive()).optional(),
  is_published: z.enum(['true', 'false']).optional(),
  is_indexable: z.enum(['true', 'false']).optional(),
})

export const faqIdParamSchema = z.object({
  id: z.string().transform(Number).pipe(z.number().int().positive()),
})

export const bulkUpdateSortOrderSchema = z.object({
  updates: z.array(
    z.object({
      id: z.number().int().positive(),
      sort_order: z.number().int().min(0).max(65535),
    })
  ).min(1),
})

// ══════════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ══════════════════════════════════════════════════════════════════════════════

export type CreateFAQGroupInput = z.infer<typeof createFAQGroupSchema>
export type UpdateFAQGroupInput = z.infer<typeof updateFAQGroupSchema>
export type ListFAQGroupsQuery = z.infer<typeof listFAQGroupsQuerySchema>

export type CreateFAQInput = z.infer<typeof createFAQSchema>
export type UpdateFAQInput = z.infer<typeof updateFAQSchema>
export type ListFAQsQuery = z.infer<typeof listFAQsQuerySchema>
export type BulkUpdateSortOrderInput = z.infer<typeof bulkUpdateSortOrderSchema>
