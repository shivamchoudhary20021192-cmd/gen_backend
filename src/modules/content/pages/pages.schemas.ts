/**
 * Pages Validation Schemas
 * 
 * Zod schemas for request validation.
 */

import { z } from 'zod'

/**
 * Page type enum
 */
export const pageTypeSchema = z.enum([
  'home',
  'standard',
  'landing',
  'policy',
  'about',
  'support',
  'concern',
  'ingredient_library',
  'custom',
])

/**
 * Page status enum
 */
export const pageStatusSchema = z.enum([
  'draft',
  'in_review',
  'scheduled',
  'published',
  'archived',
])

/**
 * Section padding enum
 */
export const sectionPaddingSchema = z.enum(['none', 'sm', 'md', 'lg', 'xl'])

/**
 * Create page schema
 */
export const createPageSchema = z.object({
  slug: z.string().min(1).max(191).optional(),
  title: z.string().min(1, 'Title is required').max(191),
  subtitle: z.string().max(255).optional(),
  page_type: pageTypeSchema,
  template: z.string().max(60).default('default'),
  locale: z.string().max(10).default('en-IN'),
  body_html: z.string().optional(),
  body_json: z.any().optional(),
  hero_media_id: z.number().positive().optional(),
  status: pageStatusSchema.default('draft'),
  scheduled_at: z.string().datetime().optional(),
  unpublish_at: z.string().datetime().optional(),
  requires_legal_review: z.boolean().default(false),
  review_due_at: z.string().datetime().optional(),
  is_indexable: z.boolean().default(true),
  show_in_sitemap: z.boolean().default(true),
  parent_id: z.number().positive().optional(),
})

/**
 * Update page schema
 */
export const updatePageSchema = z.object({
  slug: z.string().min(1).max(191).optional(),
  title: z.string().min(1).max(191).optional(),
  subtitle: z.string().max(255).nullable().optional(),
  page_type: pageTypeSchema.optional(),
  template: z.string().max(60).optional(),
  body_html: z.string().nullable().optional(),
  body_json: z.any().nullable().optional(),
  hero_media_id: z.number().positive().nullable().optional(),
  status: pageStatusSchema.optional(),
  published_at: z.string().datetime().nullable().optional(),
  scheduled_at: z.string().datetime().nullable().optional(),
  unpublish_at: z.string().datetime().nullable().optional(),
  requires_legal_review: z.boolean().optional(),
  reviewed_by_admin_id: z.number().positive().nullable().optional(),
  reviewed_at: z.string().datetime().nullable().optional(),
  review_due_at: z.string().datetime().nullable().optional(),
  is_indexable: z.boolean().optional(),
  show_in_sitemap: z.boolean().optional(),
  parent_id: z.number().positive().nullable().optional(),
})

/**
 * List pages query schema
 */
export const listPagesQuerySchema = z.object({
  page: z.string().transform(Number).pipe(z.number().positive()).default('1'),
  limit: z.string().transform(Number).pipe(z.number().positive().max(100)).default('20'),
  sortBy: z.enum(['title', 'status', 'updated_at', 'created_at']).default('updated_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
  status: z.union([
    pageStatusSchema,
    z.string().transform((val) => val.split(',') as any)
  ]).optional(),
  page_type: z.union([
    pageTypeSchema,
    z.string().transform((val) => val.split(',') as any)
  ]).optional(),
  author_id: z.string().transform(Number).pipe(z.number().positive()).optional(),
  requires_legal_review: z.string().transform((val) => val === 'true').optional(),
  is_indexable: z.string().transform((val) => val === 'true').optional(),
  created_after: z.string().datetime().optional(),
  created_before: z.string().datetime().optional(),
  published_after: z.string().datetime().optional(),
  published_before: z.string().datetime().optional(),
})

/**
 * Publish page schema
 */
export const publishPageSchema = z.object({
  scheduled_at: z.string().datetime().optional(),
  unpublish_at: z.string().datetime().optional(),
})

/**
 * Create section schema
 */
export const createSectionSchema = z.object({
  section_key: z.string().min(1).max(60),
  name: z.string().max(120).optional(),
  sort_order: z.number().int().min(0).default(0),
  is_enabled: z.boolean().default(true),
  settings: z.any().optional(),
  background: z.string().max(40).optional(),
  padding_top: sectionPaddingSchema.default('md'),
  padding_bottom: sectionPaddingSchema.default('md'),
  visible_from: z.string().datetime().optional(),
  visible_until: z.string().datetime().optional(),
})

/**
 * Update section schema
 */
export const updateSectionSchema = z.object({
  section_key: z.string().min(1).max(60).optional(),
  name: z.string().max(120).nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
  is_enabled: z.boolean().optional(),
  settings: z.any().nullable().optional(),
  background: z.string().max(40).nullable().optional(),
  padding_top: sectionPaddingSchema.optional(),
  padding_bottom: sectionPaddingSchema.optional(),
  visible_from: z.string().datetime().nullable().optional(),
  visible_until: z.string().datetime().nullable().optional(),
})

/**
 * Reorder sections schema
 */
export const reorderSectionsSchema = z.object({
  sections: z.array(
    z.object({
      id: z.number().positive(),
      sort_order: z.number().int().min(0),
    })
  ),
})

/**
 * Bulk update pages schema
 */
export const bulkUpdatePagesSchema = z.object({
  ids: z.array(z.number().positive()).min(1, 'At least one page ID required'),
  status: pageStatusSchema,
})

/**
 * Page ID param schema
 */
export const pageIdParamSchema = z.object({
  id: z.string().transform(Number).pipe(z.number().positive()),
})

/**
 * Section ID param schema
 */
export const sectionIdParamSchema = z.object({
  sectionId: z.string().transform(Number).pipe(z.number().positive()),
})
