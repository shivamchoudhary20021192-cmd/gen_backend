/**
 * Zod validation schemas for CMS Navigation
 * Validates request payloads for menus and menu items
 */

import { z } from 'zod'

// ── Link Types ───────────────────────────────────────────────────────────────

const linkTypeEnum = z.enum([
  'url',
  'page',
  'category',
  'collection',
  'product',
  'article',
  'policy',
  'ingredient',
  'routine',
  'none',
])

// ══════════════════════════════════════════════════════════════════════════════
// MENUS SCHEMAS
// ══════════════════════════════════════════════════════════════════════════════

export const createMenuSchema = z.object({
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/).optional(),
  name: z.string().min(1).max(120),
  is_active: z.boolean().optional(),
})

export const updateMenuSchema = z.object({
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/).optional(),
  name: z.string().min(1).max(120).optional(),
  is_active: z.boolean().optional(),
})

export const listMenusQuerySchema = z.object({
  is_active: z.enum(['true', 'false']).optional(),
})

export const menuIdParamSchema = z.object({
  id: z.string().transform(Number).pipe(z.number().int().positive()),
})

export const menuSlugParamSchema = z.object({
  slug: z.string().min(1).max(60),
})

// ══════════════════════════════════════════════════════════════════════════════
// MENU ITEMS SCHEMAS
// ══════════════════════════════════════════════════════════════════════════════

export const createMenuItemSchema = z.object({
  menu_id: z.number().int().positive(),
  parent_id: z.number().int().positive().nullable().optional(),
  label: z.string().min(1).max(120),
  link_type: linkTypeEnum,
  link_ref_id: z.number().int().positive().nullable().optional(),
  url: z.string().max(500).nullable().optional(),
  icon_media_id: z.number().int().positive().nullable().optional(),
  image_media_id: z.number().int().positive().nullable().optional(),
  badge_label: z.string().max(30).nullable().optional(),
  description: z.string().max(255).nullable().optional(),
  sort_order: z.number().int().min(0).max(65535).optional(),
  opens_new_tab: z.boolean().optional(),
  is_active: z.boolean().optional(),
})

export const updateMenuItemSchema = z.object({
  parent_id: z.number().int().positive().nullable().optional(),
  label: z.string().min(1).max(120).optional(),
  link_type: linkTypeEnum.optional(),
  link_ref_id: z.number().int().positive().nullable().optional(),
  url: z.string().max(500).nullable().optional(),
  icon_media_id: z.number().int().positive().nullable().optional(),
  image_media_id: z.number().int().positive().nullable().optional(),
  badge_label: z.string().max(30).nullable().optional(),
  description: z.string().max(255).nullable().optional(),
  sort_order: z.number().int().min(0).max(65535).optional(),
  opens_new_tab: z.boolean().optional(),
  is_active: z.boolean().optional(),
})

export const listMenuItemsQuerySchema = z.object({
  menu_id: z.string().transform(Number).pipe(z.number().int().positive()).optional(),
  parent_id: z.string().optional(), // Can be 'null' string or number
  link_type: linkTypeEnum.optional(),
  is_active: z.enum(['true', 'false']).optional(),
})

export const menuItemIdParamSchema = z.object({
  id: z.string().transform(Number).pipe(z.number().int().positive()),
})

export const bulkReorderMenuItemsSchema = z.object({
  updates: z
    .array(
      z.object({
        id: z.number().int().positive(),
        parent_id: z.number().int().positive().nullable(),
        sort_order: z.number().int().min(0).max(65535),
      })
    )
    .min(1)
    .max(500),
})

// ══════════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ══════════════════════════════════════════════════════════════════════════════

export type CreateMenuInput = z.infer<typeof createMenuSchema>
export type UpdateMenuInput = z.infer<typeof updateMenuSchema>
export type ListMenusQuery = z.infer<typeof listMenusQuerySchema>

export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>
export type ListMenuItemsQuery = z.infer<typeof listMenuItemsQuerySchema>
export type BulkReorderMenuItemsInput = z.infer<typeof bulkReorderMenuItemsSchema>
