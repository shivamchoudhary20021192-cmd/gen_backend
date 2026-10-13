import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { IN_STOCK_SQL, publicWhere } from '../storefront/storefront.repository';
import { shopId } from '../../platform/tenancy/context';

/**
 * Shelves — the merchandised rows of products — and the products pinned to them.
 *
 * A shelf row is small and boring; everything interesting happens when the
 * service pairs it with a rule from `shelfRules.ts`. The one thing this file
 * insists on is that a rule query and the shelf's own pins both end up as
 * plain id lists, so the service resolves products exactly once, the same way,
 * however they were chosen.
 */

export interface ShelfRow extends RowDataPacket {
  id: number;
  title: string;
  eyebrow: string | null;
  subtitle: string | null;
  placement: string;
  scope_ref_id: number | null;
  layout: string;
  source: string;
  source_collection_id: number | null;
  window_days: number | null;
  max_products: number;
  include_sold_out: number;
  tone: string;
  cta_label: string | null;
  link_type: string;
  link_url: string | null;
  link_ref_id: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
  is_active: number;
  sort_order: number;
  created_at: Date;
  updated_at: Date;

  /** Joined, so the admin list can name the collection rather than show an id. */
  collection_title: string | null;
  /** How many products are pinned, so the list can say so without a second query. */
  pin_count: number;
}

export interface ShelfPinRow extends RowDataPacket {
  shelf_id: number;
  product_id: number;
  sort_order: number;
  name: string;
  slug: string;
  status: string;
}

export interface RankedIdRow extends RowDataPacket {
  id: number;
}

const COLUMNS = `
  s.id, s.title, s.eyebrow, s.subtitle, s.placement, s.scope_ref_id, s.layout,
  s.source, s.source_collection_id, s.window_days, s.max_products, s.include_sold_out,
  s.tone, s.cta_label, s.link_type, s.link_url, s.link_ref_id,
  s.starts_at, s.ends_at, s.is_active, s.sort_order, s.created_at, s.updated_at,
  col.title AS collection_title,
  (SELECT COUNT(*) FROM shelf_products sp WHERE sp.shop_id = s.shop_id AND sp.shelf_id = s.id) AS pin_count`;

const FROM = `shelves s LEFT JOIN collections col ON col.id = s.source_collection_id AND col.shop_id = s.shop_id`;

export const shelvesRepository = {
  /** Everything the admin should see, including scheduled and switched-off rows. */
  async list(placement: string | null, exec: Executor = pool): Promise<ShelfRow[]> {
    const where = ['s.shop_id = ?', 's.deleted_at IS NULL'];
    const params: unknown[] = [shopId()];
    if (placement) {
      where.push('s.placement = ?');
      params.push(placement);
    }
    return query<ShelfRow>(
      `SELECT ${COLUMNS} FROM ${FROM}
        WHERE ${where.join(' AND ')}
        ORDER BY s.placement, s.sort_order, s.id`,
      params,
      exec,
    );
  },

  /**
   * What the storefront may show on one page, in order.
   *
   * `scopeRefId` is the category or collection being viewed. A shelf with no
   * scope belongs to every page of its placement, which is how "Bestsellers"
   * appears under every category without one row per category; a scoped shelf
   * appears only on its own. The schedule is applied here rather than in the
   * browser — a shelf whose window has not opened should not be in the payload
   * at all, or it is one view-source away from being read early.
   */
  async live(placement: string, scopeRefId: number | null, exec: Executor = pool): Promise<ShelfRow[]> {
    const params: unknown[] = [shopId(), placement];
    let scope = 's.scope_ref_id IS NULL';
    if (scopeRefId !== null) {
      scope = '(s.scope_ref_id IS NULL OR s.scope_ref_id = ?)';
      params.push(scopeRefId);
    }
    return query<ShelfRow>(
      `SELECT ${COLUMNS}
         FROM ${FROM}
        WHERE s.shop_id = ?
          AND s.deleted_at IS NULL
          AND s.is_active = 1
          AND s.placement = ?
          AND ${scope}
          AND (s.starts_at IS NULL OR s.starts_at <= NOW())
          AND (s.ends_at IS NULL OR s.ends_at >= NOW())
        ORDER BY s.sort_order, s.id`,
      params,
      exec,
    );
  },

  async byId(id: number, exec: Executor = pool): Promise<ShelfRow | null> {
    const row = await queryOne<ShelfRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE s.shop_id = ? AND s.id = ? AND s.deleted_at IS NULL`,
      [shopId(), id],
      exec,
    );
    return row ?? null;
  },

  async create(data: Record<string, unknown>, exec: Executor = pool): Promise<number> {
    const row = { ...data, shop_id: shopId() };
    const columns = Object.keys(row);
    return insert(
      `INSERT INTO shelves (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(row),
      exec,
    );
  },

  async update(id: number, data: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const columns = Object.keys(data);
    if (columns.length === 0) return;
    await execute(
      `UPDATE shelves SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE shop_id = ? AND id = ?`,
      [...Object.values(data), shopId(), id],
      exec,
    );
  },

  /** Soft, like the rest of the CMS: a shelf taken down is often put back up. */
  async remove(id: number, exec: Executor = pool): Promise<void> {
    await execute('UPDATE shelves SET deleted_at = NOW() WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async setOrder(ids: number[], exec: Executor = pool): Promise<void> {
    for (const [index, id] of ids.entries()) {
      await execute('UPDATE shelves SET sort_order = ? WHERE shop_id = ? AND id = ? AND deleted_at IS NULL', [index * 10, shopId(), id], exec);
    }
  },

  // ── pins ──────────────────────────────────────────────────────────────────

  /**
   * The pinned products of one shelf, with enough of each to name it.
   *
   * Includes products that are no longer public, on purpose: the admin needs
   * to see that the third pin is a draft, which is why `status` comes back.
   * The public reader filters them out separately.
   */
  async pins(shelfId: number, exec: Executor = pool): Promise<ShelfPinRow[]> {
    return query<ShelfPinRow>(
      `SELECT sp.shelf_id, sp.product_id, sp.sort_order, p.name, p.slug, p.status
         FROM shelf_products sp
         JOIN products p ON p.id = sp.product_id
        WHERE sp.shop_id = ? AND sp.shelf_id = ? AND p.deleted_at IS NULL
        ORDER BY sp.sort_order, sp.product_id`,
      [shopId(), shelfId],
      exec,
    );
  },

  /** Pinned ids that a shopper may actually be shown, in the pinned order. */
  async publicPinIds(shelfId: number, exec: Executor = pool): Promise<RankedIdRow[]> {
    return query<RankedIdRow>(
      `SELECT p.id
         FROM shelf_products sp
         JOIN products p ON p.id = sp.product_id
        WHERE sp.shelf_id = ? AND ${publicWhere()}
        ORDER BY sp.sort_order, sp.product_id`,
      [shelfId],
      exec,
    );
  },

  /**
   * Replace a shelf's pins wholesale.
   *
   * Delete-then-insert rather than a diff: the list is at most a few dozen
   * rows, the order is part of the meaning, and a diff that gets the ordering
   * wrong is a bug nobody sees until a merchandiser swears the list keeps
   * rearranging itself. Called inside the service's transaction.
   */
  async replacePins(shelfId: number, productIds: number[], exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM shelf_products WHERE shop_id = ? AND shelf_id = ?', [shopId(), shelfId], exec);
    if (productIds.length === 0) return;
    const values = productIds.map(() => '(?, ?, ?, ?)').join(', ');
    const params = productIds.flatMap((productId, index) => [shopId(), shelfId, productId, index]);
    await execute(`INSERT INTO shelf_products (shop_id, shelf_id, product_id, sort_order) VALUES ${values}`, params, exec);
  },

  /** Runs one of the ranking queries from `shelfRules.ts`. */
  async rankedIds(sql: string, params: unknown[], exec: Executor = pool): Promise<RankedIdRow[]> {
    return query<RankedIdRow>(sql, params, exec);
  },

  /**
   * Ordinary products to top up a shelf whose rule came back short.
   *
   * `excludeIds` is spread as bound parameters rather than joined into the SQL
   * for the same reason everything else here is.
   */
  async fillerIds(
    orderBy: string,
    limit: number,
    excludeIds: number[],
    inStockOnly: boolean,
    exec: Executor = pool,
  ): Promise<RankedIdRow[]> {
    const conditions = [publicWhere()];
    const params: unknown[] = [];
    if (excludeIds.length > 0) {
      conditions.push(`p.id NOT IN (${excludeIds.map(() => '?').join(', ')})`);
      params.push(...excludeIds);
    }
    if (inStockOnly) conditions.push(IN_STOCK_SQL);
    params.push(limit);
    return query<RankedIdRow>(
      `SELECT p.id FROM products p WHERE ${conditions.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`,
      params,
      exec,
    );
  },

  /** Resolves a category or collection slug to the id a scoped shelf stores. */
  async scopeIdBySlug(kind: 'category' | 'collection', slug: string, exec: Executor = pool): Promise<number | null> {
    const table = kind === 'category' ? 'categories' : 'collections';
    const row = await queryOne<RankedIdRow>(
      `SELECT id FROM ${table} WHERE shop_id = ? AND slug = ? AND deleted_at IS NULL LIMIT 1`,
      [shopId(), slug],
      exec,
    );
    return row?.id ?? null;
  },
};
