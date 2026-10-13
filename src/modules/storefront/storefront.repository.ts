import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId, shopIdSql, tenancy } from '../../platform/tenancy/context';

/**
 * Reads for the public storefront.
 *
 * Deliberately separate from the admin repositories rather than shared. The
 * admin needs drafts, costs and internal notes; the storefront must never be
 * one forgotten `WHERE` away from leaking them. Every query here hard-codes
 * `status = 'active'` and `visibility = 'public'`, and selects columns by name
 * instead of `p.*`, so a new internal column cannot appear in a public payload
 * by accident.
 */

export interface StorefrontProductRow extends RowDataPacket {
  id: number;
  slug: string;
  name: string;
  subtitle: string | null;
  short_description: string | null;
  min_price: string | null;
  max_price: string | null;
  card_price: string | null;
  card_mrp: string | null;
  /** The variant the card quotes — for a market's fixed price. */
  card_variant_id?: number | null;
  is_new: number;
  is_bestseller: number;
  badge: string | null;
  /** When a hand-written badge stops being shown. Null means it never does. */
  badge_expires_at: Date | null;
  rating_average: string;
  review_count: number;
  total_sold: number;
  category_name: string | null;
  category_slug: string | null;
  primary_image_key: string | null;
  primary_image_alt: string | null;
  total_inventory: number;
  published_at: Date | null;
}

export interface StorefrontProductDetailRow extends StorefrontProductRow {
  description: string | null;
  full_inci: string | null;
  texture: string | null;
  scent: string | null;
  suitability_note: string | null;
  patch_test_note: string | null;
  routine_position: string | null;
  time_of_day: string | null;
  country_of_origin: string | null;
  shelf_life_months: number | null;
  pao_months: number | null;
  category_id: number | null;
  meta_title: string | null;
  meta_description: string | null;
  // JSON columns arrive parsed from mysql2, but a hand-edited row can hold a
  // string, so the service parses defensively rather than trusting the type.
  benefits: unknown;
  key_ingredients: unknown;
  free_from: unknown;
  skin_types: unknown;
  skin_concerns: unknown;
  best_used_with: unknown;
  certifications: unknown;
  claims: unknown;
  awards: unknown;
  press_features: unknown;
  regulatory_approvals: unknown;
  ingredient_highlights: string | null;
  contraindications: string | null;
  fragrance_disclosure: string | null;
  formulation_type: string | null;
  ph_level: string | null;
  finish: string | null;
  is_hypoallergenic: number;
  is_non_comedogenic: number;
  pregnancy_safe: string | null;
  usage_instructions: string | null;
  application_method: string | null;
  usage_frequency: string | null;
  results_timeline: string | null;
  texture_description: string | null;
  absorption_rate: string | null;
  feel_on_skin: string | null;
  packaging_type: string | null;
  packaging_material: string | null;
  is_recyclable: number;
  is_refillable: number;
  is_eco_friendly: number;
  storage_instructions: string | null;
  disposal_instructions: string | null;
  manufacturer_name: string | null;
  manufacturer_address: string | null;
  marketed_by_name: string | null;
  marketed_by_address: string | null;
  manufacturing_licence_no: string | null;
  customer_care_contact: string | null;
}

export interface StorefrontVariantRow extends RowDataPacket {
  id: number;
  sku: string;
  variant_title: string | null;
  mrp: string;
  price: string;
  position: number;
  is_default: number;
  available: number;
  track_inventory: number;
  size_description: string | null;
  /** Comma-separated option_value ids, or null on a variant with no options. */
  option_value_ids: string | null;
}

/**
 * A buyable row as a card needs it: enough to label a pill and put it in a bag.
 *
 * Deliberately narrower than {@link StorefrontVariantRow} — a shelf of twenty
 * products does not need each one's shade mapping, and fetching it would be
 * twenty joins for something no card draws.
 */
export interface CardVariantRow extends RowDataPacket {
  id: number;
  product_id: number;
  variant_title: string | null;
  size_description: string | null;
  mrp: string;
  price: string;
  position: number;
  is_default: number;
  available: number;
  track_inventory: number;
}

/** A gallery photograph, carrying the product it belongs to for grouping. */
export interface CardImageRow extends RowDataPacket {
  product_id: number;
  storage_key: string;
  alt_text: string | null;
  is_primary: number;
}

export interface StorefrontImageRow extends RowDataPacket {
  storage_key: string;
  alt_text: string | null;
  is_primary: number;
}

export interface CartRow extends RowDataPacket {
  id: number;
  token: string;
  customer_id: number | null;
  status: string;
  currency: string;
  coupon_code: string | null;
  /** Gift cards applied to the bag, in the order applied (JSON array of ids). */
  gift_card_ids: number[] | string | null;
  pincode: string | null;
  region_code: string | null;
  country_code: string | null;
}

export interface CartItemRow extends RowDataPacket {
  id: number;
  cart_id: number;
  product_id: number;
  variant_id: number;
  quantity: number;
  unit_price: string;
  unit_mrp: string;
  product_name: string;
  product_slug: string;
  variant_title: string | null;
  sku: string;
  image_key: string | null;
  available: number;
  track_inventory: number;
  /** From the variant's tax class, else the product's, else the shop's default class. */
  tax_rate: string;
  tax_inclusive: number;
  /** Not taxed where the rate comes from the destination (US sales tax). */
  tax_exempt: number;
  hsn_code: string | null;
  /** For weight-banded delivery rates; unknown weights count as nothing. */
  weight_grams: number | null;
  /** A gift card being bought: no delivery, no tax, no discounts, paid online. */
  is_gift_card: number;
}

/**
 * The variant a listing quotes: the one the product page will open on.
 *
 * Pairing MIN(price) with MAX(mrp) advertises a discount nobody can buy, and
 * quoting the cheapest size alone means the page loads showing a different
 * number than the card did. One variant, one price, one MRP — and the same
 * expression is used to sort and to filter, so a product cannot appear in the
 * "under ₹700" band displaying ₹1,049.
 */
const QUOTED_VARIANT_ORDER = `(v.id = p.default_variant_id) DESC, v.is_default DESC, v.position ASC, v.id ASC`;
// tenancy: scoped by caller — correlated to p, which every caller scopes.
const quotedVariant = (column: 'price' | 'mrp' | 'id') => `
  (SELECT v.${column} FROM product_variants v
    WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.status = 'active'
    ORDER BY ${QUOTED_VARIANT_ORDER} LIMIT 1)`;

export const CARD_PRICE_SQL = quotedVariant('price');

/** Only these are safe to expose; `p.*` would leak cost price and admin notes. */
const PUBLIC_COLUMNS = `
  p.id, p.slug, p.name, p.subtitle, p.short_description,
  p.min_price, p.max_price, p.is_new, p.is_bestseller, p.badge, p.badge_expires_at,
  p.rating_average, p.review_count, p.total_sold, p.published_at,
  c.name AS category_name, c.slug AS category_slug,
  ${quotedVariant('price')} AS card_price,
  ${quotedVariant('mrp')} AS card_mrp,
  ${quotedVariant('id')} AS card_variant_id,
  (SELECT m.storage_key FROM media_attachments ma
     JOIN media m ON m.id = ma.media_id
    WHERE ma.shop_id = p.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = p.id
      AND ma.collection = 'gallery'
    ORDER BY ma.is_primary DESC, ma.sort_order ASC LIMIT 1) AS primary_image_key,
  (SELECT m.alt_text FROM media_attachments ma
     JOIN media m ON m.id = ma.media_id
    WHERE ma.shop_id = p.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = p.id
      AND ma.collection = 'gallery'
    ORDER BY ma.is_primary DESC, ma.sort_order ASC LIMIT 1) AS primary_image_alt,
  (SELECT COALESCE(SUM(ii.quantity_available), 0)
     FROM inventory_items ii
     JOIN product_variants v2 ON v2.id = ii.variant_id
    WHERE v2.product_id = p.id AND v2.deleted_at IS NULL) AS total_inventory`;

/**
 * The one place "a shopper may see this" is defined — including "in this shop".
 *
 * Exported because the shelf rules build their own ranking queries against
 * `products p` and must answer this question identically — a shelf that can
 * surface a draft or an archived product is a worse bug than a shelf that is
 * empty, and two copies of this predicate would differ within a month.
 *
 * A function rather than a constant because the shop is part of the answer.
 * The id is inlined as an integer literal (see shopIdSql) so the fragment can
 * be spliced into queries without shifting their positional parameters.
 */
export function publicWhere(): string {
  return `p.shop_id = ${shopIdSql()} AND p.deleted_at IS NULL AND p.status = 'active' AND p.visibility = 'public'`;
}

/**
 * Whether anything of this product can actually be bought right now.
 *
 * Read from inventory rather than from the cached `products.in_stock` flag,
 * which is a denormalisation that goes stale between recalculations. Exported
 * for the same reason as the predicate above.
 */
// tenancy: scoped by caller — correlated to p, which every caller scopes.
export const IN_STOCK_SQL = `EXISTS (SELECT 1 FROM product_variants v3
                               JOIN inventory_items ii2 ON ii2.variant_id = v3.id
                              WHERE v3.product_id = p.id AND v3.deleted_at IS NULL
                                AND (v3.track_inventory = 0 OR ii2.quantity_available > 0))`;

export interface CatalogueFilters {
  search?: string;
  categorySlug?: string;
  collectionSlug?: string;
  concernSlug?: string;
  skinTypeSlug?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
}

function buildWhere(filters: CatalogueFilters): { clause: string; params: unknown[] } {
  const conditions = [publicWhere()];
  const params: unknown[] = [];

  if (filters.search) {
    conditions.push('(p.name LIKE ? OR p.subtitle LIKE ? OR p.short_description LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  if (filters.categorySlug) {
    // Includes descendants, so /shop/serums also shows sub-categories.
    conditions.push(`p.category_id IN (
      SELECT id FROM categories WHERE shop_id = p.shop_id AND deleted_at IS NULL AND (
        slug = ? OR path LIKE CONCAT(
          (SELECT path FROM categories WHERE shop_id = p.shop_id AND slug = ? LIMIT 1), '/%')))`);
    params.push(filters.categorySlug, filters.categorySlug);
  }
  if (filters.collectionSlug) {
    conditions.push(`EXISTS (SELECT 1 FROM collection_products cp
                               JOIN collections col ON col.id = cp.collection_id
                              WHERE cp.shop_id = p.shop_id AND cp.product_id = p.id AND col.slug = ?
                                AND col.is_active = 1 AND col.deleted_at IS NULL)`);
    params.push(filters.collectionSlug);
  }
  if (filters.concernSlug) {
    conditions.push(`EXISTS (SELECT 1 FROM product_concerns pc
                               JOIN skin_concerns sc ON sc.id = pc.concern_id
                              WHERE pc.shop_id = p.shop_id AND pc.product_id = p.id AND sc.slug = ?)`);
    params.push(filters.concernSlug);
  }
  if (filters.skinTypeSlug) {
    conditions.push(`EXISTS (SELECT 1 FROM product_skin_types pst
                               JOIN skin_types st ON st.id = pst.skin_type_id
                              WHERE pst.shop_id = p.shop_id AND pst.product_id = p.id AND st.slug = ?)`);
    params.push(filters.skinTypeSlug);
  }
  // Filtered on the price the card shows, not the cached `min_price`, so a
  // product never turns up in a band it does not display a price inside.
  if (filters.minPrice !== undefined) {
    conditions.push(`${CARD_PRICE_SQL} >= ?`);
    params.push(filters.minPrice);
  }
  if (filters.maxPrice !== undefined) {
    conditions.push(`${CARD_PRICE_SQL} <= ?`);
    params.push(filters.maxPrice);
  }
  if (filters.inStockOnly) {
    conditions.push(IN_STOCK_SQL);
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

export const storefrontRepository = {
  async listProducts(
    filters: CatalogueFilters,
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<StorefrontProductRow[]> {
    const { clause, params } = buildWhere(filters);
    return query<StorefrontProductRow>(
      `SELECT ${PUBLIC_COLUMNS}
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id AND c.shop_id = p.shop_id
        ${clause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  /**
   * The card rows for a known set of ids, in no particular order.
   *
   * Used by the shelves: a rule decides the ranking and hands over ids, and
   * this turns them into the same rows the shop listing produces, so a shelf
   * card and a listing card cannot drift apart. Ordering is the caller's job —
   * it already knows the ranking, and `FIELD()` on a long id list is slower
   * than a Map lookup in Node.
   *
   * The public predicate is applied again here rather than trusted from the
   * caller. Ids can be stale by the time they arrive — a product archived
   * between the ranking query and this one must not reach a shelf.
   */
  async productsByIds(ids: number[], exec: Executor = pool): Promise<StorefrontProductRow[]> {
    if (ids.length === 0) return [];
    return query<StorefrontProductRow>(
      `SELECT ${PUBLIC_COLUMNS}
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id AND c.shop_id = p.shop_id
        WHERE ${publicWhere()} AND p.id IN (${ids.map(() => '?').join(', ')})`,
      ids,
      exec,
    );
  },

  async countProducts(filters: CatalogueFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM products p LEFT JOIN categories c ON c.id = p.category_id AND c.shop_id = p.shop_id ${clause}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  async findProductBySlug(slug: string, exec: Executor = pool): Promise<StorefrontProductDetailRow | null> {
    return queryOne<StorefrontProductDetailRow>(
      `SELECT ${PUBLIC_COLUMNS},
              p.description, p.full_inci, p.texture, p.scent, p.suitability_note,
              p.patch_test_note, p.routine_position, p.time_of_day,
              p.country_of_origin, p.shelf_life_months, p.pao_months, p.category_id,
              -- The Online Store's alternate template ("product.<suffix>.json").
              p.template_suffix,
              -- What the product is and does.
              p.benefits, p.key_ingredients, p.ingredient_highlights, p.free_from,
              p.skin_types, p.skin_concerns, p.contraindications, p.fragrance_disclosure,
              p.formulation_type, p.ph_level, p.finish,
              p.is_hypoallergenic, p.is_non_comedogenic, p.pregnancy_safe,
              -- How to use it.
              p.usage_instructions, p.application_method, p.usage_frequency,
              p.best_used_with, p.results_timeline,
              -- How it feels and how it is packed.
              p.texture_description, p.absorption_rate, p.feel_on_skin,
              p.packaging_type, p.packaging_material, p.is_recyclable, p.is_refillable,
              p.is_eco_friendly, p.storage_instructions, p.disposal_instructions,
              -- Claims a shopper can check, and the ones the law requires us to
              -- publish: Legal Metrology Rule 6 and the Cosmetics Rules 2020 make
              -- the maker, the marketer, the licence and a care contact mandatory
              -- on a listing, not optional detail.
              p.certifications, p.claims, p.awards, p.press_features, p.regulatory_approvals,
              p.manufacturer_name, p.manufacturer_address,
              p.marketed_by_name, p.marketed_by_address,
              p.manufacturing_licence_no, p.customer_care_contact,
              -- SEO overrides live in seo_meta, not on the product row.
              (SELECT sm.meta_title FROM seo_meta sm
                WHERE sm.shop_id = p.shop_id AND sm.entity_type = 'product' AND sm.entity_id = p.id LIMIT 1) AS meta_title,
              (SELECT sm.meta_description FROM seo_meta sm
                WHERE sm.shop_id = p.shop_id AND sm.entity_type = 'product' AND sm.entity_id = p.id LIMIT 1) AS meta_description
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id AND c.shop_id = p.shop_id
        WHERE ${publicWhere()} AND p.slug = ?
        LIMIT 1`,
      [slug],
      exec,
    );
  },

  async variantsFor(productId: number, exec: Executor = pool): Promise<StorefrontVariantRow[]> {
    return query<StorefrontVariantRow>(
      `SELECT v.id, v.sku, v.variant_title, v.mrp, v.price, v.position, v.is_default, v.track_inventory,
              v.size_description,
              COALESCE((SELECT SUM(ii.quantity_available) FROM inventory_items ii
                         WHERE ii.variant_id = v.id), 0) AS available,
              -- Which shades this row is. The picker needs it to point a
              -- swatch at a buyable variant; without it, choosing "ribbon"
              -- changes the photograph and nothing else.
              (SELECT GROUP_CONCAT(vov.option_value_id ORDER BY vov.option_value_id)
                 FROM variant_option_values vov
                WHERE vov.variant_id = v.id) AS option_value_ids
         FROM product_variants v
        WHERE v.shop_id = ? AND v.product_id = ? AND v.deleted_at IS NULL AND v.status = 'active'
        ORDER BY v.is_default DESC, v.position, v.id`,
      [shopId(), productId],
      exec,
    );
  },

  /**
   * The buyable rows behind a set of cards, in one query.
   *
   * A shelf needs each product's sizes to offer them, and needs a variant id
   * to put anything in a bag at all — a card that says "Add to cart" with no
   * variant behind it is a button that cannot work. Fetched for the whole page
   * of products at once rather than per card, because the alternative is one
   * query per tile and a shelf of twenty is twenty round trips.
   */
  async cardVariants(productIds: number[], exec: Executor = pool): Promise<CardVariantRow[]> {
    if (productIds.length === 0) return [];
    const placeholders = productIds.map(() => '?').join(', ');
    return query<CardVariantRow>(
      `SELECT v.id, v.product_id, v.variant_title, v.size_description, v.price, v.mrp,
              v.is_default, v.position, v.track_inventory,
              COALESCE((SELECT SUM(ii.quantity_available) FROM inventory_items ii
                         WHERE ii.variant_id = v.id), 0) AS available
         FROM product_variants v
        WHERE v.shop_id = ? AND v.product_id IN (${placeholders})
          AND v.deleted_at IS NULL AND v.status = 'active'
        ORDER BY v.product_id, v.is_default DESC, v.position, v.id`,
      [shopId(), ...productIds],
      exec,
    );
  },

  /**
   * The gallery behind a set of cards, for the carousel on the shelf.
   *
   * Batched for the same reason as {@link cardVariants}: a shelf of twenty is
   * otherwise twenty round trips. Capped per product in the service rather than
   * here — a window function would do it in SQL, but the cap is a presentation
   * decision and a card's worth of rows is cheap either way.
   */
  async cardImages(productIds: number[], exec: Executor = pool): Promise<CardImageRow[]> {
    if (productIds.length === 0) return [];
    const placeholders = productIds.map(() => '?').join(', ');
    return query<CardImageRow>(
      `SELECT ma.attachable_id AS product_id, m.storage_key, m.alt_text, ma.is_primary
         FROM media_attachments ma
         JOIN media m ON m.id = ma.media_id
        WHERE ma.shop_id = ? AND ma.attachable_type = 'product' AND ma.attachable_id IN (${placeholders})
          AND ma.collection = 'gallery'
        ORDER BY ma.attachable_id, ma.is_primary DESC, ma.sort_order ASC, ma.id ASC`,
      [shopId(), ...productIds],
      exec,
    );
  },

  async imagesFor(productId: number, exec: Executor = pool): Promise<StorefrontImageRow[]> {
    return query<StorefrontImageRow>(
      `SELECT m.storage_key, m.alt_text, ma.is_primary
         FROM media_attachments ma
         JOIN media m ON m.id = ma.media_id
        WHERE ma.shop_id = ? AND ma.attachable_type = 'product' AND ma.attachable_id = ?
          AND ma.collection = 'gallery'
        ORDER BY ma.is_primary DESC, ma.sort_order ASC`,
      [shopId(), productId],
      exec,
    );
  },

  /**
   * What someone is chosen to see next.
   *
   * Whatever a merchandiser attached by hand comes first and in their order —
   * "the cleanser that goes before this" is a judgement no query makes as well
   * as a person. The category fill underneath is only there so the rail is
   * never empty on a product nobody has curated yet.
   */
  async curatedRelated(
    productId: number,
    limit: number,
    exec: Executor = pool,
  ): Promise<StorefrontProductRow[]> {
    return query<StorefrontProductRow>(
      `SELECT ${PUBLIC_COLUMNS}
         FROM product_related r
         JOIN products p ON p.id = r.related_product_id
         LEFT JOIN categories c ON c.id = p.category_id AND c.shop_id = p.shop_id
        WHERE ${publicWhere()} AND r.product_id = ?
        ORDER BY r.sort_order ASC, p.total_sold DESC
        LIMIT ?`,
      [productId, limit],
      exec,
    );
  },

  async relatedProducts(
    productId: number,
    categoryId: number | null,
    limit: number,
    excludeIds: number[] = [],
    exec: Executor = pool,
  ): Promise<StorefrontProductRow[]> {
    if (limit <= 0) return [];
    const excluded = [productId, ...excludeIds];
    const placeholders = excluded.map(() => '?').join(', ');
    return query<StorefrontProductRow>(
      `SELECT ${PUBLIC_COLUMNS}
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id AND c.shop_id = p.shop_id
        WHERE ${publicWhere()} AND p.id NOT IN (${placeholders})
          ${categoryId ? 'AND p.category_id = ?' : ''}
        ORDER BY p.is_bestseller DESC, p.total_sold DESC
        LIMIT ?`,
      categoryId ? [...excluded, categoryId, limit] : [...excluded, limit],
      exec,
    );
  },

  /**
   * Shades, with the photographs that belong to each and whether it can still
   * be bought. Availability is derived here for the same reason the admin
   * derives it: a stored sold-out flag goes stale the moment stock moves.
   */
  async shadesFor(productId: number, exec: Executor = pool) {
    return query<RowDataPacket & Record<string, unknown>>(
      `SELECT o.id AS option_id, o.name AS option_name, o.display_type,
              v.id, v.value, v.descriptor, v.badge, v.description,
              v.swatch_hex, sm.storage_key AS swatch_key, v.position,
              COALESCE((
                SELECT SUM(CASE WHEN pv.track_inventory = 0 OR pv.allow_backorder = 1
                                THEN 1 ELSE COALESCE(ii.quantity_available, 0) END)
                  FROM variant_option_values vov
                  JOIN product_variants pv ON pv.id = vov.variant_id
                   AND pv.deleted_at IS NULL AND pv.status = 'active'
                  LEFT JOIN inventory_items ii ON ii.variant_id = pv.id
                 WHERE vov.option_value_id = v.id), 0) AS sellable_units,
              (SELECT MIN(pv.price) FROM variant_option_values vov
                 JOIN product_variants pv ON pv.id = vov.variant_id
                  AND pv.deleted_at IS NULL AND pv.status = 'active'
                WHERE vov.option_value_id = v.id) AS price
         FROM product_options o
         JOIN product_option_values v ON v.option_id = o.id AND v.is_active = 1
         LEFT JOIN media sm ON sm.id = v.swatch_media_id AND sm.shop_id = o.shop_id
        WHERE o.shop_id = ? AND o.product_id = ?
        ORDER BY o.position ASC, v.position ASC`,
      [shopId(), productId],
      exec,
    );
  },

  async shadeImages(optionValueIds: number[], exec: Executor = pool) {
    if (optionValueIds.length === 0) return [];
    const placeholders = optionValueIds.map(() => '?').join(', ');
    return query<RowDataPacket & Record<string, unknown>>(
      `SELECT ma.attachable_id AS option_value_id, m.storage_key, m.alt_text,
              ma.alt_override, ma.is_primary, ma.sort_order
         FROM media_attachments ma
         JOIN media m ON m.id = ma.media_id AND m.deleted_at IS NULL
        WHERE ma.shop_id = ? AND ma.attachable_type = 'product_option_value'
          AND ma.attachable_id IN (${placeholders})
        ORDER BY ma.is_primary DESC, ma.sort_order ASC`,
      [shopId(), ...optionValueIds],
      exec,
    );
  },

  // ── navigation ─────────────────────────────────────────────────────────────

  async menuCategories(exec: Executor = pool) {
    return query<RowDataPacket & { id: number; parent_id: number | null; slug: string; name: string; depth: number }>(
      `SELECT id, parent_id, slug, name, depth
         FROM categories
        WHERE shop_id = ? AND deleted_at IS NULL AND is_active = 1 AND show_in_menu = 1
        ORDER BY depth, sort_order, name`,
      [shopId()],
      exec,
    );
  },

  async menuCollections(exec: Executor = pool) {
    return query<RowDataPacket & { slug: string; title: string; subtitle: string | null; product_count: number }>(
      `SELECT slug, title, subtitle, product_count
         FROM collections
        WHERE shop_id = ? AND deleted_at IS NULL AND is_active = 1 AND show_in_menu = 1
        ORDER BY sort_order, title`,
      [shopId()],
      exec,
    );
  },

  // ── cart ───────────────────────────────────────────────────────────────────

  async createCart(token: string, exec: Executor = pool): Promise<number> {
    return insert(
      `INSERT INTO carts (shop_id, token, status, currency, last_activity_at, expires_at)
       VALUES (?, ?, 'active', ?, NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY))`,
      [shopId(), token, tenancy.current().currency],
      exec,
    );
  },

  async findCart(token: string, exec: Executor = pool): Promise<CartRow | null> {
    return queryOne<CartRow>(
      "SELECT * FROM carts WHERE shop_id = ? AND token = ? AND status = 'active' LIMIT 1",
      [shopId(), token],
      exec,
    );
  },

  async cartItems(cartId: number, exec: Executor = pool): Promise<CartItemRow[]> {
    return query<CartItemRow>(
      `SELECT ci.id, ci.cart_id, ci.product_id, ci.variant_id, ci.quantity, ci.unit_price, ci.unit_mrp,
              p.name AS product_name, p.slug AS product_slug, p.is_gift_card,
              v.variant_title, v.sku, v.track_inventory, v.weight_grams,
              COALESCE(vtc.gst_rate, ptc.gst_rate, dtc.gst_rate, 0) AS tax_rate,
              COALESCE(vtc.is_inclusive, ptc.is_inclusive, dtc.is_inclusive, 1) AS tax_inclusive,
              COALESCE(vtc.is_exempt, ptc.is_exempt, dtc.is_exempt, 0) AS tax_exempt,
              COALESCE(vtc.hsn_code, ptc.hsn_code, dtc.hsn_code) AS hsn_code,
              COALESCE((SELECT SUM(ii.quantity_available) FROM inventory_items ii
                         WHERE ii.shop_id = v.shop_id AND ii.variant_id = v.id), 0) AS available,
              (SELECT m.storage_key FROM media_attachments ma
                 JOIN media m ON m.id = ma.media_id
                WHERE ma.shop_id = p.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = p.id
                  AND ma.collection = 'gallery'
                ORDER BY ma.is_primary DESC, ma.sort_order ASC LIMIT 1) AS image_key
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id AND p.shop_id = ci.shop_id
         JOIN product_variants v ON v.id = ci.variant_id AND v.shop_id = ci.shop_id
         LEFT JOIN tax_classes vtc ON vtc.id = v.tax_class_id AND vtc.shop_id = v.shop_id AND vtc.is_active = 1
         LEFT JOIN tax_classes ptc ON ptc.id = p.tax_class_id AND ptc.shop_id = p.shop_id AND ptc.is_active = 1
         LEFT JOIN tax_classes dtc ON dtc.shop_id = ci.shop_id AND dtc.is_default = 1 AND dtc.is_active = 1
        WHERE ci.shop_id = ? AND ci.cart_id = ? AND ci.item_status = 'active'
        ORDER BY ci.added_at, ci.id`,
      [shopId(), cartId],
      exec,
    );
  },

  /** A variant, priced and stock-checked — the source of truth for what a line costs. */
  async sellableVariant(variantId: number, exec: Executor = pool) {
    return queryOne<
      RowDataPacket & {
        id: number;
        product_id: number;
        price: string;
        mrp: string;
        track_inventory: number;
        available: number;
        product_name: string;
        tax_rate: string;
        hsn_code: string | null;
        tax_inclusive: number;
        sku: string;
        variant_title: string | null;
      }
    >(
      `SELECT v.id, v.product_id, v.price, v.mrp, v.track_inventory, v.sku, v.variant_title,
              p.name AS product_name,
              COALESCE(tc.gst_rate, ptc.gst_rate, 18.00) AS tax_rate,
              COALESCE(tc.hsn_code, ptc.hsn_code) AS hsn_code,
              COALESCE(tc.is_inclusive, ptc.is_inclusive, 1) AS tax_inclusive,
              COALESCE((SELECT SUM(ii.quantity_available) FROM inventory_items ii
                         WHERE ii.variant_id = v.id), 0) AS available
         FROM product_variants v
         JOIN products p ON p.id = v.product_id
         LEFT JOIN tax_classes tc ON tc.id = v.tax_class_id AND tc.shop_id = v.shop_id
         LEFT JOIN tax_classes ptc ON ptc.id = p.tax_class_id AND ptc.shop_id = p.shop_id
        WHERE v.id = ? AND v.deleted_at IS NULL AND v.status = 'active'
          AND ${publicWhere()}
        LIMIT 1`,
      [variantId],
      exec,
    );
  },

  async findCartItem(cartId: number, variantId: number, exec: Executor = pool): Promise<CartItemRow | null> {
    return queryOne<CartItemRow>(
      "SELECT * FROM cart_items WHERE shop_id = ? AND cart_id = ? AND variant_id = ? AND item_status = 'active' LIMIT 1",
      [shopId(), cartId, variantId],
      exec,
    );
  },

  async addCartItem(
    data: { cartId: number; productId: number; variantId: number; quantity: number; price: string; mrp: string },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `INSERT INTO cart_items (shop_id, cart_id, product_id, variant_id, quantity, unit_price, unit_mrp, item_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [shopId(), data.cartId, data.productId, data.variantId, data.quantity, data.price, data.mrp],
      exec,
    );
  },

  async setCartItemQuantity(itemId: number, quantity: number, exec: Executor = pool): Promise<void> {
    await execute('UPDATE cart_items SET quantity = ? WHERE shop_id = ? AND id = ?', [quantity, shopId(), itemId], exec);
  },

  async removeCartItem(cartId: number, itemId: number, exec: Executor = pool): Promise<number> {
    const result = await execute('DELETE FROM cart_items WHERE shop_id = ? AND id = ? AND cart_id = ?', [shopId(), itemId, cartId], exec);
    return result.affectedRows;
  },

  async touchCart(cartId: number, totals: { itemCount: number; subtotal: number; total: number }, exec: Executor = pool) {
    await execute(
      `UPDATE carts SET item_count = ?, subtotal = ?, estimated_total = ?, last_activity_at = NOW()
        WHERE shop_id = ? AND id = ?`,
      [totals.itemCount, totals.subtotal, totals.total, shopId(), cartId],
      exec,
    );
  },

  async markCartConverted(cartId: number, orderId: number, exec: Executor = pool): Promise<void> {
    await execute(
      "UPDATE carts SET status = 'converted', converted_order_id = ? WHERE shop_id = ? AND id = ?",
      [orderId, shopId(), cartId],
      exec,
    );
  },

  // ── coupons ────────────────────────────────────────────────────────────────

  /** Whether a code names a live, shopper-enterable discount in this shop. */
  async liveCodeExists(code: string, exec: Executor = pool): Promise<boolean> {
    const row = await queryOne<RowDataPacket>(
      `SELECT 1 AS hit FROM coupons
        WHERE shop_id = ? AND UPPER(code) = ? AND is_automatic = 0 AND is_active = 1 AND deleted_at IS NULL
          AND (starts_at IS NULL OR starts_at <= NOW())
          AND (ends_at IS NULL OR ends_at >= NOW())
        LIMIT 1`,
      [shopId(), code],
      exec,
    );
    return row !== null;
  },

  async setCartCoupon(cartId: number, code: string | null, exec: Executor = pool): Promise<void> {
    await execute('UPDATE carts SET coupon_code = ?, last_activity_at = NOW() WHERE shop_id = ? AND id = ?', [code, shopId(), cartId], exec);
  },

  async setCartGiftCards(cartId: number, ids: number[], exec: Executor = pool): Promise<void> {
    await execute('UPDATE carts SET gift_card_ids = ?, last_activity_at = NOW() WHERE shop_id = ? AND id = ?', [ids.length ? JSON.stringify(ids) : null, shopId(), cartId], exec);
  },

  /** The shopper's country and the currency that goes with it; a new country forgets the old postcode. */
  async setCartMarket(cartId: number, countryCode: string, currency: string, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE carts SET country_code = ?, currency = ?, pincode = IF(country_code <=> ?, pincode, NULL),
              region_code = IF(country_code <=> ?, region_code, NULL), last_activity_at = NOW()
        WHERE shop_id = ? AND id = ?`,
      [countryCode, currency, countryCode, countryCode, shopId(), cartId],
      exec,
    );
  },

  async setCartDestination(cartId: number, pincode: string | null, regionCode: string | null, exec: Executor = pool): Promise<void> {
    await execute(
      'UPDATE carts SET pincode = ?, region_code = ?, last_activity_at = NOW() WHERE shop_id = ? AND id = ?',
      [pincode, regionCode, shopId(), cartId],
      exec,
    );
  },

  /**
   * Counts one use of a discount, inside the checkout transaction; false when
   * the limit was reached in the meantime.
   *
   * The UPDATE's own WHERE is the overall limit check, evaluated against the
   * latest committed count, and it leaves the coupon row locked until commit —
   * so a second checkout using the same discount waits here. Once it has the
   * row, the per-customer count is read with a locking read, which sees the
   * first checkout's committed redemption where a plain read inside this
   * transaction's older snapshot would not.
   */
  async countCouponUse(couponId: number, customerId: number, exec: Executor): Promise<boolean> {
    const result = await execute(
      `UPDATE coupons SET used_count = used_count + 1
        WHERE shop_id = ? AND id = ? AND (usage_limit_total IS NULL OR used_count < usage_limit_total)`,
      [shopId(), couponId],
      exec,
    );
    if (result.affectedRows !== 1) return false;
    const limit = await queryOne<RowDataPacket & { usage_limit_per_customer: number }>(
      'SELECT usage_limit_per_customer FROM coupons WHERE shop_id = ? AND id = ?',
      [shopId(), couponId],
      exec,
    );
    const perCustomer = Number(limit?.usage_limit_per_customer ?? 0);
    if (perCustomer <= 0) return true;
    const used = await queryOne<RowDataPacket & { total: number }>(
      'SELECT COUNT(*) AS total FROM coupon_redemptions WHERE shop_id = ? AND coupon_id = ? AND customer_id = ? FOR SHARE',
      [shopId(), couponId, customerId],
      exec,
    );
    return Number(used?.total ?? 0) < perCustomer;
  },

  // ── orders ─────────────────────────────────────────────────────────────────

  /**
   * Draws the next order number from the `number_sequences` counter.
   *
   * The previous implementation took `MAX(order_number)` — a string comparison.
   * One row carrying a non-numeric number ('VEYRTTVLZD' from a test fixture)
   * sorted above every real one, stripping its digits yielded 0, and checkout
   * then tried to write VEY0000001 forever against a unique index. It was also
   * unsafe under load: two concurrent checkouts read the same MAX.
   *
   * `LAST_INSERT_ID(expr)` inside an UPDATE both stores the new value and makes
   * it readable back on this connection, so the read and the increment are one
   * row-locked statement. Must be called inside the checkout transaction so a
   * rolled-back order does not leave a gap — gaps are harmless for orders, but
   * the lock is what keeps two shoppers off the same number.
   */
  async nextOrderNumber(exec: Executor = pool): Promise<string> {
    await execute(
      `UPDATE number_sequences
          SET current_value = LAST_INSERT_ID(current_value + 1)
        WHERE shop_id = ? AND name = 'order'`,
      [shopId()],
      exec,
    );
    const row = await queryOne<RowDataPacket & { value: number; prefix: string; padding: number }>(
      `SELECT LAST_INSERT_ID() AS value, prefix, padding FROM number_sequences WHERE shop_id = ? AND name = 'order'`,
      [shopId()],
      exec,
    );
    if (!row || !row.value) {
      // The counter row is seeded by migration 17; if it is missing the right
      // answer is to stop, not to invent a number that may already be taken.
      throw new Error('number_sequences row "order" is missing — run database/17_number_sequences.sql');
    }
    return `${row.prefix}${String(row.value).padStart(row.padding, '0')}`;
  },

  async findOrCreateCustomer(
    data: { countryCode: string; phone: string; email: string | null; firstName: string; lastName: string | null },
    exec: Executor = pool,
  ): Promise<{ id: number; created: boolean }> {
    const existing = await queryOne<RowDataPacket & { id: number }>(
      'SELECT id FROM customers WHERE shop_id = ? AND country_code = ? AND phone = ? LIMIT 1',
      [shopId(), data.countryCode, data.phone],
      exec,
    );
    if (existing) return { id: existing.id, created: false };

    const id = await insert(
      `INSERT INTO customers (shop_id, public_id, country_code, phone, email, first_name, last_name, status, signup_source)
       VALUES (?, UUID(), ?, ?, ?, ?, ?, 'active', 'web')`,
      [shopId(), data.countryCode, data.phone, data.email, data.firstName, data.lastName],
      exec,
    );
    return { id, created: true };
  },

  /**
   * Move stock for one checkout line.
   *
   * `orderId` is recorded on the movement: the ledger already carries
   * reference_type = 'order', and without the id beside it a sale row named the
   * kind of thing that caused it but not which one, so "why did this SKU drop by
   * two?" had no answer in the admin.
   *
   * The row is picked by fulfilment priority rather than by lowest id, and locked
   * before it is read, so two simultaneous checkouts of the last unit cannot both
   * see it as available.
   */
  async reserveStock(
    variantId: number,
    quantity: number,
    orderId: number,
    exec: Executor = pool,
  ): Promise<void> {
    const inventory = await queryOne<RowDataPacket & { id: number; location_id: number; quantity_on_hand: number }>(
      `SELECT ii.id, ii.location_id, ii.quantity_on_hand
         FROM inventory_items ii
         JOIN inventory_locations il ON il.id = ii.location_id
        WHERE ii.shop_id = ? AND ii.variant_id = ?
          AND il.is_active = 1
          AND il.fulfils_online_orders = 1
        ORDER BY il.is_default DESC, il.priority ASC, ii.id ASC
        LIMIT 1
        FOR UPDATE`,
      [shopId(), variantId],
      exec,
    );
    if (!inventory) return;

    await execute(
      'UPDATE inventory_items SET quantity_on_hand = quantity_on_hand - ? WHERE shop_id = ? AND id = ?',
      [quantity, shopId(), inventory.id],
      exec,
    );
    await execute(
      `INSERT INTO inventory_movements
         (shop_id, variant_id, location_id, movement_type, quantity_delta, quantity_after,
          reference_type, reference_id, reason)
       VALUES (?, ?, ?, 'sale', ?, ?, 'order', ?, 'Storefront checkout')`,
      [shopId(), variantId, inventory.location_id, -quantity, inventory.quantity_on_hand - quantity, orderId],
      exec,
    );
  },

  async findOrderByNumber(orderNumber: string, phone: string, exec: Executor = pool) {
    return queryOne<TrackedOrderRow>(
      // Columns by name, as everywhere else in this file. An order row carries
      // admin notes, a risk score, the shopper's IP and their user agent; none
      // of that belongs in a payload anyone with an order number can fetch.
      `SELECT id, order_number, order_status, payment_status, fulfillment_status,
              payment_method, customer_name, currency,
              subtotal, discount_total, shipping_total, cod_fee, tax_total,
              grand_total, amount_paid, amount_due,
              shipping_method, estimated_delivery_from, estimated_delivery_to,
              placed_at, confirmed_at, packed_at, shipped_at, delivered_at,
              cancelled_at, cancel_reason
         FROM orders
        WHERE shop_id = ? AND order_number = ? AND contact_phone = ?
        LIMIT 1`,
      [shopId(), orderNumber, phone],
      exec,
    );
  },

  /** The lines on a tracked order, in the order they were added. */
  async trackedOrderItems(orderId: number, exec: Executor = pool) {
    return query<TrackedItemRow>(
      `SELECT oi.id, oi.product_id, oi.variant_id, oi.sku, oi.product_name, oi.variant_title,
              oi.product_slug, oi.image_url, oi.quantity, oi.unit_price, oi.unit_mrp,
              oi.line_total, oi.discount_amount, oi.line_type, oi.cancelled_quantity, oi.returned_quantity,
              p.deleted_at AS product_deleted_at,
              (SELECT m.storage_key FROM media_attachments ma
                 JOIN media m ON m.id = ma.media_id
                WHERE ma.shop_id = oi.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = oi.product_id
                  AND ma.collection = 'gallery'
                ORDER BY ma.is_primary DESC, ma.sort_order ASC LIMIT 1) AS image_key,
              r.id AS review_id
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id AND p.shop_id = oi.shop_id
         LEFT JOIN reviews r ON r.order_item_id = oi.id AND r.shop_id = oi.shop_id AND r.deleted_at IS NULL
        WHERE oi.shop_id = ? AND oi.order_id = ? AND oi.line_type IN ('product', 'gift')
        ORDER BY oi.id`,
      [shopId(), orderId],
      exec,
    );
  },

  /**
   * The shipments on an order, with the carrier named rather than numbered.
   *
   * `tracking_url` is whatever the fulfilment module stored; the template on
   * the carrier is the fallback for a shipment created before one was set.
   */
  async trackedShipments(orderId: number, exec: Executor = pool) {
    return query<TrackedShipmentRow>(
      `SELECT s.id, s.shipment_number, s.awb_number, s.tracking_url, s.status,
              s.shipping_mode, s.shipped_at, s.estimated_delivery_at, s.delivered_at,
              s.ndr_reason, c.name AS carrier_name, c.tracking_url_template
         FROM shipments s
         LEFT JOIN shipping_carriers c ON c.id = s.carrier_id AND c.shop_id = s.shop_id
        WHERE s.shop_id = ? AND s.order_id = ?
        ORDER BY s.id`,
      [shopId(), orderId],
      exec,
    );
  },

  /**
   * What the shopper is allowed to see of the order's history.
   *
   * `is_customer_visible` is the whole point of the column: an internal note
   * about a risk review or a failed carrier handshake is history, but it is
   * not the shopper's history.
   */
  async trackedTimeline(orderId: number, exec: Executor = pool) {
    return query<TrackedEventRow>(
      `SELECT 'order' AS source, 0 AS source_rank, h.id AS event_id,
              h.to_status AS code, NULL AS label, h.note AS description,
              NULL AS location, h.created_at AS happened_at
         FROM order_status_history h
        WHERE h.shop_id = ? AND h.order_id = ? AND h.is_customer_visible = 1
          -- 'fulfillment' rows restate the shipment in internal words; the
          -- carrier's own events below say the same thing better.
          AND h.status_type IN ('order', 'payment')
        UNION ALL
       SELECT 'shipment' AS source, 1 AS source_rank, e.id AS event_id,
              e.status_code AS code, e.status_label AS label,
              e.description, e.location, e.event_at AS happened_at
         FROM shipment_tracking_events e
         JOIN shipments s ON s.id = e.shipment_id
        WHERE s.shop_id = ? AND s.order_id = ? AND e.is_customer_visible = 1
        -- Several of these can share a second. The tie-break keeps the story in
        -- the order it happened rather than alphabetically by status name.
        ORDER BY happened_at, source_rank, event_id`,
      [shopId(), orderId, shopId(), orderId],
      exec,
    );
  },

  /** The delivery address as the shopper gave it, for confirming it is right. */
  async trackedAddress(orderId: number, exec: Executor = pool) {
    return queryOne<TrackedAddressRow>(
      `SELECT NULLIF(CONCAT_WS(' ', first_name, last_name), '') AS name,
              line1, line2, landmark, city, state, pincode
         FROM order_addresses
        WHERE shop_id = ? AND order_id = ? AND address_type = 'shipping'
        LIMIT 1`,
      [shopId(), orderId],
      exec,
    );
  },
};

export interface TrackedOrderRow extends RowDataPacket {
  id: number;
  order_number: string;
  order_status: string;
  payment_status: string;
  fulfillment_status: string | null;
  payment_method: string;
  customer_name: string | null;
  currency: string;
  subtotal: string;
  discount_total: string;
  shipping_total: string;
  cod_fee: string;
  tax_total: string;
  grand_total: string;
  amount_paid: string;
  amount_due: string;
  shipping_method: string | null;
  estimated_delivery_from: Date | null;
  estimated_delivery_to: Date | null;
  placed_at: Date | null;
  confirmed_at: Date | null;
  packed_at: Date | null;
  shipped_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
}

export interface TrackedItemRow extends RowDataPacket {
  id: number;
  line_type: 'product' | 'gift';
  discount_amount: string;
  product_id: number | null;
  variant_id: number | null;
  sku: string;
  product_name: string;
  variant_title: string | null;
  product_slug: string | null;
  image_url: string | null;
  image_key: string | null;
  quantity: number;
  unit_price: string;
  unit_mrp: string | null;
  line_total: string;
  cancelled_quantity: number;
  returned_quantity: number;
  product_deleted_at: Date | null;
  review_id: number | null;
}

export interface TrackedShipmentRow extends RowDataPacket {
  id: number;
  shipment_number: string;
  awb_number: string | null;
  tracking_url: string | null;
  status: string;
  shipping_mode: string | null;
  shipped_at: Date | null;
  estimated_delivery_at: Date | null;
  delivered_at: Date | null;
  ndr_reason: string | null;
  carrier_name: string | null;
  tracking_url_template: string | null;
}

export interface TrackedEventRow extends RowDataPacket {
  source: 'order' | 'shipment';
  source_rank: number;
  event_id: number;
  code: string | null;
  label: string | null;
  description: string | null;
  location: string | null;
  happened_at: Date;
}

export interface TrackedAddressRow extends RowDataPacket {
  name: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  pincode: string;
}
