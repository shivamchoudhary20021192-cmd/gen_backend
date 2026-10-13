import { z } from 'zod';
import { passwordSchema } from '../auth/auth.schemas';

export const listAdminsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.enum(['invited', 'active', 'suspended', 'disabled']).optional(),
  role_id: z.coerce.number().int().positive().optional(),
  sort: z.string().max(60).optional(),
  include_deleted: z.coerce.boolean().optional(),
});

export const createAdminSchema = z.object({
  admin_user: z.object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(191),
    // Omit to create an 'invited' account with no password yet.
    password: passwordSchema.optional(),
    first_name: z.string().trim().min(1, 'First name is required.').max(80),
    last_name: z.string().trim().max(80).nullish(),
    phone: z.string().trim().max(20).nullish(),
    job_title: z.string().trim().max(120).nullish(),
    // Omitted: the store's own timezone.
    timezone: z.string().trim().max(64).optional(),
    role_ids: z.array(z.coerce.number().int().positive()).default([]),
    is_super_admin: z.boolean().default(false),
    must_change_password: z.boolean().default(true),
  }),
});

export const updateAdminSchema = z.object({
  admin_user: z
    .object({
      email: z.string().trim().toLowerCase().email().max(191).optional(),
      first_name: z.string().trim().min(1).max(80).optional(),
      last_name: z.string().trim().max(80).nullish(),
      phone: z.string().trim().max(20).nullish(),
      job_title: z.string().trim().max(120).nullish(),
      timezone: z.string().trim().max(64).optional(),
      avatar_media_id: z.coerce.number().int().positive().nullish(),
      is_super_admin: z.boolean().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update.'),
});

export const setRolesSchema = z.object({
  role_ids: z.array(z.coerce.number().int().positive()).max(10),
});

export const resetPasswordSchema = z.object({
  new_password: passwordSchema,
  must_change_password: z.boolean().default(true),
  revoke_sessions: z.boolean().default(true),
});

export const createRoleSchema = z.object({
  role: z.object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_-]+$/, 'Slug may contain lowercase letters, numbers, hyphens and underscores only.')
      .min(2)
      .max(50),
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(255).nullish(),
    level: z.coerce.number().int().min(1).max(999).default(100),
    permission_ids: z.array(z.coerce.number().int().positive()).default([]),
  }),
});

export const updateRoleSchema = z.object({
  role: z.object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(255).nullish(),
    level: z.coerce.number().int().min(1).max(999).optional(),
    permission_ids: z.array(z.coerce.number().int().positive()).optional(),
  }),
});
