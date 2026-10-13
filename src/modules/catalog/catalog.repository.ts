import { ApiError } from '../../core/ApiError';
import { pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';
import { storage } from '../media/storage';
import { decodeCursor, encodeCursor } from './customData.service';

/**
 * Reads of the catalog: one product with everything the editor shows, and the
 * product list — keyset-paginated so page 400 of a 100,000-product store costs
 * what page 1 does, on indexes that start with (shop_id, deleted_at, …).
 */

export type CatalogStatus = 'draft' | 'active' | 'unlisted' | 'archived';

export interface ProductRow extends RowDataPacket {
  id: number;
  public_id: string;
  handle: string;
  title: string;
  description_html: string | null;
  summary: string | null;
  status: CatalogStatus;
  vendor: string | null;
  product_type: string | null;
  category_code: string | null;
  category_name: string | null;
  category_full_name: string | null;
  template_suffix: string | null;
  seo_title: string | null;
  seo_description: string | null;
  is_gift_card: number;
  option_count: number;
  variant_count: number;
  price_min: string | null;
  price_max: string | null;
  published_at: Date | null;
  origin: 'native' | 'classic';
  version: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface OptionRow extends RowDataPacket {
  id: number;
  name: string;
  position: number;
  display_style: 'dropdown' | 'buttons' | 'swatches';
  linked_metaobject_type: string | null;
}

export interface ValueRow extends RowDataPacket {
  id: number;
  option_id: number;
  name: string;
  position: number;
  swatch_color: string | null;
  swatch_media_id: number | null;
  swatch_key: string | null;
  swatch_url: string | null;
  linked_metaobject_id: number | null;
}

export interface VariantRow extends RowDataPacket {
  id: number;
  public_id: string;
  product_id: number;
  position: number;
  title: string;
  options_key: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  compare_at_price: string | null;
  cost: string | null;
  taxable: number;
  tax_class_id: number | null;
  hsn_code: string | null;
  inventory_tracked: number;
  inventory_policy: 'deny' | 'continue';
  requires_shipping: number;
  weight: string | null;
  weight_unit: 'g' | 'kg' | 'oz' | 'lb';
  length: string | null;
  width: string | null;
  height: string | null;
  dimension_unit: 'mm' | 'cm' | 'm' | 'in';
  origin_country: string | null;
  hs_code: string | null;
  unit_price_quantity: string | null;
  unit_price_quantity_unit: string | null;
  unit_price_reference: string | null;
  unit_price_reference_unit: string | null;
  media_id: number | null;
  max_per_order: number | null;
  deleted_at: Date | null;
}

export interface MediaRow extends RowDataPacket {
  media_id: number;
  position: number;
  alt: string | null;
  storage_key: string | null;
  absolute_url: string | null;
  media_type: string;
  width: number | null;
  height: number | null;
  default_alt: string | null;
}

const PRODUCT_COLUMNS = `p.id, p.public_id, p.handle, p.title, p.description_html, p.summary, p.status, p.vendor, p.product_type,
  p.category_code, t.name AS category_name, t.full_name AS category_full_name, p.template_suffix, p.seo_title, p.seo_description,
  p.is_gift_card, p.option_count, p.variant_count, p.price_min, p.price_max, p.published_at, p.origin, p.version,
  p.created_at, p.updated_at, p.deleted_at`;

export const VARIANT_COLUMNS = `id, public_id, product_id, position, title, options_key, sku, barcode, price, compare_at_price, cost, taxable,
  tax_class_id, hsn_code, inventory_tracked, inventory_policy, requires_shipping, weight, weight_unit, length, width, height,
  dimension_unit, origin_country, hs_code, unit_price_quantity, unit_price_quantity_unit, unit_price_reference,
  unit_price_reference_unit, media_id, max_per_order, deleted_at`;

export function mediaUrlOf(row: { storage_key?: string | null; absolute_url?: string | null }): string | null {
  if (row.absolute_url) return row.absolute_url;
  return row.storage_key ? storage.publicUrl(row.storage_key) : null;
}

export interface ListFilters {
  status?: CatalogStatus;
  q?: string;
  vendor?: string;
  product_type?: string;
  tag?: string;
  category?: string;
  collection_id?: number;
  origin?: 'native' | 'classic';
  sort?: SortKey;
  limit?: number;
  after?: string | null;
}

export const SORTS = {
  updated_desc: { column: 'p.updated_at', dir: 'DESC' },
  created_desc: { column: 'p.created_at', dir: 'DESC' },
  created_asc: { column: 'p.created_at', dir: 'ASC' },
  title_asc: { column: 'p.title', dir: 'ASC' },
  title_desc: { column: 'p.title', dir: 'DESC' },
  price_asc: { column: 'p.price_min', dir: 'ASC' },
  price_desc: { column: 'p.price_min', dir: 'DESC' },
} as const;

export type SortKey = keyof typeof SORTS;

function like(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Words for MySQL's boolean full-text mode: each must appear, as a prefix. */
function fullTextQuery(text: string): string | null {
  const words = text
    .replace(/[+\-<>()~*"@]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .slice(0, 8);
  return words.length ? words.map((word) => `+${word}*`).join(' ') : null;
}

function sortValue(row: ProductRow, sort: SortKey): unknown {
  const column = SORTS[sort].column.slice(2) as keyof ProductRow;
  const value = row[column];
  return value instanceof Date ? value.toISOString() : value;
}

export const catalogRepository = {
  async product(id: number, exec: Executor = pool, { withDeleted = false } = {}): Promise<ProductRow | null> {
    return queryOne<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM catalog_products p
         LEFT JOIN product_taxonomy_categories t ON t.code = p.category_code
        WHERE p.shop_id = ? AND p.id = ?${withDeleted ? '' : ' AND p.deleted_at IS NULL'}`,
      [shopId(), id],
      exec,
    );
  },

  async productOrFail(id: number, exec: Executor = pool): Promise<ProductRow> {
    const row = await this.product(id, exec);
    if (!row) throw ApiError.notFound('Product');
    return row;
  },

  async isManaged(productId: number, exec: Executor = pool): Promise<boolean> {
    return (await queryOne('SELECT id FROM catalog_products WHERE shop_id = ? AND id = ?', [shopId(), productId], exec)) !== null;
  },

  async managedAmong(productIds: number[], exec: Executor = pool): Promise<Set<number>> {
    if (productIds.length === 0) return new Set();
    const rows = await query<RowDataPacket & { id: number }>(
      `SELECT id FROM catalog_products WHERE shop_id = ? AND id IN (${productIds.map(() => '?').join(', ')})`,
      [shopId(), ...productIds],
      exec,
    );
    return new Set(rows.map((row) => Number(row.id)));
  },

  async options(productId: number, exec: Executor = pool): Promise<OptionRow[]> {
    return query<OptionRow>(
      'SELECT id, name, position, display_style, linked_metaobject_type FROM catalog_product_options WHERE shop_id = ? AND product_id = ? ORDER BY position, id',
      [shopId(), productId],
      exec,
    );
  },

  async values(productId: number, exec: Executor = pool): Promise<ValueRow[]> {
    return query<ValueRow>(
      `SELECT v.id, v.option_id, v.name, v.position, v.swatch_color, v.swatch_media_id, v.linked_metaobject_id,
              m.storage_key AS swatch_key, m.absolute_url AS swatch_url
         FROM catalog_option_values v
         LEFT JOIN media m ON m.shop_id = v.shop_id AND m.id = v.swatch_media_id
        WHERE v.shop_id = ? AND v.product_id = ?
        ORDER BY v.option_id, v.position, v.id`,
      [shopId(), productId],
      exec,
    );
  },

  async variants(productId: number, exec: Executor = pool, { withDeleted = false } = {}): Promise<VariantRow[]> {
    return query<VariantRow>(
      `SELECT ${VARIANT_COLUMNS} FROM catalog_variants
        WHERE shop_id = ? AND product_id = ?${withDeleted ? '' : ' AND deleted_at IS NULL'}
        ORDER BY position, id`,
      [shopId(), productId],
      exec,
    );
  },

  /** variant id → value id for each option. */
  async variantOptions(productId: number, exec: Executor = pool): Promise<Map<number, Map<number, number>>> {
    const rows = await query<RowDataPacket & { variant_id: number; option_id: number; value_id: number }>(
      `SELECT vo.variant_id, vo.option_id, vo.value_id
         FROM catalog_variant_options vo
         JOIN catalog_variants v ON v.shop_id = vo.shop_id AND v.id = vo.variant_id
        WHERE vo.shop_id = ? AND v.product_id = ? AND v.deleted_at IS NULL`,
      [shopId(), productId],
      exec,
    );
    const out = new Map<number, Map<number, number>>();
    for (const row of rows) {
      const map = out.get(Number(row.variant_id)) ?? new Map<number, number>();
      map.set(Number(row.option_id), Number(row.value_id));
      out.set(Number(row.variant_id), map);
    }
    return out;
  },

  async media(productId: number, exec: Executor = pool): Promise<MediaRow[]> {
    return query<MediaRow>(
      `SELECT pm.media_id, pm.position, pm.alt, m.storage_key, m.absolute_url, m.media_type, m.width, m.height, m.alt_text AS default_alt
         FROM catalog_product_media pm
         JOIN media m ON m.shop_id = pm.shop_id AND m.id = pm.media_id
        WHERE pm.shop_id = ? AND pm.product_id = ?
        ORDER BY pm.position, pm.media_id`,
      [shopId(), productId],
      exec,
    );
  },

  async tags(productId: number, exec: Executor = pool): Promise<string[]> {
    const rows = await query<RowDataPacket & { tag: string }>('SELECT tag FROM catalog_product_tags WHERE shop_id = ? AND product_id = ? ORDER BY tag', [shopId(), productId], exec);
    return rows.map((row) => row.tag);
  },

  /** On-hand and available per variant and location, for the editor. */
  async stock(variantIds: number[], exec: Executor = pool) {
    if (variantIds.length === 0) return [];
    return query<RowDataPacket & { variant_id: number; location_id: number; on_hand: number; available: number; reserved: number; incoming: number }>(
      `SELECT variant_id, location_id, quantity_on_hand AS on_hand, quantity_available AS available,
              quantity_reserved AS reserved, quantity_incoming AS incoming
         FROM inventory_items
        WHERE shop_id = ? AND variant_id IN (${variantIds.map(() => '?').join(', ')})`,
      [shopId(), ...variantIds],
      exec,
    );
  },

  async locations(exec: Executor = pool) {
    return query<RowDataPacket & { id: number; name: string; is_default: number; is_active: number }>(
      'SELECT id, name, is_default, is_active FROM inventory_locations WHERE shop_id = ? ORDER BY is_default DESC, priority, name',
      [shopId()],
      exec,
    );
  },

  async list(filters: ListFilters) {
    const sort: SortKey = filters.sort && filters.sort in SORTS ? filters.sort : 'updated_desc';
    const { column, dir } = SORTS[sort];
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
    const where: string[] = ['p.shop_id = ?', 'p.deleted_at IS NULL'];
    const params: unknown[] = [shopId()];

    if (filters.status) {
      where.push('p.status = ?');
      params.push(filters.status);
    }
    if (filters.origin) {
      where.push('p.origin = ?');
      params.push(filters.origin);
    }
    if (filters.vendor) {
      where.push('p.vendor = ?');
      params.push(filters.vendor);
    }
    if (filters.product_type) {
      where.push('p.product_type = ?');
      params.push(filters.product_type);
    }
    if (filters.category) {
      where.push('(p.category_code = ? OR p.category_code LIKE ?)');
      params.push(filters.category, `${filters.category.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`);
    }
    if (filters.tag) {
      where.push('EXISTS (SELECT 1 FROM catalog_product_tags pt WHERE pt.shop_id = p.shop_id AND pt.product_id = p.id AND pt.tag = ?)');
      params.push(filters.tag);
    }
    if (filters.collection_id) {
      where.push('EXISTS (SELECT 1 FROM collection_products cp WHERE cp.shop_id = p.shop_id AND cp.product_id = p.id AND cp.collection_id = ?)');
      params.push(filters.collection_id);
    }
    const q = filters.q?.trim();
    if (q) {
      const ft = fullTextQuery(q);
      const parts = ['p.title LIKE ?', 'p.handle LIKE ?'];
      const qParams: unknown[] = [like(q), like(q)];
      if (ft) {
        parts.push('MATCH(p.title, p.vendor, p.product_type) AGAINST (? IN BOOLEAN MODE)');
        qParams.push(ft);
      }
      parts.push(
        'EXISTS (SELECT 1 FROM catalog_variants sv WHERE sv.shop_id = p.shop_id AND sv.product_id = p.id AND sv.deleted_at IS NULL AND (sv.sku LIKE ? OR sv.barcode = ?))',
      );
      qParams.push(`${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, q);
      where.push(`(${parts.join(' OR ')})`);
      params.push(...qParams);
    }
    const filterWhere = [...where];
    const filterParams = [...params];
    if (filters.after) {
      const [value, id] = decodeCursor(filters.after);
      const op = dir === 'DESC' ? '<' : '>';
      where.push(`(${column} ${op} ? OR (${column} = ? AND p.id ${op} ?))`);
      const cursorValue = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : value;
      params.push(cursorValue, cursorValue, Number(id));
    }

    const rows = await query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM catalog_products p
         LEFT JOIN product_taxonomy_categories t ON t.code = p.category_code
        WHERE ${where.join(' AND ')}
        ORDER BY ${column} ${dir}, p.id ${dir}
        LIMIT ${limit + 1}`,
      params,
    );
    const page = rows.slice(0, limit);
    const ids = page.map((row) => Number(row.id));

    const [images, stock, totalRow] = await Promise.all([
      ids.length
        ? query<RowDataPacket & { product_id: number; storage_key: string | null; absolute_url: string | null }>(
            `SELECT product_id, storage_key, absolute_url FROM (
               SELECT pm.product_id, m.storage_key, m.absolute_url,
                      ROW_NUMBER() OVER (PARTITION BY pm.product_id ORDER BY pm.position, pm.media_id) AS rn
                 FROM catalog_product_media pm
                 JOIN media m ON m.shop_id = pm.shop_id AND m.id = pm.media_id
                WHERE pm.shop_id = ? AND pm.product_id IN (${ids.map(() => '?').join(', ')})
             ) ranked WHERE rn = 1`,
            [shopId(), ...ids],
          )
        : Promise.resolve([]),
      ids.length
        ? query<RowDataPacket & { product_id: number; tracked: number; available: string | null }>(
            `SELECT v.product_id,
                    COUNT(DISTINCT CASE WHEN v.inventory_tracked = 1 THEN v.id END) AS tracked,
                    SUM(CASE WHEN v.inventory_tracked = 1 THEN ii.quantity_available ELSE 0 END) AS available
               FROM catalog_variants v
               LEFT JOIN inventory_items ii ON ii.shop_id = v.shop_id AND ii.variant_id = v.id
              WHERE v.shop_id = ? AND v.deleted_at IS NULL AND v.product_id IN (${ids.map(() => '?').join(', ')})
              GROUP BY v.product_id`,
            [shopId(), ...ids],
          )
        : Promise.resolve([]),
      filters.after ? Promise.resolve(null) : queryOne<RowDataPacket & { n: number }>(`SELECT COUNT(*) AS n FROM catalog_products p WHERE ${filterWhere.join(' AND ')}`, filterParams),
    ]);
    const imageBy = new Map(images.map((row) => [Number(row.product_id), mediaUrlOf(row)]));
    const stockBy = new Map(stock.map((row) => [Number(row.product_id), row]));
    const last = page[page.length - 1];

    return {
      products: page.map((row) => {
        const inventory = stockBy.get(Number(row.id));
        return {
          id: Number(row.id),
          handle: row.handle,
          title: row.title,
          status: row.status,
          vendor: row.vendor,
          product_type: row.product_type,
          category: row.category_code ? { code: row.category_code, name: row.category_name, full_name: row.category_full_name } : null,
          image: imageBy.get(Number(row.id)) ?? null,
          option_count: Number(row.option_count),
          variant_count: Number(row.variant_count),
          price_min: row.price_min === null ? null : Number(row.price_min),
          price_max: row.price_max === null ? null : Number(row.price_max),
          inventory: {
            tracked_variants: Number(inventory?.tracked ?? 0),
            available: Number(inventory?.available ?? 0),
          },
          origin: row.origin,
          updated_at: new Date(row.updated_at).toISOString(),
          created_at: new Date(row.created_at).toISOString(),
        };
      }),
      next: rows.length > limit && last ? encodeCursor([sortValue(last, sort), Number(last.id)]) : null,
      total: totalRow ? Number(totalRow.n) : null,
    };
  },

  async statusCounts(): Promise<Record<string, number>> {
    const rows = await query<RowDataPacket & { status: string; n: number }>(
      'SELECT status, COUNT(*) AS n FROM catalog_products WHERE shop_id = ? AND deleted_at IS NULL GROUP BY status',
      [shopId()],
    );
    const counts: Record<string, number> = { all: 0, active: 0, draft: 0, unlisted: 0, archived: 0 };
    for (const row of rows) {
      counts[row.status] = Number(row.n);
      counts.all += Number(row.n);
    }
    return counts;
  },

  /** Distinct vendors, product types or tags already in use, for autocomplete and filters. */
  async suggestions(field: 'vendor' | 'product_type' | 'tag', q: string, limit = 20): Promise<string[]> {
    const search = q.trim() ? like(q.trim()) : '%';
    if (field === 'tag') {
      const rows = await query<RowDataPacket & { value: string }>(
        'SELECT tag AS value, COUNT(*) AS n FROM catalog_product_tags WHERE shop_id = ? AND tag LIKE ? GROUP BY tag ORDER BY n DESC, tag LIMIT ?',
        [shopId(), search, limit],
      );
      return rows.map((row) => row.value);
    }
    const rows = await query<RowDataPacket & { value: string }>(
      `SELECT ${field} AS value, COUNT(*) AS n FROM catalog_products
        WHERE shop_id = ? AND deleted_at IS NULL AND ${field} IS NOT NULL AND ${field} <> '' AND ${field} LIKE ?
        GROUP BY ${field} ORDER BY n DESC, ${field} LIMIT ?`,
      [shopId(), search, limit],
    );
    return rows.map((row) => row.value);
  },

  async taxonomy({ q, parent }: { q?: string; parent?: string | null }) {
    type Row = RowDataPacket & { code: string; parent_code: string | null; name: string; full_name: string; level: number; is_leaf: number };
    const rows = q?.trim()
      ? await query<Row>(
          'SELECT code, parent_code, name, full_name, level, is_leaf FROM product_taxonomy_categories WHERE full_name LIKE ? ORDER BY level, sort_order LIMIT 50',
          [like(q.trim())],
        )
      : await query<Row>(
          `SELECT code, parent_code, name, full_name, level, is_leaf FROM product_taxonomy_categories
            WHERE ${parent ? 'parent_code = ?' : 'parent_code IS NULL'} ORDER BY sort_order`,
          parent ? [parent] : [],
        );
    return rows.map((row) => ({ code: row.code, parent_code: row.parent_code, name: row.name, full_name: row.full_name, level: Number(row.level), is_leaf: Number(row.is_leaf) === 1 }));
  },

  async category(code: string, exec: Executor = pool) {
    return queryOne<RowDataPacket & { code: string; name: string; full_name: string }>('SELECT code, name, full_name FROM product_taxonomy_categories WHERE code = ?', [code], exec);
  },
};
