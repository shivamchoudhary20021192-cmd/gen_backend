import { randomUUID } from 'node:crypto';
import { slugify } from '../../core/slug';
import { execute, insert, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';
import { mediaRepository } from '../media/media.repository';
import { productsRepository } from '../products/products.repository';
import { catalogRepository } from './catalog.repository';
import { DEFAULT_TITLE } from './options';

/**
 * Products (new) → the classic tables.
 *
 * Everything that sells a product — storefront and Liquid, Storefront API,
 * search, collections, cart, checkout, orders, inventory, reviews, wishlists,
 * price lists — reads `products` and `product_variants`. Rather than teach
 * thirty readers a second catalog at once, each catalog product keeps a
 * classic twin with the SAME ids: the catalog is the source of truth, this
 * module rewrites the twin's columns from it inside the same transaction, and
 * every reader sells the new product unchanged.
 *
 * During the transition the classic tables allocate the ids (a new product,
 * option, value or variant inserts its classic row first and the catalog row
 * takes that id), so the two can never collide. At cutover the readers'
 * foreign keys move to the catalog tables — the ids already match, so no row
 * is rewritten — and the classic tables go. docs/CATALOG.md has the plan.
 *
 * Only the columns listed in OWNED_* are written. A product brought over from
 * the classic catalog keeps the rest (ratings, sales counts, badges, beauty
 * columns) untouched until the classic tables are removed.
 */

export const OWNED_PRODUCT_COLUMNS = [
  'slug', 'name', 'status', 'visibility', 'product_type', 'template_suffix', 'short_description', 'description',
  'brand_id', 'tax_class_id', 'requires_shipping', 'is_gift_card', 'published_at', 'default_variant_id', 'deleted_at',
] as const;

export const OWNED_VARIANT_COLUMNS = [
  'sku', 'barcode', 'variant_title', 'weight_grams', 'length_mm', 'width_mm', 'height_mm', 'mrp', 'price', 'cost_price',
  'tax_class_id', 'position', 'is_default', 'status', 'track_inventory', 'allow_backorder', 'max_per_order',
  'image_media_id', 'deleted_at',
] as const;

const GRAMS: Record<string, number> = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 };
const MILLIMETRES: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4 };

function toGrams(weight: string | number | null, unit: string): number | null {
  if (weight === null || weight === undefined) return null;
  return Math.round(Number(weight) * (GRAMS[unit] ?? 1));
}

function toMillimetres(size: string | number | null, unit: string): number | null {
  if (size === null || size === undefined) return null;
  return Math.min(65_535, Math.round(Number(size) * (MILLIMETRES[unit] ?? 1)));
}

const CLASSIC_STATUS = { draft: 'draft', active: 'active', unlisted: 'active', archived: 'archived' } as const;
const CLASSIC_DISPLAY = { dropdown: 'dropdown', buttons: 'pill', swatches: 'swatch' } as const;

/** A placeholder while a new row waits for its real value in the same transaction (unique columns). */
function placeholder(): string {
  return `~${randomUUID().slice(0, 30)}`;
}

async function brandFor(vendor: string | null, tx: Executor): Promise<number | null> {
  const name = vendor?.trim();
  if (!name) return null;
  const slug = slugify(name).slice(0, 140) || 'vendor';
  const existing = await queryOne<RowDataPacket & { id: number }>('SELECT id FROM brands WHERE shop_id = ? AND slug = ?', [shopId(), slug], tx);
  if (existing) return Number(existing.id);
  return insert('INSERT INTO brands (shop_id, slug, name, is_active) VALUES (?, ?, ?, 1)', [shopId(), slug, name.slice(0, 120)], tx);
}

export const projection = {
  // ── ids: the classic tables allocate them during the transition ────────────

  async allocateProduct(tx: Executor, input: { publicId: string; handle: string; title: string }): Promise<number> {
    return insert(
      "INSERT INTO products (shop_id, public_id, slug, name, status, visibility) VALUES (?, ?, ?, ?, 'draft', 'public')",
      [shopId(), input.publicId, input.handle, input.title.slice(0, 191)],
      tx,
    );
  },

  async allocateOption(tx: Executor, productId: number, position: number): Promise<number> {
    return insert('INSERT INTO product_options (shop_id, product_id, name, position) VALUES (?, ?, ?, ?)', [shopId(), productId, placeholder(), position], tx);
  },

  async allocateValue(tx: Executor, optionId: number, position: number): Promise<number> {
    return insert('INSERT INTO product_option_values (shop_id, option_id, value, position) VALUES (?, ?, ?, ?)', [shopId(), optionId, placeholder(), Math.min(position, 255)], tx);
  },

  async allocateVariant(tx: Executor, productId: number, publicId: string): Promise<number> {
    return insert(
      "INSERT INTO product_variants (shop_id, public_id, product_id, sku, mrp, price, status) VALUES (?, ?, ?, ?, 0, 0, 'active')",
      [shopId(), publicId, productId, placeholder()],
      tx,
    );
  },

  // ── the twin ───────────────────────────────────────────────────────────────

  /** Rewrites the classic twin of a catalog product from the catalog's current state. */
  async sync(productId: number, tx: Executor): Promise<void> {
    const product = await catalogRepository.product(productId, tx, { withDeleted: true });
    if (!product) return;
    if (product.deleted_at) {
      await this.remove(productId, tx);
      return;
    }
    const [options, values, variants, deletedVariants, variantOptions, media, tags] = await Promise.all([
      catalogRepository.options(productId, tx),
      catalogRepository.values(productId, tx),
      catalogRepository.variants(productId, tx),
      query<RowDataPacket & { id: number }>('SELECT id FROM catalog_variants WHERE shop_id = ? AND product_id = ? AND deleted_at IS NOT NULL', [shopId(), productId], tx),
      catalogRepository.variantOptions(productId, tx),
      catalogRepository.media(productId, tx),
      catalogRepository.tags(productId, tx),
    ]);

    // options and values — stale ones go (cascading to classic variant_option_values);
    // names are cleared first so a swap (Size ↔ Colour) never trips the unique index.
    const optionIds = options.map((option) => Number(option.id));
    const staleOptions = await query<RowDataPacket & { id: number }>(
      `SELECT id FROM product_options WHERE shop_id = ? AND product_id = ?${optionIds.length ? ` AND id NOT IN (${optionIds.map(() => '?').join(', ')})` : ''}`,
      [shopId(), productId, ...optionIds],
      tx,
    );
    if (staleOptions.length) {
      const staleIds = staleOptions.map((row) => Number(row.id));
      const staleValues = await query<RowDataPacket & { id: number }>(
        `SELECT id FROM product_option_values WHERE shop_id = ? AND option_id IN (${staleIds.map(() => '?').join(', ')})`,
        [shopId(), ...staleIds],
        tx,
      );
      if (staleValues.length) await this.dropValues(staleValues.map((row) => Number(row.id)), tx);
      await execute(`DELETE FROM product_options WHERE shop_id = ? AND id IN (${staleIds.map(() => '?').join(', ')})`, [shopId(), ...staleIds], tx);
    }
    for (const option of options) await execute('UPDATE product_options SET name = ? WHERE shop_id = ? AND id = ?', [placeholder(), shopId(), option.id], tx);
    for (const option of options) {
      await execute('UPDATE product_options SET name = ?, display_type = ?, position = ? WHERE shop_id = ? AND id = ?', [option.name.slice(0, 50), CLASSIC_DISPLAY[option.display_style], option.position, shopId(), option.id], tx);
    }
    if (optionIds.length) {
      const valueIds = values.map((value) => Number(value.id));
      const stale = await query<RowDataPacket & { id: number }>(
        `SELECT id FROM product_option_values WHERE shop_id = ? AND option_id IN (${optionIds.map(() => '?').join(', ')})${valueIds.length ? ` AND id NOT IN (${valueIds.map(() => '?').join(', ')})` : ''}`,
        [shopId(), ...optionIds, ...valueIds],
        tx,
      );
      if (stale.length) await this.dropValues(stale.map((row) => Number(row.id)), tx);
      for (const value of values) await execute('UPDATE product_option_values SET value = ? WHERE shop_id = ? AND id = ?', [placeholder(), shopId(), value.id], tx);
      for (const value of values) {
        await execute(
          'UPDATE product_option_values SET option_id = ?, value = ?, swatch_hex = ?, swatch_media_id = ?, position = ?, is_active = 1 WHERE shop_id = ? AND id = ?',
          [value.option_id, value.name.slice(0, 80), value.swatch_color, value.swatch_media_id, Math.min(Number(value.position), 255), shopId(), value.id],
          tx,
        );
      }
    }

    // variants — SKUs cleared first for the same reason as names.
    for (const variant of variants) await execute('UPDATE product_variants SET sku = ? WHERE shop_id = ? AND id = ?', [placeholder(), shopId(), variant.id], tx);
    for (const variant of variants) {
      const compareAt = variant.compare_at_price === null ? null : Number(variant.compare_at_price);
      const price = Number(variant.price);
      await execute(
        `UPDATE product_variants
            SET sku = ?, barcode = ?, variant_title = ?, weight_grams = ?, length_mm = ?, width_mm = ?, height_mm = ?,
                mrp = ?, price = ?, cost_price = ?, tax_class_id = ?, position = ?, is_default = ?, status = 'active',
                track_inventory = ?, allow_backorder = ?, max_per_order = COALESCE(?, max_per_order), image_media_id = ?, deleted_at = NULL
          WHERE shop_id = ? AND id = ?`,
        [
          variant.sku ?? `VL-${variant.id}`,
          variant.barcode,
          variant.title === DEFAULT_TITLE ? null : variant.title.slice(0, 160),
          toGrams(variant.weight, variant.weight_unit),
          toMillimetres(variant.length, variant.dimension_unit),
          toMillimetres(variant.width, variant.dimension_unit),
          toMillimetres(variant.height, variant.dimension_unit),
          compareAt !== null && compareAt > price ? compareAt : price,
          price,
          variant.cost,
          variant.tax_class_id,
          variant.position,
          variant.position === variants[0].position ? 1 : 0,
          variant.inventory_tracked,
          variant.inventory_policy === 'continue' ? 1 : 0,
          variant.max_per_order,
          variant.media_id,
          shopId(),
          variant.id,
        ],
        tx,
      );
    }
    for (const row of deletedVariants) {
      await execute(
        `UPDATE product_variants SET deleted_at = COALESCE(deleted_at, NOW()), status = 'archived',
                sku = CASE WHEN sku LIKE '%-del-%' THEN sku ELSE CONCAT(LEFT(sku, 40), '-del-', UNIX_TIMESTAMP()) END
          WHERE shop_id = ? AND id = ?`,
        [shopId(), row.id],
        tx,
      );
    }
    const liveIds = variants.map((variant) => Number(variant.id));
    if (liveIds.length) {
      await execute(`DELETE FROM variant_option_values WHERE shop_id = ? AND variant_id IN (${liveIds.map(() => '?').join(', ')})`, [shopId(), ...liveIds], tx);
      const links: unknown[] = [];
      for (const [variantId, byOption] of variantOptions) for (const [optionId, valueId] of byOption) links.push(shopId(), variantId, optionId, valueId);
      for (let start = 0; start < links.length; start += 4 * 500) {
        const chunk = links.slice(start, start + 4 * 500);
        await execute(`INSERT INTO variant_option_values (shop_id, variant_id, option_id, option_value_id) VALUES ${Array.from({ length: chunk.length / 4 }, () => '(?, ?, ?, ?)').join(', ')}`, chunk, tx);
      }
    }

    // the product
    const first = variants[0];
    await execute(
      `UPDATE products
          SET slug = ?, name = ?, status = ?, visibility = ?, product_type = ?, template_suffix = ?, short_description = ?,
              description = ?, brand_id = ?, tax_class_id = ?, requires_shipping = ?, is_gift_card = ?, published_at = ?,
              default_variant_id = ?, deleted_at = NULL
        WHERE shop_id = ? AND id = ?`,
      [
        product.handle,
        product.title.slice(0, 191),
        CLASSIC_STATUS[product.status],
        product.status === 'unlisted' ? 'hidden' : 'public',
        Number(product.is_gift_card) ? 'gift_card' : variants.length > 1 ? 'variable' : 'simple',
        product.template_suffix,
        product.summary,
        product.description_html,
        await brandFor(product.vendor, tx),
        first?.tax_class_id ?? null,
        variants.some((variant) => Number(variant.requires_shipping) === 1) ? 1 : 0,
        product.is_gift_card,
        product.published_at,
        first?.id ?? null,
        shopId(),
        productId,
      ],
      tx,
    );

    // gallery: media_attachments, with the media's usage count kept true
    const before = await query<RowDataPacket & { media_id: number }>(
      "SELECT media_id FROM media_attachments WHERE shop_id = ? AND attachable_type = 'product' AND attachable_id = ? AND collection = 'gallery'",
      [shopId(), productId],
      tx,
    );
    const had = new Set(before.map((row) => Number(row.media_id)));
    const has = new Set(media.map((row) => Number(row.media_id)));
    for (const mediaId of had) {
      if (has.has(mediaId)) continue;
      await execute("DELETE FROM media_attachments WHERE shop_id = ? AND attachable_type = 'product' AND attachable_id = ? AND collection = 'gallery' AND media_id = ?", [shopId(), productId, mediaId], tx);
      await mediaRepository.bumpUsage(mediaId, -1, tx);
    }
    for (const [index, row] of media.entries()) {
      await execute(
        `INSERT INTO media_attachments (shop_id, media_id, attachable_type, attachable_id, collection, sort_order, is_primary, alt_override)
         VALUES (?, ?, 'product', ?, 'gallery', ?, ?, ?)
         ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), is_primary = VALUES(is_primary), alt_override = VALUES(alt_override)`,
        [shopId(), row.media_id, productId, index, index === 0 ? 1 : 0, row.alt],
        tx,
      );
      if (!had.has(Number(row.media_id))) await mediaRepository.bumpUsage(Number(row.media_id), 1, tx);
    }

    await productsRepository.replaceTags(productId, [...new Set(tags.map((tag) => slugify(tag).slice(0, 80)).filter(Boolean))], tx);
    await productsRepository.upsertSeo(productId, { meta_title: product.seo_title, meta_description: product.seo_description }, tx);
    await productsRepository.refreshDerivedFields(productId, tx);
  },

  /** A deleted catalog product: its twin is deleted the way the classic editor deletes. */
  async remove(productId: number, tx: Executor): Promise<void> {
    const twin = await queryOne<RowDataPacket & { deleted_at: Date | null }>('SELECT deleted_at FROM products WHERE shop_id = ? AND id = ?', [shopId(), productId], tx);
    if (!twin || twin.deleted_at) return;
    const mediaIds = await productsRepository.detachAllImages(productId, tx);
    for (const mediaId of mediaIds) await mediaRepository.bumpUsage(mediaId, -1, tx);
    await productsRepository.softDelete(productId, tx);
  },

  /** Option values that are going: their shade photographs go with them (usage counts kept true). */
  async dropValues(valueIds: number[], tx: Executor): Promise<void> {
    const marks = valueIds.map(() => '?').join(', ');
    const photos = await query<RowDataPacket & { media_id: number }>(
      `SELECT media_id FROM media_attachments WHERE shop_id = ? AND attachable_type = 'product_option_value' AND attachable_id IN (${marks})`,
      [shopId(), ...valueIds],
      tx,
    );
    await execute(`DELETE FROM media_attachments WHERE shop_id = ? AND attachable_type = 'product_option_value' AND attachable_id IN (${marks})`, [shopId(), ...valueIds], tx);
    for (const photo of photos) await mediaRepository.bumpUsage(Number(photo.media_id), -1, tx);
    await execute(`DELETE FROM product_option_values WHERE shop_id = ? AND id IN (${marks})`, [shopId(), ...valueIds], tx);
  },
};
