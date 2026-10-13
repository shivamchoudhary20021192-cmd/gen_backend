import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface ProductRow extends RowDataPacket {
  id: number;
  public_id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  category_id: number | null;
  brand_id: number | null;
  product_type: string;
  status: string;
  visibility: string;
  short_description: string | null;
  description: string | null;
  description_json: string | null;
  
  // Texture & Sensory
  texture: string | null;
  scent: string | null;
  fragrance_disclosure: string | null;
  texture_description: string | null;
  color_description: string | null;
  absorption_rate: string | null;
  feel_on_skin: string | null;
  
  // Product Attributes
  suitability_note: string | null;
  benefits: string | null; // JSON
  skin_types: string | null; // JSON
  skin_concerns: string | null; // JSON
  finish: string | null;
  coverage: string | null;
  shade_family: string | null;
  
  // Safety & Warnings
  contraindications: string | null;
  patch_test_note: string | null;
  
  // Routine & Timing
  routine_position: string;
  time_of_day: string;
  
  // Ingredients & Formulation
  full_inci: string | null;
  key_ingredients: string | null; // JSON
  ingredient_highlights: string | null;
  free_from: string | null; // JSON
  formulation_type: string | null;
  ph_level: string | null;
  
  // Certifications & Claims
  certifications: string | null; // JSON
  claims: string | null; // JSON
  is_hypoallergenic: number;
  is_non_comedogenic: number;
  pregnancy_safe: string | null;
  
  // Regulatory & Manufacturing
  inci_approved_at: Date | null;
  inci_approved_by_admin_id: number | null;
  manufacturer_name: string | null;
  manufacturer_address: string | null;
  marketed_by_name: string | null;
  marketed_by_address: string | null;
  manufacturing_licence_no: string | null;
  country_of_origin: string;
  customer_care_contact: string | null;
  
  // Shelf Life & Storage
  shelf_life_months: number | null;
  pao_months: number | null;
  storage_instructions: string | null;
  disposal_instructions: string | null;
  
  // Usage Instructions
  usage_instructions: string | null;
  application_method: string | null;
  usage_frequency: string | null;
  best_used_with: string | null; // JSON
  
  // Performance & Results
  results_timeline: string | null;
  clinical_study_summary: string | null;
  has_before_after_study: number;
  
  // Packaging & Sustainability
  packaging_type: string | null;
  packaging_material: string | null;
  is_recyclable: number;
  is_refillable: number;
  is_eco_friendly: number;
  is_carbon_neutral: number;
  
  // Size & Classification
  size_category: string | null;
  is_professional_use: number;
  requires_training: number;
  
  // Geographical & Regulatory
  regulatory_approvals: string | null; // JSON
  restricted_regions: string | null; // JSON
  
  // Awards & Recognition
  awards: string | null; // JSON
  press_features: string | null; // JSON
  
  // Target Demographics
  age_range: string | null;
  gender_target: string;
  
  // Seasonal & Trends
  is_seasonal: number;
  season: string | null;
  is_limited_edition: number;
  
  // Sample Products
  is_sample: number;
  sample_of_product_id: number | null;
  
  // Video Content
  tutorial_video_url: string | null;
  demo_video_url: string | null;
  
  // Marketing & Sales
  is_new: number;
  is_bestseller: number;
  is_gift_card?: number;
  badge: string | null;
  badge_expires_at: Date | null;
  rating_average: string;
  rating_count: number;
  review_count: number;
  total_sold: number;
  view_count: number;
  
  // Pricing & Inventory
  min_price: string | null;
  max_price: string | null;
  in_stock: number;
  tax_class_id: number | null;
  default_variant_id: number | null;
  
  // Meta
  requires_shipping: number;
  sort_order: number;
  published_at: Date | null;
  created_by_admin_id: number | null;
  updated_by_admin_id: number | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  
  // Joined/Computed Fields
  category_name?: string | null;
  category_slug?: string | null;
  variant_count?: number;
  image_count?: number;
  primary_image_key?: string | null;
  primary_image_alt?: string | null;
  total_inventory?: number;
}

export interface VariantRow extends RowDataPacket {
  option_values: string | null;
  id: number;
  public_id: string;
  product_id: number;
  sku: string;
  barcode: string | null;
  variant_title: string | null;
  net_quantity: string | null;
  size_description: string | null;
  volume_ml: string | null;
  weight_grams: number | null;
  mrp: string;
  price: string;
  cost_price: string | null;
  sale_starts_at: Date | null;
  sale_ends_at: Date | null;
  position: number;
  is_default: number;
  status: string;
  track_inventory: number;
  allow_backorder: number;
  low_stock_threshold: number;
  max_per_order: number;
  image_media_id: number | null;
  quantity_available?: number;
  quantity_on_hand?: number;
}

export interface SimpleRow extends RowDataPacket {
  [key: string]: unknown;
}

interface CountRow extends RowDataPacket {
  total: number;
}

export interface ProductFilters {
  search?: string;
  status?: string;
  categoryId?: number;
  collectionId?: number;
  concernSlug?: string;
  skinTypeSlug?: string;
  tag?: string;
  ids?: number[];
  inStock?: boolean;
  includeArchived?: boolean;
  
  // New cosmetic filters
  benefit?: string;
  skinType?: string; // JSON contains
  skinConcern?: string; // JSON contains
  finish?: string;
  coverage?: string;
  formulationType?: string;
  isHypoallergenic?: boolean;
  isNonComedogenic?: boolean;
  isEcoFriendly?: boolean;
  isRefillable?: boolean;
  isVegan?: boolean; // checks certifications JSON
  isCrueltyFree?: boolean; // checks certifications JSON
  genderTarget?: string;
  isSeasons?: boolean;
  isProfessionalUse?: boolean;
  isSample?: boolean;
}

/**
 * The list query joins the primary image and aggregates variant/inventory
 * counts in one statement. Fetching those per row is the classic admin-list
 * N+1: 50 products became 151 queries before this was folded in.
 */
const LIST_SELECT = `
  SELECT p.*,
         c.name AS category_name,
         c.slug AS category_slug,
         (SELECT COUNT(*) FROM product_variants v
           WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS variant_count,
         (SELECT COUNT(*) FROM media_attachments ma
           WHERE ma.shop_id = p.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = p.id
             AND ma.collection = 'gallery') AS image_count,
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
           WHERE v2.product_id = p.id AND v2.deleted_at IS NULL) AS total_inventory
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id AND c.shop_id = p.shop_id`;

function buildWhere(filters: ProductFilters): { clause: string; params: unknown[] } {
  const conditions = ['p.shop_id = ?', 'p.deleted_at IS NULL'];
  const params: unknown[] = [shopId()];

  if (filters.status) {
    conditions.push('p.status = ?');
    params.push(filters.status);
  } else if (!filters.includeArchived) {
    conditions.push("p.status <> 'archived'");
  }

  if (filters.categoryId) {
    // Includes descendants, so filtering by "Serums" also returns anything in
    // a sub-category of Serums.
    // Descendants are matched by path prefix, so both lookups are pinned to
    // the product's shop — another shop's "/serums/…" is not a descendant.
    conditions.push(`(p.category_id = ? OR p.category_id IN (
      SELECT id FROM categories WHERE shop_id = p.shop_id AND path LIKE CONCAT(
        (SELECT path FROM categories WHERE shop_id = p.shop_id AND id = ?), '/%')))`);
    params.push(filters.categoryId, filters.categoryId);
  }

  if (filters.collectionId) {
    // Correlated to `p`, so `cp.position` is addressable in ORDER BY — a manual
    // collection's curated order is meaningless if listing it re-sorts by
    // creation date.
    conditions.push(
      'EXISTS (SELECT 1 FROM collection_products cp WHERE cp.product_id = p.id AND cp.collection_id = ?)',
    );
    params.push(filters.collectionId);
  }

  if (filters.concernSlug) {
    conditions.push(`EXISTS (SELECT 1 FROM product_concerns pc
                              JOIN skin_concerns sc ON sc.id = pc.concern_id
                             WHERE pc.product_id = p.id AND sc.slug = ?)`);
    params.push(filters.concernSlug);
  }

  if (filters.skinTypeSlug) {
    conditions.push(`EXISTS (SELECT 1 FROM product_skin_types pst
                              JOIN skin_types st ON st.id = pst.skin_type_id
                             WHERE pst.product_id = p.id AND st.slug = ?)`);
    params.push(filters.skinTypeSlug);
  }

  if (filters.tag) {
    conditions.push(`EXISTS (SELECT 1 FROM taggables tg JOIN tags t ON t.id = tg.tag_id
                             WHERE tg.shop_id = p.shop_id AND tg.taggable_type = 'product'
                               AND tg.taggable_id = p.id AND t.slug = ?)`);
    params.push(filters.tag);
  }

  if (filters.ids?.length) {
    conditions.push(`p.id IN (${filters.ids.map(() => '?').join(',')})`);
    params.push(...filters.ids);
  }

  if (filters.inStock !== undefined) {
    conditions.push('p.in_stock = ?');
    params.push(filters.inStock ? 1 : 0);
  }

  // New cosmetic filters
  if (filters.benefit) {
    conditions.push('JSON_CONTAINS(p.benefits, ?)');
    params.push(JSON.stringify(filters.benefit));
  }

  if (filters.skinType) {
    conditions.push('JSON_CONTAINS(p.skin_types, ?)');
    params.push(JSON.stringify(filters.skinType));
  }

  if (filters.skinConcern) {
    conditions.push('JSON_CONTAINS(p.skin_concerns, ?)');
    params.push(JSON.stringify(filters.skinConcern));
  }

  if (filters.finish) {
    conditions.push('p.finish = ?');
    params.push(filters.finish);
  }

  if (filters.coverage) {
    conditions.push('p.coverage = ?');
    params.push(filters.coverage);
  }

  if (filters.formulationType) {
    conditions.push('p.formulation_type = ?');
    params.push(filters.formulationType);
  }

  if (filters.isHypoallergenic !== undefined) {
    conditions.push('p.is_hypoallergenic = ?');
    params.push(filters.isHypoallergenic ? 1 : 0);
  }

  if (filters.isNonComedogenic !== undefined) {
    conditions.push('p.is_non_comedogenic = ?');
    params.push(filters.isNonComedogenic ? 1 : 0);
  }

  if (filters.isEcoFriendly !== undefined) {
    conditions.push('p.is_eco_friendly = ?');
    params.push(filters.isEcoFriendly ? 1 : 0);
  }

  if (filters.isRefillable !== undefined) {
    conditions.push('p.is_refillable = ?');
    params.push(filters.isRefillable ? 1 : 0);
  }

  if (filters.isVegan) {
    conditions.push('JSON_SEARCH(p.certifications, "one", "Vegan", NULL, "$[*].type") IS NOT NULL');
  }

  if (filters.isCrueltyFree) {
    conditions.push('JSON_SEARCH(p.certifications, "one", "Cruelty-Free", NULL, "$[*].type") IS NOT NULL');
  }

  if (filters.genderTarget) {
    conditions.push('p.gender_target = ?');
    params.push(filters.genderTarget);
  }

  if (filters.isSeasons !== undefined) {
    conditions.push('p.is_seasonal = ?');
    params.push(filters.isSeasons ? 1 : 0);
  }

  if (filters.isProfessionalUse !== undefined) {
    conditions.push('p.is_professional_use = ?');
    params.push(filters.isProfessionalUse ? 1 : 0);
  }

  if (filters.isSample !== undefined) {
    conditions.push('p.is_sample = ?');
    params.push(filters.isSample ? 1 : 0);
  }

  if (filters.search) {
    // LIKE rather than MATCH…AGAINST: admins search partial SKUs and slugs,
    // which a fulltext index tokenises away. The catalogue is small enough
    // that this stays fast; the storefront uses the FULLTEXT index instead.
    conditions.push('(p.name LIKE ? OR p.slug LIKE ? OR p.subtitle LIKE ? OR EXISTS (SELECT 1 FROM product_variants sv WHERE sv.product_id = p.id AND sv.sku LIKE ?))');
    const like = `%${filters.search}%`;
    params.push(like, like, like, like);
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

export const productsRepository = {
  async list(
    filters: ProductFilters,
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<ProductRow[]> {
    const { clause, params } = buildWhere(filters);
    return query<ProductRow>(`${LIST_SELECT} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, limit, offset], exec);
  },

  async count(filters: ProductFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<CountRow>(`SELECT COUNT(*) AS total FROM products p ${clause}`, params, exec);
    return row?.total ?? 0;
  },

  async findById(id: number, exec: Executor = pool): Promise<ProductRow | null> {
    return queryOne<ProductRow>(
      `${LIST_SELECT} WHERE p.shop_id = ? AND p.id = ? AND p.deleted_at IS NULL LIMIT 1`,
      [shopId(), id],
      exec,
    );
  },

  async findBySlug(slug: string, exec: Executor = pool): Promise<ProductRow | null> {
    return queryOne<ProductRow>('SELECT * FROM products WHERE shop_id = ? AND slug = ? AND deleted_at IS NULL LIMIT 1', [shopId(), slug], exec);
  },

  async create(data: Record<string, unknown>, exec: Executor = pool): Promise<number> {
    const row = { ...data, shop_id: shopId() };
    const keys = Object.keys(row);
    const columns = keys.map((k) => `\`${k}\``).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    return insert(`INSERT INTO products (${columns}) VALUES (${placeholders})`, Object.values(row), exec);
  },

  async update(id: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `\`${k}\` = ?`).join(', ');
    await execute(`UPDATE products SET ${assignments} WHERE shop_id = ? AND id = ?`, [...Object.values(fields), shopId(), id], exec);
  },

  async softDelete(id: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE products
          SET deleted_at = NOW(), status = 'archived',
              slug = CONCAT(slug, '-deleted-', UNIX_TIMESTAMP())
        WHERE shop_id = ? AND id = ?`,
      [shopId(), id],
      exec,
    );
  },

  async bulkSetStatus(ids: number[], status: string, exec: Executor = pool): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const result = await execute(
      `UPDATE products
          SET status = ?, published_at = CASE WHEN ? = 'active' AND published_at IS NULL THEN NOW() ELSE published_at END
        WHERE shop_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`,
      [status, status, shopId(), ...ids],
      exec,
    );
    return result.affectedRows;
  },

  async bulkSetCategory(ids: number[], categoryId: number | null, exec: Executor = pool): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const result = await execute(
      `UPDATE products SET category_id = ? WHERE shop_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`,
      [categoryId, shopId(), ...ids],
      exec,
    );
    return result.affectedRows;
  },

  async bulkSoftDelete(ids: number[], exec: Executor = pool): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    const result = await execute(
      `UPDATE products
          SET deleted_at = NOW(), status = 'archived', slug = CONCAT(slug, '-deleted-', UNIX_TIMESTAMP())
        WHERE shop_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`,
      [shopId(), ...ids],
      exec,
    );
    return result.affectedRows;
  },

  // ── options ────────────────────────────────────────────────────────────────
  async createOption(
    productId: number,
    name: string,
    position: number,
    displayType: string | undefined,
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      'INSERT INTO product_options (shop_id, product_id, name, position, display_type) VALUES (?, ?, ?, ?, ?)',
      [shopId(), productId, name, position, displayType ?? 'pill'],
      exec,
    );
  },

  async createOptionValue(
    optionId: number,
    data: {
      value: string;
      descriptor?: string | null;
      badge?: string | null;
      description?: string | null;
      swatch_hex?: string | null;
      swatch_media_id?: number | null;
      is_active?: boolean;
    },
    position: number,
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO product_option_values
         (shop_id, option_id, value, descriptor, badge, description, swatch_hex, swatch_media_id, position, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        optionId,
        data.value,
        data.descriptor ?? null,
        data.badge ?? null,
        data.description ?? null,
        data.swatch_hex ?? null,
        data.swatch_media_id ?? null,
        position,
        data.is_active === false ? 0 : 1,
      ],
      exec,
    );
  },

  /**
   * Options with everything a shade picker needs.
   *
   * `sellable_units` is the whole reason this query is not two lines. A shade
   * reads as sold out when no variant carrying it can be bought — which is not
   * the same as "stock is zero", because a variant that does not track
   * inventory, or that allows backorders, is always sellable. Deriving it here
   * is what keeps the site from advertising a shade nobody can buy, without a
   * stored flag that goes stale the moment stock moves.
   */
  async optionsFor(productId: number, exec: Executor = pool): Promise<SimpleRow[]> {
    return query<SimpleRow>(
      `SELECT o.id, o.name, o.position, o.display_type,
              JSON_ARRAYAGG(JSON_OBJECT(
                'id', v.id,
                'value', v.value,
                'descriptor', v.descriptor,
                'badge', v.badge,
                'description', v.description,
                'swatch_hex', v.swatch_hex,
                'swatch_media_id', v.swatch_media_id,
                'swatch_key', sm.storage_key,
                'is_active', v.is_active,
                'position', v.position,
                'sellable_units', COALESCE((
                  SELECT SUM(CASE WHEN pv.track_inventory = 0 OR pv.allow_backorder = 1
                                  THEN 1 ELSE COALESCE(ii.quantity_available, 0) END)
                    FROM variant_option_values vov
                    JOIN product_variants pv ON pv.id = vov.variant_id
                     AND pv.deleted_at IS NULL AND pv.status = 'active'
                    LEFT JOIN inventory_items ii ON ii.variant_id = pv.id
                   WHERE vov.option_value_id = v.id), 0),
                'min_price', (
                  SELECT MIN(pv.price) FROM variant_option_values vov
                    JOIN product_variants pv ON pv.id = vov.variant_id
                     AND pv.deleted_at IS NULL AND pv.status = 'active'
                   WHERE vov.option_value_id = v.id)
              )) AS 'values'
         FROM product_options o
         LEFT JOIN product_option_values v ON v.option_id = o.id
         LEFT JOIN media sm ON sm.id = v.swatch_media_id AND sm.shop_id = o.shop_id
        WHERE o.shop_id = ? AND o.product_id = ?
        GROUP BY o.id
        ORDER BY o.position`,
      [shopId(), productId],
      exec,
    );
  },

  /**
   * Photographs that belong to a shade rather than to the product.
   *
   * Attached to the option value and not to the variant: on a shade x size
   * product the pictures belong to the colour, not to the 30ml.
   */
  async shadeImagesFor(optionValueIds: number[], exec: Executor = pool): Promise<SimpleRow[]> {
    if (optionValueIds.length === 0) return [];
    const placeholders = optionValueIds.map(() => '?').join(', ');
    return query<SimpleRow>(
      `SELECT ma.attachable_id AS option_value_id, ma.media_id, ma.sort_order, ma.is_primary,
              ma.alt_override, m.storage_key, m.alt_text, m.width, m.height
         FROM media_attachments ma
         JOIN media m ON m.id = ma.media_id AND m.deleted_at IS NULL
        WHERE ma.shop_id = ? AND ma.attachable_type = 'product_option_value'
          AND ma.attachable_id IN (${placeholders})
        ORDER BY ma.is_primary DESC, ma.sort_order ASC`,
      [shopId(), ...optionValueIds],
      exec,
    );
  },

  async attachShadeImage(
    optionValueId: number,
    mediaId: number,
    sortOrder: number,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `INSERT INTO media_attachments (shop_id, media_id, attachable_type, attachable_id, collection, sort_order)
       VALUES (?, ?, 'product_option_value', ?, 'gallery', ?)
       ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order)`,
      [shopId(), mediaId, optionValueId, sortOrder],
      exec,
    );
  },

  /** Guards the endpoint: a shade id from another product must not be writable. */
  async optionValueBelongsTo(
    productId: number,
    optionValueId: number,
    exec: Executor = pool,
  ): Promise<boolean> {
    const row = await queryOne<SimpleRow>(
      `SELECT v.id FROM product_option_values v
         JOIN product_options o ON o.id = v.option_id
        WHERE v.shop_id = ? AND v.id = ? AND o.product_id = ? LIMIT 1`,
      [shopId(), optionValueId, productId],
      exec,
    );
    return row !== null;
  },

  async clearShadeImages(optionValueId: number, exec: Executor = pool): Promise<void> {
    await execute(
      `DELETE FROM media_attachments
        WHERE shop_id = ? AND attachable_type = 'product_option_value' AND attachable_id = ?`,
      [shopId(), optionValueId],
      exec,
    );
  },

  async detachShadeImage(
    optionValueId: number,
    mediaId: number,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `DELETE FROM media_attachments
        WHERE shop_id = ? AND attachable_type = 'product_option_value' AND attachable_id = ? AND media_id = ?`,
      [shopId(), optionValueId, mediaId],
      exec,
    );
  },

  async deleteOptions(productId: number, exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM product_options WHERE shop_id = ? AND product_id = ?', [shopId(), productId], exec);
  },

  /**
   * The options and values a product already has, flat, for matching by name.
   *
   * Used by the save path to keep ids stable — see `replaceOptions` in the
   * service for why that matters.
   */
  async optionRowsFor(productId: number, exec: Executor = pool): Promise<SimpleRow[]> {
    return query<SimpleRow>(
      `SELECT o.id AS option_id, o.name AS option_name,
              v.id AS value_id, v.value AS value_name
         FROM product_options o
         LEFT JOIN product_option_values v ON v.option_id = o.id
        WHERE o.shop_id = ? AND o.product_id = ?`,
      [shopId(), productId],
      exec,
    );
  },

  async updateOption(
    id: number,
    name: string,
    position: number,
    displayType: string | undefined,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE product_options SET name = ?, position = ?${displayType ? ', display_type = ?' : ''}
        WHERE shop_id = ? AND id = ?`,
      displayType ? [name, position, displayType, shopId(), id] : [name, position, shopId(), id],
      exec,
    );
  },

  async updateOptionValue(
    id: number,
    data: {
      value: string;
      descriptor?: string | null;
      badge?: string | null;
      description?: string | null;
      swatch_hex?: string | null;
      swatch_media_id?: number | null;
      is_active?: boolean;
    },
    position: number,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE product_option_values
          SET value = ?, descriptor = ?, badge = ?, description = ?,
              swatch_hex = ?, swatch_media_id = ?, position = ?, is_active = ?
        WHERE shop_id = ? AND id = ?`,
      [
        data.value,
        data.descriptor ?? null,
        data.badge ?? null,
        data.description ?? null,
        data.swatch_hex ?? null,
        data.swatch_media_id ?? null,
        position,
        data.is_active === false ? 0 : 1,
        shopId(),
        id,
      ],
      exec,
    );
  },

  async deleteOptionsExcept(productId: number, keep: number[], exec: Executor = pool): Promise<void> {
    if (keep.length === 0) {
      await execute('DELETE FROM product_options WHERE shop_id = ? AND product_id = ?', [shopId(), productId], exec);
      return;
    }
    const placeholders = keep.map(() => '?').join(', ');
    await execute(
      `DELETE FROM product_options WHERE shop_id = ? AND product_id = ? AND id NOT IN (${placeholders})`,
      [shopId(), productId, ...keep],
      exec,
    );
  },

  async deleteOptionValuesExcept(
    optionId: number,
    keep: number[],
    exec: Executor = pool,
  ): Promise<void> {
    if (keep.length === 0) {
      await execute('DELETE FROM product_option_values WHERE shop_id = ? AND option_id = ?', [shopId(), optionId], exec);
      return;
    }
    const placeholders = keep.map(() => '?').join(', ');
    await execute(
      `DELETE FROM product_option_values WHERE shop_id = ? AND option_id = ? AND id NOT IN (${placeholders})`,
      [shopId(), optionId, ...keep],
      exec,
    );
  },

  /**
   * Drop a variant's option links so they can be rewritten.
   *
   * Options used to be deleted and recreated on every save, and the cascade
   * took these with them. Now that option ids survive, the links have to be
   * cleared explicitly or a variant renamed from one shade to another keeps
   * both.
   */
  async clearVariantOptionValues(variantId: number, exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM variant_option_values WHERE shop_id = ? AND variant_id = ?', [shopId(), variantId], exec);
  },

  // ── variants ───────────────────────────────────────────────────────────────
  async createVariant(data: Record<string, unknown>, exec: Executor = pool): Promise<number> {
    const row = { ...data, shop_id: shopId() };
    const keys = Object.keys(row);
    const columns = keys.map((k) => `\`${k}\``).join(', ');
    const placeholders = keys.map(() => '?').join(', ');
    return insert(`INSERT INTO product_variants (${columns}) VALUES (${placeholders})`, Object.values(row), exec);
  },

  async updateVariant(id: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `\`${k}\` = ?`).join(', ');
    await execute(`UPDATE product_variants SET ${assignments} WHERE shop_id = ? AND id = ?`, [...Object.values(fields), shopId(), id], exec);
  },

  /**
   * Leave exactly one variant flagged default, and point the product at it.
   *
   * The winner is the lowest-positioned row that already claims the flag, so a
   * merchant's choice survives; only when nothing claims it does the first row
   * take it. `product.default_variant_id` is moved to match, because the two
   * disagreeing is how a product page and its cart show different prices.
   */
  async normaliseDefaultVariant(productId: number, exec: Executor = pool): Promise<void> {
    const winner = await queryOne<VariantRow>(
      `SELECT id FROM product_variants
        WHERE shop_id = ? AND product_id = ? AND deleted_at IS NULL AND status = 'active'
        ORDER BY is_default DESC, position ASC, id ASC
        LIMIT 1`,
      [shopId(), productId],
      exec,
    );
    if (!winner) return;

    await execute(
      'UPDATE product_variants SET is_default = IF(id = ?, 1, 0) WHERE shop_id = ? AND product_id = ? AND deleted_at IS NULL',
      [winner.id, shopId(), productId],
      exec,
    );
    await execute('UPDATE products SET default_variant_id = ? WHERE shop_id = ? AND id = ?', [winner.id, shopId(), productId], exec);
  },

  async findVariant(id: number, exec: Executor = pool): Promise<VariantRow | null> {
    return queryOne<VariantRow>(
      'SELECT * FROM product_variants WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
      [shopId(), id],
      exec,
    );
  },

  async variantsFor(productId: number, exec: Executor = pool): Promise<VariantRow[]> {
    return query<VariantRow>(
      `SELECT v.*,
              COALESCE((SELECT SUM(ii.quantity_available) FROM inventory_items ii WHERE ii.variant_id = v.id), 0) AS quantity_available,
              COALESCE((SELECT SUM(ii.quantity_on_hand)   FROM inventory_items ii WHERE ii.variant_id = v.id), 0) AS quantity_on_hand,
              -- Which option values this row is. Without it the admin has to
              -- guess a variant's shade from its title, which is wrong the
              -- moment someone writes a title that does not repeat the colour.
              (SELECT GROUP_CONCAT(ov.value ORDER BY o.position SEPARATOR '\u001f')
                 FROM variant_option_values vov
                 JOIN product_option_values ov ON ov.id = vov.option_value_id
                 JOIN product_options o ON o.id = vov.option_id
                WHERE vov.variant_id = v.id) AS option_values
         FROM product_variants v
        WHERE v.shop_id = ? AND v.product_id = ? AND v.deleted_at IS NULL
        ORDER BY v.position, v.id`,
      [shopId(), productId],
      exec,
    );
  },

  async softDeleteVariant(id: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE product_variants
          SET deleted_at = NOW(), status = 'archived', sku = CONCAT(sku, '-del-', UNIX_TIMESTAMP())
        WHERE shop_id = ? AND id = ?`,
      [shopId(), id],
      exec,
    );
  },

  async countActiveVariants(productId: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<CountRow>(
      "SELECT COUNT(*) AS total FROM product_variants WHERE shop_id = ? AND product_id = ? AND deleted_at IS NULL AND status = 'active'",
      [shopId(), productId],
      exec,
    );
    return row?.total ?? 0;
  },

  async skuExists(sku: string, excludeId?: number, exec: Executor = pool): Promise<boolean> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      excludeId
        ? 'SELECT id FROM product_variants WHERE shop_id = ? AND sku = ? AND id <> ? LIMIT 1'
        : 'SELECT id FROM product_variants WHERE shop_id = ? AND sku = ? LIMIT 1',
      excludeId ? [shopId(), sku, excludeId] : [shopId(), sku],
      exec,
    );
    return row !== null;
  },

  async linkVariantOptionValue(
    variantId: number,
    optionId: number,
    optionValueId: number,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `INSERT INTO variant_option_values (shop_id, variant_id, option_id, option_value_id) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE option_value_id = VALUES(option_value_id)`,
      [shopId(), variantId, optionId, optionValueId],
      exec,
    );
  },

  /** Denormalised price band + stock flag, recomputed after any variant write. */
  async refreshDerivedFields(productId: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE products p
          SET p.min_price = (SELECT MIN(price) FROM product_variants v
                              WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.status = 'active'),
              p.max_price = (SELECT MAX(price) FROM product_variants v
                              WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.status = 'active'),
              p.in_stock = (
                SELECT CASE WHEN COALESCE(SUM(ii.quantity_available), 0) > 0
                            OR MAX(v.allow_backorder) = 1
                            OR MAX(v.track_inventory) = 0
                       THEN 1 ELSE 0 END
                  FROM product_variants v
                  LEFT JOIN inventory_items ii ON ii.variant_id = v.id
                 WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.status = 'active')
        WHERE p.shop_id = ? AND p.id = ?`,
      [shopId(), productId],
      exec,
    );
  },

  async initialiseInventory(variantId: number, quantity: number, exec: Executor = pool): Promise<void> {
    await execute(
      `INSERT INTO inventory_items (shop_id, variant_id, location_id, quantity_on_hand)
       SELECT shop_id, ?, id, ? FROM inventory_locations WHERE shop_id = ? AND is_default = 1 LIMIT 1
       ON DUPLICATE KEY UPDATE quantity_on_hand = VALUES(quantity_on_hand)`,
      [variantId, quantity, shopId()],
      exec,
    );
  },

  async recordInventoryMovement(
    variantId: number,
    delta: number,
    quantityAfter: number,
    reason: string,
    adminId: number | null,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `INSERT INTO inventory_movements
         (shop_id, variant_id, location_id, movement_type, quantity_delta, quantity_after, reason, admin_user_id)
       SELECT shop_id, ?, id, 'adjustment', ?, ?, ?, ? FROM inventory_locations WHERE shop_id = ? AND is_default = 1 LIMIT 1`,
      [variantId, delta, quantityAfter, reason, adminId, shopId()],
      exec,
    );
  },

  // ── child collections (benefits, usage, taxonomy, ingredients) ──────────────
  async replaceBenefits(
    productId: number,
    benefits: { benefit: string; detail?: string | null; benefit_kind?: string }[],
    exec: Executor = pool,
  ): Promise<void> {
    await execute('DELETE FROM product_benefits WHERE shop_id = ? AND product_id = ?', [shopId(), productId], exec);
    for (const [i, b] of benefits.entries()) {
      await execute(
        'INSERT INTO product_benefits (shop_id, product_id, benefit, detail, benefit_kind, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
        [shopId(), productId, b.benefit, b.detail ?? null, b.benefit_kind ?? 'long_term', i],
        exec,
      );
    }
  },

  async benefitsFor(productId: number, exec: Executor = pool): Promise<SimpleRow[]> {
    return query<SimpleRow>(
      'SELECT id, benefit, detail, benefit_kind, sort_order FROM product_benefits WHERE shop_id = ? AND product_id = ? ORDER BY sort_order',
      [shopId(), productId],
      exec,
    );
  },

  async replaceUsageSteps(
    productId: number,
    steps: { instruction: string; time_of_day?: string; frequency?: string | null; amount?: string | null }[],
    exec: Executor = pool,
  ): Promise<void> {
    await execute('DELETE FROM product_usage_steps WHERE shop_id = ? AND product_id = ?', [shopId(), productId], exec);
    for (const [i, s] of steps.entries()) {
      await execute(
        `INSERT INTO product_usage_steps (shop_id, product_id, step_no, instruction, time_of_day, frequency, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [shopId(), productId, i + 1, s.instruction, s.time_of_day ?? 'BOTH', s.frequency ?? null, s.amount ?? null],
        exec,
      );
    }
  },

  async usageStepsFor(productId: number, exec: Executor = pool): Promise<SimpleRow[]> {
    return query<SimpleRow>(
      'SELECT id, step_no, instruction, time_of_day, frequency, amount FROM product_usage_steps WHERE shop_id = ? AND product_id = ? ORDER BY step_no',
      [shopId(), productId],
      exec,
    );
  },

  async replaceSkinTypes(productId: number, ids: number[], exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM product_skin_types WHERE shop_id = ? AND product_id = ?', [shopId(), productId], exec);
    if (ids.length === 0) return;
    const values = ids.map(() => '(?, ?, ?)').join(', ');
    await execute(
      `INSERT INTO product_skin_types (shop_id, product_id, skin_type_id) VALUES ${values}`,
      ids.flatMap((id) => [shopId(), productId, id]),
      exec,
    );
  },

  async replaceConcerns(productId: number, ids: number[], exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM product_concerns WHERE shop_id = ? AND product_id = ?', [shopId(), productId], exec);
    if (ids.length === 0) return;
    const values = ids.map(() => '(?, ?, ?, ?, ?)').join(', ');
    await execute(
      `INSERT INTO product_concerns (shop_id, product_id, concern_id, is_primary, sort_order) VALUES ${values}`,
      ids.flatMap((id, i) => [shopId(), productId, id, i === 0 ? 1 : 0, i]),
      exec,
    );
  },

  async replaceIngredients(
    productId: number,
    ingredients: { ingredient_id: number; role?: string | null; concentration?: string | null; is_key?: boolean }[],
    exec: Executor = pool,
  ): Promise<void> {
    await execute('DELETE FROM product_ingredients WHERE shop_id = ? AND product_id = ?', [shopId(), productId], exec);
    for (const [i, ing] of ingredients.entries()) {
      await execute(
        `INSERT INTO product_ingredients (shop_id, product_id, ingredient_id, role, concentration, is_key, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [shopId(), productId, ing.ingredient_id, ing.role ?? null, ing.concentration ?? null, ing.is_key ? 1 : 0, i],
        exec,
      );
    }
  },

  async taxonomyFor(productId: number, exec: Executor = pool): Promise<{ skinTypes: SimpleRow[]; concerns: SimpleRow[]; ingredients: SimpleRow[] }> {
    const [skinTypes, concerns, ingredients] = await Promise.all([
      query<SimpleRow>(
        `SELECT st.id, st.slug, st.name FROM product_skin_types pst
           JOIN skin_types st ON st.id = pst.skin_type_id WHERE pst.shop_id = ? AND pst.product_id = ? ORDER BY st.sort_order`,
        [shopId(), productId],
        exec,
      ),
      query<SimpleRow>(
        `SELECT sc.id, sc.slug, sc.name, pc.is_primary FROM product_concerns pc
           JOIN skin_concerns sc ON sc.id = pc.concern_id WHERE pc.shop_id = ? AND pc.product_id = ? ORDER BY pc.sort_order`,
        [shopId(), productId],
        exec,
      ),
      query<SimpleRow>(
        `SELECT i.id, i.slug, i.name, i.inci_name, pi.role, pi.concentration, pi.is_key
           FROM product_ingredients pi JOIN ingredients i ON i.id = pi.ingredient_id
          WHERE pi.shop_id = ? AND pi.product_id = ? ORDER BY pi.sort_order`,
        [shopId(), productId],
        exec,
      ),
    ]);
    return { skinTypes, concerns, ingredients };
  },

  // ── images (polymorphic media_attachments) ─────────────────────────────────
  async attachImage(
    productId: number,
    mediaId: number,
    sortOrder: number,
    isPrimary: boolean,
    altOverride: string | null,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `INSERT INTO media_attachments
         (shop_id, media_id, attachable_type, attachable_id, collection, sort_order, is_primary, alt_override)
       VALUES (?, ?, 'product', ?, 'gallery', ?, ?, ?)
       ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), is_primary = VALUES(is_primary),
                               alt_override = VALUES(alt_override)`,
      [shopId(), mediaId, productId, sortOrder, isPrimary ? 1 : 0, altOverride],
      exec,
    );
  },

  async detachImage(productId: number, mediaId: number, exec: Executor = pool): Promise<number> {
    const result = await execute(
      `DELETE FROM media_attachments
        WHERE shop_id = ? AND attachable_type = 'product' AND attachable_id = ? AND media_id = ? AND collection = 'gallery'`,
      [shopId(), productId, mediaId],
      exec,
    );
    return result.affectedRows;
  },

  async detachAllImages(productId: number, exec: Executor = pool): Promise<number[]> {
    const rows = await query<RowDataPacket & { media_id: number }>(
      `SELECT media_id FROM media_attachments
        WHERE shop_id = ? AND attachable_type = 'product' AND attachable_id = ? AND collection = 'gallery'`,
      [shopId(), productId],
      exec,
    );
    await execute(
      `DELETE FROM media_attachments WHERE shop_id = ? AND attachable_type = 'product' AND attachable_id = ? AND collection = 'gallery'`,
      [shopId(), productId],
      exec,
    );
    return rows.map((r) => r.media_id);
  },

  async imagesFor(productId: number, exec: Executor = pool): Promise<SimpleRow[]> {
    return query<SimpleRow>(
      `SELECT ma.media_id, ma.sort_order, ma.is_primary, ma.alt_override,
              m.storage_key, m.disk, m.alt_text, m.width, m.height, m.placeholder_uri,
              m.dominant_color, m.focal_x, m.focal_y, m.status
         FROM media_attachments ma
         JOIN media m ON m.id = ma.media_id
        WHERE ma.shop_id = ? AND ma.attachable_type = 'product' AND ma.attachable_id = ? AND ma.collection = 'gallery'
          AND m.deleted_at IS NULL
        ORDER BY ma.is_primary DESC, ma.sort_order`,
      [shopId(), productId],
      exec,
    );
  },

  // ── SEO + tags ─────────────────────────────────────────────────────────────
  async upsertSeo(productId: number, seo: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    await execute(
      `INSERT INTO seo_meta (shop_id, entity_type, entity_id, locale, meta_title, meta_description, canonical_url, robots_index)
       VALUES (?, 'product', ?, 'en-IN', ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE meta_title = VALUES(meta_title), meta_description = VALUES(meta_description),
                               canonical_url = VALUES(canonical_url), robots_index = VALUES(robots_index)`,
      [
        shopId(),
        productId,
        seo.meta_title ?? null,
        seo.meta_description ?? null,
        seo.canonical_url ?? null,
        seo.robots_index === false ? 0 : 1,
      ],
      exec,
    );
  },

  async seoFor(productId: number, exec: Executor = pool): Promise<SimpleRow | null> {
    return queryOne<SimpleRow>(
      `SELECT meta_title, meta_description, canonical_url, robots_index
         FROM seo_meta WHERE shop_id = ? AND entity_type = 'product' AND entity_id = ? AND locale = 'en-IN' LIMIT 1`,
      [shopId(), productId],
      exec,
    );
  },

  async replaceTags(productId: number, tagSlugs: string[], exec: Executor = pool): Promise<void> {
    await execute(
      "DELETE FROM taggables WHERE shop_id = ? AND taggable_type = 'product' AND taggable_id = ?",
      [shopId(), productId],
      exec,
    );
    for (const slug of tagSlugs) {
      await execute(
        `INSERT INTO tags (shop_id, slug, name, tag_type) VALUES (?, ?, ?, 'product')
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [shopId(), slug, slug.replace(/-/g, ' ')],
        exec,
      );
      await execute(
        `INSERT IGNORE INTO taggables (shop_id, tag_id, taggable_type, taggable_id)
         SELECT shop_id, id, 'product', ? FROM tags WHERE shop_id = ? AND slug = ? AND tag_type = 'product'`,
        [productId, shopId(), slug],
        exec,
      );
    }
  },

  async tagsFor(productId: number, exec: Executor = pool): Promise<string[]> {
    const rows = await query<RowDataPacket & { slug: string }>(
      `SELECT t.slug FROM taggables tg JOIN tags t ON t.id = tg.tag_id
        WHERE tg.shop_id = ? AND tg.taggable_type = 'product' AND tg.taggable_id = ? ORDER BY t.slug`,
      [shopId(), productId],
      exec,
    );
    return rows.map((r) => r.slug);
  },

  /**
   * The ids a request named that exist IN THIS SHOP. Ids arrive in request
   * bodies, and "exists somewhere" is not good enough: another shop's skin
   * type id must come back as missing, not be linked.
   */
  async validateIds(table: 'skin_types' | 'skin_concerns' | 'ingredients', ids: number[], exec: Executor = pool): Promise<number[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = await query<RowDataPacket & { id: number }>(
      `SELECT id FROM \`${table}\` WHERE shop_id = ? AND id IN (${placeholders})`,
      [shopId(), ...ids],
      exec,
    );
    return rows.map((r) => r.id);
  },
};
