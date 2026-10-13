import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';
import { shopCountry } from '../../platform/geo/postalCodes';

// ── Row types ────────────────────────────────────────────────────────────────

export interface StockLevelRow extends RowDataPacket {
  inventory_item_id: number;
  variant_id: number;
  location_id: number;
  sku: string;
  barcode: string | null;
  variant_title: string | null;
  product_id: number;
  product_name: string;
  product_status: string;
  track_inventory: number;
  allow_backorder: number;
  low_stock_threshold: number;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  quantity_incoming: number;
  safety_stock: number;
  bin_location: string | null;
  last_counted_at: Date | null;
  location_code: string;
  location_name: string;
  stock_state: 'untracked' | 'out_of_stock' | 'low' | 'in_stock';
  primary_image_key: string | null;
  updated_at: Date;
}

export interface MovementRow extends RowDataPacket {
  id: number;
  variant_id: number;
  location_id: number;
  movement_type: string;
  quantity_delta: number;
  quantity_after: number;
  reference_type: string | null;
  reference_id: number | null;
  batch_id: number | null;
  unit_cost: string | null;
  reason: string | null;
  admin_user_id: number | null;
  admin_name: string | null;
  created_at: Date;
  sku: string;
  variant_title: string | null;
  product_name: string;
  location_code: string;
}

export interface LocationRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  location_type: string;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  state_code: string | null;
  pincode: string | null;
  country: string;
  gstin: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  is_default: number;
  is_active: number;
  fulfils_online_orders: number;
  priority: number;
  created_at: Date;
  updated_at: Date;
  item_count?: number;
  total_on_hand?: number;
}

interface CountRow extends RowDataPacket {
  total: number;
}

export interface SummaryRow extends RowDataPacket {
  total_skus: number;
  total_on_hand: number;
  total_available: number;
  low_stock_count: number;
  out_of_stock_count: number;
}

// ── Filters ──────────────────────────────────────────────────────────────────

export type StockState = 'in_stock' | 'low' | 'out_of_stock' | 'untracked';

export interface StockFilters {
  search?: string;
  locationId?: number;
  stockStatus?: StockState;
  productStatus?: string;
}

export interface MovementFilters {
  variantId?: number;
  locationId?: number;
  movementType?: string;
  from?: string;
  to?: string;
}

// ── Shared scope ─────────────────────────────────────────────────────────────

/**
 * What counts as an inventory row, in exactly one place.
 *
 * The stock list, the row count, the KPI summary and the per-location totals all
 * used to carry their own predicate, so the cards never footed against the table
 * they sat above: the summary skipped soft-deleted variants, the list also
 * skipped soft-deleted products, and the location totals filtered nothing at all
 * — three numbers for one quantity on one screen. Every read now composes these.
 */
const STOCK_FROM = `
    FROM inventory_items ii
    JOIN product_variants v ON v.id = ii.variant_id
    JOIN products p ON p.id = v.product_id
    JOIN inventory_locations il ON il.id = ii.location_id
   WHERE ii.shop_id = ?
     AND v.deleted_at IS NULL
     AND p.deleted_at IS NULL`;

/**
 * Whether a row is out, low, healthy — or simply not stock-managed.
 *
 * The badge in the table and the "low stock" / "out of stock" counters must agree
 * on the answer, so neither derives it independently: the API computes it here
 * and both consume the result. A variant with track_inventory = 0 is 'untracked'
 * rather than "out of stock", which is why a zero-quantity sample product no
 * longer inflates the out-of-stock counter.
 */
const STOCK_STATE_SQL = `CASE
    WHEN v.track_inventory = 0 THEN 'untracked'
    WHEN ii.quantity_available <= 0 THEN 'out_of_stock'
    WHEN ii.quantity_available <= v.low_stock_threshold THEN 'low'
    ELSE 'in_stock'
  END`;

/**
 * A location row plus its counters. The counters are scoped exactly like the
 * stock list — soft-deleted products and variants excluded — so "78 items" on the
 * location and the rows you get when you filter the list by it are the same set.
 */
const LOCATION_SELECT = `
  SELECT il.*,
         (SELECT COUNT(*)
            FROM inventory_items ii
            JOIN product_variants v ON v.id = ii.variant_id
            JOIN products p ON p.id = v.product_id
           WHERE ii.shop_id = il.shop_id AND v.deleted_at IS NULL AND p.deleted_at IS NULL
             AND ii.location_id = il.id) AS item_count,
         (SELECT COALESCE(SUM(ii.quantity_on_hand), 0)
            FROM inventory_items ii
            JOIN product_variants v ON v.id = ii.variant_id
            JOIN products p ON p.id = v.product_id
           WHERE ii.shop_id = il.shop_id AND v.deleted_at IS NULL AND p.deleted_at IS NULL
             AND ii.location_id = il.id) AS total_on_hand
    FROM inventory_locations il
   WHERE il.shop_id = ?`;

// ── Repository ───────────────────────────────────────────────────────────────

/**
 * Stock levels list. Joins inventory_items → product_variants → products so the
 * admin sees product name, SKU, variant title, image alongside quantities.
 */
const STOCK_SELECT = `
  SELECT ii.id AS inventory_item_id,
         ii.variant_id,
         ii.location_id,
         v.sku,
         v.barcode,
         v.variant_title,
         v.product_id,
         p.name AS product_name,
         p.status AS product_status,
         v.track_inventory,
         v.allow_backorder,
         v.low_stock_threshold,
         ii.quantity_on_hand,
         ii.quantity_reserved,
         ii.quantity_available,
         ii.quantity_incoming,
         ii.safety_stock,
         ii.bin_location,
         ii.last_counted_at,
         il.code AS location_code,
         il.name AS location_name,
         ${STOCK_STATE_SQL} AS stock_state,
         (SELECT m.storage_key FROM media_attachments ma
            JOIN media m ON m.id = ma.media_id
           WHERE ma.shop_id = p.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = p.id
             AND ma.collection = 'gallery'
           ORDER BY ma.is_primary DESC, ma.sort_order ASC LIMIT 1) AS primary_image_key,
         ii.updated_at
  ${STOCK_FROM}`;

/**
 * Filters appended to STOCK_FROM. The first parameter is always the shop,
 * binding the `ii.shop_id = ?` that STOCK_FROM opens its WHERE with.
 */
function buildStockWhere(filters: StockFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [shopId()];

  if (filters.search) {
    conditions.push('(v.sku LIKE ? OR p.name LIKE ? OR v.variant_title LIKE ? OR v.barcode LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term, term);
  }

  if (filters.locationId) {
    conditions.push('ii.location_id = ?');
    params.push(filters.locationId);
  }

  // Filtering by state reuses the expression the badge and the counters use, so
  // "8 low" in the summary and the 8 rows behind the Low filter are the same 8.
  if (filters.stockStatus) {
    conditions.push(`${STOCK_STATE_SQL} = ?`);
    params.push(filters.stockStatus);
  }

  if (filters.productStatus) {
    conditions.push('p.status = ?');
    params.push(filters.productStatus);
  }

  const clause = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';
  return { clause, params };
}

const MOVEMENT_SELECT = `
  SELECT im.id,
         im.variant_id,
         im.location_id,
         im.movement_type,
         im.quantity_delta,
         im.quantity_after,
         im.reference_type,
         im.reference_id,
         im.batch_id,
         im.unit_cost,
         im.reason,
         im.admin_user_id,
         NULLIF(CONCAT_WS(' ', au.first_name, au.last_name), '') AS admin_name,
         im.created_at,
         v.sku,
         v.variant_title,
         p.name AS product_name,
         il.code AS location_code
    FROM inventory_movements im
    JOIN product_variants v ON v.id = im.variant_id
    JOIN products p ON p.id = v.product_id
    JOIN inventory_locations il ON il.id = im.location_id
    LEFT JOIN admin_users au ON au.id = im.admin_user_id
   WHERE im.shop_id = ?`;

/** Same contract as buildStockWhere: the shop binds the base WHERE first. */
function buildMovementWhere(filters: MovementFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [shopId()];

  if (filters.variantId) {
    conditions.push('im.variant_id = ?');
    params.push(filters.variantId);
  }
  if (filters.locationId) {
    conditions.push('im.location_id = ?');
    params.push(filters.locationId);
  }
  if (filters.movementType) {
    conditions.push('im.movement_type = ?');
    params.push(filters.movementType);
  }
  if (filters.from) {
    conditions.push('im.created_at >= ?');
    params.push(`${filters.from} 00:00:00`);
  }
  if (filters.to) {
    conditions.push('im.created_at <= ?');
    params.push(`${filters.to} 23:59:59`);
  }

  const clause = conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '';
  return { clause, params };
}

export const inventoryRepository = {
  // ── Stock levels ─────────────────────────────────────────────────────────

  async listStock(
    filters: StockFilters,
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<StockLevelRow[]> {
    const { clause, params } = buildStockWhere(filters);
    return query<StockLevelRow>(
      `${STOCK_SELECT}${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async countStock(filters: StockFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildStockWhere(filters);
    const row = await queryOne<CountRow>(
      `SELECT COUNT(*) AS total ${STOCK_FROM}${clause}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  async findStockItem(
    variantId: number,
    locationId?: number,
    exec: Executor = pool,
  ): Promise<StockLevelRow | null> {
    const locationClause = locationId
      ? ' AND ii.location_id = ?'
      : ' AND il.is_default = 1';
    const params = locationId ? [shopId(), variantId, locationId] : [shopId(), variantId];
    return queryOne<StockLevelRow>(
      `${STOCK_SELECT} AND ii.variant_id = ?${locationClause} LIMIT 1`,
      params,
      exec,
    );
  },

  async getInventoryItem(
    inventoryItemId: number,
    exec: Executor = pool,
  ): Promise<StockLevelRow | null> {
    return queryOne<StockLevelRow>(
      `${STOCK_SELECT} AND ii.id = ? LIMIT 1`,
      [shopId(), inventoryItemId],
      exec,
    );
  },

  /**
   * Take a write lock on one variant's stock at one location and return the
   * quantity as it stands under that lock.
   *
   * Every caller that decides something from the current quantity — "would this
   * go negative?", "what is quantity_after?" — has to read it through here. The
   * guard used to run against an unlocked SELECT, so two concurrent -3
   * adjustments against 5 on hand both saw 5, both passed, and the row ended at
   * -1 with two movement rows each claiming to have landed on 2.
   *
   * Deliberately narrow: it touches inventory_items and nothing else, so the lock
   * does not spread to product_variants or the media rows the presentation query
   * joins.
   */
  async lockStockItem(
    variantId: number,
    locationId: number,
    exec: Executor = pool,
  ): Promise<{ id: number; location_id: number; quantity_on_hand: number } | null> {
    return queryOne<RowDataPacket & { id: number; location_id: number; quantity_on_hand: number }>(
      `SELECT id, location_id, quantity_on_hand
         FROM inventory_items
        WHERE shop_id = ? AND variant_id = ? AND location_id = ?
        LIMIT 1
        FOR UPDATE`,
      [shopId(), variantId, locationId],
      exec,
    );
  },

  // ── Stock adjustments ──────────────────────────────────────────────────

  async adjustOnHand(
    inventoryItemId: number,
    delta: number,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      'UPDATE inventory_items SET quantity_on_hand = quantity_on_hand + ? WHERE shop_id = ? AND id = ?',
      [delta, shopId(), inventoryItemId],
      exec,
    );
  },

  async setOnHand(
    inventoryItemId: number,
    quantity: number,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      'UPDATE inventory_items SET quantity_on_hand = ? WHERE shop_id = ? AND id = ?',
      [quantity, shopId(), inventoryItemId],
      exec,
    );
  },

  async recordMovement(
    data: {
      variantId: number;
      locationId: number;
      movementType: string;
      quantityDelta: number;
      quantityAfter: number;
      referenceType?: string | null;
      referenceId?: number | null;
      batchId?: number | null;
      unitCost?: number | null;
      reason?: string | null;
      adminUserId?: number | null;
    },
    exec: Executor = pool,
  ): Promise<number> {
    // batch_id and unit_cost are selected and returned by the read path, so they
    // are writable here too rather than being columns that can only ever be null.
    return insert(
      `INSERT INTO inventory_movements
         (shop_id, variant_id, location_id, movement_type, quantity_delta, quantity_after,
          reference_type, reference_id, batch_id, unit_cost, reason, admin_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.variantId,
        data.locationId,
        data.movementType,
        data.quantityDelta,
        data.quantityAfter,
        data.referenceType ?? null,
        data.referenceId ?? null,
        data.batchId ?? null,
        data.unitCost ?? null,
        data.reason ?? null,
        data.adminUserId ?? null,
      ],
      exec,
    );
  },

  /**
   * Ensure an inventory_items row exists for a variant at the default location.
   * If the variant already has a row, this is a no-op. Used when we need to
   * guarantee the row exists before adjusting.
   */
  async ensureItemExists(variantId: number, locationId?: number, exec: Executor = pool): Promise<void> {
    if (locationId) {
      await execute(
        `INSERT IGNORE INTO inventory_items (shop_id, variant_id, location_id, quantity_on_hand) VALUES (?, ?, ?, 0)`,
        [shopId(), variantId, locationId],
        exec,
      );
    } else {
      await execute(
        `INSERT IGNORE INTO inventory_items (shop_id, variant_id, location_id, quantity_on_hand)
         SELECT shop_id, ?, id, 0 FROM inventory_locations WHERE shop_id = ? AND is_default = 1 LIMIT 1`,
        [variantId, shopId()],
        exec,
      );
    }
  },

  // ── Movement history ─────────────────────────────────────────────────────

  async listMovements(
    filters: MovementFilters,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<MovementRow[]> {
    const { clause, params } = buildMovementWhere(filters);
    return query<MovementRow>(
      `${MOVEMENT_SELECT}${clause} ORDER BY im.created_at DESC, im.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async countMovements(filters: MovementFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildMovementWhere(filters);
    const row = await queryOne<CountRow>(
      `SELECT COUNT(*) AS total
         FROM inventory_movements im
         JOIN product_variants v ON v.id = im.variant_id
         JOIN products p ON p.id = v.product_id
         JOIN inventory_locations il ON il.id = im.location_id
        WHERE im.shop_id = ?${clause}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  // ── Summary stats ────────────────────────────────────────────────────────

  /**
   * The KPI row above the table.
   *
   * Takes the same filters as the list (minus the state filter, which is what the
   * counters break down) so the cards describe the rows on screen rather than the
   * whole catalogue — search for one product and the cards follow.
   */
  async summary(filters: StockFilters = {}, exec: Executor = pool): Promise<SummaryRow> {
    const { clause, params } = buildStockWhere({ ...filters, stockStatus: undefined });
    const row = await queryOne<SummaryRow>(
      `SELECT
         COUNT(DISTINCT ii.variant_id) AS total_skus,
         COALESCE(SUM(ii.quantity_on_hand), 0) AS total_on_hand,
         COALESCE(SUM(ii.quantity_available), 0) AS total_available,
         COALESCE(SUM(${STOCK_STATE_SQL} = 'low'), 0) AS low_stock_count,
         COALESCE(SUM(${STOCK_STATE_SQL} = 'out_of_stock'), 0) AS out_of_stock_count
       ${STOCK_FROM}${clause}`,
      params,
      exec,
    );
    return row!;
  },

  // ── Locations ────────────────────────────────────────────────────────────

  async listLocations(exec: Executor = pool): Promise<LocationRow[]> {
    return query<LocationRow>(
      `${LOCATION_SELECT} ORDER BY il.is_default DESC, il.priority ASC, il.name ASC`,
      [shopId()],
      exec,
    );
  },

  async findLocationById(id: number, exec: Executor = pool): Promise<LocationRow | null> {
    return queryOne<LocationRow>(`${LOCATION_SELECT} AND il.id = ?`, [shopId(), id], exec);
  },

  /**
   * Exactly one location may be the default, because `findStockItem` and
   * `ensureItemExists` both resolve "no location given" through `is_default = 1`
   * and a second default would make which row they touch a matter of table order.
   */
  async clearDefaultLocation(exceptId: number | null, exec: Executor = pool): Promise<void> {
    await execute(
      'UPDATE inventory_locations SET is_default = 0 WHERE shop_id = ? AND is_default = 1 AND id <> ?',
      [shopId(), exceptId ?? 0],
      exec,
    );
  },

  async findLocationByCode(code: string, exec: Executor = pool): Promise<LocationRow | null> {
    return queryOne<LocationRow>(
      'SELECT * FROM inventory_locations WHERE shop_id = ? AND code = ?',
      [shopId(), code],
      exec,
    );
  },

  async createLocation(
    data: {
      code: string;
      name: string;
      location_type?: string;
      line1?: string | null;
      line2?: string | null;
      city?: string | null;
      state?: string | null;
      state_code?: string | null;
      pincode?: string | null;
      country?: string;
      gstin?: string | null;
      contact_name?: string | null;
      contact_phone?: string | null;
      is_default?: boolean;
      is_active?: boolean;
      fulfils_online_orders?: boolean;
      priority?: number;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO inventory_locations
         (shop_id, code, name, location_type, line1, line2, city, state, state_code, pincode,
          country, gstin, contact_name, contact_phone, is_default, is_active,
          fulfils_online_orders, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.code,
        data.name,
        data.location_type ?? 'warehouse',
        data.line1 ?? null,
        data.line2 ?? null,
        data.city ?? null,
        data.state ?? null,
        data.state_code ?? null,
        data.pincode ?? null,
        data.country ?? shopCountry(),
        data.gstin ?? null,
        data.contact_name ?? null,
        data.contact_phone ?? null,
        data.is_default ? 1 : 0,
        data.is_active !== false ? 1 : 0,
        data.fulfils_online_orders !== false ? 1 : 0,
        data.priority ?? 0,
      ],
      exec,
    );
  },

  async updateLocation(
    id: number,
    data: Record<string, unknown>,
    exec: Executor = pool,
  ): Promise<void> {
    const allowed = [
      'name', 'location_type', 'line1', 'line2', 'city', 'state', 'state_code',
      'pincode', 'country', 'gstin', 'contact_name', 'contact_phone',
      'is_default', 'is_active', 'fulfils_online_orders', 'priority',
    ];
    const sets: string[] = [];
    const params: unknown[] = [];

    for (const key of allowed) {
      if (data[key] !== undefined) {
        sets.push(`\`${key}\` = ?`);
        // Boolean → tinyint
        const val = data[key];
        params.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
      }
    }

    if (sets.length === 0) return;
    params.push(shopId(), id);
    await execute(`UPDATE inventory_locations SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`, params, exec);
  },

  /** Default location id — used when no location is specified. */
  async defaultLocationId(exec: Executor = pool): Promise<number | null> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      'SELECT id FROM inventory_locations WHERE shop_id = ? AND is_default = 1 LIMIT 1',
      [shopId()],
      exec,
    );
    return row?.id ?? null;
  },
};
