import { randomUUID } from 'node:crypto';
import { ApiError, type FieldErrors } from '../../core/ApiError';
import { sanitizeMerchantHtml } from '../../core/merchantHtml';
import { slugify, uniqueSlug } from '../../core/slug';
import { execute, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { shopId } from '../../platform/tenancy/context';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { collectionsRepository } from '../collections/collections.repository';
import { inventoryRepository } from '../inventory/inventory.repository';
import { catalogRepository, mediaUrlOf, type CatalogStatus, type ListFilters, type VariantRow } from './catalog.repository';
import { appliesTo, customDataService, type MetafieldInput } from './customData.service';
import { DEFAULT_TITLE, optionsKey, planOptions, planVariants, skuPart, suggestSku, type OptionInput, type PlannedOption } from './options';
import { projection } from './projection';

/**
 * Products (new): the generic product, written the way Shopify's productSet
 * writes one — the admin sends the state it wants, and this works out what
 * changed.
 *
 *   • Options, values and variants keep their ids across saves: matched by id,
 *     then by name (options, values) or by combination (variants). Renaming
 *     "Colour" to "Color" or "Navy" to "Midnight" keeps every variant, its
 *     stock, its orders and its reviews.
 *   • A variant that is no longer sent is retired (soft-deleted), never
 *     removed: orders and returns still point at it.
 *   • A save names the version it edited; if someone else saved in between it
 *     is refused (409 VERSION_CONFLICT) rather than silently overwriting them.
 *   • Everything — the product, its options and variants, custom fields,
 *     stock, collections, the classic twin (projection.ts), the audit entry and
 *     so the products/create|update webhook — commits in one transaction.
 */

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface UnitPriceInput {
  quantity: number;
  quantity_unit: string;
  reference: number;
  reference_unit: string;
}

export interface VariantInput {
  id?: number | null;
  option_values?: string[];
  sku?: string | null;
  barcode?: string | null;
  price?: number;
  compare_at_price?: number | null;
  cost?: number | null;
  taxable?: boolean;
  tax_class_id?: number | null;
  hsn_code?: string | null;
  inventory_tracked?: boolean;
  inventory_policy?: 'deny' | 'continue';
  requires_shipping?: boolean;
  weight?: number | null;
  weight_unit?: 'g' | 'kg' | 'oz' | 'lb';
  length?: number | null;
  width?: number | null;
  height?: number | null;
  dimension_unit?: 'mm' | 'cm' | 'm' | 'in';
  origin_country?: string | null;
  hs_code?: string | null;
  unit_price?: UnitPriceInput | null;
  media_id?: number | null;
  max_per_order?: number | null;
  inventory?: { location_id: number; on_hand: number }[];
  metafields?: MetafieldInput[];
}

export interface ProductInput {
  version?: number;
  title?: string;
  handle?: string;
  description_html?: string | null;
  summary?: string | null;
  status?: CatalogStatus;
  vendor?: string | null;
  product_type?: string | null;
  category_code?: string | null;
  template_suffix?: string | null;
  seo?: { title?: string | null; description?: string | null };
  is_gift_card?: boolean;
  options?: OptionInput[];
  variants?: VariantInput[];
  media?: { media_id: number; alt?: string | null }[];
  tags?: string[];
  collection_ids?: number[];
  metafields?: MetafieldInput[];
}

export const MAX_TAGS = 250;
export const MAX_MEDIA = 250;
export const MAX_PRICE = 99_999_999.99;

/** Unit-price units and what they measure; the quantity and the reference must measure the same thing. */
export const UNIT_PRICE_UNITS: Record<string, 'volume' | 'weight' | 'length' | 'area' | 'count'> = {
  ml: 'volume', cl: 'volume', l: 'volume', m3: 'volume',
  mg: 'weight', g: 'weight', kg: 'weight',
  mm: 'length', cm: 'length', m: 'length',
  m2: 'area',
  item: 'count',
};

/** A variant's fields as the service keeps them between loading and writing. */
interface VariantState {
  sku: string | null;
  barcode: string | null;
  price: number;
  compare_at_price: number | null;
  cost: number | null;
  taxable: boolean;
  tax_class_id: number | null;
  hsn_code: string | null;
  inventory_tracked: boolean;
  inventory_policy: 'deny' | 'continue';
  requires_shipping: boolean;
  weight: number | null;
  weight_unit: 'g' | 'kg' | 'oz' | 'lb';
  length: number | null;
  width: number | null;
  height: number | null;
  dimension_unit: 'mm' | 'cm' | 'm' | 'in';
  origin_country: string | null;
  hs_code: string | null;
  unit_price: UnitPriceInput | null;
  media_id: number | null;
  max_per_order: number | null;
}

const VARIANT_DEFAULTS: VariantState = {
  sku: null,
  barcode: null,
  price: 0,
  compare_at_price: null,
  cost: null,
  taxable: true,
  tax_class_id: null,
  hsn_code: null,
  inventory_tracked: true,
  inventory_policy: 'deny',
  requires_shipping: true,
  weight: null,
  weight_unit: 'g',
  length: null,
  width: null,
  height: null,
  dimension_unit: 'cm',
  origin_country: null,
  hs_code: null,
  unit_price: null,
  media_id: null,
  max_per_order: null,
};

const num = (value: string | number | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));

function stateOf(row: VariantRow): VariantState {
  return {
    sku: row.sku,
    barcode: row.barcode,
    price: Number(row.price),
    compare_at_price: num(row.compare_at_price),
    cost: num(row.cost),
    taxable: Number(row.taxable) === 1,
    tax_class_id: num(row.tax_class_id),
    hsn_code: row.hsn_code,
    inventory_tracked: Number(row.inventory_tracked) === 1,
    inventory_policy: row.inventory_policy,
    requires_shipping: Number(row.requires_shipping) === 1,
    weight: num(row.weight),
    weight_unit: row.weight_unit,
    length: num(row.length),
    width: num(row.width),
    height: num(row.height),
    dimension_unit: row.dimension_unit,
    origin_country: row.origin_country,
    hs_code: row.hs_code,
    unit_price:
      row.unit_price_quantity !== null && row.unit_price_quantity_unit && row.unit_price_reference !== null && row.unit_price_reference_unit
        ? { quantity: Number(row.unit_price_quantity), quantity_unit: row.unit_price_quantity_unit, reference: Number(row.unit_price_reference), reference_unit: row.unit_price_reference_unit }
        : null,
    media_id: num(row.media_id),
    max_per_order: num(row.max_per_order),
  };
}

/** The given fields of a variant input over a base state: undefined keeps, null clears. */
function mergeVariant(base: VariantState, input: VariantInput): VariantState {
  const out = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(VARIANT_DEFAULTS)) {
    const value = (input as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = typeof value === 'string' ? value.trim() || null : value;
  }
  return out as unknown as VariantState;
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A product as the editor sees it: options, variants with stock per location, media, tags, collections, custom fields. */
async function loadProduct(id: number, exec: Executor = pool) {
  const product = await catalogRepository.productOrFail(id, exec);
  const [options, values, variants, variantOptions, media, tags, collections, metafields, locations] = await Promise.all([
    catalogRepository.options(id, exec),
    catalogRepository.values(id, exec),
    catalogRepository.variants(id, exec),
    catalogRepository.variantOptions(id, exec),
    catalogRepository.media(id, exec),
    catalogRepository.tags(id, exec),
    collectionsRepository.forProduct(id, exec),
    customDataService.valuesFor('product', [id], exec),
    catalogRepository.locations(exec),
  ]);
  const variantIds = variants.map((variant) => Number(variant.id));
  const [variantFields, stock] = await Promise.all([customDataService.valuesFor('variant', variantIds, exec), catalogRepository.stock(variantIds, exec)]);
  const valueName = new Map(values.map((value) => [Number(value.id), value.name]));

  return {
    id: Number(product.id),
    public_id: product.public_id,
    handle: product.handle,
    title: product.title,
    description_html: product.description_html ?? '',
    summary: product.summary,
    status: product.status,
    vendor: product.vendor,
    product_type: product.product_type,
    category: product.category_code ? { code: product.category_code, name: product.category_name, full_name: product.category_full_name } : null,
    template_suffix: product.template_suffix,
    seo: { title: product.seo_title, description: product.seo_description },
    is_gift_card: Number(product.is_gift_card) === 1,
    published_at: product.published_at ? new Date(product.published_at).toISOString() : null,
    origin: product.origin,
    version: Number(product.version),
    created_at: new Date(product.created_at).toISOString(),
    updated_at: new Date(product.updated_at).toISOString(),
    options: options.map((option) => ({
      id: Number(option.id),
      name: option.name,
      position: Number(option.position),
      display_style: option.display_style,
      linked_metaobject_type: option.linked_metaobject_type,
      values: values
        .filter((value) => Number(value.option_id) === Number(option.id))
        .map((value) => ({
          id: Number(value.id),
          name: value.name,
          position: Number(value.position),
          swatch_color: value.swatch_color,
          swatch_media_id: num(value.swatch_media_id),
          swatch_url: mediaUrlOf({ storage_key: value.swatch_key, absolute_url: value.swatch_url }),
          linked_metaobject_id: num(value.linked_metaobject_id),
        })),
    })),
    variants: variants.map((variant) => {
      const byOption = variantOptions.get(Number(variant.id)) ?? new Map<number, number>();
      const ids = options.map((option) => byOption.get(Number(option.id)) ?? null);
      const levels = stock.filter((row) => Number(row.variant_id) === Number(variant.id));
      return {
        id: Number(variant.id),
        public_id: variant.public_id,
        position: Number(variant.position),
        title: variant.title,
        option_values: ids.map((valueId) => (valueId ? (valueName.get(valueId) ?? '') : '')),
        option_value_ids: ids,
        ...stateOf(variant),
        inventory: {
          on_hand: levels.reduce((sum, row) => sum + Number(row.on_hand), 0),
          available: levels.reduce((sum, row) => sum + Number(row.available), 0),
          levels: locations.map((location) => {
            const level = levels.find((row) => Number(row.location_id) === Number(location.id));
            return {
              location_id: Number(location.id),
              location_name: location.name,
              on_hand: Number(level?.on_hand ?? 0),
              available: Number(level?.available ?? 0),
              reserved: Number(level?.reserved ?? 0),
              incoming: Number(level?.incoming ?? 0),
            };
          }),
        },
        metafields: variantFields.get(Number(variant.id)) ?? [],
      };
    }),
    media: media.map((row) => ({
      media_id: Number(row.media_id),
      position: Number(row.position),
      alt: row.alt,
      default_alt: row.default_alt,
      url: mediaUrlOf(row),
      media_type: row.media_type,
      width: num(row.width),
      height: num(row.height),
    })),
    tags,
    collections: collections.map((collection) => ({ id: Number(collection.id), title: collection.title, type: collection.collection_type, editable_here: collection.collection_type === 'manual' })),
    metafields: metafields.get(id) ?? [],
    locations: locations.map((location) => ({ id: Number(location.id), name: location.name, is_default: Number(location.is_default) === 1 })),
  };
}

export type CatalogProduct = Awaited<ReturnType<typeof loadProduct>>;

export const catalogService = {
  // ── reads ──────────────────────────────────────────────────────────────────

  async list(filters: ListFilters) {
    const [page, counts] = await Promise.all([catalogRepository.list(filters), filters.after ? Promise.resolve(null) : catalogRepository.statusCounts()]);
    return { ...page, counts };
  },

  get: loadProduct,

  // ── writes ─────────────────────────────────────────────────────────────────

  async create(input: ProductInput, actor: AuthenticatedAdmin, meta: ActorMeta) {
    return this.save(null, input, actor, meta);
  },

  async update(id: number, input: ProductInput, actor: AuthenticatedAdmin, meta: ActorMeta) {
    return this.save(id, input, actor, meta);
  },

  async save(id: number | null, input: ProductInput, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = id ? await this.get(id) : null;
    const errors: FieldErrors = {};
    const put = (path: string, message: string) => (errors[path] ??= []).push(message);

    // ── the product's own fields ─────────────────────────────────────────────
    const title = (input.title ?? existing?.title ?? '').trim();
    if (!title) put('title', 'Give the product a title.');
    else if (title.length > 255) put('title', 'At most 255 characters.');
    const status: CatalogStatus = input.status ?? existing?.status ?? 'draft';
    const productType = input.product_type !== undefined ? input.product_type?.trim() || null : (existing?.product_type ?? null);
    const categoryCode = input.category_code !== undefined ? input.category_code?.trim() || null : (existing?.category?.code ?? null);
    if (categoryCode && !(await catalogRepository.category(categoryCode))) put('category_code', 'Choose a category from the list.');
    if (input.template_suffix && !/^[a-z0-9_-]{1,60}$/.test(input.template_suffix)) put('template_suffix', 'Lower-case letters, digits, - and _.');
    const description = input.description_html !== undefined ? sanitizeMerchantHtml(input.description_html ?? '') : undefined;
    if (description && description.length > 512_000) put('description_html', 'The description is too long.');

    // ── options and variants ─────────────────────────────────────────────────
    let plan: { options: PlannedOption[]; variants: (VariantInput & { option_values: string[]; title: string; position: number })[] } | null = null;
    if (input.options !== undefined || input.variants !== undefined || !existing) {
      if (existing && (input.options === undefined || input.variants === undefined)) put('variants', 'Send the options and the variants together.');
      const planned = planOptions(input.options ?? []);
      const variantsIn = input.variants ?? [{ option_values: [] }];
      const variants = planVariants(planned.options, variantsIn);
      Object.assign(errors, planned.errors, variants.errors);
      plan = { options: planned.options, variants: variants.variants };
    }
    if (Object.keys(errors).length) throw ApiError.validation(errors);

    const handle = await uniqueSlug('products', input.handle ?? existing?.handle ?? title, id ?? undefined);

    // Media: the final gallery, checked before anything refers to it.
    const mediaIn = input.media ?? null;
    if (mediaIn) {
      const ids = [...new Set(mediaIn.map((item) => Number(item.media_id)))];
      if (ids.length > MAX_MEDIA) put('media', `At most ${MAX_MEDIA} files.`);
      const found = ids.length
        ? await query<RowDataPacket & { id: number }>(`SELECT id FROM media WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`, [shopId(), ...ids])
        : [];
      if (found.length !== ids.length) put('media', 'Some files no longer exist. Reload and try again.');
    }
    const galleryIds = new Set((mediaIn ?? existing?.media ?? []).map((item) => Number(item.media_id)));

    // Variant state: matched ones start from what they are, new ones from defaults.
    const states: VariantState[] = [];
    const matches: (number | null)[] = [];
    if (plan) {
      const live = existing?.variants ?? [];
      const byId = new Map(live.map((variant) => [variant.id, variant]));
      const byCombo = new Map(live.map((variant) => [variant.option_values.map((value) => value.toLowerCase()).join('\u0000'), variant]));
      const claimed = new Set<number>();
      for (const variant of plan.variants) {
        if (variant.id && byId.has(variant.id) && !claimed.has(variant.id)) {
          claimed.add(variant.id);
          matches.push(variant.id);
        } else matches.push(null);
      }
      for (const [index, variant] of plan.variants.entries()) {
        if (matches[index] !== null) continue;
        const candidate = byCombo.get(variant.option_values.map((value) => value.toLowerCase()).join('\u0000'));
        if (candidate && !claimed.has(candidate.id)) {
          claimed.add(candidate.id);
          matches[index] = candidate.id;
        }
      }
      for (const [index, variant] of plan.variants.entries()) {
        const matched = matches[index] !== null ? byId.get(matches[index]!) : null;
        const base: VariantState = matched ? { ...VARIANT_DEFAULTS, ...pickState(matched) } : { ...VARIANT_DEFAULTS, requires_shipping: !(input.is_gift_card ?? existing?.is_gift_card ?? false) };
        const state = mergeVariant(base, variant);
        const path = `variants.${index}`;
        if (state.price < 0 || state.price > MAX_PRICE) put(`${path}.price`, 'Enter a price between 0 and 99,999,999.99.');
        if (state.compare_at_price !== null && (state.compare_at_price < 0 || state.compare_at_price > MAX_PRICE)) put(`${path}.compare_at_price`, 'Enter an amount between 0 and 99,999,999.99.');
        if (state.cost !== null && (state.cost < 0 || state.cost > MAX_PRICE)) put(`${path}.cost`, 'Enter an amount between 0 and 99,999,999.99.');
        if (state.sku && (state.sku.length > 64 || /[\s]/.test(state.sku))) put(`${path}.sku`, 'At most 64 characters, no spaces.');
        if (state.sku?.startsWith('~')) put(`${path}.sku`, 'A SKU cannot start with ~.');
        if (state.media_id !== null && !galleryIds.has(state.media_id)) put(`${path}.media_id`, "Choose one of the product's own images.");
        if (state.unit_price) {
          const measures = [UNIT_PRICE_UNITS[state.unit_price.quantity_unit], UNIT_PRICE_UNITS[state.unit_price.reference_unit]];
          if (!measures[0] || !measures[1] || measures[0] !== measures[1]) put(`${path}.unit_price`, 'The pack size and the "per" amount must be in the same kind of unit (e.g. ml and l).');
        }
        state.price = money(state.price);
        if (state.compare_at_price !== null) state.compare_at_price = money(state.compare_at_price);
        if (state.cost !== null) state.cost = money(state.cost);
        states.push(state);
      }

      // SKUs: none twice in the product, none another product's; blanks get a readable one.
      const seen = new Map<string, number>();
      for (const [index, state] of states.entries()) {
        if (!state.sku) continue;
        const key = state.sku.toUpperCase();
        if (seen.has(key)) put(`variants.${index}.sku`, `${state.sku} is used by another variant of this product.`);
        seen.set(key, index);
      }
      const given = states.map((state) => state.sku).filter((sku): sku is string => Boolean(sku));
      if (given.length) {
        for (let start = 0; start < given.length; start += 500) {
          const chunk = given.slice(start, start + 500);
          const clashes = await query<RowDataPacket & { sku: string; product_id: number }>(
            `SELECT sku, product_id FROM product_variants WHERE shop_id = ? AND deleted_at IS NULL AND sku IN (${chunk.map(() => '?').join(', ')})${id ? ' AND product_id <> ?' : ''}`,
            [shopId(), ...chunk, ...(id ? [id] : [])],
          );
          for (const clash of clashes) {
            const index = seen.get(clash.sku.toUpperCase());
            if (index !== undefined) put(`variants.${index}.sku`, `${clash.sku} is already the SKU of another product.`);
          }
        }
      }
      if (states.some((state) => !state.sku)) {
        const prefix = skuPart(handle, 24) || 'SKU';
        const rows = await query<RowDataPacket & { sku: string }>('SELECT sku FROM product_variants WHERE shop_id = ? AND sku LIKE ?', [shopId(), `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`]);
        const taken = new Set([...rows.map((row) => row.sku.toUpperCase()), ...given.map((sku) => sku.toUpperCase())]);
        for (const [index, state] of states.entries()) if (!state.sku) state.sku = suggestSku(handle, plan.variants[index].option_values, taken);
      }

      // What variants point at: tax classes, stock locations, swatch images, metaobjects.
      const taxIds = [...new Set(states.map((state) => state.tax_class_id).filter((value): value is number => value !== null))];
      if (taxIds.length) {
        const found = await query<RowDataPacket & { id: number }>(`SELECT id FROM tax_classes WHERE shop_id = ? AND id IN (${taxIds.map(() => '?').join(', ')})`, [shopId(), ...taxIds]);
        const ok = new Set(found.map((row) => Number(row.id)));
        states.forEach((state, index) => state.tax_class_id !== null && !ok.has(state.tax_class_id) && put(`variants.${index}.tax_class_id`, 'Choose a tax class from the list.'));
      }
      const locationIds = [...new Set(plan.variants.flatMap((variant) => (variant.inventory ?? []).map((level) => Number(level.location_id))))];
      if (locationIds.length) {
        const found = await query<RowDataPacket & { id: number }>(`SELECT id FROM inventory_locations WHERE shop_id = ? AND id IN (${locationIds.map(() => '?').join(', ')})`, [shopId(), ...locationIds]);
        if (found.length !== locationIds.length) put('variants', 'A stock location no longer exists. Reload and try again.');
      }
      for (const [index, option] of plan.options.entries()) {
        if (option.linked_metaobject_type) {
          const type = await queryOne('SELECT id FROM metaobject_definitions WHERE shop_id = ? AND type = ?', [shopId(), option.linked_metaobject_type]);
          if (!type) put(`options.${index}.linked_metaobject_type`, `There is no metaobject type ${option.linked_metaobject_type}.`);
        }
        const linked = option.values.map((value) => value.linked_metaobject_id).filter((value): value is number => Boolean(value));
        if (linked.length) {
          const found = await query<RowDataPacket & { id: number }>(
            `SELECT m.id FROM metaobjects m JOIN metaobject_definitions d ON d.shop_id = m.shop_id AND d.id = m.definition_id
              WHERE m.shop_id = ? AND m.id IN (${linked.map(() => '?').join(', ')})${option.linked_metaobject_type ? ' AND d.type = ?' : ''}`,
            [shopId(), ...linked, ...(option.linked_metaobject_type ? [option.linked_metaobject_type] : [])],
          );
          if (found.length !== new Set(linked).size) put(`options.${index}.values`, 'Some linked entries no longer exist.');
        }
        const swatches = option.values.map((value) => value.swatch_media_id).filter((value): value is number => Boolean(value));
        if (swatches.length) {
          const found = await query<RowDataPacket & { id: number }>(`SELECT id FROM media WHERE shop_id = ? AND id IN (${swatches.map(() => '?').join(', ')})`, [shopId(), ...swatches]);
          if (found.length !== new Set(swatches).size) put(`options.${index}.values`, 'Some swatch images no longer exist.');
        }
      }
    }

    // Collections: only manual ones can be chosen here (automatic ones choose by their rules).
    if (input.collection_ids) {
      for (const collectionId of new Set(input.collection_ids)) {
        const collection = await collectionsRepository.findById(collectionId);
        if (!collection) put('collection_ids', 'A collection no longer exists.');
        else if (collection.collection_type === 'automatic') put('collection_ids', `"${collection.title}" is automatic — it picks its own products from its rules.`);
      }
    }
    const tags = input.tags === undefined ? null : cleanTags(input.tags);
    if (tags && tags.length > MAX_TAGS) put('tags', `At most ${MAX_TAGS} tags.`);
    if (Object.keys(errors).length) throw ApiError.validation(errors);

    // ── write ────────────────────────────────────────────────────────────────
    const productId = await withTransaction(async (tx) => {
      let pid = id;
      if (!pid) {
        const publicId = randomUUID();
        pid = await projection.allocateProduct(tx, { publicId, handle, title });
        await execute(
          `INSERT INTO catalog_products (id, shop_id, public_id, handle, title, status, created_by_admin_id, updated_by_admin_id)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
          [pid, shopId(), publicId, handle, title, actor.id, actor.id],
          tx,
        );
      } else {
        const locked = await queryOne<RowDataPacket & { version: number }>('SELECT version FROM catalog_products WHERE shop_id = ? AND id = ? FOR UPDATE', [shopId(), pid], tx);
        if (!locked) throw ApiError.notFound('Product');
        if (input.version !== undefined && Number(locked.version) !== input.version) {
          throw ApiError.conflict('Someone saved this product after you opened it. Reload to see their changes, then make yours again.', 'VERSION_CONFLICT', { version: Number(locked.version) });
        }
      }

      const goingLive = status === 'active' || status === 'unlisted';
      await execute(
        `UPDATE catalog_products
            SET handle = ?, title = ?, description_html = COALESCE(?, description_html), summary = ?, status = ?, vendor = ?,
                product_type = ?, category_code = ?, template_suffix = ?, seo_title = ?, seo_description = ?, is_gift_card = ?,
                published_at = CASE WHEN ? = 1 AND published_at IS NULL THEN UTC_TIMESTAMP() ELSE published_at END,
                version = version + ?, updated_by_admin_id = ?
          WHERE shop_id = ? AND id = ?`,
        [
          handle,
          title,
          description ?? null,
          input.summary !== undefined ? input.summary?.trim().slice(0, 500) || null : (existing?.summary ?? null),
          status,
          input.vendor !== undefined ? input.vendor?.trim().slice(0, 255) || null : (existing?.vendor ?? null),
          productType?.slice(0, 255) ?? null,
          categoryCode,
          input.template_suffix !== undefined ? input.template_suffix || null : (existing?.template_suffix ?? null),
          input.seo?.title !== undefined ? input.seo.title?.trim().slice(0, 255) || null : (existing?.seo.title ?? null),
          input.seo?.description !== undefined ? input.seo.description?.trim().slice(0, 320) || null : (existing?.seo.description ?? null),
          (input.is_gift_card ?? existing?.is_gift_card ?? false) ? 1 : 0,
          goingLive ? 1 : 0,
          existing ? 1 : 0,
          actor.id,
          shopId(),
          pid,
        ],
        tx,
      );

      if (mediaIn) await this.writeMedia(pid, mediaIn, tx);
      let variantIds: number[] = existing?.variants.map((variant) => variant.id) ?? [];
      if (plan) variantIds = await this.writeOptionsAndVariants(pid, plan, states, matches, existing, tx);
      if (tags) await this.writeTags(pid, tags, tx);
      await this.refreshDerived(pid, tx);

      // custom fields: the product's, then each variant's
      if (input.metafields !== undefined || !existing) {
        await customDataService.writeValues('product', pid, input.metafields ?? [], tx, { requiredFor: { product_type: productType, category_code: categoryCode } });
      }
      if (plan) {
        for (const [index, variant] of plan.variants.entries()) {
          if (variant.metafields !== undefined || matches[index] === null) {
            await customDataService.writeValues('variant', variantIds[index], variant.metafields ?? [], tx, { errorPrefix: `variants.${index}.metafields`, requiredFor: {} });
          }
        }
        await this.writeStock(plan.variants, variantIds, states, matches, actor, tx);
      }

      if (input.collection_ids) await this.writeCollections(pid, [...new Set(input.collection_ids)], tx);
      await projection.sync(pid, tx);

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: existing ? 'product.updated' : 'product.created',
          entityType: 'product',
          entityId: pid,
          summary: `${existing ? 'Updated' : 'Created'} "${title}" in Products (new)`,
          changes: existing
            ? auditService.diff(
                { title: existing.title, handle: existing.handle, status: existing.status, vendor: existing.vendor, product_type: existing.product_type, variants: existing.variants.length },
                { title, handle, status, vendor: input.vendor, product_type: productType, variants: plan?.variants.length },
              )
            : { status: { from: null, to: status }, variants: { from: null, to: plan?.variants.length ?? 1 } },
          context: { request_id: meta.requestId, source: 'catalog' },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return pid;
    });

    return this.get(productId);
  },

  async writeMedia(productId: number, media: { media_id: number; alt?: string | null }[], tx: Executor): Promise<void> {
    await execute('DELETE FROM catalog_product_media WHERE shop_id = ? AND product_id = ?', [shopId(), productId], tx);
    const unique = [...new Map(media.map((item) => [Number(item.media_id), item])).values()];
    if (unique.length === 0) return;
    await execute(
      `INSERT INTO catalog_product_media (shop_id, product_id, media_id, position, alt) VALUES ${unique.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
      unique.flatMap((item, index) => [shopId(), productId, Number(item.media_id), index + 1, item.alt?.trim().slice(0, 255) || null]),
      tx,
    );
  },

  async writeTags(productId: number, tags: string[], tx: Executor): Promise<void> {
    await execute('DELETE FROM catalog_product_tags WHERE shop_id = ? AND product_id = ?', [shopId(), productId], tx);
    if (tags.length === 0) return;
    await execute(
      `INSERT INTO catalog_product_tags (shop_id, product_id, tag) VALUES ${tags.map(() => '(?, ?, ?)').join(', ')}`,
      tags.flatMap((tag) => [shopId(), productId, tag]),
      tx,
    );
  },

  /** Adds and removes manual memberships only — the product keeps its place in collections it stays in. */
  async writeCollections(productId: number, collectionIds: number[], tx: Executor): Promise<void> {
    const before = await collectionsRepository.forProduct(productId, tx);
    const manualBefore = before.filter((collection) => collection.collection_type === 'manual').map((collection) => Number(collection.id));
    const removed = manualBefore.filter((collectionId) => !collectionIds.includes(collectionId));
    const added = collectionIds.filter((collectionId) => !manualBefore.includes(collectionId));
    for (const collectionId of removed) {
      await execute('DELETE FROM collection_products WHERE shop_id = ? AND collection_id = ? AND product_id = ?', [shopId(), collectionId, productId], tx);
    }
    for (const collectionId of added) {
      const last = await queryOne<RowDataPacket & { top: number | null }>('SELECT MAX(position) AS top FROM collection_products WHERE shop_id = ? AND collection_id = ?', [shopId(), collectionId], tx);
      await collectionsRepository.addMember(collectionId, productId, Math.min(Number(last?.top ?? -1) + 1, 32_767), tx);
    }
    for (const collectionId of [...removed, ...added]) await collectionsRepository.syncProductCount(collectionId, tx);
  },

  /**
   * Options, values and variants to the planned state, keeping ids: an
   * option is matched by id, then name; a value by id, then name within its
   * option; a variant by the match worked out in save(). New rows take the id
   * their classic twin was given. Returns the variant id of each planned
   * variant, in order.
   */
  async writeOptionsAndVariants(
    productId: number,
    plan: { options: PlannedOption[]; variants: (VariantInput & { option_values: string[]; title: string; position: number })[] },
    states: VariantState[],
    matches: (number | null)[],
    existing: CatalogProduct | null,
    tx: Executor,
  ): Promise<number[]> {
    const current = existing?.options ?? [];
    const claimedOptions = new Set<number>();
    const optionIds: number[] = [];
    const valueIdByOptionAndName: Map<string, number>[] = [];

    for (const option of plan.options) {
      let match = option.id ? current.find((candidate) => candidate.id === option.id && !claimedOptions.has(candidate.id)) : undefined;
      match ??= current.find((candidate) => !claimedOptions.has(candidate.id) && candidate.name.toLowerCase() === option.name.toLowerCase());
      if (match) claimedOptions.add(match.id);
      optionIds.push(match ? match.id : 0);
    }
    // Retire options that are gone (their values and variant links cascade).
    const goneOptions = current.filter((option) => !claimedOptions.has(option.id)).map((option) => option.id);
    if (goneOptions.length) await execute(`DELETE FROM catalog_product_options WHERE shop_id = ? AND id IN (${goneOptions.map(() => '?').join(', ')})`, [shopId(), ...goneOptions], tx);
    // Names cleared first, so swapping two option names never trips the unique index.
    for (const optionId of optionIds.filter(Boolean)) await execute('UPDATE catalog_product_options SET name = CONCAT(\'~\', id) WHERE shop_id = ? AND id = ?', [shopId(), optionId], tx);

    for (const [index, option] of plan.options.entries()) {
      let optionId = optionIds[index];
      if (!optionId) {
        optionId = await projection.allocateOption(tx, productId, option.position);
        await execute(
          'INSERT INTO catalog_product_options (id, shop_id, product_id, name, position, display_style, linked_metaobject_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [optionId, shopId(), productId, option.name, option.position, option.display_style, option.linked_metaobject_type ?? null],
          tx,
        );
        optionIds[index] = optionId;
      } else {
        await execute('UPDATE catalog_product_options SET name = ?, position = ?, display_style = ?, linked_metaobject_type = ? WHERE shop_id = ? AND id = ?', [option.name, option.position, option.display_style, option.linked_metaobject_type ?? null, shopId(), optionId], tx);
      }

      const currentValues = current.find((candidate) => candidate.id === optionId)?.values ?? [];
      const claimedValues = new Set<number>();
      const valueIds: number[] = [];
      for (const value of option.values) {
        let match = value.id ? currentValues.find((candidate) => candidate.id === value.id && !claimedValues.has(candidate.id)) : undefined;
        match ??= currentValues.find((candidate) => !claimedValues.has(candidate.id) && candidate.name.toLowerCase() === value.name.toLowerCase());
        if (match) claimedValues.add(match.id);
        valueIds.push(match ? match.id : 0);
      }
      const goneValues = currentValues.filter((value) => !claimedValues.has(value.id)).map((value) => value.id);
      if (goneValues.length) await execute(`DELETE FROM catalog_option_values WHERE shop_id = ? AND id IN (${goneValues.map(() => '?').join(', ')})`, [shopId(), ...goneValues], tx);
      for (const valueId of valueIds.filter(Boolean)) await execute("UPDATE catalog_option_values SET name = CONCAT('~', id) WHERE shop_id = ? AND id = ?", [shopId(), valueId], tx);

      const byName = new Map<string, number>();
      for (const [valueIndex, value] of option.values.entries()) {
        let valueId = valueIds[valueIndex];
        if (!valueId) {
          valueId = await projection.allocateValue(tx, optionId, value.position);
          await execute(
            `INSERT INTO catalog_option_values (id, shop_id, product_id, option_id, name, position, swatch_color, swatch_media_id, linked_metaobject_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [valueId, shopId(), productId, optionId, value.name, value.position, value.swatch_color ?? null, value.swatch_media_id ?? null, value.linked_metaobject_id ?? null],
            tx,
          );
        } else {
          await execute(
            'UPDATE catalog_option_values SET name = ?, position = ?, swatch_color = ?, swatch_media_id = ?, linked_metaobject_id = ? WHERE shop_id = ? AND id = ?',
            [value.name, value.position, value.swatch_color ?? null, value.swatch_media_id ?? null, value.linked_metaobject_id ?? null, shopId(), valueId],
            tx,
          );
        }
        byName.set(value.name.toLowerCase(), valueId);
      }
      valueIdByOptionAndName.push(byName);
    }

    // Variants: retire the unmatched, then write every planned one.
    const kept = new Set(matches.filter((match): match is number => match !== null));
    const retired = (existing?.variants ?? []).filter((variant) => !kept.has(variant.id)).map((variant) => variant.id);
    if (retired.length) {
      await execute(
        `UPDATE catalog_variants SET deleted_at = UTC_TIMESTAMP(), sku = NULL, options_key = CONCAT('x', id)
          WHERE shop_id = ? AND id IN (${retired.map(() => '?').join(', ')})`,
        [shopId(), ...retired],
        tx,
      );
      await execute(`DELETE FROM catalog_variant_options WHERE shop_id = ? AND variant_id IN (${retired.map(() => '?').join(', ')})`, [shopId(), ...retired], tx);
    }
    // SKUs and option keys cleared first: two variants may be trading them.
    const keptIds = [...kept];
    if (keptIds.length) {
      await execute(`UPDATE catalog_variants SET sku = NULL, options_key = CONCAT('~', id) WHERE shop_id = ? AND id IN (${keptIds.map(() => '?').join(', ')})`, [shopId(), ...keptIds], tx);
    }

    const variantIds: number[] = [];
    const links: unknown[] = [];
    for (const [index, variant] of plan.variants.entries()) {
      const state = states[index];
      const valueIds = variant.option_values.map((name, position) => valueIdByOptionAndName[position].get(name.toLowerCase())!);
      const columns = {
        position: variant.position,
        title: variant.option_values.length ? variant.title.slice(0, 255) : DEFAULT_TITLE,
        options_key: optionsKey(valueIds),
        sku: state.sku,
        barcode: state.barcode,
        price: state.price,
        compare_at_price: state.compare_at_price,
        cost: state.cost,
        taxable: state.taxable ? 1 : 0,
        tax_class_id: state.tax_class_id,
        hsn_code: state.hsn_code,
        inventory_tracked: state.inventory_tracked ? 1 : 0,
        inventory_policy: state.inventory_policy,
        requires_shipping: state.requires_shipping ? 1 : 0,
        weight: state.weight,
        weight_unit: state.weight_unit,
        length: state.length,
        width: state.width,
        height: state.height,
        dimension_unit: state.dimension_unit,
        origin_country: state.origin_country?.toUpperCase() ?? null,
        hs_code: state.hs_code,
        unit_price_quantity: state.unit_price?.quantity ?? null,
        unit_price_quantity_unit: state.unit_price?.quantity_unit ?? null,
        unit_price_reference: state.unit_price?.reference ?? null,
        unit_price_reference_unit: state.unit_price?.reference_unit ?? null,
        media_id: state.media_id,
        max_per_order: state.max_per_order,
      };
      let variantId = matches[index];
      if (variantId === null) {
        const publicId = randomUUID();
        variantId = await projection.allocateVariant(tx, productId, publicId);
        const names = Object.keys(columns);
        await execute(
          `INSERT INTO catalog_variants (id, shop_id, public_id, product_id, ${names.join(', ')}) VALUES (?, ?, ?, ?, ${names.map(() => '?').join(', ')})`,
          [variantId, shopId(), publicId, productId, ...Object.values(columns)],
          tx,
        );
      } else {
        await execute(
          `UPDATE catalog_variants SET ${Object.keys(columns).map((name) => `${name} = ?`).join(', ')}, deleted_at = NULL WHERE shop_id = ? AND id = ?`,
          [...Object.values(columns), shopId(), variantId],
          tx,
        );
      }
      variantIds.push(variantId);
      valueIds.forEach((valueId, position) => links.push(shopId(), variantId, optionIds[position], valueId));
    }
    if (keptIds.length) await execute(`DELETE FROM catalog_variant_options WHERE shop_id = ? AND variant_id IN (${keptIds.map(() => '?').join(', ')})`, [shopId(), ...keptIds], tx);
    for (let start = 0; start < links.length; start += 4 * 500) {
      const chunk = links.slice(start, start + 4 * 500);
      await execute(`INSERT INTO catalog_variant_options (shop_id, variant_id, option_id, value_id) VALUES ${Array.from({ length: chunk.length / 4 }, () => '(?, ?, ?, ?)').join(', ')}`, chunk, tx);
    }
    return variantIds;
  },

  /**
   * Stock the editor set, per variant and location, as stock-take movements —
   * the same record the Inventory screen writes, so the history reads the same
   * whichever screen changed it. A new tracked variant gets a zero row at the
   * default location, as the classic editor gives it.
   */
  async writeStock(
    variants: VariantInput[],
    variantIds: number[],
    states: VariantState[],
    matches: (number | null)[],
    actor: AuthenticatedAdmin,
    tx: Executor,
  ): Promise<void> {
    const fallback = await queryOne<RowDataPacket & { id: number }>('SELECT id FROM inventory_locations WHERE shop_id = ? ORDER BY is_default DESC, priority, id LIMIT 1', [shopId()], tx);
    for (const [index, variant] of variants.entries()) {
      const variantId = variantIds[index];
      const levels = variant.inventory ?? (matches[index] === null && states[index].inventory_tracked && fallback ? [{ location_id: Number(fallback.id), on_hand: 0 }] : []);
      for (const level of levels) {
        const quantity = Math.max(-999_999, Math.min(9_999_999, Math.trunc(Number(level.on_hand))));
        const row = await queryOne<RowDataPacket & { id: number; quantity_on_hand: number }>(
          'SELECT id, quantity_on_hand FROM inventory_items WHERE shop_id = ? AND variant_id = ? AND location_id = ? FOR UPDATE',
          [shopId(), variantId, level.location_id],
          tx,
        );
        const before = row ? Number(row.quantity_on_hand) : 0;
        if (row && before === quantity) continue;
        if (row) await execute('UPDATE inventory_items SET quantity_on_hand = ? WHERE shop_id = ? AND id = ?', [quantity, shopId(), row.id], tx);
        else await execute('INSERT INTO inventory_items (shop_id, variant_id, location_id, quantity_on_hand) VALUES (?, ?, ?, ?)', [shopId(), variantId, level.location_id, quantity], tx);
        if (quantity !== before) {
          await inventoryRepository.recordMovement(
            { variantId, locationId: Number(level.location_id), movementType: 'stock_take', quantityDelta: quantity - before, quantityAfter: quantity, reason: 'Set in Products (new)', adminUserId: actor.id },
            tx,
          );
        }
      }
    }
  },

  async refreshDerived(productId: number, tx: Executor): Promise<void> {
    await execute(
      `UPDATE catalog_products p
          SET p.option_count = (SELECT COUNT(*) FROM catalog_product_options o WHERE o.shop_id = p.shop_id AND o.product_id = p.id),
              p.variant_count = (SELECT COUNT(*) FROM catalog_variants v WHERE v.shop_id = p.shop_id AND v.product_id = p.id AND v.deleted_at IS NULL),
              p.price_min = (SELECT MIN(price) FROM catalog_variants v WHERE v.shop_id = p.shop_id AND v.product_id = p.id AND v.deleted_at IS NULL),
              p.price_max = (SELECT MAX(price) FROM catalog_variants v WHERE v.shop_id = p.shop_id AND v.product_id = p.id AND v.deleted_at IS NULL)
        WHERE p.shop_id = ? AND p.id = ?`,
      [shopId(), productId],
      tx,
    );
  },

  /** Price, SKU, barcode, cost or stock of some variants, without resending the whole product. */
  async updateVariants(productId: number, patches: (VariantInput & { id: number })[], version: number | undefined, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const product = await this.get(productId);
    const byId = new Map(patches.map((patch) => [patch.id, patch]));
    const unknown = patches.find((patch) => !product.variants.some((variant) => variant.id === patch.id));
    if (unknown) throw ApiError.validation({ variants: [`Variant ${unknown.id} is not part of this product.`] });
    return this.save(
      productId,
      {
        version,
        options: product.options.map((option) => ({ id: option.id, name: option.name, display_style: option.display_style, linked_metaobject_type: option.linked_metaobject_type, values: option.values })),
        variants: product.variants.map((variant) => ({ id: variant.id, option_values: variant.option_values, ...(byId.get(variant.id) ?? {}) })),
      },
      actor,
      meta,
    );
  },

  async remove(id: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<void> {
    const product = await catalogRepository.productOrFail(id);
    await withTransaction(async (tx) => {
      await execute(
        `UPDATE catalog_products SET deleted_at = UTC_TIMESTAMP(), status = 'archived', handle = LEFT(CONCAT(handle, '-deleted-', UNIX_TIMESTAMP()), 191), version = version + 1
          WHERE shop_id = ? AND id = ?`,
        [shopId(), id],
        tx,
      );
      await projection.remove(id, tx);
      await auditService.log(
        { actorId: actor.id, actorLabel: actor.email, action: 'product.deleted', entityType: 'product', entityId: id, summary: `Deleted "${product.title}" in Products (new)`, context: { request_id: meta.requestId, source: 'catalog' }, ip: meta.ip, userAgent: meta.userAgent },
        tx,
      );
    });
  },

  /** Shopify's Duplicate: a draft copy with the same options, variants, fields, media, tags and collections; new SKUs; no stock. */
  async duplicate(id: number, input: { title?: string; status?: CatalogStatus }, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const source = await this.get(id);
    return this.save(
      null,
      {
        title: input.title?.trim() || `${source.title} (Copy)`,
        status: input.status ?? 'draft',
        description_html: source.description_html,
        summary: source.summary,
        vendor: source.vendor,
        product_type: source.product_type,
        category_code: source.category?.code ?? null,
        template_suffix: source.template_suffix,
        seo: { title: source.seo.title, description: source.seo.description },
        is_gift_card: source.is_gift_card,
        options: source.options.map((option) => ({
          name: option.name,
          display_style: option.display_style,
          linked_metaobject_type: option.linked_metaobject_type,
          values: option.values.map((value) => ({ name: value.name, swatch_color: value.swatch_color, swatch_media_id: value.swatch_media_id, linked_metaobject_id: value.linked_metaobject_id })),
        })),
        variants: source.variants.map((variant) => {
          const { id: _id, public_id: _public, position: _position, title: _title, option_value_ids: _ids, inventory: _inventory, metafields, ...rest } = variant;
          return { ...rest, sku: null, metafields: metafields.map((field) => ({ namespace: field.namespace, key: field.key, value: field.value, type: field.type })) };
        }),
        media: source.media.map((item) => ({ media_id: item.media_id, alt: item.alt })),
        tags: source.tags,
        collection_ids: source.collections.filter((collection) => collection.editable_here).map((collection) => collection.id),
        metafields: source.metafields.map((field) => ({ namespace: field.namespace, key: field.key, value: field.value, type: field.type })),
      },
      actor,
      meta,
    );
  },

  /** One change to many products; each product is its own transaction, so one refusal does not stop the rest. */
  async bulk(input: { ids: number[]; action: BulkAction; status?: CatalogStatus; tags?: string[]; value?: string | null }, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const done: number[] = [];
    const failed: { id: number; error: string }[] = [];
    for (const id of [...new Set(input.ids)]) {
      try {
        if (input.action === 'delete') {
          await this.remove(id, actor, meta);
        } else {
          const product = await this.get(id);
          const patch: ProductInput = {};
          if (input.action === 'set_status') patch.status = input.status;
          if (input.action === 'add_tags') patch.tags = cleanTags([...product.tags, ...(input.tags ?? [])]);
          if (input.action === 'remove_tags') {
            const drop = new Set((input.tags ?? []).map((tag) => tag.toLowerCase()));
            patch.tags = product.tags.filter((tag) => !drop.has(tag.toLowerCase()));
          }
          if (input.action === 'set_vendor') patch.vendor = input.value ?? null;
          if (input.action === 'set_product_type') patch.product_type = input.value ?? null;
          if (input.action === 'set_category') patch.category_code = input.value ?? null;
          await this.save(id, patch, actor, meta);
        }
        done.push(id);
      } catch (error) {
        failed.push({ id, error: error instanceof ApiError ? firstMessage(error) : 'Something went wrong.' });
      }
    }
    return { done, failed };
  },

  /** The fields that apply to a product of this type/category, for the editor (pinned first). */
  async fieldsFor(ownerType: 'product' | 'variant', product: { product_type?: string | null; category_code?: string | null }) {
    const definitions = await customDataService.definitions(ownerType);
    return definitions.filter((definition) => ownerType === 'variant' || appliesTo(definition, product));
  },
};

export type BulkAction = 'set_status' | 'add_tags' | 'remove_tags' | 'delete' | 'set_vendor' | 'set_product_type' | 'set_category';

function pickState(variant: { [key: string]: unknown }): VariantState {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(VARIANT_DEFAULTS)) out[key] = variant[key];
  return out as unknown as VariantState;
}

/** Tags as Shopify keeps them: trimmed, no commas, each once (any case), in the order given. */
export function cleanTags(tags: string[]): string[] {
  const out = new Map<string, string>();
  for (const raw of tags.flatMap((tag) => String(tag).split(','))) {
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, 255);
    if (tag && !out.has(tag.toLowerCase())) out.set(tag.toLowerCase(), tag);
  }
  return [...out.values()];
}

function firstMessage(error: ApiError): string {
  const details = error.details as Record<string, unknown> | undefined;
  const first = details ? Object.values(details)[0] : null;
  return Array.isArray(first) && typeof first[0] === 'string' ? first[0] : error.message;
}
