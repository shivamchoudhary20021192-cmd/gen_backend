/**
 * Banners Validation Schemas
 * 
 * Zod schemas for request validation.
 * All fields use snake_case for consistency with database and DTOs.
 */

import { z } from 'zod'

/**
 * Banner placement enum
 */
export const bannerPlacementSchema = z.enum([
  'announcement_bar',
  'home_hero',
  'home_carousel',
  'category_top',
  'pdp_strip',
  'cart_drawer',
  'checkout',
  'popup',
  'footer',
])

/**
 * Banner audience enum
 */
export const bannerAudienceSchema = z.enum([
  'all',
  'new_visitors',
  'returning',
  'logged_in',
  'guests',
])

/**
 * Link type enum
 */
export const linkTypeSchema = z.enum([
  'none',
  'url',
  'page',
  'category',
  'collection',
  'product',
  'article',
])

/**
 * Hex color validation (e.g., #FF5733)
 */
const hexColorSchema = z.string().regex(/^#[0-9A-F]{6}$/i, 'Must be a valid hex color (e.g., #FF5733)')

/**
 * Create banner schema
 */
export const createBannerSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  placement: bannerPlacementSchema,
  title: z.string().max(191).optional(),
  subtitle: z.string().max(255).optional(),
  body: z.string().max(500).optional(),
  cta_label: z.string().max(60).optional(),
  cta_link_type: linkTypeSchema.default('none'),
  cta_link_ref_id: z.number().positive().optional(),
  cta_url: z.string().max(500).url('Must be a valid URL').optional(),
  desktop_media_id: z.number().positive().optional(),
  mobile_media_id: z.number().positive().optional(),
  poster_media_id: z.number().positive().nullable().optional(),
  background_hex: hexColorSchema.optional(),
  text_hex: hexColorSchema.optional(),
  audience: bannerAudienceSchema.default('all'),
  starts_at: z.string().datetime().optional(),
  ends_at: z.string().datetime().optional(),
  priority: z.number().int().min(0).max(32767).default(0),
  is_active: z.boolean().default(true),
  is_dismissible: z.boolean().default(true),
})

/**
 * Update banner schema
 */
export const updateBannerSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  placement: bannerPlacementSchema.optional(),
  title: z.string().max(191).nullable().optional(),
  subtitle: z.string().max(255).nullable().optional(),
  body: z.string().max(500).nullable().optional(),
  cta_label: z.string().max(60).nullable().optional(),
  cta_link_type: linkTypeSchema.optional(),
  cta_link_ref_id: z.number().positive().nullable().optional(),
  cta_url: z.string().max(500).url('Must be a valid URL').nullable().optional(),
  desktop_media_id: z.number().positive().nullable().optional(),
  mobile_media_id: z.number().positive().nullable().optional(),
  poster_media_id: z.number().positive().nullable().optional(),
  background_hex: hexColorSchema.nullable().optional(),
  text_hex: hexColorSchema.nullable().optional(),
  audience: bannerAudienceSchema.optional(),
  starts_at: z.string().datetime().nullable().optional(),
  ends_at: z.string().datetime().nullable().optional(),
  priority: z.number().int().min(0).max(32767).optional(),
  is_active: z.boolean().optional(),
  is_dismissible: z.boolean().optional(),
})

/**
 * List banners query schema
 */
export const listBannersQuerySchema = z.object({
  page: z.string().transform(Number).pipe(z.number().positive()).default('1'),
  limit: z.string().transform(Number).pipe(z.number().positive().max(100)).default('20'),
  sort_by: z.enum(['name', 'placement', 'priority', 'created_at', 'updated_at']).default('priority'),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
  placement: z.union([
    bannerPlacementSchema,
    z.string().transform((val) => val.split(',') as any)
  ]).optional(),
  audience: z.union([
    bannerAudienceSchema,
    z.string().transform((val) => val.split(',') as any)
  ]).optional(),
  is_active: z.string().transform((val) => val === 'true').optional(),
  status: z.enum(['scheduled', 'active', 'expired', 'inactive']).optional(),
  creator_id: z.string().transform(Number).pipe(z.number().positive()).optional(),
  starts_after: z.string().datetime().optional(),
  starts_before: z.string().datetime().optional(),
  ends_after: z.string().datetime().optional(),
  ends_before: z.string().datetime().optional(),
})

/**
 * Banner stats update schema
 */
export const updateBannerStatsSchema = z.object({
  banner_id: z.number().positive(),
  impressions: z.number().int().min(0).optional(),
  clicks: z.number().int().min(0).optional(),
})

/**
 * Bulk activate/deactivate schema
 */
export const bulkUpdateBannersSchema = z.object({
  ids: z.array(z.number().positive()).min(1, 'At least one banner ID required'),
})

/**
 * Banner ID param schema
 */
export const bannerIdParamSchema = z.object({
  id: z.string().transform(Number).pipe(z.number().positive()),
})

/**
 * Placement param schema
 */
export const placementParamSchema = z.object({
  placement: bannerPlacementSchema,
})

/**
 * Get by placement query schema
 */
export const getByPlacementQuerySchema = z.object({
  audience: bannerAudienceSchema.default('all'),
})
