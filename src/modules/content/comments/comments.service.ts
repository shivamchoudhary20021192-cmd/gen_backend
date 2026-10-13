import { ApiError } from '../../../core/ApiError';
import { logger } from '../../../core/logger';
import { execute, insert, pool, query, queryOne, type RowDataPacket } from '../../../db/pool';
import { notificationEngine } from '../../../platform/notifications/notificationEngine';
import { shopId } from '../../../platform/tenancy/context';
import { auditService } from '../../../shared/audit.service';

/**
 * Blog comments — Shopify's: a blog allows them or not, and if it does,
 * either holds each for approval or publishes it at once. Shoppers post with
 * the theme's {% form 'new_comment', article %}; staff moderate in Content →
 * Comments.
 *
 * Spam is kept out without making people solve puzzles: a hidden field only
 * bots fill (the comment is quietly filed as spam), a cap on links (more than
 * two holds even an auto-published blog's comment for approval), and a rate
 * limit on the posting route.
 */

export type CommentsPolicy = 'disabled' | 'moderated' | 'published';
export type CommentStatus = 'pending' | 'published' | 'spam' | 'removed';

interface CommentRow extends RowDataPacket {
  id: number;
  article_id: number;
  customer_id: number | null;
  author: string;
  email: string;
  body: string;
  status: CommentStatus;
  published_at: Date | null;
  created_at: Date;
  article_title?: string;
  article_slug?: string;
  blog_slug?: string;
}

export interface ArticleTarget {
  articleId: number;
  articleSlug: string;
  articleTitle: string;
  blogSlug: string;
  policy: CommentsPolicy;
}

const MAX_LINKS = 2;

function presentComment(row: CommentRow) {
  return {
    id: row.id,
    author: row.author,
    email: row.email,
    body: row.body,
    status: row.status,
    customer_id: row.customer_id,
    published_at: row.published_at,
    created_at: row.created_at,
    article: row.article_title ? { id: row.article_id, title: row.article_title, url: `/blogs/${row.blog_slug}/${row.article_slug}` } : undefined,
  };
}

/** Plain text in, safe HTML out: paragraphs and line breaks, nothing else. */
export function commentHtml(body: string): string {
  const escaped = body.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function linkCount(body: string): number {
  return (body.match(/https?:\/\/|www\./gi) ?? []).length;
}

export const commentsService = {
  /** The published article (and its blog's policy) a comment would go on. */
  async target(blogSlug: string, articleSlug: string): Promise<ArticleTarget | null> {
    const row = await queryOne<RowDataPacket & { id: number; slug: string; title: string; blog_slug: string; comments_policy: CommentsPolicy }>(
      `SELECT a.id, a.slug, a.title, b.slug AS blog_slug, b.comments_policy
         FROM cms_articles a JOIN cms_blogs b ON b.shop_id = a.shop_id AND b.id = a.blog_id
        WHERE a.shop_id = ? AND a.slug = ? AND b.slug = ? AND a.status = 'published' AND a.deleted_at IS NULL AND b.is_active = 1
        LIMIT 1`,
      [shopId(), articleSlug, blogSlug],
    );
    return row ? { articleId: Number(row.id), articleSlug: row.slug, articleTitle: row.title, blogSlug: row.blog_slug, policy: row.comments_policy } : null;
  },

  async policyOf(blogSlug: string): Promise<CommentsPolicy> {
    const row = await queryOne<RowDataPacket & { comments_policy: CommentsPolicy }>('SELECT comments_policy FROM cms_blogs WHERE shop_id = ? AND slug = ? LIMIT 1', [shopId(), blogSlug]);
    return row?.comments_policy ?? 'disabled';
  },

  /** An article's published comments, oldest first, and how many there are. */
  async published(articleId: number, limit = 50, offset = 0) {
    const rows = await query<CommentRow>(
      `SELECT id, article_id, customer_id, author, email, body, status, published_at, created_at FROM blog_comments
        WHERE shop_id = ? AND article_id = ? AND status = 'published' ORDER BY COALESCE(published_at, created_at), id LIMIT ? OFFSET ?`,
      [shopId(), articleId, limit, offset],
    );
    return rows;
  },

  async publishedCount(articleId: number): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>("SELECT COUNT(*) AS total FROM blog_comments WHERE shop_id = ? AND article_id = ? AND status = 'published'", [shopId(), articleId]);
    return Number(row?.total ?? 0);
  },

  /**
   * A shopper's comment. Returns how it was filed; the storefront says
   * "posted" either way (a bot is never told it was caught).
   */
  async post(
    target: ArticleTarget,
    input: { author: string; email: string; body: string; honeypot?: string | null; customerId: number | null },
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<{ status: CommentStatus }> {
    if (target.policy === 'disabled') throw ApiError.notFound('Comments are closed on this blog.');
    const author = input.author.trim().slice(0, 120);
    const email = input.email.trim().toLowerCase();
    const body = input.body.replace(/\r\n?/g, '\n').trim();
    const errors: Record<string, string[]> = {};
    if (!author) errors.author = ['Enter your name.'];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 191) errors.email = ['Enter a valid email address.'];
    if (body.length < 2) errors.body = ['Write a comment.'];
    if (body.length > 5000) errors.body = ['Keep it under 5,000 characters.'];
    if (Object.keys(errors).length) throw ApiError.validation(errors, 'Please check your comment.');

    const status: CommentStatus = input.honeypot ? 'spam' : target.policy === 'published' && linkCount(body) <= MAX_LINKS ? 'published' : 'pending';
    const id = await insert(
      `INSERT INTO blog_comments (shop_id, article_id, customer_id, author, email, body, status, ip, user_agent, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ${meta.ip ? 'INET6_ATON(?)' : 'NULL'}, ?, ${status === 'published' ? 'NOW()' : 'NULL'})`,
      [shopId(), target.articleId, input.customerId, author, email, body, status, ...(meta.ip ? [meta.ip] : []), meta.userAgent?.slice(0, 255) ?? null],
    );
    if (status !== 'spam') {
      await notificationEngine
        .notifyStaff({
          key: 'staff.comment_posted',
          title: status === 'pending' ? `New comment to approve on “${target.articleTitle}”` : `New comment on “${target.articleTitle}”`,
          body: `${author}: ${body.slice(0, 140)}${body.length > 140 ? '…' : ''}`,
          linkUrl: '/content/comments',
          entityType: 'blog_comment',
          entityId: id,
        })
        .catch((error) => logger.warn('comments.notify_failed', { error: String(error) }));
    }
    return { status };
  },

  // ── staff ─────────────────────────────────────────────────────────────────

  async list(input: { status?: CommentStatus; q?: string; page?: number; limit?: number }) {
    const page = Math.max(1, Number(input.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 25));
    const where = ['c.shop_id = ?'];
    const params: unknown[] = [shopId()];
    if (input.status) {
      where.push('c.status = ?');
      params.push(input.status);
    } else {
      where.push("c.status <> 'removed'");
    }
    if (input.q?.trim()) {
      const like = `%${input.q.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      where.push('(c.author LIKE ? OR c.email LIKE ? OR c.body LIKE ? OR a.title LIKE ?)');
      params.push(like, like, like, like);
    }
    const clause = where.join(' AND ');
    const from = `FROM blog_comments c
      JOIN cms_articles a ON a.shop_id = c.shop_id AND a.id = c.article_id
      JOIN cms_blogs b ON b.shop_id = a.shop_id AND b.id = a.blog_id`;
    const [count] = await query<RowDataPacket & { total: number }>(`SELECT COUNT(*) AS total ${from} WHERE ${clause}`, params);
    const rows = await query<CommentRow>(
      `SELECT c.id, c.article_id, c.customer_id, c.author, c.email, c.body, c.status, c.published_at, c.created_at,
              a.title AS article_title, a.slug AS article_slug, b.slug AS blog_slug
         ${from} WHERE ${clause} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    const counts = await query<RowDataPacket & { status: CommentStatus; total: number }>('SELECT status, COUNT(*) AS total FROM blog_comments WHERE shop_id = ? GROUP BY status', [shopId()]);
    const total = Number(count?.total ?? 0);
    return {
      comments: rows.map(presentComment),
      counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.total)])),
      pagination: { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) },
    };
  },

  /** Publish, hold, mark as spam or remove. */
  async moderate(id: number, status: CommentStatus, actor: { id: number | null; label: string | null }) {
    const row = await queryOne<CommentRow>('SELECT id, article_id, author, status, published_at FROM blog_comments WHERE shop_id = ? AND id = ?', [shopId(), id]);
    if (!row) throw ApiError.notFound('Comment');
    await execute(
      `UPDATE blog_comments SET status = ?, moderated_by_admin_id = ?, moderated_at = NOW(),
              published_at = IF(? = 'published', COALESCE(published_at, NOW()), published_at)
        WHERE shop_id = ? AND id = ?`,
      [status, actor.id, status, shopId(), id],
    );
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: `blog_comment.${status}`, entityType: 'blog_comment', entityId: id, summary: `${status === 'published' ? 'Published' : status === 'spam' ? 'Marked as spam' : status === 'removed' ? 'Removed' : 'Held'} a comment by ${row.author}` });
    return { comment: { ...presentComment(row), status } };
  },
};
