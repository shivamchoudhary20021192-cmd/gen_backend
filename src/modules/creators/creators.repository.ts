import {
  execute,
  insert,
  pool,
  query,
  queryOne,
  type Executor,
  type RowDataPacket,
} from '../../db/pool';
import type { CreatorInput, CreatorRow } from './creators.types';
import { shopId } from '../../platform/tenancy/context';

/**
 * The people whose faces sell the product.
 *
 * `block_count` is a subquery rather than a stored counter: it is read on a
 * list of a dozen rows, and a counter that nothing decrements is how you end up
 * refusing to delete a creator nobody features any more.
 */
const SELECT_SQL = `
  SELECT c.id, c.public_id, c.slug, c.name, c.handle, c.role, c.bio,
         c.portrait_media_id, m.storage_key AS portrait_key, m.alt_text AS portrait_alt,
         c.instagram_url, c.youtube_url, c.tiktok_url, c.website_url,
         c.is_active, c.is_identity_public, c.sort_order, c.created_at, c.updated_at,
         (SELECT COUNT(*) FROM content_section_blocks b
           WHERE b.shop_id = c.shop_id AND b.creator_id = c.id) AS block_count
    FROM creators c
    LEFT JOIN media m ON m.id = c.portrait_media_id AND m.shop_id = c.shop_id`;

export const creatorsRepository = {
  async list(
    filters: { activeOnly?: boolean; search?: string },
    exec: Executor = pool,
  ): Promise<CreatorRow[]> {
    const where: string[] = ['c.shop_id = ?', 'c.deleted_at IS NULL'];
    const params: unknown[] = [shopId()];

    if (filters.activeOnly) where.push('c.is_active = 1');
    if (filters.search) {
      where.push('(c.name LIKE ? OR c.handle LIKE ?)');
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }

    return query<CreatorRow>(
      `${SELECT_SQL} WHERE ${where.join(' AND ')} ORDER BY c.sort_order ASC, c.name ASC`,
      params,
      exec,
    );
  },

  async findById(id: number, exec: Executor = pool): Promise<CreatorRow | null> {
    return queryOne<CreatorRow>(
      `${SELECT_SQL} WHERE c.shop_id = ? AND c.id = ? AND c.deleted_at IS NULL`,
      [shopId(), id],
      exec,
    );
  },

  async create(
    data: CreatorInput & { slug: string; name: string; createdByAdminId: number | null },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO creators
         (shop_id, slug, name, handle, role, bio, portrait_media_id,
          instagram_url, youtube_url, tiktok_url, website_url,
          is_active, is_identity_public, sort_order, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.slug,
        data.name,
        data.handle ?? null,
        data.role ?? null,
        data.bio ?? null,
        data.portrait_media_id ?? null,
        data.instagram_url ?? null,
        data.youtube_url ?? null,
        data.tiktok_url ?? null,
        data.website_url ?? null,
        data.is_active === false ? 0 : 1,
        data.is_identity_public === false ? 0 : 1,
        data.sort_order ?? 0,
        data.createdByAdminId,
      ],
      exec,
    );
  },

  /** Only the keys the caller sent — a PATCH that omits `bio` must not blank it. */
  async update(id: number, data: CreatorInput, exec: Executor = pool): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (data.slug !== undefined) assign('slug', data.slug);
    if (data.name !== undefined) assign('name', data.name);
    if (data.handle !== undefined) assign('handle', data.handle);
    if (data.role !== undefined) assign('role', data.role);
    if (data.bio !== undefined) assign('bio', data.bio);
    if (data.portrait_media_id !== undefined) assign('portrait_media_id', data.portrait_media_id);
    if (data.instagram_url !== undefined) assign('instagram_url', data.instagram_url);
    if (data.youtube_url !== undefined) assign('youtube_url', data.youtube_url);
    if (data.tiktok_url !== undefined) assign('tiktok_url', data.tiktok_url);
    if (data.website_url !== undefined) assign('website_url', data.website_url);
    if (data.is_active !== undefined) assign('is_active', data.is_active ? 1 : 0);
    if (data.is_identity_public !== undefined)
      assign('is_identity_public', data.is_identity_public ? 1 : 0);
    if (data.sort_order !== undefined) assign('sort_order', data.sort_order);

    if (sets.length === 0) return;
    params.push(shopId(), id);
    await execute(`UPDATE creators SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`, params, exec);
  },

  /**
   * Soft delete. A creator who appeared in a campaign is part of the record of
   * that campaign, and the blocks that feature her keep their foreign key.
   */
  async softDelete(id: number, exec: Executor = pool): Promise<void> {
    await execute(`UPDATE creators SET deleted_at = NOW(), is_active = 0 WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
  },

  async slugExists(
    slug: string,
    excludeId: number | null,
    exec: Executor = pool,
  ): Promise<boolean> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      `SELECT id FROM creators WHERE shop_id = ? AND slug = ? ${excludeId ? 'AND id <> ?' : ''} LIMIT 1`,
      excludeId ? [shopId(), slug, excludeId] : [shopId(), slug],
      exec,
    );
    return row !== null;
  },
};
