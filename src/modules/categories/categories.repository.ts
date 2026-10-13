import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface CategoryRow extends RowDataPacket {
  id: number;
  parent_id: number | null;
  slug: string;
  name: string;
  short_description: string | null;
  description: string | null;
  banner_media_id: number | null;
  thumbnail_media_id: number | null;
  path: string;
  depth: number;
  sort_order: number;
  is_active: number;
  show_in_menu: number;
  product_count: number;
  /** Computed per query — see `list()`. Absent on rows read by findById/findBySlug. */
  live_product_count?: number;
  subtree_product_count?: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export const categoriesRepository = {
  /**
   * Counts are computed here, not read from `categories.product_count`.
   *
   * That column is a cache that nothing kept warm — assigning a product to a
   * category never touched it — so every category read 0 forever. A correlated
   * COUNT costs a few milliseconds on a taxonomy this size and cannot go stale,
   * which is the right trade until the catalogue is large enough to need a
   * maintained counter (and then it needs a trigger, not hope).
   *
   * Two numbers, because a tree has two honest answers:
   *
   *   live_product_count     products filed directly in this category
   *   subtree_product_count  ...plus everything in its descendants
   *
   * The second is the one that matches what `GET /products?category_id=` returns
   * (that filter includes descendants), so a category showing "1" and listing
   * one product agree with each other.
   *
   * Archived and deleted products are excluded, matching the product list's own
   * default — a count that includes rows the next screen hides is a bug report
   * waiting to happen.
   */
  async list(includeInactive: boolean, exec: Executor = pool): Promise<CategoryRow[]> {
    return query<CategoryRow>(
      `SELECT c.*,
              (SELECT COUNT(*) FROM products p
                WHERE p.shop_id = c.shop_id
                  AND p.category_id = c.id
                  AND p.deleted_at IS NULL
                  AND p.status <> 'archived') AS live_product_count,
              -- The subtree is matched by path prefix, not by key, so both
              -- sides are pinned to this shop: another shop's /skincare/…
              -- must never count here.
              (SELECT COUNT(*) FROM products p
                 JOIN categories d ON d.id = p.category_id AND d.shop_id = p.shop_id AND d.deleted_at IS NULL
                WHERE p.shop_id = c.shop_id
                  AND (d.id = c.id OR d.path LIKE CONCAT(c.path, '/%'))
                  AND p.deleted_at IS NULL
                  AND p.status <> 'archived') AS subtree_product_count
         FROM categories c
        WHERE c.shop_id = ? AND c.deleted_at IS NULL ${includeInactive ? '' : 'AND c.is_active = 1'}
        ORDER BY c.path, c.sort_order, c.name`,
      [shopId()],
      exec,
    );
  },

  async findById(id: number, exec: Executor = pool): Promise<CategoryRow | null> {
    return queryOne<CategoryRow>('SELECT * FROM categories WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1', [shopId(), id], exec);
  },

  async findBySlug(slug: string, exec: Executor = pool): Promise<CategoryRow | null> {
    return queryOne<CategoryRow>('SELECT * FROM categories WHERE shop_id = ? AND slug = ? AND deleted_at IS NULL LIMIT 1', [shopId(), slug], exec);
  },

  async create(
    data: {
      parentId: number | null;
      slug: string;
      name: string;
      shortDescription: string | null;
      description: string | null;
      bannerMediaId: number | null;
      thumbnailMediaId: number | null;
      path: string;
      depth: number;
      sortOrder: number;
      isActive: boolean;
      showInMenu: boolean;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO categories
         (shop_id, parent_id, slug, name, short_description, description, banner_media_id,
          thumbnail_media_id, path, depth, sort_order, is_active, show_in_menu)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.parentId,
        data.slug,
        data.name,
        data.shortDescription,
        data.description,
        data.bannerMediaId,
        data.thumbnailMediaId,
        data.path,
        data.depth,
        data.sortOrder,
        data.isActive ? 1 : 0,
        data.showInMenu ? 1 : 0,
      ],
      exec,
    );
  },

  async update(id: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `\`${k}\` = ?`).join(', ');
    await execute(`UPDATE categories SET ${assignments} WHERE shop_id = ? AND id = ?`, [...Object.values(fields), shopId(), id], exec);
  },

  async softDelete(id: number, exec: Executor = pool): Promise<void> {
    await execute('UPDATE categories SET deleted_at = NOW(), is_active = 0 WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async countChildren(id: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      'SELECT COUNT(*) AS total FROM categories WHERE shop_id = ? AND parent_id = ? AND deleted_at IS NULL',
      [shopId(), id],
      exec,
    );
    return row?.total ?? 0;
  },

  async countProducts(id: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      'SELECT COUNT(*) AS total FROM products WHERE shop_id = ? AND category_id = ? AND deleted_at IS NULL',
      [shopId(), id],
      exec,
    );
    return row?.total ?? 0;
  },

  /**
   * A category's `path` is denormalised for cheap subtree queries, so moving a
   * node has to rewrite every descendant. One statement, using the old path as
   * a prefix match.
   */
  async rewriteDescendantPaths(oldPath: string, newPath: string, depthDelta: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE categories
          SET path  = CONCAT(?, SUBSTRING(path, ?)),
              depth = depth + ?
        WHERE shop_id = ? AND path LIKE CONCAT(?, '/%') AND deleted_at IS NULL`,
      [newPath, oldPath.length + 1, depthDelta, shopId(), oldPath],
      exec,
    );
  },

  async refreshProductCounts(exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE categories c
          SET product_count = (
            SELECT COUNT(*) FROM products p
             WHERE p.shop_id = c.shop_id AND p.category_id = c.id AND p.deleted_at IS NULL AND p.status <> 'archived')
        WHERE c.shop_id = ?`,
      [shopId()],
      exec,
    );
  },

  async reorder(items: { id: number; sort_order: number }[], exec: Executor = pool): Promise<void> {
    for (const item of items) {
      await execute('UPDATE categories SET sort_order = ? WHERE shop_id = ? AND id = ?', [item.sort_order, shopId(), item.id], exec);
    }
  },
};
