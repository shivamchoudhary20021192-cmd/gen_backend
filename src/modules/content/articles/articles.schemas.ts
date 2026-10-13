import { z } from 'zod';

/**
 * Validation for the Journal.
 *
 * `body_html` is capped rather than unbounded: it is a longtext column reached
 * by an authenticated request, but "authenticated" is not "trusted with an
 * unlimited payload", and a 2 MB article is a mistake every time.
 */

const BODY_MAX = 200_000;

/** An empty string from a cleared form field means "no value", not "". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === '' ? null : (value ?? null)));

const dateOnly = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.')
  .nullish()
  .transform((value) => (value === '' ? null : (value ?? null)));

export const articleBodySchema = z.object({
  blog_id: z.coerce.number().int().positive().optional(),
  category_id: z.coerce.number().int().positive().nullish(),
  slug: z
    .string()
    .trim()
    .max(180)
    .optional(),
  title: z.string().trim().min(2, 'Give the article a title.').max(191),
  subtitle: optionalText(255),
  excerpt: optionalText(500),
  body_html: z.string().max(BODY_MAX).nullish(),
  cover_media_id: z.coerce.number().int().positive().nullish(),
  author_name: optionalText(120),
  author_title: optionalText(160),
  author_media_id: z.coerce.number().int().positive().nullish(),
  medically_reviewed_by: optionalText(160),
  reviewed_at: dateOnly,
  next_review_due: dateOnly,
  read_time_minutes: z.coerce.number().int().min(1).max(255).nullish(),
  is_featured: z.boolean().optional(),
  is_indexable: z.boolean().optional(),
  scheduled_at: z.string().datetime().nullish(),
  product_ids: z.array(z.coerce.number().int().positive()).max(12).optional(),
});

/** Every field optional on update, but `title` still may not be blanked. */
export const articleUpdateSchema = articleBodySchema.partial().extend({
  title: z.string().trim().min(2, 'Give the article a title.').max(191).optional(),
});

export const articleListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.enum(['draft', 'in_review', 'scheduled', 'published', 'archived']).optional(),
  category_id: z.coerce.number().int().positive().optional(),
  blog_id: z.coerce.number().int().positive().optional(),
  featured: z.enum(['true', 'false']).optional(),
  review_due: z.enum(['true', 'false']).optional(),
});

export const articleIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const publicArticleListQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(24).optional(),
  category: z.string().trim().max(140).optional(),
  /** A blog handle, to read one publication rather than all of them. */
  blog: z.string().trim().max(140).optional(),
});

export const slugParamSchema = z.object({
  slug: z.string().trim().min(1).max(191),
});
