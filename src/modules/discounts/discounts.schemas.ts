import { z } from 'zod';

const money = z.coerce.number().min(0).max(9999999.99);

const discountCore = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]+$/, 'Use letters, numbers, hyphens and underscores only.')
    .min(3)
    .max(60),
  title: z.string().trim().max(191).nullish(),
  description: z.string().trim().max(500).nullish(),
  discount_type: z
    .enum(['percentage', 'fixed_amount', 'free_shipping', 'buy_x_get_y', 'free_gift'])
    .default('percentage'),
  value: money.default(0),
  max_discount_amount: money.nullish(),
  min_order_amount: money.default(0),
  min_quantity: z.coerce.number().int().min(0).max(1000).default(0),
  applies_to: z.enum(['all', 'products', 'categories', 'collections']).default('all'),
  customer_eligibility: z.enum(['all', 'new_customers', 'returning', 'specific']).default('all'),
  // Buy X get Y: buy `buy_quantity` qualifying items, get `get_quantity` at
  // `value`% off (0 or 100: free) — the cheapest qualifying ones, or a named
  // `get_variant_id`.
  buy_quantity: z.coerce.number().int().min(1).max(100).nullish(),
  get_quantity: z.coerce.number().int().min(1).max(100).nullish(),
  get_variant_id: z.coerce.number().int().positive().nullish(),
  // Free gift: the variant added at no charge, and whether it comes out of stock.
  gift_variant_id: z.coerce.number().int().positive().nullish(),
  gift_reserves_inventory: z.boolean().optional(),
  usage_limit_total: z.coerce.number().int().positive().nullish(),
  usage_limit_per_customer: z.coerce.number().int().min(1).max(1000).default(1),
  is_stackable: z.boolean().default(false),
  /** Automatic discounts need no code at checkout, like Shopify's. */
  is_automatic: z.boolean().default(false),
  is_visible: z.boolean().default(false),
  priority: z.coerce.number().int().min(0).max(9999).default(100),
  starts_at: z.string().datetime().nullish(),
  ends_at: z.string().datetime().nullish(),
  is_active: z.boolean().default(true),
  product_ids: z.array(z.coerce.number().int().positive()).max(500).optional(),
  collection_ids: z.array(z.coerce.number().int().positive()).max(100).optional(),
  category_ids: z.array(z.coerce.number().int().positive()).max(100).optional(),
});

/**
 * The cross-field rules the API would otherwise only discover at the database
 * or, worse, at checkout: a 150% discount, a window that ends before it starts,
 * or a "specific products" discount that names none.
 */
function refineDiscount<T extends z.ZodTypeAny>(schema: T) {
  return schema
    .superRefine((data: z.infer<typeof discountCore>, ctx: z.RefinementCtx) => {
      if (data.discount_type === 'percentage' && data.value !== undefined && data.value > 100) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'A percentage discount cannot exceed 100.',
        });
      }
      if (data.discount_type === 'free_gift' && data.gift_variant_id == null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['gift_variant_id'], message: 'Choose the product to give away.' });
      }
      if (data.discount_type === 'buy_x_get_y' && (data.buy_quantity == null || data.get_quantity == null)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['buy_quantity'], message: 'Say how many to buy and how many they get.' });
      }
      if (
        data.discount_type !== 'free_shipping' &&
        data.discount_type !== 'free_gift' &&
        data.discount_type !== 'buy_x_get_y' &&
        data.value !== undefined &&
        data.value <= 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['value'],
          message: 'Enter a discount amount greater than zero.',
        });
      }
      if (data.starts_at && data.ends_at && new Date(data.ends_at) <= new Date(data.starts_at)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ends_at'],
          message: 'The end date must be after the start date.',
        });
      }
      if (data.applies_to === 'products' && data.product_ids && data.product_ids.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['product_ids'],
          message: 'Choose at least one product, or set this to apply to all products.',
        });
      }
    });
}

export const createDiscountSchema = z.object({
  discount: refineDiscount(discountCore),
});

export const updateDiscountSchema = z.object({
  discount: refineDiscount(discountCore.partial()),
});

export const listDiscountsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  discount_type: z.enum(['percentage', 'fixed_amount', 'free_shipping', 'buy_x_get_y', 'free_gift']).optional(),
  is_automatic: z.coerce.boolean().optional(),
  state: z.enum(['active', 'scheduled', 'expired', 'disabled']).optional(),
  sort: z.string().max(60).optional(),
});

export const setProductsSchema = z.object({
  product_ids: z.array(z.coerce.number().int().positive()).max(500),
});

export const setProductDiscountsSchema = z.object({
  discount_ids: z.array(z.coerce.number().int().positive()).max(50),
});
