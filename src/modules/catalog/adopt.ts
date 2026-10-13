import { ApiError } from '../../core/ApiError';
import { execute, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { shopId } from '../../platform/tenancy/context';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { DEFAULT_TITLE, MAX_OPTIONS, optionsKey, VALUE_NAME_MAX } from './options';
import { projection } from './projection';

/**
 * Classic → Products (new), one product at a time, keeping every id.
 *
 * The catalog rows take the classic rows' ids (product, options, values,
 * variants), so orders, stock, reviews, wishlists, collections, price lists
 * and custom-field values — which all point at those ids — stay attached with
 * nothing rewritten. After the copy the projection runs as on any save, so the
 * classic twin is exactly what the catalog says; the classic-only columns
 * (beauty fields, ratings, sales counts) are not in OWNED_* and stay as they
 * were.
 *
 * From then on the classic editor refuses to change the product
 * (CATALOG_MANAGED) and Products (new) owns it. There is no way back — as
 * with Shopify's product-model migration — so the admin asks first.
 */

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

const STATUS = { draft: 'draft', in_review: 'draft', active: 'active', archived: 'archived' } as const;
const DISPLAY = { dropdown: 'dropdown', pill: 'buttons', swatch: 'swatches' } as const;

type ClassicProduct = RowDataPacket & {
  id: number;
  public_id: string;
  slug: string;
  name: string;
  status: keyof typeof STATUS;
  visibility: 'public' | 'hidden' | 'search_only';
  product_type: string;
  template_suffix: string | null;
  short_description: string | null;
  description: string | null;
  brand_name: string | null;
  is_gift_card: number;
  published_at: Date | null;
  created_at: Date;
  meta_title: string | null;
  meta_description: string | null;
};

/** Why a classic product cannot be moved as it is, or null. */
async function blocker(productId: number, tx: Executor): Promise<string | null> {
  const options = await queryOne<RowDataPacket & { n: number }>('SELECT COUNT(*) AS n FROM product_options WHERE shop_id = ? AND product_id = ?', [shopId(), productId], tx);
  if (Number(options?.n ?? 0) > MAX_OPTIONS) return `It has more than ${MAX_OPTIONS} options. Remove one in the classic editor first.`;
  const orphan = await queryOne<RowDataPacket & { id: number }>(
    `SELECT v.id FROM product_variants v
      WHERE v.shop_id = ? AND v.product_id = ? AND v.deleted_at IS NULL
        AND (SELECT COUNT(*) FROM variant_option_values vov WHERE vov.shop_id = v.shop_id AND vov.variant_id = v.id)
            <> (SELECT COUNT(*) FROM product_options o WHERE o.shop_id = v.shop_id AND o.product_id = v.product_id)
      LIMIT 1`,
    [shopId(), productId],
    tx,
  );
  if (orphan) return 'A variant does not have a value for every option. Fix it in the classic editor first.';
  const live = await queryOne<RowDataPacket & { n: number }>('SELECT COUNT(*) AS n FROM product_variants WHERE shop_id = ? AND product_id = ? AND deleted_at IS NULL', [shopId(), productId], tx);
  if (Number(live?.n ?? 0) === 0) return 'It has no variants.';
  return null;
}

export const adoption = {
  /** Classic products not yet moved, with whether each can be moved as it is. */
  async candidates({ q, limit = 50 }: { q?: string; limit?: number }) {
    const rows = await query<RowDataPacket & { id: number; name: string; slug: string; status: string; variants: number }>(
      `SELECT p.id, p.name, p.slug, p.status,
              (SELECT COUNT(*) FROM product_variants v WHERE v.shop_id = p.shop_id AND v.product_id = p.id AND v.deleted_at IS NULL) AS variants
         FROM products p
        WHERE p.shop_id = ? AND p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM catalog_products c WHERE c.shop_id = p.shop_id AND c.id = p.id)
          ${q?.trim() ? 'AND (p.name LIKE ? OR p.slug LIKE ?)' : ''}
        ORDER BY p.updated_at DESC, p.id DESC
        LIMIT ${Math.min(Math.max(limit, 1), 200)}`,
      [shopId(), ...(q?.trim() ? [`%${q.trim()}%`, `%${q.trim()}%`] : [])],
    );
    const remaining = await queryOne<RowDataPacket & { n: number }>(
      `SELECT COUNT(*) AS n FROM products p WHERE p.shop_id = ? AND p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM catalog_products c WHERE c.shop_id = p.shop_id AND c.id = p.id)`,
      [shopId()],
    );
    return {
      products: rows.map((row) => ({ id: Number(row.id), title: row.name, handle: row.slug, status: row.status, variant_count: Number(row.variants) })),
      remaining: Number(remaining?.n ?? 0),
    };
  },

  /** Moves the given classic products; each is its own transaction, so one refusal does not stop the rest. */
  async adoptMany(ids: number[], actor: AuthenticatedAdmin, meta: ActorMeta) {
    const done: number[] = [];
    const failed: { id: number; error: string }[] = [];
    for (const id of [...new Set(ids)]) {
      try {
        await this.adopt(id, actor, meta);
        done.push(id);
      } catch (error) {
        failed.push({ id, error: error instanceof ApiError ? error.message : 'Something went wrong.' });
      }
    }
    return { done, failed };
  },

  async adopt(productId: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<number> {
    return withTransaction(async (tx) => {
      const product = await queryOne<ClassicProduct>(
        `SELECT p.id, p.public_id, p.slug, p.name, p.status, p.visibility, p.product_type, p.template_suffix, p.short_description,
                p.description, b.name AS brand_name, p.is_gift_card, p.published_at, p.created_at, s.meta_title, s.meta_description
           FROM products p
           LEFT JOIN brands b ON b.shop_id = p.shop_id AND b.id = p.brand_id
           LEFT JOIN seo_meta s ON s.shop_id = p.shop_id AND s.entity_type = 'product' AND s.entity_id = p.id AND s.locale = 'en-IN'
          WHERE p.shop_id = ? AND p.id = ? AND p.deleted_at IS NULL
          FOR UPDATE`,
        [shopId(), productId],
        tx,
      );
      if (!product) throw ApiError.notFound('Product');
      if (await queryOne('SELECT id FROM catalog_products WHERE shop_id = ? AND id = ?', [shopId(), productId], tx)) {
        throw ApiError.conflict('This product is already in Products (new).', 'CATALOG_MANAGED', { catalog_url: `/catalog/products/${productId}` });
      }
      const problem = await blocker(productId, tx);
      if (problem) throw ApiError.conflict(`"${product.name}" cannot be moved yet. ${problem}`);

      const status = product.status === 'active' && product.visibility !== 'public' ? 'unlisted' : STATUS[product.status];
      await execute(
        `INSERT INTO catalog_products (id, shop_id, public_id, handle, title, description_html, summary, status, vendor, template_suffix,
                                       seo_title, seo_description, is_gift_card, published_at, origin, created_by_admin_id, updated_by_admin_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'classic', ?, ?, ?)`,
        [
          productId, shopId(), product.public_id, product.slug, product.name, product.description, product.short_description, status,
          product.brand_name, product.template_suffix, product.meta_title, product.meta_description?.slice(0, 320) ?? null,
          Number(product.is_gift_card) || product.product_type === 'gift_card' ? 1 : 0, product.published_at, actor.id, actor.id, product.created_at,
        ],
        tx,
      );

      // options and their values, same ids, positions from 1
      const options = await query<RowDataPacket & { id: number; name: string; display_type: keyof typeof DISPLAY }>(
        'SELECT id, name, display_type FROM product_options WHERE shop_id = ? AND product_id = ? ORDER BY position, id',
        [shopId(), productId],
        tx,
      );
      for (const [index, option] of options.entries()) {
        await execute(
          'INSERT INTO catalog_product_options (id, shop_id, product_id, name, position, display_style) VALUES (?, ?, ?, ?, ?, ?)',
          [option.id, shopId(), productId, option.name, index + 1, DISPLAY[option.display_type] ?? 'buttons'],
          tx,
        );
        const values = await query<RowDataPacket & { id: number; value: string; swatch_hex: string | null; swatch_media_id: number | null }>(
          'SELECT id, value, swatch_hex, swatch_media_id FROM product_option_values WHERE shop_id = ? AND option_id = ? ORDER BY position, id',
          [shopId(), option.id],
          tx,
        );
        for (const [valueIndex, value] of values.entries()) {
          await execute(
            'INSERT INTO catalog_option_values (id, shop_id, product_id, option_id, name, position, swatch_color, swatch_media_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [value.id, shopId(), productId, option.id, value.value, valueIndex + 1, value.swatch_hex, value.swatch_media_id],
            tx,
          );
        }
      }

      // gallery first: a variant's image must be one of the product's own
      const gallery = await query<RowDataPacket & { media_id: number; alt_override: string | null }>(
        `SELECT media_id, alt_override FROM media_attachments
          WHERE shop_id = ? AND attachable_type = 'product' AND attachable_id = ? AND collection = 'gallery'
          ORDER BY sort_order, id`,
        [shopId(), productId],
        tx,
      );
      for (const [index, row] of gallery.entries()) {
        await execute('INSERT IGNORE INTO catalog_product_media (shop_id, product_id, media_id, position, alt) VALUES (?, ?, ?, ?, ?)', [shopId(), productId, row.media_id, index + 1, row.alt_override], tx);
      }
      const galleryIds = new Set(gallery.map((row) => Number(row.media_id)));

      // variants, same ids; money as Shopify has it: compare-at only when above the price
      const variants = await query<
        RowDataPacket & {
          id: number; public_id: string; sku: string; variant_title: string | null; net_quantity: string | null; barcode: string | null; weight_grams: number | null;
          length_mm: number | null; width_mm: number | null; height_mm: number | null; mrp: string; price: string; cost_price: string | null;
          tax_class_id: number | null; track_inventory: number; allow_backorder: number; max_per_order: number | null; image_media_id: number | null;
        }
      >(
        `SELECT id, public_id, sku, variant_title, net_quantity, barcode, weight_grams, length_mm, width_mm, height_mm, mrp, price, cost_price,
                tax_class_id, track_inventory, allow_backorder, max_per_order, image_media_id
           FROM product_variants WHERE shop_id = ? AND product_id = ? AND deleted_at IS NULL
          ORDER BY is_default DESC, position, id`,
        [shopId(), productId],
        tx,
      );
      const links = await query<RowDataPacket & { variant_id: number; option_id: number; option_value_id: number }>(
        `SELECT vov.variant_id, vov.option_id, vov.option_value_id FROM variant_option_values vov
           JOIN product_variants v ON v.shop_id = vov.shop_id AND v.id = vov.variant_id
          WHERE vov.shop_id = ? AND v.product_id = ? AND v.deleted_at IS NULL`,
        [shopId(), productId],
        tx,
      );
      let optionOrder = options.map((option) => Number(option.id));

      // The classic editor let variants differ by their title alone ("50 g", "15 g travel"), with no
      // option. Products (new), like Shopify, tells variants apart by option values, so those titles
      // become the values of one option, "Variant" — which the merchant can rename; ids are kept.
      const titleValue = new Map<number, number>();
      if (options.length === 0 && variants.length > 1) {
        const optionId = await projection.allocateOption(tx, productId, 1);
        await execute("INSERT INTO catalog_product_options (id, shop_id, product_id, name, position, display_style) VALUES (?, ?, ?, 'Variant', 1, 'buttons')", [optionId, shopId(), productId], tx);
        const taken = new Set<string>();
        for (const [index, variant] of variants.entries()) {
          let name = (variant.variant_title?.trim() || variant.net_quantity?.trim() || variant.sku).slice(0, VALUE_NAME_MAX);
          if (taken.has(name.toLowerCase())) name = `${name.slice(0, Math.max(1, VALUE_NAME_MAX - variant.sku.length - 3))} (${variant.sku})`.slice(0, VALUE_NAME_MAX);
          taken.add(name.toLowerCase());
          const valueId = await projection.allocateValue(tx, optionId, index + 1);
          await execute(
            'INSERT INTO catalog_option_values (id, shop_id, product_id, option_id, name, position) VALUES (?, ?, ?, ?, ?, ?)',
            [valueId, shopId(), productId, optionId, name, index + 1],
            tx,
          );
          titleValue.set(Number(variant.id), valueId);
        }
        optionOrder = [optionId];
      }

      const seenKeys = new Set<string>();
      for (const [index, variant] of variants.entries()) {
        const mine = links.filter((link) => Number(link.variant_id) === Number(variant.id));
        const valueIds = titleValue.size
          ? [titleValue.get(Number(variant.id))!]
          : optionOrder.map((optionId) => Number(mine.find((link) => Number(link.option_id) === optionId)?.option_value_id));
        const key = optionsKey(valueIds);
        if (seenKeys.has(key)) throw ApiError.conflict(`"${product.name}" cannot be moved yet. Two of its variants are the same combination; remove one in the classic editor first.`);
        seenKeys.add(key);
        const price = Number(variant.price);
        const mrp = Number(variant.mrp);
        await execute(
          `INSERT INTO catalog_variants (id, shop_id, public_id, product_id, position, title, options_key, sku, barcode, price, compare_at_price, cost,
                                         tax_class_id, inventory_tracked, inventory_policy, weight, weight_unit, length, width, height, dimension_unit,
                                         media_id, max_per_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'g', ?, ?, ?, 'mm', ?, ?)`,
          [
            variant.id, shopId(), variant.public_id, productId, index + 1,
            DEFAULT_TITLE,
            key, variant.sku, variant.barcode, price, mrp > price ? mrp : null, variant.cost_price,
            variant.tax_class_id, Number(variant.track_inventory) ? 1 : 0, Number(variant.allow_backorder) ? 'continue' : 'deny',
            variant.weight_grams, variant.length_mm, variant.width_mm, variant.height_mm,
            variant.image_media_id && galleryIds.has(Number(variant.image_media_id)) ? variant.image_media_id : null, variant.max_per_order,
          ],
          tx,
        );
        for (const [position, valueId] of valueIds.entries()) {
          await execute('INSERT INTO catalog_variant_options (shop_id, variant_id, option_id, value_id) VALUES (?, ?, ?, ?)', [shopId(), variant.id, optionOrder[position], valueId], tx);
        }
      }
      // Titles are the values, "Red / M", as every save in Products (new) writes them.
      await execute(
        `UPDATE catalog_variants v
            SET v.title = LEFT((SELECT GROUP_CONCAT(ov.name ORDER BY o.position SEPARATOR ' / ')
                                  FROM catalog_variant_options vo
                                  JOIN catalog_product_options o ON o.shop_id = vo.shop_id AND o.id = vo.option_id
                                  JOIN catalog_option_values ov ON ov.shop_id = vo.shop_id AND ov.id = vo.value_id
                                 WHERE vo.shop_id = v.shop_id AND vo.variant_id = v.id), 255)
          WHERE v.shop_id = ? AND v.product_id = ? AND v.options_key <> 'default'`,
        [shopId(), productId],
        tx,
      );

      // tags: the classic ones are slugs; their display names are the closest thing to what was typed
      await execute(
        `INSERT IGNORE INTO catalog_product_tags (shop_id, product_id, tag)
         SELECT tg.shop_id, ?, LEFT(t.name, 255) FROM taggables tg JOIN tags t ON t.id = tg.tag_id
          WHERE tg.shop_id = ? AND tg.taggable_type = 'product' AND tg.taggable_id = ?`,
        [productId, shopId(), productId],
        tx,
      );

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
      await projection.sync(productId, tx);

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'product.updated',
          entityType: 'product',
          entityId: productId,
          summary: `Moved "${product.name}" to Products (new)`,
          changes: { managed_by: { from: 'classic', to: 'catalog' } },
          context: { request_id: meta.requestId, source: 'catalog', public_id: product.public_id },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return productId;
    });
  },
};
