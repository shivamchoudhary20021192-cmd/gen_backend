import { z } from 'zod';

export const listMediaQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  folder_id: z.coerce.number().int().positive().optional(),
  media_type: z.enum(['image', 'video', 'audio', 'document', 'other']).optional(),
  status: z.enum(['uploading', 'processing', 'ready', 'failed', 'quarantined']).optional(),
  unused: z.coerce.boolean().optional(),
  sort: z.string().max(60).optional(),
});

export const uploadBodySchema = z.object({
  folder_id: z.coerce.number().int().positive().optional(),
  alt_text: z.string().trim().max(255).optional(),
});

export const updateMediaSchema = z.object({
  media: z
    .object({
      alt_text: z.string().trim().max(255).nullish(),
      title: z.string().trim().max(255).nullish(),
      caption: z.string().trim().max(500).nullish(),
      credit: z.string().trim().max(255).nullish(),
      folder_id: z.coerce.number().int().positive().nullish(),
      usage_rights: z.enum(['owned', 'licensed', 'ugc_permissioned', 'stock', 'unknown']).optional(),
      // Normalised 0–1 coordinates; drives object-position on every crop.
      focal_x: z.coerce.number().min(0).max(1).optional(),
      focal_y: z.coerce.number().min(0).max(1).optional(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update.'),
});

export const createFolderSchema = z.object({
  folder: z.object({
    name: z.string().trim().min(1).max(120),
    parent_id: z.coerce.number().int().positive().nullish(),
  }),
});
