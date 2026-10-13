import { z } from 'zod';
import { regionCode, shopPostalCode } from '../../platform/geo/postalCodes';

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const pincodeParamSchema = z.object({
  pincode: shopPostalCode(),
});

export const createRateSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  zone: z.enum(['local', 'regional', 'metro', 'rest_of_india', 'special', 'all']).default('all'),
  // A rate for one shipping zone; omitted, the rate follows `zone` ('all': everywhere no zone covers).
  zone_id: z.coerce.number().int().positive().nullish(),
  method: z.enum(['standard', 'express', 'pickup']).default('standard'),
  // 'carrier': priced by the courier's live quote for each parcel, with
  // `rate` as the fallback when it cannot answer.
  rate_type: z.enum(['flat', 'carrier']).default('flat'),
  carrier_id: z.coerce.number().int().positive().nullish(),
  carrier_markup_percent: z.coerce.number().min(0).max(500).default(0),
  carrier_markup_amount: z.coerce.number().min(0).default(0),
  min_order_amount: z.coerce.number().min(0).default(0),
  max_order_amount: z.coerce.number().min(0).nullish(),
  min_weight_grams: z.coerce.number().int().min(0).default(0),
  max_weight_grams: z.coerce.number().int().min(0).nullish(),
  rate: z.coerce.number().min(0, 'Rate cannot be negative.'),
  free_above_amount: z.coerce.number().min(0).nullish(),
  eta_min_days: z.coerce.number().int().min(1).max(30).default(3),
  eta_max_days: z.coerce.number().int().min(1).max(60).default(7),
  is_active: z.boolean().default(true),
  priority: z.coerce.number().int().min(0).max(999).default(0),
});

export const updateRateSchema = createRateSchema.partial();

export const updateCarrierSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  tracking_url_template: z.string().trim().max(500).nullish(),
  supports_cod: z.boolean().optional(),
  supports_reverse_pickup: z.boolean().optional(),
  is_active: z.boolean().optional(),
  priority: z.coerce.number().int().min(0).max(999).optional(),
});

export const updateCodRuleSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  is_active: z.boolean().optional(),
  min_order_amount: z.coerce.number().min(0).optional(),
  max_order_amount: z.coerce.number().min(0).nullish(),
  cod_fee: z.coerce.number().min(0).optional(),
  prepaid_discount_amount: z.coerce.number().min(0).optional(),
  prepaid_discount_percent: z.coerce.number().min(0).max(100).optional(),
  requires_otp_confirmation: z.boolean().optional(),
  max_open_cod_orders: z.coerce.number().int().min(1).max(10).optional(),
  block_if_rto_count_gte: z.coerce.number().int().min(1).max(10).nullish(),
  priority: z.coerce.number().int().min(0).max(999).optional(),
});

export const upsertPincodeSchema = z.object({
  pincode: shopPostalCode(),
  city: z.string().trim().max(80).nullish(),
  district: z.string().trim().max(80).nullish(),
  state: z.string().trim().max(80).nullish(),
  state_code: regionCode().nullish(),
  zone: z.enum(['local', 'regional', 'metro', 'rest_of_india', 'special']).default('rest_of_india'),
  is_serviceable: z.boolean().default(true),
  prepaid_available: z.boolean().default(true),
  cod_available: z.boolean().default(true),
  express_available: z.boolean().default(false),
  standard_eta_min_days: z.coerce.number().int().min(1).max(30).default(3),
  standard_eta_max_days: z.coerce.number().int().min(1).max(60).default(7),
  express_eta_days: z.coerce.number().int().min(1).max(14).nullish(),
  default_carrier_id: z.coerce.number().int().positive().nullish(),
  notes: z.string().trim().max(255).nullish(),
});

const zoneArea = z.object({
  // Two-letter country; omitted, the store's own. Abroad a country alone is a place.
  country: z.string().trim().length(2).nullish(),
  // A state or province, by code or name.
  region: z.string().trim().min(1).max(80).nullish(),
  // The start of a postcode: "941", "SW1A", "560".
  postal_prefix: z.string().trim().max(16).nullish(),
});

export const createZoneSchema = z.object({
  name: z.string().trim().min(1, 'Name the zone.').max(120),
  is_active: z.boolean().default(true),
  areas: z.array(zoneArea).min(1, 'A zone needs at least one place.').max(500),
});

export const updateZoneSchema = createZoneSchema.partial();

export const quotePreviewSchema = z.object({
  country: z.string().trim().length(2).nullish(),
  postal_code: z.string().trim().max(16).nullish(),
  region: z.string().trim().max(80).nullish(),
  subtotal: z.coerce.number().min(0).max(100_000_000),
  weight_grams: z.coerce.number().int().min(0).max(10_000_000).default(0),
});
