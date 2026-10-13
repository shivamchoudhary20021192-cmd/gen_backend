import type { PoolConnection } from 'mysql2/promise';
import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination, parseSort, type PaginationMeta } from '../../core/pagination';
import { slugify, uniqueSlug } from '../../core/slug';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { mediaRepository } from '../media/media.repository';
import { storage } from '../media/storage';
import { productsRepository, type ProductRow, type VariantRow } from './products.repository';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

interface VariantInput {
  id?: number;
  sku: string;
  barcode?: string | null;
  variant_title?: string | null;
  net_quantity?: string | null;
  volume_ml?: number | null;
  weight_grams?: number | null;
  mrp: number;
  price: number;
  cost_price?: number | null;
  sale_starts_at?: string | null;
  sale_ends_at?: string | null;
  position?: number;
  is_default?: boolean;
  track_inventory?: boolean;
  allow_backorder?: boolean;
  low_stock_threshold?: number;
  max_per_order?: number;
  image_media_id?: number | null;
  inventory_quantity?: number;
  option_values?: string[];
}

interface ProductInput {
  name: string;
  slug?: string;
  variants: VariantInput[];
  options?: { name: string; display_type?: string; values: string[] }[];
  images?: { media_id: number; alt?: string | null; position?: number; is_primary?: boolean }[];
  benefits?: { benefit: string; detail?: string | null; benefit_kind?: string }[];
  usage_steps?: { instruction: string; time_of_day?: string; frequency?: string | null; amount?: string | null }[];
  skin_type_ids?: number[];
  concern_ids?: number[];
  ingredients?: { ingredient_id: number; role?: string | null; concentration?: string | null; is_key?: boolean }[];
  tags?: string[];
  seo?: Record<string, unknown>;
  [key: string]: unknown;
}

const SORTABLE: Record<string, string> = {
  created_at: 'p.created_at',
  updated_at: 'p.updated_at',
  name: 'p.name',
  price: 'p.min_price',
  status: 'p.status',
  inventory: 'total_inventory',
  sold: 'p.total_sold',
  sort_order: 'p.sort_order',
};

/** Product columns the API may write. Anything outside this map is ignored. */
const PRODUCT_COLUMNS = [
  'name',
  'subtitle',
  'category_id',
  'brand_id',
  'product_type',
  'status',
  'visibility',
  'short_description',
  'description',
  'full_inci',
  'texture',
  'scent',
  'fragrance_disclosure',
  'suitability_note',
  'contraindications',
  'patch_test_note',
  'routine_position',
  'time_of_day',
  'manufacturer_name',
  'manufacturer_address',
  'marketed_by_name',
  'marketed_by_address',
  'manufacturing_licence_no',
  'country_of_origin',
  'customer_care_contact',
  'shelf_life_months',
  'pao_months',
  'storage_instructions',
  'badge',
  'tax_class_id',
  'sort_order',
] as const;

const BOOLEAN_COLUMNS = ['is_new', 'is_bestseller'] as const;

function pickProductColumns(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of PRODUCT_COLUMNS) {
    if (column in input) out[column] = input[column] ?? null;
  }
  for (const column of BOOLEAN_COLUMNS) {
    if (column in input) out[column] = input[column] ? 1 : 0;
  }
  return out;
}

function presentVariant(v: VariantRow) {
  const now = Date.now();
  const saleActive =
    (!v.sale_starts_at || v.sale_starts_at.getTime() <= now) &&
    (!v.sale_ends_at || v.sale_ends_at.getTime() >= now);
  return {
    id: v.id,
    public_id: v.public_id,
    sku: v.sku,
    barcode: v.barcode,
    variant_title: v.variant_title,
    net_quantity: v.net_quantity,
    volume_ml: v.volume_ml ? Number(v.volume_ml) : null,
    weight_grams: v.weight_grams,
    mrp: Number(v.mrp),
    price: Number(v.price),
    cost_price: v.cost_price ? Number(v.cost_price) : null,
    // Only advertise a discount while the reference-price window is open —
    // BRD §8.1 forbids a permanent strike-through.
    discount_active: saleActive && Number(v.price) < Number(v.mrp),
    discount_percent:
      Number(v.mrp) > 0 ? Math.round(((Number(v.mrp) - Number(v.price)) / Number(v.mrp)) * 100) : 0,
    sale_starts_at: v.sale_starts_at?.toISOString() ?? null,
    sale_ends_at: v.sale_ends_at?.toISOString() ?? null,
    position: v.position,
    is_default: v.is_default === 1,
    status: v.status,
    track_inventory: v.track_inventory === 1,
    allow_backorder: v.allow_backorder === 1,
    low_stock_threshold: v.low_stock_threshold,
    max_per_order: v.max_per_order,
    image_media_id: v.image_media_id,
    inventory_quantity: Number(v.quantity_available ?? 0),
    inventory_on_hand: Number(v.quantity_on_hand ?? 0),
  };
}

function presentSummary(row: ProductRow) {
  return {
    id: row.id,
    public_id: row.public_id,
    slug: row.slug,
    name: row.name,
    subtitle: row.subtitle,
    status: row.status,
    visibility: row.visibility,
    product_type: row.product_type,
    category: row.category_id ? { id: row.category_id, name: row.category_name, slug: row.category_slug } : null,
    is_new: row.is_new === 1,
    is_bestseller: row.is_bestseller === 1,
    badge: row.badge,
    min_price: row.min_price ? Number(row.min_price) : null,
    max_price: row.max_price ? Number(row.max_price) : null,
    in_stock: row.in_stock === 1,
    inventory_quantity: Number(row.total_inventory ?? 0),
    variant_count: Number(row.variant_count ?? 0),
    image_count: Number(row.image_count ?? 0),
    primary_image: row.primary_image_key
      ? { url: storage.publicUrl(row.primary_image_key), alt: row.primary_image_alt ?? null }
      : null,
    rating_average: Number(row.rating_average),
    review_count: Number(row.review_count),
    total_sold: Number(row.total_sold),
    published_at: row.published_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export const productsService = {
  async list(queryParams: Record<string, unknown>): Promise<{ products: unknown[]; pagination: PaginationMeta }> {
    const page = parsePagination(queryParams);
    const orderBy = parseSort(queryParams.sort, SORTABLE, 'p.created_at DESC');
    const filters = {
      search: queryParams.q as string | undefined,
      status: queryParams.status as string | undefined,
      categoryId: queryParams.category_id as number | undefined,
      collectionId: queryParams.collection_id as number | undefined,
      concernSlug: queryParams.concern as string | undefined,
      skinTypeSlug: queryParams.skin_type as string | undefined,
      tag: queryParams.tag as string | undefined,
      ids: queryParams.ids as number[] | undefined,
      inStock: queryParams.in_stock as boolean | undefined,
      includeArchived: queryParams.include_archived === true,
    };

    const [rows, total] = await Promise.all([
      productsRepository.list(filters, orderBy, page.limit, page.offset),
      productsRepository.count(filters),
    ]);

    return { products: rows.map(presentSummary), pagination: buildMeta(total, page) };
  },

  /** The full graph, as the product edit screen needs it. */
  async get(id: number) {
    const row = await productsRepository.findById(id);
    if (!row) throw ApiError.notFound('Product');

    const [variants, options, images, benefits, usageSteps, taxonomy, seo, tags] = await Promise.all([
      productsRepository.variantsFor(id),
      productsRepository.optionsFor(id),
      productsRepository.imagesFor(id),
      productsRepository.benefitsFor(id),
      productsRepository.usageStepsFor(id),
      productsRepository.taxonomyFor(id),
      productsRepository.seoFor(id),
      productsRepository.tagsFor(id),
    ]);

    return {
      ...presentSummary(row),
      short_description: row.short_description,
      description: row.description,
      full_inci: row.full_inci,
      texture: row.texture,
      scent: row.scent,
      fragrance_disclosure: row.fragrance_disclosure,
      suitability_note: row.suitability_note,
      contraindications: row.contraindications,
      patch_test_note: row.patch_test_note,
      routine_position: row.routine_position,
      time_of_day: row.time_of_day,
      compliance: {
        manufacturer_name: row.manufacturer_name,
        marketed_by_name: row.marketed_by_name,
        country_of_origin: row.country_of_origin,
        shelf_life_months: row.shelf_life_months,
        pao_months: row.pao_months,
        storage_instructions: row.storage_instructions,
      },
      tax_class_id: row.tax_class_id,
      default_variant_id: row.default_variant_id,
      options: options.map((o) => ({
        id: o.id,
        name: o.name,
        position: o.position,
        display_type: o.display_type,
        values: typeof o.values === 'string' ? JSON.parse(o.values as string) : o.values,
      })),
      variants: variants.map(presentVariant),
      images: images.map((img) => ({
        media_id: Number(img.media_id),
        url: storage.publicUrl(img.storage_key as string),
        alt: (img.alt_override as string | null) ?? (img.alt_text as string | null),
        width: img.width,
        height: img.height,
        placeholder: img.placeholder_uri,
        dominant_color: img.dominant_color,
        focal_point: { x: Number(img.focal_x), y: Number(img.focal_y) },
        position: img.sort_order,
        is_primary: img.is_primary === 1,
        status: img.status,
      })),
      benefits,
      usage_steps: usageSteps,
      skin_types: taxonomy.skinTypes,
      concerns: taxonomy.concerns,
      ingredients: taxonomy.ingredients,
      tags,
      seo: seo ?? { meta_title: null, meta_description: null, canonical_url: null, robots_index: 1 },
    };
  },

  async create(input: ProductInput, actor: AuthenticatedAdmin, meta: ActorMeta) {
    await this.assertReferencesExist(input);

    const skus = input.variants.map((v) => v.sku.trim());
    const duplicateInPayload = skus.find((sku, i) => skus.indexOf(sku) !== i);
    if (duplicateInPayload) {
      throw ApiError.validation({ 'product.variants': [`SKU "${duplicateInPayload}" appears more than once.`] });
    }
    for (const sku of skus) {
      if (await productsRepository.skuExists(sku)) {
        throw ApiError.conflict(`SKU "${sku}" is already in use.`, 'SKU_TAKEN');
      }
    }

    const slug = await uniqueSlug('products', input.slug ?? input.name);

    const productId = await withTransaction(async (tx) => {
      const columns = pickProductColumns(input as Record<string, unknown>);
      columns.slug = slug;
      columns.name = input.name;
      if ((input.status as string) === 'active') columns.published_at = new Date();

      const id = await productsRepository.create(columns, tx);

      await this.writeChildren(id, input, actor, tx, { replaceAll: true });

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'product.created',
          entityType: 'product',
          entityId: id,
          summary: `Created product "${input.name}"`,
          changes: {
            slug: { from: null, to: slug },
            status: { from: null, to: input.status ?? 'draft' },
            variants: { from: null, to: skus },
          },
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return id;
    });

    await productsRepository.refreshDerivedFields(productId);
    return this.get(productId);
  },

  async update(id: number, input: ProductInput, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = await productsRepository.findById(id);
    if (!existing) throw ApiError.notFound('Product');
    await this.assertReferencesExist(input);

    const fields = pickProductColumns(input as Record<string, unknown>);
    if (typeof input.slug === 'string' && slugify(input.slug) !== existing.slug) {
      fields.slug = await uniqueSlug('products', input.slug, id);
    }
    if (input.status === 'active' && !existing.published_at) fields.published_at = new Date();

    await withTransaction(async (tx) => {
      if (Object.keys(fields).length > 0) await productsRepository.update(id, fields, tx);
      // Child collections are replace-on-write: sending `benefits` replaces the
      // whole list, omitting it leaves the existing rows untouched. That keeps
      // PATCH semantics predictable without a per-item diff protocol.
      await this.writeChildren(id, input, actor, tx, { replaceAll: false });

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'product.updated',
          entityType: 'product',
          entityId: id,
          summary: `Updated product "${existing.name}"`,
          changes: auditService.diff(existing as unknown as Record<string, unknown>, fields),
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    await productsRepository.refreshDerivedFields(id);
    return this.get(id);
  },

  /**
   * Writes every child collection of a product inside the caller's transaction.
   * `replaceAll` is true on create (write everything) and false on update
   * (write only what the payload actually included).
   */
  async writeChildren(
    productId: number,
    input: ProductInput,
    actor: AuthenticatedAdmin,
    tx: PoolConnection,
    { replaceAll }: { replaceAll: boolean },
  ): Promise<void> {
    // options → option values, then variants that reference them by value
    const optionValueIds = new Map<string, { optionId: number; valueId: number }>();
    if (input.options && (replaceAll || input.options.length > 0)) {
      if (!replaceAll) await productsRepository.deleteOptions(productId, tx);
      for (const [oi, option] of input.options.entries()) {
        const optionId = await productsRepository.createOption(productId, option.name, oi, tx);
        for (const [vi, value] of option.values.entries()) {
          const valueId = await productsRepository.createOptionValue(optionId, value, vi, tx);
          optionValueIds.set(`${oi}:${value}`, { optionId, valueId });
        }
      }
    }

    if (input.variants) {
      for (const [index, variant] of input.variants.entries()) {
        const variantColumns: Record<string, unknown> = {
          product_id: productId,
          sku: variant.sku.trim(),
          barcode: variant.barcode ?? null,
          variant_title: variant.variant_title ?? null,
          net_quantity: variant.net_quantity ?? null,
          volume_ml: variant.volume_ml ?? null,
          weight_grams: variant.weight_grams ?? null,
          mrp: variant.mrp,
          price: variant.price,
          cost_price: variant.cost_price ?? null,
          sale_starts_at: variant.sale_starts_at ? new Date(variant.sale_starts_at) : null,
          sale_ends_at: variant.sale_ends_at ? new Date(variant.sale_ends_at) : null,
          position: variant.position ?? index,
          is_default: variant.is_default ?? index === 0 ? 1 : 0,
          track_inventory: variant.track_inventory === false ? 0 : 1,
          allow_backorder: variant.allow_backorder ? 1 : 0,
          low_stock_threshold: variant.low_stock_threshold ?? 5,
          max_per_order: variant.max_per_order ?? 10,
          image_media_id: variant.image_media_id ?? null,
        };

        let variantId: number;
        if (variant.id) {
          const { product_id: _ignored, ...updatable } = variantColumns;
          await productsRepository.updateVariant(variant.id, updatable, tx);
          variantId = variant.id;
        } else {
          variantId = await productsRepository.createVariant(variantColumns, tx);
        }

        if (variant.option_values?.length && optionValueIds.size > 0) {
          for (const [oi, value] of variant.option_values.entries()) {
            const match = optionValueIds.get(`${oi}:${value}`);
            if (match) await productsRepository.linkVariantOptionValue(variantId, match.optionId, match.valueId, tx);
          }
        }

        if (variant.inventory_quantity !== undefined) {
          await productsRepository.initialiseInventory(variantId, variant.inventory_quantity, tx);
          await productsRepository.recordInventoryMovement(
            variantId,
            variant.inventory_quantity,
            variant.inventory_quantity,
            variant.id ? 'Stock set from product edit' : 'Initial stock on product creation',
            actor.id,
            tx,
          );
        }

        if ((variant.is_default ?? index === 0) && !variant.id) {
          await productsRepository.update(productId, { default_variant_id: variantId }, tx);
        }
      }
    }

    if (input.images) {
      const previous = await productsRepository.detachAllImages(productId, tx);
      for (const mediaId of previous) await mediaRepository.bumpUsage(mediaId, -1, tx);
      for (const [i, image] of input.images.entries()) {
        await productsRepository.attachImage(
          productId,
          image.media_id,
          image.position ?? i,
          image.is_primary ?? i === 0,
          image.alt ?? null,
          tx,
        );
        await mediaRepository.bumpUsage(image.media_id, 1, tx);
      }
    }

    if (input.benefits) await productsRepository.replaceBenefits(productId, input.benefits, tx);
    if (input.usage_steps) await productsRepository.replaceUsageSteps(productId, input.usage_steps, tx);
    if (input.skin_type_ids) await productsRepository.replaceSkinTypes(productId, input.skin_type_ids, tx);
    if (input.concern_ids) await productsRepository.replaceConcerns(productId, input.concern_ids, tx);
    if (input.ingredients) await productsRepository.replaceIngredients(productId, input.ingredients, tx);
    if (input.tags) await productsRepository.replaceTags(productId, input.tags.map(slugify), tx);
    if (input.seo) await productsRepository.upsertSeo(productId, input.seo, tx);
  },

  /** Fails fast with a 422 rather than letting MySQL raise a foreign-key error. */
  async assertReferencesExist(input: ProductInput): Promise<void> {
    const errors: Record<string, string[]> = {};

    if (input.skin_type_ids?.length) {
      const valid = await productsRepository.validateIds('skin_types', input.skin_type_ids);
      const missing = input.skin_type_ids.filter((id) => !valid.includes(id));
      if (missing.length) errors['product.skin_type_ids'] = [`Unknown skin type id(s): ${missing.join(', ')}`];
    }
    if (input.concern_ids?.length) {
      const valid = await productsRepository.validateIds('skin_concerns', input.concern_ids);
      const missing = input.concern_ids.filter((id) => !valid.includes(id));
      if (missing.length) errors['product.concern_ids'] = [`Unknown concern id(s): ${missing.join(', ')}`];
    }
    if (input.ingredients?.length) {
      const ids = input.ingredients.map((i) => i.ingredient_id);
      const valid = await productsRepository.validateIds('ingredients', ids);
      const missing = ids.filter((id) => !valid.includes(id));
      if (missing.length) errors['product.ingredients'] = [`Unknown ingredient id(s): ${missing.join(', ')}`];
    }
    if (input.images?.length) {
      const ids = input.images.map((i) => i.media_id);
      const found = await mediaRepository.findManyByIds(ids);
      const missing = ids.filter((id) => !found.some((m) => m.id === id));
      if (missing.length) errors['product.images'] = [`Unknown media id(s): ${missing.join(', ')}`];
    }

    if (Object.keys(errors).length > 0) throw ApiError.validation(errors);
  },

  async setStatus(
    id: number,
    status: 'active' | 'draft' | 'archived',
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const existing = await productsRepository.findById(id);
    if (!existing) throw ApiError.notFound('Product');

    // Publishing is the gate where the mandatory declarations become required.
    // Draft is deliberately permissive so work in progress can be saved.
    if (status === 'active') {
      const problems: string[] = [];
      const variantCount = await productsRepository.countActiveVariants(id);
      if (variantCount === 0) problems.push('at least one active variant');
      if (!existing.short_description) problems.push('a short description');
      if (!existing.full_inci) problems.push('the full INCI list');
      if (!existing.manufacturer_name && !existing.marketed_by_name) {
        problems.push('a manufacturer or marketer name');
      }
      if (problems.length > 0) {
        throw ApiError.validation(
          { product: [`Cannot publish without ${problems.join(', ')}.`] },
          'This product is not ready to publish.',
        );
      }
    }

    await withTransaction(async (tx) => {
      await productsRepository.update(
        id,
        { status, ...(status === 'active' && !existing.published_at ? { published_at: new Date() } : {}) },
        tx,
      );
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: `product.${status === 'active' ? 'published' : status === 'draft' ? 'unpublished' : 'archived'}`,
          entityType: 'product',
          entityId: id,
          summary: `"${existing.name}" set to ${status}`,
          changes: { status: { from: existing.status, to: status } },
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  async remove(id: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<void> {
    const existing = await productsRepository.findById(id);
    if (!existing) throw ApiError.notFound('Product');

    await withTransaction(async (tx) => {
      const mediaIds = await productsRepository.detachAllImages(id, tx);
      for (const mediaId of mediaIds) await mediaRepository.bumpUsage(mediaId, -1, tx);
      await productsRepository.softDelete(id, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'product.deleted',
          entityType: 'product',
          entityId: id,
          summary: `Deleted product "${existing.name}"`,
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });
  },

  /** Shopify's "Duplicate" — a full copy in draft, with SKUs suffixed. */
  async duplicate(id: number, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const source = await this.get(id);
    const suffix = Date.now().toString(36).slice(-4).toUpperCase();

    const input: ProductInput = {
      name: `${source.name} (Copy)`,
      subtitle: source.subtitle,
      category_id: source.category?.id ?? null,
      product_type: source.product_type,
      status: 'draft',
      short_description: source.short_description,
      description: source.description,
      full_inci: source.full_inci,
      texture: source.texture,
      scent: source.scent,
      routine_position: source.routine_position,
      time_of_day: source.time_of_day,
      variants: source.variants.map((v, i) => ({
        sku: `${v.sku}-${suffix}`,
        variant_title: v.variant_title,
        net_quantity: v.net_quantity,
        mrp: v.mrp,
        price: v.price,
        position: i,
        is_default: v.is_default,
        inventory_quantity: 0,
      })),
      images: source.images.map((img, i) => ({ media_id: img.media_id, position: i, is_primary: i === 0 })),
      benefits: source.benefits as ProductInput['benefits'],
      usage_steps: source.usage_steps as ProductInput['usage_steps'],
      skin_type_ids: (source.skin_types as { id: number }[]).map((s) => s.id),
      concern_ids: (source.concerns as { id: number }[]).map((c) => c.id),
      tags: source.tags,
    };

    const created = await this.create(input, actor, meta);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'product.duplicated',
      entityType: 'product',
      entityId: created.id,
      summary: `Duplicated "${source.name}"`,
      context: { request_id: meta.requestId, source_product_id: id },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return created;
  },

  async bulk(
    ids: number[],
    action: 'publish' | 'unpublish' | 'archive' | 'delete' | 'set_category',
    categoryId: number | null | undefined,
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ): Promise<{ affected: number; skipped: { id: number; reason: string }[] }> {
    const skipped: { id: number; reason: string }[] = [];
    let affected = 0;

    if (action === 'publish') {
      // Publishing runs the readiness gate per product, so one unpublishable
      // item does not silently fail the whole batch.
      const publishable: number[] = [];
      for (const id of ids) {
        try {
          const row = await productsRepository.findById(id);
          if (!row) {
            skipped.push({ id, reason: 'not found' });
            continue;
          }
          const variantCount = await productsRepository.countActiveVariants(id);
          if (variantCount === 0 || !row.short_description || !row.full_inci) {
            skipped.push({ id, reason: 'missing required fields for publishing' });
            continue;
          }
          publishable.push(id);
        } catch {
          skipped.push({ id, reason: 'check failed' });
        }
      }
      affected = await withTransaction((tx) => productsRepository.bulkSetStatus(publishable, 'active', tx));
    } else if (action === 'unpublish') {
      affected = await withTransaction((tx) => productsRepository.bulkSetStatus(ids, 'draft', tx));
    } else if (action === 'archive') {
      affected = await withTransaction((tx) => productsRepository.bulkSetStatus(ids, 'archived', tx));
    } else if (action === 'delete') {
      affected = await withTransaction((tx) => productsRepository.bulkSoftDelete(ids, tx));
    } else {
      affected = await withTransaction((tx) => productsRepository.bulkSetCategory(ids, categoryId ?? null, tx));
    }

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: `product.bulk_${action}`,
      entityType: 'product',
      summary: `Bulk ${action} on ${affected} product(s)`,
      changes: { ids, affected, skipped },
      context: { request_id: meta.requestId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { affected, skipped };
  },

  // ── variants ───────────────────────────────────────────────────────────────
  async listVariants(productId: number) {
    const product = await productsRepository.findById(productId);
    if (!product) throw ApiError.notFound('Product');
    const variants = await productsRepository.variantsFor(productId);
    return { variants: variants.map(presentVariant) };
  },

  async addVariant(productId: number, input: VariantInput, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const product = await productsRepository.findById(productId);
    if (!product) throw ApiError.notFound('Product');
    if (await productsRepository.skuExists(input.sku)) {
      throw ApiError.conflict(`SKU "${input.sku}" is already in use.`, 'SKU_TAKEN');
    }

    await withTransaction(async (tx) => {
      await this.writeChildren(productId, { name: product.name, variants: [input] }, actor, tx, { replaceAll: false });
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'product.variant_created',
          entityType: 'product',
          entityId: productId,
          summary: `Added variant ${input.sku}`,
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    await productsRepository.refreshDerivedFields(productId);
    return this.listVariants(productId);
  },

  async updateVariant(
    productId: number,
    variantId: number,
    input: Partial<VariantInput>,
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const variant = await productsRepository.findVariant(variantId);
    if (!variant || variant.product_id !== productId) throw ApiError.notFound('Variant');

    if (input.sku && (await productsRepository.skuExists(input.sku, variantId))) {
      throw ApiError.conflict(`SKU "${input.sku}" is already in use.`, 'SKU_TAKEN');
    }

    const price = input.price ?? Number(variant.price);
    const mrp = input.mrp ?? Number(variant.mrp);
    if (price > mrp) throw ApiError.validation({ 'variant.price': ['Selling price cannot exceed MRP.'] });

    const fields: Record<string, unknown> = {};
    const map: Record<string, string> = {
      sku: 'sku',
      barcode: 'barcode',
      variant_title: 'variant_title',
      net_quantity: 'net_quantity',
      volume_ml: 'volume_ml',
      weight_grams: 'weight_grams',
      mrp: 'mrp',
      price: 'price',
      cost_price: 'cost_price',
      position: 'position',
      low_stock_threshold: 'low_stock_threshold',
      max_per_order: 'max_per_order',
      image_media_id: 'image_media_id',
    };
    for (const [key, column] of Object.entries(map)) {
      if (key in input) fields[column] = (input as Record<string, unknown>)[key] ?? null;
    }
    if ('is_default' in input) fields.is_default = input.is_default ? 1 : 0;
    if ('track_inventory' in input) fields.track_inventory = input.track_inventory ? 1 : 0;
    if ('allow_backorder' in input) fields.allow_backorder = input.allow_backorder ? 1 : 0;
    if ('sale_starts_at' in input) fields.sale_starts_at = input.sale_starts_at ? new Date(input.sale_starts_at) : null;
    if ('sale_ends_at' in input) fields.sale_ends_at = input.sale_ends_at ? new Date(input.sale_ends_at) : null;

    await withTransaction(async (tx) => {
      if (Object.keys(fields).length > 0) await productsRepository.updateVariant(variantId, fields, tx);
      if (input.inventory_quantity !== undefined) {
        const current = Number(variant.quantity_on_hand ?? 0);
        await productsRepository.initialiseInventory(variantId, input.inventory_quantity, tx);
        await productsRepository.recordInventoryMovement(
          variantId,
          input.inventory_quantity - current,
          input.inventory_quantity,
          'Manual adjustment from admin',
          actor.id,
          tx,
        );
      }
      if (input.is_default) await productsRepository.update(productId, { default_variant_id: variantId }, tx);

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'product.variant_updated',
          entityType: 'product',
          entityId: productId,
          summary: `Updated variant ${variant.sku}`,
          changes: auditService.diff(variant as unknown as Record<string, unknown>, fields),
          context: { request_id: meta.requestId, variant_id: variantId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    await productsRepository.refreshDerivedFields(productId);
    return this.listVariants(productId);
  },

  async removeVariant(productId: number, variantId: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<void> {
    const variant = await productsRepository.findVariant(variantId);
    if (!variant || variant.product_id !== productId) throw ApiError.notFound('Variant');

    const remaining = await productsRepository.countActiveVariants(productId);
    if (remaining <= 1) {
      throw ApiError.conflict('A product must keep at least one variant. Archive the product instead.');
    }

    await withTransaction(async (tx) => {
      await productsRepository.softDeleteVariant(variantId, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'product.variant_deleted',
          entityType: 'product',
          entityId: productId,
          summary: `Deleted variant ${variant.sku}`,
          context: { request_id: meta.requestId, variant_id: variantId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    await productsRepository.refreshDerivedFields(productId);
  },

  // ── images ─────────────────────────────────────────────────────────────────
  async attachImages(
    productId: number,
    images: { media_id: number; alt?: string | null; position?: number; is_primary?: boolean }[],
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const product = await productsRepository.findById(productId);
    if (!product) throw ApiError.notFound('Product');

    const found = await mediaRepository.findManyByIds(images.map((i) => i.media_id));
    const missing = images.map((i) => i.media_id).filter((id) => !found.some((m) => m.id === id));
    if (missing.length) throw ApiError.validation({ images: [`Unknown media id(s): ${missing.join(', ')}`] });

    const existingCount = (await productsRepository.imagesFor(productId)).length;

    await withTransaction(async (tx) => {
      for (const [i, image] of images.entries()) {
        await productsRepository.attachImage(
          productId,
          image.media_id,
          image.position ?? existingCount + i,
          image.is_primary ?? (existingCount === 0 && i === 0),
          image.alt ?? null,
          tx,
        );
        await mediaRepository.bumpUsage(image.media_id, 1, tx);
      }
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'product.images_attached',
          entityType: 'product',
          entityId: productId,
          summary: `Attached ${images.length} image(s)`,
          context: { request_id: meta.requestId, media_ids: images.map((i) => i.media_id) },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(productId);
  },

  async detachImage(productId: number, mediaId: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<void> {
    const removed = await withTransaction(async (tx) => {
      const count = await productsRepository.detachImage(productId, mediaId, tx);
      if (count > 0) await mediaRepository.bumpUsage(mediaId, -1, tx);
      return count;
    });
    if (removed === 0) throw ApiError.notFound('Image on this product');

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'product.image_detached',
      entityType: 'product',
      entityId: productId,
      summary: `Detached media ${mediaId}`,
      context: { request_id: meta.requestId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  },

  async reorderImages(productId: number, mediaIds: number[]) {
    const product = await productsRepository.findById(productId);
    if (!product) throw ApiError.notFound('Product');
    await withTransaction(async (tx) => {
      for (const [i, mediaId] of mediaIds.entries()) {
        await productsRepository.attachImage(productId, mediaId, i, i === 0, null, tx);
      }
    });
    return this.get(productId);
  },
};
