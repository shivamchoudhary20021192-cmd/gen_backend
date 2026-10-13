import { z } from 'zod';

/**
 * `section_key` and `block_type` are free strings rather than enums on purpose.
 * A new kind of story section is a frontend component plus a row; making it a
 * database enum would mean a migration every time the design team invents a
 * layout, which is how content models ossify.
 */
const key = z.string().trim().min(2).max(60).regex(/^[a-z0-9_]+$/, {
  message: 'Use lower-case letters, numbers and underscores.',
});

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const sectionBodySchema = z.object({
  section_key: key,
  name: z.string().trim().min(2).max(120),
  heading: optionalText(255),
  standfirst: optionalText(500),
  footnote: optionalText(500),
  layout: z.enum(['split', 'stacked', 'carousel', 'grid']).optional(),
  background: optionalText(40),
  padding_top: z.enum(['none', 'sm', 'md', 'lg', 'xl']).optional(),
  padding_bottom: z.enum(['none', 'sm', 'md', 'lg', 'xl']).optional(),
  settings: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const sectionUpdateSchema = sectionBodySchema.partial();

export const blockBodySchema = z.object({
  block_type: key,
  sort_order: z.number().int().min(0).max(9999).optional(),
  is_enabled: z.boolean().optional(),
  heading: optionalText(255),
  body: z.string().trim().max(5000).nullable().optional(),
  media_id: z.number().int().positive().nullable().optional(),
  secondary_media_id: z.number().int().positive().nullable().optional(),
  creator_id: z.number().int().positive().nullable().optional(),
  /** Whether this use carries the model's name and link. */
  credit_creator: z.boolean().optional(),
  claim_id: z.number().int().positive().nullable().optional(),
  option_value_id: z.number().int().positive().nullable().optional(),
  link_type: z
    .enum(['none', 'url', 'product', 'collection', 'category', 'page', 'article'])
    .optional(),
  link_ref_id: z.number().int().positive().nullable().optional(),
  link_url: optionalText(500),
  cta_label: optionalText(60),
  settings: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const blockUpdateSchema = blockBodySchema.partial();

/**
 * Coordinates are percentages of the image, never pixels — the photograph is
 * rendered at whatever width the screen allows, and a label measured in pixels
 * slides off the cap on a laptop.
 */
export const hotspotsSchema = z.object({
  hotspots: z
    .array(
      z.object({
        x_pct: z.number().min(0).max(100),
        y_pct: z.number().min(0).max(100),
        label: z.string().trim().min(1).max(120),
        body: optionalText(500),
        product_id: z.number().int().positive().nullable().optional(),
        media_id: z.number().int().positive().nullable().optional(),
        line_direction: z.enum(['left', 'right', 'up', 'down']).optional(),
      }),
    )
    .max(24),
});

export const reorderSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
});

export const attachSchema = z.object({
  section_id: z.number().int().positive(),
});

export const assignmentUpdateSchema = z.object({
  is_enabled: z.boolean().optional(),
  visible_from: z.coerce.date().nullable().optional(),
  visible_until: z.coerce.date().nullable().optional(),
});

export const sectionIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const blockParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  blockId: z.coerce.number().int().positive(),
});

export const ownerParamSchema = z.object({
  productId: z.coerce.number().int().positive(),
});

export const ownerAssignmentParamSchema = z.object({
  productId: z.coerce.number().int().positive(),
  assignmentId: z.coerce.number().int().positive(),
});

export const sectionListQuerySchema = z.object({
  kind: z.string().trim().max(60).optional(),
  q: z.string().trim().max(120).optional(),
});
