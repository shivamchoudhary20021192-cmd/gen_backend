import { z } from 'zod';

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const transactionsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  status: z.enum(['created', 'pending', 'authorized', 'captured', 'failed', 'cancelled', 'refunded', 'partially_refunded']).optional(),
  gateway: z.string().trim().optional(),
  method: z.string().trim().optional(),
  search: z.string().trim().optional(),
});

export const updatePaymentSettingsSchema = z.object({
  gateway: z.string().trim().min(1).optional(),
  cod_enabled: z.boolean().optional(),
  capture_mode: z.enum(['automatic', 'manual']).optional(),
  razorpay_key_id: z.string().trim().optional(),
  razorpay_key_secret: z.string().trim().optional(),
  razorpay_webhook_secret: z.string().trim().optional(),
  test_mode: z.boolean().optional(),
  enabled_methods: z.array(z.string()).optional(),
});
