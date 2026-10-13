import { z } from 'zod';

/**
 * Money arrives as a number and is written as a DECIMAL string. Two decimal
 * places, never negative, capped well below the column width.
 */
const money = z.coerce.number().min(0).max(9999999.99);

/**
 * Split into a plain object and a refined wrapper: `.refine()` produces a
 * ZodEffects, which has no `.partial()`. The PATCH schema needs the object.
 */
const variantObjectSchema = z.object({
  id: z.coerce.number().int().positive().optional(), // present = update existing
  sku: z.string().trim().min(1, 'SKU is required.').max(64),
  barcode: z.string().trim().max(64).nullish(),
  variant_title: z.string().trim().max(160).nullish(),
  net_quantity: z.string().trim().max(40).nullish(),
  /** "30 ml — about six weeks of nightly use": what the size means, in words. */
  size_description: z.string().trim().max(255).nullish(),
  volume_ml: z.coerce.number().min(0).max(999999).nullish(),
  weight_grams: z.coerce.number().int().min(0).max(1000000).nullish(),
  mrp: money,
  price: money,
  cost_price: money.nullish(),
  sale_starts_at: z.string().datetime().nullish(),
  sale_ends_at: z.string().datetime().nullish(),
  position: z.coerce.number().int().min(0).max(9999).optional(),
  is_default: z.boolean().optional(),
  track_inventory: z.boolean().optional(),
  allow_backorder: z.boolean().optional(),
  low_stock_threshold: z.coerce.number().int().min(0).max(10000).optional(),
  max_per_order: z.coerce.number().int().min(1).max(1000).optional(),
  image_media_id: z.coerce.number().int().positive().nullish(),
  inventory_quantity: z.coerce.number().int().min(0).max(1000000).optional(),
  /** Option values in the same order as `options`, e.g. ["30ml", "Shade 02"]. */
  option_values: z.array(z.string().trim().max(80)).max(3).optional(),
});

export const variantInputSchema = variantObjectSchema.refine((v) => v.price <= v.mrp, {
  message: 'Selling price cannot exceed MRP.',
  path: ['price'],
});

/**
 * A value is either a bare name or a shade.
 *
 * The string form is what a Size option needs and what the older screens send;
 * the object form carries what a colour needs — the descriptor under the name,
 * a badge, and a swatch. Accepting both means the shade work did not have to
 * break every existing caller.
 */
const optionValueInputSchema = z.union([
  z.string().trim().min(1).max(80),
  z.object({
    value: z.string().trim().min(1).max(80),
    descriptor: z.string().trim().max(160).nullish(),
    badge: z.string().trim().max(40).nullish(),
    description: z.string().trim().max(500).nullish(),
    swatch_hex: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour, like #C77B6A.')
      .nullish(),
    swatch_media_id: z.coerce.number().int().positive().nullish(),
    is_active: z.boolean().optional(),
  }),
]);

export const optionInputSchema = z.object({
  name: z.string().trim().min(1).max(50),
  display_type: z.enum(['dropdown', 'pill', 'swatch']).default('pill'),
  values: z.array(optionValueInputSchema).min(1).max(50),
});

const imageInputSchema = z.object({
  media_id: z.coerce.number().int().positive(),
  alt: z.string().trim().max(255).nullish(),
  position: z.coerce.number().int().min(0).max(999).optional(),
  is_primary: z.boolean().optional(),
});

const productCoreSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required.').max(191),
  slug: z.string().trim().max(191).optional(),
  subtitle: z.string().trim().max(255).nullish(),
  category_id: z.coerce.number().int().positive().nullish(),
  brand_id: z.coerce.number().int().positive().nullish(),
  product_type: z.enum(['simple', 'variable', 'bundle', 'kit']).default('simple'),
  status: z.enum(['draft', 'in_review', 'active', 'archived']).default('draft'),
  visibility: z.enum(['public', 'hidden', 'search_only']).default('public'),
  // The Online Store template: null for the theme's default, or an alternate ("gift" → product.gift.json).
  template_suffix: z.string().trim().regex(/^[a-z0-9_-]{1,60}$/i, 'Use letters, numbers, dashes and underscores.').nullish(),

  short_description: z.string().trim().max(500).nullish(),
  description: z.string().max(100000).nullish(),
  description_json: z.string().max(100000).nullish(),
  
  // Texture & Sensory
  full_inci: z.string().max(20000).nullish(),
  texture: z.string().trim().max(255).nullish(),
  scent: z.string().trim().max(120).nullish(),
  fragrance_disclosure: z.string().trim().max(255).nullish(),
  texture_description: z.string().trim().max(500).nullish(),
  color_description: z.string().trim().max(255).nullish(),
  absorption_rate: z.enum(['instant', 'fast', 'medium', 'slow']).nullish(),
  feel_on_skin: z.string().trim().max(255).nullish(),
  
  // Product Attributes (JSON fields)
  suitability_note: z.string().max(5000).nullish(),
  // NOTE: `benefits` is declared further down as a structured array
  // ({ benefit, detail, benefit_kind }), which is the shape the repository
  // writes. A flat string[] used to be declared here too and was silently
  // overwritten by it.
  skin_types: z.array(z.string().trim().max(50)).max(20).nullish(),
  skin_concerns: z.array(z.string().trim().max(100)).max(20).nullish(),
  finish: z.string().trim().max(50).nullish(),
  coverage: z.enum(['sheer', 'light', 'medium', 'full', 'buildable']).nullish(),
  shade_family: z.string().trim().max(100).nullish(),
  
  // Safety & Warnings
  contraindications: z.string().max(5000).nullish(),
  patch_test_note: z.string().trim().max(500).nullish(),
  
  // Routine & Timing
  routine_position: z.enum(['cleanse', 'treat', 'hydrate', 'protect', 'mask', 'none']).default('none'),
  time_of_day: z.enum(['AM', 'PM', 'BOTH']).default('BOTH'),
  
  // Ingredients & Formulation (JSON fields)
  key_ingredients: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(255),
        percentage: z.string().trim().max(20).nullish(),
        purpose: z.string().trim().max(255).nullish(),
      })
    )
    .max(30)
    .nullish(),
  ingredient_highlights: z.string().trim().max(500).nullish(),
  free_from: z.array(z.string().trim().max(100)).max(30).nullish(),
  formulation_type: z.string().trim().max(80).nullish(),
  ph_level: z.string().trim().max(20).nullish(),
  
  // Certifications & Claims (JSON fields)
  certifications: z
    .array(
      z.object({
        type: z.string().trim().min(1).max(100),
        authority: z.string().trim().max(100).nullish(),
        year: z.coerce.number().int().min(1900).max(2100).nullish(),
      })
    )
    .max(20)
    .nullish(),
  claims: z.array(z.string().trim().max(150)).max(20).nullish(),
  is_hypoallergenic: z.boolean().optional(),
  is_non_comedogenic: z.boolean().optional(),
  pregnancy_safe: z.enum(['safe', 'consult_doctor', 'not_recommended']).nullish(),

  // Mandatory label declarations (BRD §14). Optional at draft, enforced on publish.
  manufacturer_name: z.string().trim().max(255).nullish(),
  manufacturer_address: z.string().trim().max(500).nullish(),
  marketed_by_name: z.string().trim().max(255).nullish(),
  marketed_by_address: z.string().trim().max(500).nullish(),
  manufacturing_licence_no: z.string().trim().max(80).nullish(),
  country_of_origin: z.string().trim().max(80).default('India'),
  customer_care_contact: z.string().trim().max(255).nullish(),
  shelf_life_months: z.coerce.number().int().min(0).max(600).nullish(),
  pao_months: z.coerce.number().int().min(0).max(120).nullish(),
  storage_instructions: z.string().trim().max(500).nullish(),
  disposal_instructions: z.string().trim().max(500).nullish(),
  
  // Usage Instructions
  usage_instructions: z.string().max(10000).nullish(),
  application_method: z.string().trim().max(255).nullish(),
  usage_frequency: z.string().trim().max(100).nullish(),
  best_used_with: z.array(z.coerce.number().int().positive()).max(20).nullish(),
  
  // Performance & Results
  results_timeline: z.string().trim().max(150).nullish(),
  clinical_study_summary: z.string().max(10000).nullish(),
  has_before_after_study: z.boolean().optional(),
  
  // Packaging & Sustainability
  packaging_type: z.string().trim().max(100).nullish(),
  packaging_material: z.string().trim().max(255).nullish(),
  is_recyclable: z.boolean().optional(),
  is_refillable: z.boolean().optional(),
  is_eco_friendly: z.boolean().optional(),
  is_carbon_neutral: z.boolean().optional(),
  
  // Size & Classification
  size_category: z.enum(['sample', 'travel', 'standard', 'deluxe', 'professional', 'value']).nullish(),
  is_professional_use: z.boolean().optional(),
  requires_training: z.boolean().optional(),
  
  // Geographical & Regulatory
  regulatory_approvals: z.array(z.string().trim().max(255)).max(50).nullish(),
  restricted_regions: z.array(z.string().trim().max(100)).max(100).nullish(),
  
  // Awards & Recognition (JSON fields)
  awards: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(255),
        authority: z.string().trim().max(255).nullish(),
        year: z.coerce.number().int().min(1900).max(2100).nullish(),
      })
    )
    .max(50)
    .nullish(),
  press_features: z
    .array(
      z.object({
        publication: z.string().trim().min(1).max(255),
        title: z.string().trim().max(500).nullish(),
        date: z.string().nullish(),
        url: z.string().trim().url().max(500).nullish(),
      })
    )
    .max(100)
    .nullish(),
  
  // Target Demographics
  age_range: z.string().trim().max(50).nullish(),
  gender_target: z.enum(['unisex', 'female', 'male', 'non_binary']).default('unisex'),
  
  // Seasonal & Trends
  is_seasonal: z.boolean().optional(),
  season: z.enum(['spring', 'summer', 'fall', 'winter', 'all_year']).nullish(),
  is_limited_edition: z.boolean().optional(),
  
  // Sample Products
  is_sample: z.boolean().optional(),
  sample_of_product_id: z.coerce.number().int().positive().nullish(),
  
  // Video Content
  tutorial_video_url: z.string().trim().url().max(500).nullish(),
  demo_video_url: z.string().trim().url().max(500).nullish(),

  is_new: z.boolean().optional(),
  is_bestseller: z.boolean().optional(),
  /** A gift card product: each variant's price is a denomination. */
  is_gift_card: z.boolean().optional(),
  badge: z.string().trim().max(60).nullish(),
  /**
   * When a hand-written badge stops being shown.
   *
   * Accepted as a plain date from the form as well as a full timestamp — a
   * merchandiser picks "ends on 30 November", not an instant.
   */
  badge_expires_at: z.coerce.date().nullish(),
  tax_class_id: z.coerce.number().int().positive().nullish(),
  sort_order: z.coerce.number().int().min(0).max(9999).optional(),

  options: z.array(optionInputSchema).max(3).optional(),
  variants: z.array(variantInputSchema).min(1, 'A product needs at least one variant.').max(100),
  images: z.array(imageInputSchema).max(30).optional(),
  benefits: z
    .array(
      z.object({
        benefit: z.string().trim().min(1).max(255),
        detail: z.string().max(2000).nullish(),
        benefit_kind: z.enum(['immediate', 'long_term', 'sensorial']).optional(),
      }),
    )
    .max(20)
    .optional(),
  usage_steps: z
    .array(
      z.object({
        instruction: z.string().trim().min(1).max(500),
        time_of_day: z.enum(['AM', 'PM', 'BOTH']).optional(),
        frequency: z.string().trim().max(80).nullish(),
        amount: z.string().trim().max(80).nullish(),
      }),
    )
    .max(20)
    .optional(),
  skin_type_ids: z.array(z.coerce.number().int().positive()).max(20).optional(),
  concern_ids: z.array(z.coerce.number().int().positive()).max(20).optional(),
  ingredients: z
    .array(
      z.object({
        ingredient_id: z.coerce.number().int().positive(),
        role: z.string().trim().max(191).nullish(),
        concentration: z.string().trim().max(20).nullish(),
        is_key: z.boolean().optional(),
      }),
    )
    .max(60)
    .optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  collection_ids: z.array(z.coerce.number().int().positive()).max(50).optional(),
  seo: z
    .object({
      meta_title: z.string().trim().max(200).nullish(),
      meta_description: z.string().trim().max(320).nullish(),
      canonical_url: z.string().trim().url().max(500).nullish(),
      robots_index: z.boolean().optional(),
    })
    .optional(),
});

export const createProductSchema = z.object({ product: productCoreSchema });

/** Update accepts the same shape, all optional, and `variants` may be omitted. */
export const updateProductSchema = z.object({
  product: productCoreSchema.partial().refine(
    (d) => Object.keys(d).length > 0,
    'Provide at least one field to update.',
  ),
});

export const listProductsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.enum(['draft', 'in_review', 'active', 'archived']).optional(),
  category_id: z.coerce.number().int().positive().optional(),
  collection_id: z.coerce.number().int().positive().optional(),
  concern: z.string().trim().max(60).optional(),
  skin_type: z.string().trim().max(60).optional(),
  tag: z.string().trim().max(60).optional(),
  in_stock: z.coerce.boolean().optional(),
  include_archived: z.coerce.boolean().optional(),
  ids: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map(Number).filter(Number.isInteger) : undefined)),
  sort: z.string().max(60).optional(),
  fields: z.string().max(500).optional(),
  
  // New cosmetic filters
  benefit: z.string().trim().max(100).optional(),
  skin_concern: z.string().trim().max(100).optional(),
  finish: z.string().trim().max(50).optional(),
  coverage: z.enum(['sheer', 'light', 'medium', 'full', 'buildable']).optional(),
  formulation_type: z.string().trim().max(80).optional(),
  is_hypoallergenic: z.coerce.boolean().optional(),
  is_non_comedogenic: z.coerce.boolean().optional(),
  is_eco_friendly: z.coerce.boolean().optional(),
  is_refillable: z.coerce.boolean().optional(),
  is_vegan: z.coerce.boolean().optional(),
  is_cruelty_free: z.coerce.boolean().optional(),
  gender_target: z.enum(['unisex', 'female', 'male', 'non_binary']).optional(),
  is_seasonal: z.coerce.boolean().optional(),
  is_professional_use: z.coerce.boolean().optional(),
  is_sample: z.coerce.boolean().optional(),
});

export const bulkActionSchema = z
  .object({
    ids: z.array(z.coerce.number().int().positive()).min(1).max(500),
    action: z.enum(['publish', 'unpublish', 'archive', 'delete', 'set_category']),
    category_id: z.coerce.number().int().positive().nullish(),
  })
  .refine((d) => d.action !== 'set_category' || d.category_id !== undefined, {
    message: 'category_id is required for set_category.',
    path: ['category_id'],
  });

export const attachImagesSchema = z.object({
  images: z.array(imageInputSchema).min(1).max(30),
});

export const reorderImagesSchema = z.object({
  media_ids: z.array(z.coerce.number().int().positive()).min(1).max(30),
});

export const productIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const variantParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  variantId: z.coerce.number().int().positive(),
});

export const imageParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  mediaId: z.coerce.number().int().positive(),
});

export const createVariantSchema = z.object({ variant: variantInputSchema });
export const updateVariantSchema = z.object({
  variant: variantObjectSchema
    .partial()
    .refine((d: Record<string, unknown>) => Object.keys(d).length > 0, 'Provide at least one field.'),
});

/** Photographs for one shade, replaced as a set. */
export const shadeImagesSchema = z.object({
  media_ids: z.array(z.coerce.number().int().positive()).max(20),
});

export const shadeImagesParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  optionValueId: z.coerce.number().int().positive(),
});
