import {
  execute,
  insert,
  pool,
  query,
  queryOne,
  type Executor,
  type RowDataPacket,
} from '../../../db/pool';
import type { BlogInput, BlogListRow, BlogRow } from './blogs.types';
import { shopId } from '../../../platform/tenancy/context';

/**
 * Reads and writes for blogs.
 *
 * The counts are subqueries rather than a GROUP BY join so a blog with no
 * articles still comes back as a row with zero — a LEFT JOIN with an aggregate
 * would work too, but this keeps the shape obvious and the list is small by
 * nature: a shop runs two or three blogs, not two thousand.
 */

const LIST_SQL = `
  SELECT b.id, b.slug, b.title, b.description, b.is_active, b.comments_policy, b.created_at,
         (SELECT COUNT(*) FROM cms_articles a
           WHERE a.shop_id = b.shop_id AND a.blog_id = b.id AND a.deleted_at IS NULL) AS article_count,
         (SELECT COUNT(*) FROM cms_articles a
           WHERE a.shop_id = b.shop_id AND a.blog_id = b.id AND a.deleted_at IS NULL
             AND a.status = 'published') AS published_count,
         (SELECT MAX(a.published_at) FROM cms_articles a
           WHERE a.shop_id = b.shop_id AND a.blog_id = b.id AND a.deleted_at IS NULL
             AND a.status = 'published') AS last_published_at
    FROM cms_blogs b
   WHERE b.shop_id = ?`;

export const blogsRepository = {
  async list(activeOnly: boolean, exec: Executor = pool): Promise<BlogListRow[]> {
    return query<BlogListRow & RowDataPacket>(
      `${LIST_SQL}
        ${activeOnly ? 'AND b.is_active = 1' : ''}
        ORDER BY b.id ASC`,
      [shopId()],
      exec,
    );
  },

  async findById(id: number, exec: Executor = pool): Promise<BlogListRow | null> {
    return queryOne<BlogListRow & RowDataPacket>(`${LIST_SQL} AND b.id = ?`, [shopId(), id], exec);
  },

  async findBySlug(slug: string, exec: Executor = pool): Promise<BlogListRow | null> {
    return queryOne<BlogListRow & RowDataPacket>(`${LIST_SQL} AND b.slug = ?`, [shopId(), slug], exec);
  },

  async slugExists(slug: string, excludeId: number | null, exec: Executor = pool): Promise<boolean> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      `SELECT id FROM cms_blogs WHERE shop_id = ? AND slug = ? ${excludeId ? 'AND id <> ?' : ''} LIMIT 1`,
      excludeId ? [shopId(), slug, excludeId] : [shopId(), slug],
      exec,
    );
    return row !== null;
  },

  async create(data: BlogInput & { slug: string }, exec: Executor = pool): Promise<number> {
    return insert(
      `INSERT INTO cms_blogs (shop_id, slug, title, description, is_active, comments_policy) VALUES (?, ?, ?, ?, ?, ?)`,
      [shopId(), data.slug, data.title, data.description ?? null, data.is_active === false ? 0 : 1, data.comments_policy ?? 'disabled'],
      exec,
    );
  },

  async update(id: number, data: BlogInput, exec: Executor = pool): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    // Only the keys the caller sent — a PATCH that omits `description` must not
    // blank it.
    if (data.slug !== undefined) {
      sets.push('slug = ?');
      params.push(data.slug);
    }
    if (data.title !== undefined) {
      sets.push('title = ?');
      params.push(data.title);
    }
    if (data.description !== undefined) {
      sets.push('description = ?');
      params.push(data.description);
    }
    if (data.is_active !== undefined) {
      sets.push('is_active = ?');
      params.push(data.is_active ? 1 : 0);
    }
    if (data.comments_policy !== undefined) {
      sets.push('comments_policy = ?');
      params.push(data.comments_policy);
    }

    if (sets.length === 0) return;
    params.push(shopId(), id);
    await execute(`UPDATE cms_blogs SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`, params, exec);
  },

  /**
   * A hard delete.
   *
   * `cms_articles.blog_id` is ON DELETE CASCADE, so this would take every
   * article with it — which is why the service refuses unless the blog is
   * empty, or the caller has said where the articles should go instead.
   */
  async remove(id: number, exec: Executor = pool): Promise<void> {
    await execute(`DELETE FROM cms_blogs WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
  },

  /** Moves every article from one blog to another, for a delete-with-reassign. */
  async moveArticles(fromId: number, toId: number, exec: Executor = pool): Promise<number> {
    const result = await execute(
      `UPDATE cms_articles SET blog_id = ? WHERE shop_id = ? AND blog_id = ?`,
      [toId, shopId(), fromId],
      exec,
    );
    return result.affectedRows;
  },

  async countBlogs(exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM cms_blogs WHERE shop_id = ?`,
      [shopId()],
      exec,
    );
    return Number(row?.total ?? 0);
  },

  async findAny(excludeId: number, exec: Executor = pool): Promise<BlogRow | null> {
    return queryOne<BlogRow & RowDataPacket>(
      `SELECT id, slug, title, description, is_active, created_at
         FROM cms_blogs WHERE shop_id = ? AND id <> ? ORDER BY is_active DESC, id ASC LIMIT 1`,
      [shopId(), excludeId],
      exec,
    );
  },
};
