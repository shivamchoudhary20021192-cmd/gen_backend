import {
  execute,
  insert,
  pool,
  query,
  queryOne,
  type Executor,
  type RowDataPacket,
} from '../../../db/pool';
import type {
  ArticleDetailRow,
  ArticleFilters,
  ArticleInput,
  ArticleListRow,
  ArticleStatus,
} from './articles.types';
import { shopId } from '../../../platform/tenancy/context';

/**
 * Reads and writes for the Journal.
 *
 * Columns are listed by name rather than `a.*` throughout. The same rows are
 * read by the public storefront repository below, and a `preview_token` or a
 * future internal column must not be able to reach a visitor's browser because
 * someone widened a SELECT.
 */

const LIST_COLUMNS = `
  a.id, a.public_id, a.blog_id, a.category_id, a.slug, a.title, a.subtitle,
  a.excerpt, a.cover_media_id, a.locale, a.author_name, a.author_title,
  a.author_media_id, a.medically_reviewed_by, a.reviewed_at, a.next_review_due,
  a.read_time_minutes, a.status, a.is_featured, a.published_at, a.scheduled_at,
  a.is_indexable, a.view_count, a.created_at, a.updated_at,
  c.name AS category_name, c.slug AS category_slug,
  b.slug AS blog_slug, b.title AS blog_title,
  cover.storage_key AS cover_key, cover.alt_text AS cover_alt`;

const JOINS = `
    FROM cms_articles a
    JOIN cms_blogs b ON b.id = a.blog_id
    LEFT JOIN cms_article_categories c ON c.id = a.category_id AND c.shop_id = a.shop_id
    LEFT JOIN media cover ON cover.id = a.cover_media_id AND cover.shop_id = a.shop_id`;

function buildFilters(filters: ArticleFilters): { sql: string; params: unknown[] } {
  const conditions = ['a.shop_id = ?', 'a.deleted_at IS NULL'];
  const params: unknown[] = [shopId()];

  if (filters.q) {
    conditions.push('(a.title LIKE ? OR a.slug LIKE ? OR a.excerpt LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like, like);
  }
  if (filters.status) {
    conditions.push('a.status = ?');
    params.push(filters.status);
  }
  if (filters.category_id) {
    conditions.push('a.category_id = ?');
    params.push(filters.category_id);
  }
  if (filters.blog_id) {
    conditions.push('a.blog_id = ?');
    params.push(filters.blog_id);
  }
  if (filters.featured !== undefined) {
    conditions.push('a.is_featured = ?');
    params.push(filters.featured ? 1 : 0);
  }
  if (filters.review_due) {
    conditions.push('a.next_review_due IS NOT NULL AND a.next_review_due <= CURDATE()');
  }

  return { sql: ` WHERE ${conditions.join(' AND ')}`, params };
}

export const articlesRepository = {
  async list(
    filters: ArticleFilters,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<ArticleListRow[]> {
    const built = buildFilters(filters);
    return query<ArticleListRow & RowDataPacket>(
      `SELECT ${LIST_COLUMNS}${JOINS}${built.sql}
        ORDER BY a.is_featured DESC, COALESCE(a.published_at, a.created_at) DESC, a.id DESC
        LIMIT ? OFFSET ?`,
      [...built.params, limit, offset],
      exec,
    );
  },

  async count(filters: ArticleFilters, exec: Executor = pool): Promise<number> {
    const built = buildFilters(filters);
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total${JOINS}${built.sql}`,
      built.params,
      exec,
    );
    return Number(row?.total ?? 0);
  },

  /** Counts per status, for the tab strip — one query, not one per tab. */
  async statusCounts(exec: Executor = pool): Promise<Record<string, number>> {
    const rows = await query<RowDataPacket & { status: ArticleStatus; total: number }>(
      `SELECT a.status, COUNT(*) AS total
         FROM cms_articles a
        WHERE a.shop_id = ? AND a.deleted_at IS NULL
        GROUP BY a.status`,
      [shopId()],
      exec,
    );
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = Number(row.total);
    return counts;
  },

  async findById(id: number, exec: Executor = pool): Promise<ArticleDetailRow | null> {
    return queryOne<ArticleDetailRow & RowDataPacket>(
      `SELECT ${LIST_COLUMNS}, a.body_html,
              author.storage_key AS author_media_key,
              seo.meta_title, seo.meta_description
         ${JOINS}
         LEFT JOIN media author ON author.id = a.author_media_id AND author.shop_id = a.shop_id
         LEFT JOIN seo_meta seo ON seo.shop_id = a.shop_id AND seo.entity_type = 'article' AND seo.entity_id = a.id
        WHERE a.shop_id = ? AND a.id = ? AND a.deleted_at IS NULL`,
      [shopId(), id],
      exec,
    );
  },

  /**
   * Public read. `publishedOnly` is a parameter rather than a separate method so
   * the admin preview and the live page cannot drift apart in how they render.
   */
  async findBySlug(
    slug: string,
    publishedOnly: boolean,
    exec: Executor = pool,
  ): Promise<ArticleDetailRow | null> {
    const gate = publishedOnly
      ? `AND a.status = 'published' AND a.published_at IS NOT NULL AND a.published_at <= NOW()`
      : '';
    return queryOne<ArticleDetailRow & RowDataPacket>(
      `SELECT ${LIST_COLUMNS}, a.body_html,
              author.storage_key AS author_media_key,
              seo.meta_title, seo.meta_description
         ${JOINS}
         LEFT JOIN media author ON author.id = a.author_media_id AND author.shop_id = a.shop_id
         LEFT JOIN seo_meta seo ON seo.shop_id = a.shop_id AND seo.entity_type = 'article' AND seo.entity_id = a.id
        WHERE a.shop_id = ? AND a.slug = ? AND a.deleted_at IS NULL ${gate}`,
      [shopId(), slug],
      exec,
    );
  },

  async slugExists(slug: string, excludeId: number | null, exec: Executor = pool): Promise<boolean> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      `SELECT id FROM cms_articles WHERE shop_id = ? AND slug = ? AND locale = 'en-IN'
        ${excludeId ? 'AND id <> ?' : ''} LIMIT 1`,
      excludeId ? [shopId(), slug, excludeId] : [shopId(), slug],
      exec,
    );
    return row !== null;
  },

  async create(
    data: ArticleInput & { slug: string; blog_id: number; author_admin_id: number | null },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO cms_articles
         (shop_id, blog_id, category_id, slug, title, subtitle, excerpt, body_html,
          cover_media_id, author_name, author_title, author_media_id, author_admin_id,
          medically_reviewed_by, reviewed_at, next_review_due, read_time_minutes,
          is_featured, is_indexable, scheduled_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
      [
        shopId(),
        data.blog_id,
        data.category_id ?? null,
        data.slug,
        data.title,
        data.subtitle ?? null,
        data.excerpt ?? null,
        data.body_html ?? null,
        data.cover_media_id ?? null,
        data.author_name ?? null,
        data.author_title ?? null,
        data.author_media_id ?? null,
        data.author_admin_id,
        data.medically_reviewed_by ?? null,
        data.reviewed_at ?? null,
        data.next_review_due ?? null,
        data.read_time_minutes ?? null,
        data.is_featured ? 1 : 0,
        data.is_indexable === false ? 0 : 1,
        data.scheduled_at ?? null,
      ],
      exec,
    );
  },

  async update(id: number, data: ArticleInput, exec: Executor = pool): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];

    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    // Only the keys the caller actually sent. A PATCH that omits `excerpt` must
    // not blank it out.
    // Moving an article to another blog is an ordinary edit, not a special
    // operation — it is the same row with a different parent.
    if (data.blog_id !== undefined) assign('blog_id', data.blog_id);
    if (data.slug !== undefined) assign('slug', data.slug);
    if (data.title !== undefined) assign('title', data.title);
    if (data.subtitle !== undefined) assign('subtitle', data.subtitle);
    if (data.excerpt !== undefined) assign('excerpt', data.excerpt);
    if (data.body_html !== undefined) assign('body_html', data.body_html);
    if (data.category_id !== undefined) assign('category_id', data.category_id);
    if (data.cover_media_id !== undefined) assign('cover_media_id', data.cover_media_id);
    if (data.author_name !== undefined) assign('author_name', data.author_name);
    if (data.author_title !== undefined) assign('author_title', data.author_title);
    if (data.author_media_id !== undefined) assign('author_media_id', data.author_media_id);
    if (data.medically_reviewed_by !== undefined)
      assign('medically_reviewed_by', data.medically_reviewed_by);
    if (data.reviewed_at !== undefined) assign('reviewed_at', data.reviewed_at);
    if (data.next_review_due !== undefined) assign('next_review_due', data.next_review_due);
    if (data.read_time_minutes !== undefined) assign('read_time_minutes', data.read_time_minutes);
    if (data.is_featured !== undefined) assign('is_featured', data.is_featured ? 1 : 0);
    if (data.is_indexable !== undefined) assign('is_indexable', data.is_indexable ? 1 : 0);
    if (data.scheduled_at !== undefined) assign('scheduled_at', data.scheduled_at);

    if (sets.length === 0) return;
    params.push(shopId(), id);
    await execute(`UPDATE cms_articles SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`, params, exec);
  },

  async setStatus(
    id: number,
    status: ArticleStatus,
    publishedAt: Date | null,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE cms_articles
          SET status = ?,
              published_at = CASE WHEN ? IS NULL THEN published_at ELSE ? END
        WHERE shop_id = ? AND id = ?`,
      [status, publishedAt, publishedAt, shopId(), id],
      exec,
    );
  },

  /** Soft delete. The slug stays taken, which is the point — old links 404 rather than resurrect. */
  async softDelete(id: number, exec: Executor = pool): Promise<void> {
    await execute(`UPDATE cms_articles SET deleted_at = NOW() WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
  },

  async setProducts(articleId: number, productIds: number[], exec: Executor = pool): Promise<void> {
    await execute(`DELETE FROM cms_article_products WHERE shop_id = ? AND article_id = ?`, [shopId(), articleId], exec);
    if (productIds.length === 0) return;
    const values = productIds.map(() => '(?, ?, ?, ?)').join(', ');
    const params = productIds.flatMap((productId, index) => [shopId(), articleId, productId, index]);
    await execute(
      `INSERT INTO cms_article_products (shop_id, article_id, product_id, sort_order) VALUES ${values}`,
      params,
      exec,
    );
  },

  async productsFor(articleId: number, exec: Executor = pool) {
    return query<
      RowDataPacket & {
        id: number;
        slug: string;
        name: string;
        price: string | null;
        image_key: string | null;
      }
    >(
      `SELECT p.id, p.slug, p.name,
              (SELECT MIN(v.price) FROM product_variants v
                WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS price,
              (SELECT m.storage_key FROM media_attachments ma
                 JOIN media m ON m.id = ma.media_id
                WHERE ma.shop_id = p.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = p.id
                  AND ma.collection = 'gallery'
                ORDER BY ma.is_primary DESC, ma.sort_order ASC LIMIT 1) AS image_key
         FROM cms_article_products ap
         JOIN products p ON p.id = ap.product_id
        WHERE ap.shop_id = ? AND ap.article_id = ? AND p.deleted_at IS NULL AND p.status = 'active'
        ORDER BY ap.sort_order ASC`,
      [shopId(), articleId],
      exec,
    );
  },

  async categories(activeOnly: boolean, exec: Executor = pool) {
    return query<
      RowDataPacket & {
        id: number;
        slug: string;
        name: string;
        description: string | null;
        sort_order: number;
        is_active: number;
        article_count: number;
      }
    >(
      `SELECT c.id, c.slug, c.name, c.description, c.sort_order, c.is_active,
              (SELECT COUNT(*) FROM cms_articles a
                WHERE a.shop_id = c.shop_id AND a.category_id = c.id AND a.deleted_at IS NULL
                  AND a.status = 'published') AS article_count
         FROM cms_article_categories c
        WHERE c.shop_id = ? ${activeOnly ? 'AND c.is_active = 1' : ''}
        ORDER BY c.sort_order ASC, c.name ASC`,
      [shopId()],
      exec,
    );
  },

  async defaultBlogId(exec: Executor = pool): Promise<number | null> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      `SELECT id FROM cms_blogs WHERE shop_id = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`,
      [shopId()],
      exec,
    );
    return row ? Number(row.id) : null;
  },

  async incrementViews(id: number, exec: Executor = pool): Promise<void> {
    await execute(`UPDATE cms_articles SET view_count = view_count + 1 WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
  },

  /** Other published articles, preferring the same category. */
  async related(
    articleId: number,
    categoryId: number | null,
    limit: number,
    exec: Executor = pool,
  ): Promise<ArticleListRow[]> {
    return query<ArticleListRow & RowDataPacket>(
      `SELECT ${LIST_COLUMNS}${JOINS}
        WHERE a.shop_id = ?
          AND a.deleted_at IS NULL
          AND a.status = 'published'
          AND a.published_at IS NOT NULL AND a.published_at <= NOW()
          AND a.id <> ?
        ORDER BY (a.category_id <=> ?) DESC, a.published_at DESC
        LIMIT ?`,
      [shopId(), articleId, categoryId, limit],
      exec,
    );
  },
};
