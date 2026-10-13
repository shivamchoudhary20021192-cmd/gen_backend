import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface CollectionRow extends RowDataPacket {
  id: number;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  meta_title: string | null;
  meta_description: string | null;
  collection_type: 'manual' | 'automatic';
  match_condition: 'all' | 'any';
  sort_type: string;
  image_media_id: number | null;
  banner_media_id: number | null;
  is_active: number;
  show_in_menu: number;
  product_count: number;
  /** Computed per query in list()/findById(); see the note there. */
  live_product_count?: number;
  published_at: Date | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface CollectionRuleRow extends RowDataPacket {
  id: number;
  collection_id: number;
  field: string;
  operator: string;
  value: string | null;
  sort_order: number;
}

interface CountRow extends RowDataPacket {
  total: number;
}

export const collectionsRepository = {
  async list(
    filters: { search?: string; type?: string; active?: boolean },
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<CollectionRow[]> {
    const conditions = ['c.shop_id = ?', 'c.deleted_at IS NULL'];
    const params: unknown[] = [shopId()];
    if (filters.search) {
      conditions.push('(c.title LIKE ? OR c.slug LIKE ?)');
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }
    if (filters.type) {
      conditions.push('c.collection_type = ?');
      params.push(filters.type);
    }
    if (filters.active !== undefined) {
      conditions.push('c.is_active = ?');
      params.push(filters.active ? 1 : 0);
    }
    // `collections.product_count` is a cache kept in step with MEMBERSHIP
    // changes, but not with the products themselves — archive a product and the
    // number stays too high, so the list disagrees with what clicking through
    // shows. Counting live keeps the two honest.
    return query<CollectionRow>(
      `SELECT c.*,
              (SELECT COUNT(*) FROM collection_products cp
                 JOIN products p ON p.id = cp.product_id AND p.shop_id = cp.shop_id
                WHERE cp.shop_id = c.shop_id
                  AND cp.collection_id = c.id
                  AND p.deleted_at IS NULL
                  AND p.status <> 'archived') AS live_product_count
         FROM collections c
        WHERE ${conditions.join(' AND ')}
        ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async count(filters: { search?: string; type?: string; active?: boolean }, exec: Executor = pool): Promise<number> {
    const conditions = ['c.shop_id = ?', 'c.deleted_at IS NULL'];
    const params: unknown[] = [shopId()];
    if (filters.search) {
      conditions.push('(c.title LIKE ? OR c.slug LIKE ?)');
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }
    if (filters.type) {
      conditions.push('c.collection_type = ?');
      params.push(filters.type);
    }
    if (filters.active !== undefined) {
      conditions.push('c.is_active = ?');
      params.push(filters.active ? 1 : 0);
    }
    const row = await queryOne<CountRow>(
      `SELECT COUNT(*) AS total FROM collections c WHERE ${conditions.join(' AND ')}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  async findById(id: number, exec: Executor = pool): Promise<CollectionRow | null> {
    return queryOne<CollectionRow>(
      `SELECT c.*,
              (SELECT COUNT(*) FROM collection_products cp
                 JOIN products p ON p.id = cp.product_id AND p.shop_id = cp.shop_id
                WHERE cp.shop_id = c.shop_id
                  AND cp.collection_id = c.id
                  AND p.deleted_at IS NULL
                  AND p.status <> 'archived') AS live_product_count
         FROM collections c
        WHERE c.shop_id = ? AND c.id = ? AND c.deleted_at IS NULL LIMIT 1`,
      [shopId(), id],
      exec,
    );
  },

  async create(
    data: {
      slug: string;
      title: string;
      subtitle: string | null;
      description: string | null;
      metaTitle: string | null;
      metaDescription: string | null;
      collectionType: 'manual' | 'automatic';
      matchCondition: 'all' | 'any';
      sortType: string;
      imageMediaId: number | null;
      bannerMediaId: number | null;
      isActive: boolean;
      showInMenu: boolean;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO collections
         (shop_id, slug, title, subtitle, description, meta_title, meta_description, collection_type,
          match_condition, sort_type, image_media_id, banner_media_id, is_active, show_in_menu, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${data.isActive ? 'NOW()' : 'NULL'})`,
      [
        shopId(),
        data.slug,
        data.title,
        data.subtitle,
        data.description,
        data.metaTitle,
        data.metaDescription,
        data.collectionType,
        data.matchCondition,
        data.sortType,
        data.imageMediaId,
        data.bannerMediaId,
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
    await execute(`UPDATE collections SET ${assignments} WHERE shop_id = ? AND id = ?`, [...Object.values(fields), shopId(), id], exec);
  },

  async softDelete(id: number, exec: Executor = pool): Promise<void> {
    await execute('UPDATE collections SET deleted_at = NOW(), is_active = 0 WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async rulesFor(collectionId: number, exec: Executor = pool): Promise<CollectionRuleRow[]> {
    return query<CollectionRuleRow>(
      'SELECT * FROM collection_rules WHERE shop_id = ? AND collection_id = ? ORDER BY sort_order',
      [shopId(), collectionId],
      exec,
    );
  },

  async replaceRules(
    collectionId: number,
    rules: { field: string; operator: string; value: string | null }[],
    exec: Executor = pool,
  ): Promise<void> {
    await execute('DELETE FROM collection_rules WHERE shop_id = ? AND collection_id = ?', [shopId(), collectionId], exec);
    for (const [index, rule] of rules.entries()) {
      await execute(
        'INSERT INTO collection_rules (shop_id, collection_id, field, operator, value, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
        [shopId(), collectionId, rule.field, rule.operator, rule.value, index],
        exec,
      );
    }
  },

  async setMembers(collectionId: number, productIds: number[], exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM collection_products WHERE shop_id = ? AND collection_id = ? AND is_pinned = 0', [shopId(), collectionId], exec);
    if (productIds.length === 0) return;
    const values = productIds.map(() => '(?, ?, ?, ?)').join(', ');
    const params = productIds.flatMap((pid, index) => [shopId(), collectionId, pid, index]);
    await execute(
      `INSERT INTO collection_products (shop_id, collection_id, product_id, position) VALUES ${values}
       ON DUPLICATE KEY UPDATE position = VALUES(position)`,
      params,
      exec,
    );
  },

  async addMember(collectionId: number, productId: number, position: number, exec: Executor = pool): Promise<void> {
    await execute(
      `INSERT INTO collection_products (shop_id, collection_id, product_id, position, is_pinned)
       VALUES (?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE position = VALUES(position), is_pinned = 1`,
      [shopId(), collectionId, productId, position],
      exec,
    );
  },

  async removeMember(collectionId: number, productId: number, exec: Executor = pool): Promise<number> {
    const result = await execute(
      'DELETE FROM collection_products WHERE shop_id = ? AND collection_id = ? AND product_id = ?',
      [shopId(), collectionId, productId],
      exec,
    );
    return result.affectedRows;
  },

  async clearMembers(collectionId: number, exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM collection_products WHERE shop_id = ? AND collection_id = ?', [shopId(), collectionId], exec);
  },

  /** Every collection this product is in, manual and automatic alike. */
  async forProduct(productId: number, exec: Executor = pool): Promise<CollectionRow[]> {
    return query<CollectionRow>(
      `SELECT c.* FROM collections c
         JOIN collection_products cp ON cp.collection_id = c.id AND cp.shop_id = c.shop_id
        WHERE c.shop_id = ? AND cp.product_id = ? AND c.deleted_at IS NULL
        ORDER BY c.title`,
      [shopId(), productId],
      exec,
    );
  },

  /** Detach this product from every MANUAL collection; automatic ones are left alone. */
  async clearManualMemberships(productId: number, exec: Executor = pool): Promise<void> {
    await execute(
      `DELETE cp FROM collection_products cp
         JOIN collections c ON c.id = cp.collection_id AND c.shop_id = cp.shop_id
        WHERE cp.shop_id = ? AND cp.product_id = ? AND c.collection_type = 'manual'`,
      [shopId(), productId],
      exec,
    );
  },

  async memberIds(collectionId: number, exec: Executor = pool): Promise<number[]> {
    const rows = await query<RowDataPacket & { product_id: number }>(
      'SELECT product_id FROM collection_products WHERE shop_id = ? AND collection_id = ? ORDER BY position',
      [shopId(), collectionId],
      exec,
    );
    return rows.map((r) => r.product_id);
  },

  async syncProductCount(collectionId: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE collections
          SET product_count = (SELECT COUNT(*) FROM collection_products WHERE shop_id = ? AND collection_id = ?)
        WHERE shop_id = ? AND id = ?`,
      [shopId(), collectionId, shopId(), collectionId],
      exec,
    );
  },

  /** Runs the compiled rule SQL and returns matching product ids. */
  async findProductsMatching(whereSql: string, params: unknown[], exec: Executor = pool): Promise<number[]> {
    const rows = await query<RowDataPacket & { id: number }>(
      `SELECT DISTINCT p.id
         FROM products p
        WHERE p.shop_id = ? AND p.deleted_at IS NULL AND p.status = 'active' AND (${whereSql})
        ORDER BY p.id
        LIMIT 5000`,
      [shopId(), ...params],
      exec,
    );
    return rows.map((r) => r.id);
  },
};
