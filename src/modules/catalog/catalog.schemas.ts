import { z } from 'zod';
import { SORTS } from './catalog.repository';
import { MAX_MEDIA, MAX_PRICE, MAX_TAGS, UNIT_PRICE_UNITS } from './catalog.service';
import { OWNER_TYPES } from './customData.service';
import { REFERENCE_KINDS } from './fieldTypes';
import { MAX_OPTIONS, MAX_VARIANTS, OPTION_NAME_MAX, VALUE_NAME_MAX } from './options';

/**
 * Shapes only: types, lengths and enums. What depends on the shop — handles,
 * SKUs, categories, field definitions and their validations — is checked by
 * the services, which answer with field paths the editor can put under the
 * right input.
 */

const id = z.coerce.number().int().positive();
const status = z.enum(['draft', 'active', 'unlisted', 'archived']);
const amount = z.coerce.number().min(0).max(MAX_PRICE);
const text = (max: number) => z.string().max(max);
const unit = z.enum(Object.keys(UNIT_PRICE_UNITS) as [string, ...string[]]);

const metafieldSchema = z.object({
  namespace: z.string().trim().min(1).max(64),
  key: z.string().trim().min(1).max(64),
  value: z.unknown(),
  type: z.string().max(64).optional(),
});

const optionValueSchema = z.object({
  id: id.nullish(),
  name: z.string().trim().min(1).max(VALUE_NAME_MAX),
  swatch_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour like #1a2b3c.').nullish(),
  swatch_media_id: id.nullish(),
  linked_metaobject_id: id.nullish(),
});

const optionSchema = z.object({
  id: id.nullish(),
  name: z.string().trim().min(1).max(OPTION_NAME_MAX),
  display_style: z.enum(['dropdown', 'buttons', 'swatches']).optional(),
  linked_metaobject_type: z.string().max(64).nullish(),
  values: z.array(optionValueSchema).max(MAX_VARIANTS),
});

const variantSchema = z.object({
  id: id.nullish(),
  option_values: z.array(z.string().max(VALUE_NAME_MAX)).max(MAX_OPTIONS).optional(),
  sku: text(64).nullish(),
  barcode: text(64).nullish(),
  price: amount.optional(),
  compare_at_price: amount.nullish(),
  cost: amount.nullish(),
  taxable: z.boolean().optional(),
  tax_class_id: id.nullish(),
  hsn_code: text(12).nullish(),
  inventory_tracked: z.boolean().optional(),
  inventory_policy: z.enum(['deny', 'continue']).optional(),
  requires_shipping: z.boolean().optional(),
  weight: z.coerce.number().min(0).max(9_999_999).nullish(),
  weight_unit: z.enum(['g', 'kg', 'oz', 'lb']).optional(),
  length: z.coerce.number().min(0).max(99_999_999).nullish(),
  width: z.coerce.number().min(0).max(99_999_999).nullish(),
  height: z.coerce.number().min(0).max(99_999_999).nullish(),
  dimension_unit: z.enum(['mm', 'cm', 'm', 'in']).optional(),
  origin_country: z.string().regex(/^[A-Za-z]{2}$/, 'A two-letter country code.').nullish(),
  hs_code: text(16).nullish(),
  unit_price: z
    .object({ quantity: z.coerce.number().positive().max(999_999), quantity_unit: unit, reference: z.coerce.number().positive().max(999_999), reference_unit: unit })
    .nullish(),
  media_id: id.nullish(),
  max_per_order: z.coerce.number().int().min(1).max(10_000).nullish(),
  inventory: z.array(z.object({ location_id: id, on_hand: z.coerce.number().int().min(-999_999).max(9_999_999) })).max(100).optional(),
  metafields: z.array(metafieldSchema).max(256).optional(),
});

const productSchema = z.object({
  version: z.coerce.number().int().min(0).optional(),
  title: text(255).optional(),
  handle: text(191).optional(),
  description_html: z.string().max(512_000).nullish(),
  summary: text(500).nullish(),
  status: status.optional(),
  vendor: text(255).nullish(),
  product_type: text(255).nullish(),
  category_code: text(191).nullish(),
  template_suffix: text(60).nullish(),
  seo: z.object({ title: text(255).nullish(), description: text(320).nullish() }).optional(),
  is_gift_card: z.boolean().optional(),
  options: z.array(optionSchema).max(MAX_OPTIONS).optional(),
  variants: z.array(variantSchema).max(MAX_VARIANTS).optional(),
  media: z.array(z.object({ media_id: id, alt: text(255).nullish() })).max(MAX_MEDIA).optional(),
  tags: z.array(text(255)).max(MAX_TAGS * 2).optional(),
  collection_ids: z.array(id).max(500).optional(),
  metafields: z.array(metafieldSchema).max(256).optional(),
});

export const productBodySchema = z.object({ product: productSchema });
export const idParamSchema = z.object({ id });

export const listQuerySchema = z.object({
  status: status.optional(),
  q: z.string().max(200).optional(),
  vendor: z.string().max(255).optional(),
  product_type: z.string().max(255).optional(),
  tag: z.string().max(255).optional(),
  category: z.string().max(191).optional(),
  collection_id: id.optional(),
  origin: z.enum(['native', 'classic']).optional(),
  sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS, ...(keyof typeof SORTS)[]]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  after: z.string().max(500).optional(),
});

export const duplicateSchema = z.object({ title: text(255).optional(), status: status.optional() });

export const variantsPatchSchema = z.object({
  version: z.coerce.number().int().min(0).optional(),
  variants: z.array(variantSchema.extend({ id })).min(1).max(MAX_VARIANTS),
});

export const bulkSchema = z
  .object({
    ids: z.array(id).min(1).max(250),
    action: z.enum(['set_status', 'add_tags', 'remove_tags', 'delete', 'set_vendor', 'set_product_type', 'set_category']),
    status: status.optional(),
    tags: z.array(text(255)).max(50).optional(),
    value: text(255).nullish(),
  })
  .refine((body) => body.action !== 'set_status' || body.status, { message: 'Choose a status.', path: ['status'] })
  .refine((body) => !['add_tags', 'remove_tags'].includes(body.action) || body.tags?.length, { message: 'Enter at least one tag.', path: ['tags'] });

export const suggestionsQuerySchema = z.object({
  field: z.enum(['vendor', 'product_type', 'tag']),
  q: z.string().max(100).default(''),
});

export const taxonomyQuerySchema = z.object({
  q: z.string().max(100).optional(),
  parent: z.string().max(191).optional(),
});

export const referencesParamSchema = z.object({
  kind: z.enum(Object.values(REFERENCE_KINDS) as [string, ...string[]]),
});

export const referencesQuerySchema = z.object({
  q: z.string().max(100).optional(),
  ids: z
    .string()
    .max(2000)
    .optional()
    .transform((raw) => (raw ? raw.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100) : undefined)),
  metaobject_type: z.string().max(64).optional(),
});

export const classicQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const adoptSchema = z.object({ ids: z.array(id).min(1).max(100) });

// ── custom fields ────────────────────────────────────────────────────────────

const ownerType = z.enum(OWNER_TYPES);

export const definitionsQuerySchema = z.object({ owner_type: ownerType.default('product') });

const definitionSchema = z.object({
  owner_type: ownerType.optional(),
  name: text(120).optional(),
  namespace: text(64).optional(),
  key: text(64).optional(),
  description: text(500).nullish(),
  type: text(64).optional(),
  validations: z.record(z.unknown()).nullish(),
  constraints: z.object({ product_types: z.array(text(255)).max(50).optional(), categories: z.array(text(191)).max(50).optional() }).nullish(),
  required: z.boolean().optional(),
  storefront: z.boolean().optional(),
  filterable: z.boolean().optional(),
  unique_values: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

export const definitionBodySchema = z.object({ definition: definitionSchema });
export const pinnedSchema = z.object({ owner_type: ownerType, ids: z.array(id).max(256) });

// ── metaobjects ──────────────────────────────────────────────────────────────

const metaobjectDefinitionSchema = z.object({
  type: text(64).optional(),
  name: text(120).optional(),
  description: text(500).nullish(),
  display_name_key: text(64).nullish(),
  fields: z
    .array(
      z.object({
        key: text(64).optional(),
        name: text(120),
        type: text(64),
        description: text(500).nullish(),
        required: z.boolean().optional(),
        validations: z.record(z.unknown()).nullish(),
      }),
    )
    .max(40)
    .optional(),
  publishable: z.boolean().optional(),
  translatable: z.boolean().optional(),
  storefront: z.boolean().optional(),
});

export const metaobjectDefinitionBodySchema = z.object({ definition: metaobjectDefinitionSchema });
export const typeParamSchema = z.object({ type: z.string().max(64) });
export const entryParamSchema = z.object({ type: z.string().max(64), id });
export const entriesQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  after: z.string().max(500).optional(),
});
export const entryBodySchema = z.object({
  entry: z.object({ handle: text(191).optional(), status: z.enum(['draft', 'active']).optional(), fields: z.record(z.unknown()).optional() }),
});
