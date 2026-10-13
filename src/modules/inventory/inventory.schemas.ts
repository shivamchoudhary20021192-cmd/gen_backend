import { z } from 'zod';
import { countryCode, regionCode, shopPostalCode } from '../../platform/geo/postalCodes';

// ── Query schemas ────────────────────────────────────────────────────────────

export const listStockQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  location_id: z.coerce.number().int().positive().optional(),
  // 'untracked' is a real state, not an absence of one: a variant with
  // track_inventory = 0 is neither in stock nor out of it, and it has to be
  // filterable or those rows are unreachable from the UI.
  stock_status: z.enum(['all', 'in_stock', 'low', 'out_of_stock', 'untracked']).optional(),
  product_status: z.enum(['draft', 'active', 'archived']).optional(),
  sort: z.string().max(60).optional(),
});

export const movementsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  variant_id: z.coerce.number().int().positive().optional(),
  location_id: z.coerce.number().int().positive().optional(),
  movement_type: z
    .enum([
      'purchase_receipt',
      'sale',
      'cancellation',
      'return_restock',
      'adjustment',
      'damage',
      'expiry',
      'transfer_in',
      'transfer_out',
      'reservation_hold',
      'reservation_release',
      'stock_take',
      'rto_restock',
    ])
    .optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
    .optional(),
});

// ── Param schemas ────────────────────────────────────────────────────────────

export const variantIdParamSchema = z.object({
  variantId: z.coerce.number().int().positive(),
});

export const locationIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// ── Body schemas ─────────────────────────────────────────────────────────────

export const adjustSchema = z.object({
  quantity_delta: z.number().int().refine((n) => n !== 0, { message: 'Delta cannot be zero.' }),
  location_id: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().min(3, 'Give a reason for the adjustment.').max(255),
});

export const setStockSchema = z.object({
  quantity: z.number().int().min(0, 'Stock cannot be negative.'),
  location_id: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().min(3, 'Give a reason for the stock set.').max(255),
});

export const bulkAdjustSchema = z.object({
  items: z
    .array(
      z.object({
        variant_id: z.coerce.number().int().positive(),
        location_id: z.coerce.number().int().positive().optional(),
        quantity_delta: z.number().int().refine((n) => n !== 0, { message: 'Delta cannot be zero.' }),
      }),
    )
    .min(1, 'Provide at least one item.')
    .max(200, 'Maximum 200 items per batch.'),
  reason: z.string().trim().min(3, 'Give a reason.').max(255),
});

// ── Location schemas ─────────────────────────────────────────────────────────

export const createLocationSchema = z.object({
  location: z.object({
    code: z
      .string()
      .trim()
      .min(1, 'Code is required.')
      .max(40)
      .transform((v) => v.toUpperCase()),
    name: z.string().trim().min(1, 'Name is required.').max(120),
    location_type: z.enum(['warehouse', 'store', '3pl', 'virtual']).optional(),
    line1: z.string().trim().max(255).nullish(),
    line2: z.string().trim().max(255).nullish(),
    city: z.string().trim().max(80).nullish(),
    state: z.string().trim().max(80).nullish(),
    state_code: z
      .string()
      .trim()
      .min(1)
      .max(10, 'Region code is at most 10 characters.')
      .nullish(),
    pincode: shopPostalCode().nullish(),
    country: countryCode(),
    gstin: z.string().trim().max(15).nullish(),
    contact_name: z.string().trim().max(120).nullish(),
    contact_phone: z.string().trim().max(20).nullish(),
    is_default: z.boolean().optional(),
    is_active: z.boolean().optional(),
    fulfils_online_orders: z.boolean().optional(),
    priority: z.coerce.number().int().min(0).max(999).optional(),
  }),
});

export const updateLocationSchema = z.object({
  location: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    location_type: z.enum(['warehouse', 'store', '3pl', 'virtual']).optional(),
    line1: z.string().trim().max(255).nullish(),
    line2: z.string().trim().max(255).nullish(),
    city: z.string().trim().max(80).nullish(),
    state: z.string().trim().max(80).nullish(),
    state_code: regionCode().nullish(),
    pincode: shopPostalCode().nullish(),
    country: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).optional(),
    gstin: z.string().trim().max(15).nullish(),
    contact_name: z.string().trim().max(120).nullish(),
    contact_phone: z.string().trim().max(20).nullish(),
    is_default: z.boolean().optional(),
    is_active: z.boolean().optional(),
    fulfils_online_orders: z.boolean().optional(),
    priority: z.coerce.number().int().min(0).max(999).optional(),
  }),
});
