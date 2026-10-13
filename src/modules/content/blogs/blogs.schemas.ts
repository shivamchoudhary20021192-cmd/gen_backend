import { z } from 'zod';

/** An empty string from a cleared field means "no value", not "". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === '' ? null : (value ?? null)));

export const blogBodySchema = z.object({
  slug: z.string().trim().max(130).optional(),
  title: z.string().trim().min(2, 'Give the blog a title.').max(160),
  description: optionalText(500),
  is_active: z.boolean().optional(),
  /** Comments: off, held for approval, or published straight away. */
  comments_policy: z.enum(['disabled', 'moderated', 'published']).optional(),
});

export const blogUpdateSchema = blogBodySchema.partial().extend({
  title: z.string().trim().min(2, 'Give the blog a title.').max(160).optional(),
});

export const blogIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * `reassign_to` rides on the delete because moving the articles and removing
 * the blog are one decision, taken once, in one transaction.
 */
export const blogDeleteQuerySchema = z.object({
  reassign_to: z.coerce.number().int().positive().optional(),
});

export const blogSlugParamSchema = z.object({
  slug: z.string().trim().min(1).max(140),
});
