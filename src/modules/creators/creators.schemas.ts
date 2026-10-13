import { z } from 'zod';

/**
 * The social URLs are only length-checked here. Whether they are actually
 * http(s) is decided in the service, so that the same rule applies however a
 * creator is written — and so the error names the field rather than saying
 * "invalid url" about a body with four of them.
 */
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const creatorBodySchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().max(160).optional(),
  handle: optionalText(80),
  role: optionalText(120),
  bio: optionalText(1000),
  portrait_media_id: z.number().int().positive().nullable().optional(),
  instagram_url: optionalText(500),
  youtube_url: optionalText(500),
  tiktok_url: optionalText(500),
  website_url: optionalText(500),
  is_active: z.boolean().optional(),
  is_identity_public: z.boolean().optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
});

export const creatorUpdateSchema = creatorBodySchema.partial();

export const creatorIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const creatorListQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(120).optional(),
});
