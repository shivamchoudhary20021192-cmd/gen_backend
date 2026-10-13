import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

// ── Row types ────────────────────────────────────────────────────────────────

export interface ReviewRow extends RowDataPacket {
  id: number;
  public_id: string;
  product_id: number;
  variant_id: number | null;
  customer_id: number | null;
  order_id: number | null;
  order_item_id: number | null;
  author_name: string;
  author_location: string | null;
  rating: number;
  title: string | null;
  body: string | null;
  age_range: string | null;
  usage_duration: string | null;
  would_recommend: number | null;
  is_verified_purchase: number;
  has_media: number;
  status: 'pending' | 'approved' | 'rejected' | 'spam' | 'hidden';
  rejection_reason: string | null;
  moderated_by_admin_id: number | null;
  moderated_at: Date | null;
  moderation_note: string | null;
  flagged_adverse_reaction: number;
  helpful_count: number;
  not_helpful_count: number;
  report_count: number;
  source: string;
  published_at: Date | null;
  created_at: Date;
  // joined
  product_name?: string;
  product_slug?: string;
  variant_title?: string | null;
  order_number?: string | null;
  moderator_name?: string | null;
  open_reports?: number;
  reply_body?: string | null;
  reply_author?: string | null;
  reply_published_at?: Date | null;
}

export interface SummaryRow extends RowDataPacket {
  rating_count: number;
  review_count: number;
  rating_average: number | null;
  five: number;
  four: number;
  three: number;
  two: number;
  one: number;
  recommend_count: number;
}

interface CountRow extends RowDataPacket {
  total: number;
}

export interface ReviewFilters {
  status?: string;
  productId?: number;
  rating?: number;
  flagged?: boolean;
  reported?: boolean;
  search?: string;
}

// ── Shared scope ─────────────────────────────────────────────────────────────

/**
 * What the public may see: approved, not soft-deleted, and published.
 *
 * Written once and composed by every public read. A review that is hidden or
 * still in the queue must never reach a shopper, and the one place that decides
 * that is here — not a `status = 'approved'` repeated across four queries, one
 * of which will eventually be written without the `deleted_at` half.
 */
const PUBLIC_SCOPE = `r.status = 'approved' AND r.deleted_at IS NULL`;

const REVIEW_SELECT = `
  SELECT r.id, r.public_id, r.product_id, r.variant_id, r.customer_id, r.order_id,
         r.order_item_id, r.author_name, r.author_location, r.rating, r.title, r.body,
         r.age_range, r.usage_duration, r.would_recommend, r.is_verified_purchase,
         r.has_media, r.status, r.rejection_reason, r.moderated_by_admin_id,
         r.moderated_at, r.moderation_note, r.flagged_adverse_reaction,
         r.helpful_count, r.not_helpful_count, r.report_count, r.source,
         r.published_at, r.created_at,
         p.name AS product_name,
         p.slug AS product_slug,
         v.variant_title,
         o.order_number,
         NULLIF(CONCAT_WS(' ', au.first_name, au.last_name), '') AS moderator_name,
         (SELECT COUNT(*) FROM review_reports rr
           WHERE rr.review_id = r.id AND rr.status = 'open') AS open_reports,
         (SELECT rp.body FROM review_replies rp
           WHERE rp.review_id = r.id AND rp.is_public = 1
           ORDER BY rp.id DESC LIMIT 1) AS reply_body,
         (SELECT rp.display_name FROM review_replies rp
           WHERE rp.review_id = r.id AND rp.is_public = 1
           ORDER BY rp.id DESC LIMIT 1) AS reply_author,
         (SELECT rp.published_at FROM review_replies rp
           WHERE rp.review_id = r.id AND rp.is_public = 1
           ORDER BY rp.id DESC LIMIT 1) AS reply_published_at
    FROM reviews r
    JOIN products p ON p.id = r.product_id
    LEFT JOIN product_variants v ON v.id = r.variant_id AND v.shop_id = r.shop_id
    LEFT JOIN orders o ON o.id = r.order_id AND o.shop_id = r.shop_id
    LEFT JOIN admin_users au ON au.id = r.moderated_by_admin_id
   WHERE r.shop_id = ? AND r.deleted_at IS NULL`;

/**
 * Filters appended to a base query that opens with `r.shop_id = ?` — the first
 * parameter returned is always the shop, binding that placeholder.
 */
function buildWhere(filters: ReviewFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [shopId()];

  if (filters.status && filters.status !== 'all') {
    conditions.push('r.status = ?');
    params.push(filters.status);
  }
  if (filters.productId) {
    conditions.push('r.product_id = ?');
    params.push(filters.productId);
  }
  if (filters.rating) {
    conditions.push('r.rating = ?');
    params.push(filters.rating);
  }
  if (filters.flagged) {
    conditions.push('r.flagged_adverse_reaction = 1');
  }
  if (filters.reported) {
    conditions.push(
      `EXISTS (SELECT 1 FROM review_reports rr WHERE rr.review_id = r.id AND rr.status = 'open')`,
    );
  }
  if (filters.search) {
    conditions.push('(r.title LIKE ? OR r.body LIKE ? OR r.author_name LIKE ? OR p.name LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term, term);
  }

  return { clause: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', params };
}

// ── Repository ───────────────────────────────────────────────────────────────

export const reviewsRepository = {
  // ── admin reads ──────────────────────────────────────────────────────────

  async list(
    filters: ReviewFilters,
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<ReviewRow[]> {
    const { clause, params } = buildWhere(filters);
    return query<ReviewRow>(
      `${REVIEW_SELECT}${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async count(filters: ReviewFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<CountRow>(
      `SELECT COUNT(*) AS total
         FROM reviews r
         JOIN products p ON p.id = r.product_id
        WHERE r.shop_id = ? AND r.deleted_at IS NULL${clause}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  async findById(id: number, exec: Executor = pool): Promise<ReviewRow | null> {
    return queryOne<ReviewRow>(`${REVIEW_SELECT} AND r.id = ? LIMIT 1`, [shopId(), id], exec);
  },

  /** The queue badge: how many sit in each state right now. */
  async statusCounts(exec: Executor = pool): Promise<Record<string, number>> {
    const rows = await query<RowDataPacket & { status: string; total: number }>(
      `SELECT status, COUNT(*) AS total FROM reviews WHERE shop_id = ? AND deleted_at IS NULL GROUP BY status`,
      [shopId()],
      exec,
    );
    const counts: Record<string, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      spam: 0,
      hidden: 0,
    };
    for (const row of rows) counts[row.status] = Number(row.total);
    return counts;
  },

  // ── public reads ─────────────────────────────────────────────────────────

  async listPublic(
    productId: number,
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<ReviewRow[]> {
    return query<ReviewRow>(
      `${REVIEW_SELECT} AND r.product_id = ? AND ${PUBLIC_SCOPE}
        ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [shopId(), productId, limit, offset],
      exec,
    );
  },

  async countPublic(productId: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<CountRow>(
      `SELECT COUNT(*) AS total FROM reviews r
        WHERE r.shop_id = ? AND r.product_id = ? AND ${PUBLIC_SCOPE}`,
      [shopId(), productId],
      exec,
    );
    return row?.total ?? 0;
  },

  /**
   * The star breakdown shown above the list.
   *
   * Scoped identically to `listPublic`, so "412 ratings" and the rows a shopper
   * can page through are the same 412 — the mismatch that made the inventory
   * cards disagree with their own table.
   */
  async summary(productId: number, exec: Executor = pool): Promise<SummaryRow> {
    const row = await queryOne<SummaryRow>(
      `SELECT COUNT(*) AS rating_count,
              COALESCE(SUM(r.body IS NOT NULL AND TRIM(r.body) <> ''), 0) AS review_count,
              ROUND(AVG(r.rating), 2) AS rating_average,
              COALESCE(SUM(r.rating = 5), 0) AS five,
              COALESCE(SUM(r.rating = 4), 0) AS four,
              COALESCE(SUM(r.rating = 3), 0) AS three,
              COALESCE(SUM(r.rating = 2), 0) AS two,
              COALESCE(SUM(r.rating = 1), 0) AS one,
              COALESCE(SUM(r.would_recommend = 1), 0) AS recommend_count
         FROM reviews r
        WHERE r.shop_id = ? AND r.product_id = ? AND ${PUBLIC_SCOPE}`,
      [shopId(), productId],
      exec,
    );
    return row!;
  },

  // ── eligibility ──────────────────────────────────────────────────────────

  /**
   * The purchased line a review would hang off, or null.
   *
   * Matching is order number + phone against a delivered order that actually
   * contains the product — the same pair the public order-lookup endpoint
   * already accepts, so a shopper proves a purchase with what is on their
   * confirmation message and nothing else.
   */
  async findPurchasedLine(
    productId: number,
    orderNumber: string,
    phone: string,
    exec: Executor = pool,
  ): Promise<
    | (RowDataPacket & {
        order_id: number;
        order_item_id: number;
        variant_id: number | null;
        customer_id: number | null;
        order_status: string;
        delivered_at: Date | null;
        first_name: string | null;
        city: string | null;
      })
    | null
  > {
    return queryOne(
      `SELECT o.id AS order_id,
              oi.id AS order_item_id,
              oi.variant_id,
              o.customer_id,
              o.order_status,
              o.delivered_at,
              oa.first_name,
              oa.city
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id AND oi.product_id = ?
         LEFT JOIN order_addresses oa
                ON oa.order_id = o.id AND oa.address_type = 'shipping'
        WHERE o.shop_id = ? AND o.order_number = ? AND o.contact_phone = ?
        ORDER BY oi.id ASC
        LIMIT 1`,
      [productId, shopId(), orderNumber, phone],
      exec,
    );
  },

  /** One review per purchased line — a second submission is an edit, not a new voice. */
  async findByOrderItem(orderItemId: number, exec: Executor = pool): Promise<ReviewRow | null> {
    return queryOne<ReviewRow>(
      `SELECT * FROM reviews WHERE shop_id = ? AND order_item_id = ? AND deleted_at IS NULL LIMIT 1`,
      [shopId(), orderItemId],
      exec,
    );
  },

  // ── writes ───────────────────────────────────────────────────────────────

  async create(
    data: {
      publicId: string;
      productId: number;
      variantId: number | null;
      customerId: number | null;
      orderId: number;
      orderItemId: number;
      authorName: string;
      authorLocation: string | null;
      authorEmail: string | null;
      rating: number;
      title: string | null;
      body: string | null;
      ageRange: string | null;
      usageDuration: string | null;
      wouldRecommend: boolean | null;
      flaggedAdverseReaction: boolean;
      ip: string | null;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO reviews
         (shop_id, public_id, product_id, variant_id, customer_id, order_id, order_item_id,
          author_name, author_location, author_email, rating, title, body,
          age_range, usage_duration, would_recommend, is_verified_purchase,
          flagged_adverse_reaction, status, source, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'pending', 'web',
               ${'INET6_ATON(?)'})`,
      [
        shopId(),
        data.publicId,
        data.productId,
        data.variantId,
        data.customerId,
        data.orderId,
        data.orderItemId,
        data.authorName,
        data.authorLocation,
        data.authorEmail,
        data.rating,
        data.title,
        data.body,
        data.ageRange,
        data.usageDuration,
        data.wouldRecommend === null ? null : data.wouldRecommend ? 1 : 0,
        data.flaggedAdverseReaction ? 1 : 0,
        data.ip,
      ],
      exec,
    );
  },

  async setStatus(
    id: number,
    status: 'pending' | 'approved' | 'rejected' | 'spam' | 'hidden',
    adminId: number,
    note: string | null,
    rejectionReason: string | null,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE reviews
          SET status = ?,
              moderated_by_admin_id = ?,
              moderated_at = NOW(),
              moderation_note = ?,
              rejection_reason = ?,
              -- published_at is set the first time it goes live and then left
              -- alone, so hiding and re-approving does not reorder the list.
              published_at = CASE WHEN ? = 'approved' AND published_at IS NULL
                                  THEN NOW() ELSE published_at END
        WHERE shop_id = ? AND id = ?`,
      [status, adminId, note, rejectionReason, status, shopId(), id],
      exec,
    );
  },

  async addReply(
    reviewId: number,
    adminId: number,
    displayName: string,
    body: string,
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO review_replies (shop_id, review_id, admin_user_id, display_name, body, is_public, published_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW())`,
      [shopId(), reviewId, adminId, displayName, body],
      exec,
    );
  },

  async resolveReports(reviewId: number, adminId: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE review_reports SET status = 'reviewed', handled_by_admin_id = ?
        WHERE shop_id = ? AND review_id = ? AND status = 'open'`,
      [adminId, shopId(), reviewId],
      exec,
    );
  },

  // ── derived product aggregates ───────────────────────────────────────────

  /**
   * Recomputes what the catalogue claims about a product's reception.
   *
   * `rating_count` counts every approved review (all carry a star rating);
   * `review_count` counts only those that also wrote something, which is the
   * pair retailers show as "4.7 · 412 ratings, 88 written". Both are derived
   * here and nowhere else, so the number on a product card, the number on the
   * detail page and the rows behind them cannot drift.
   *
   * Called after every moderation change. Zero approved reviews means zero, not
   * a remembered value: a product with no reviews has to look like one.
   */
  async refreshProductAggregates(productId: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE products p
          SET p.rating_average = COALESCE((
                SELECT ROUND(AVG(r.rating), 2) FROM reviews r
                 WHERE r.product_id = p.id AND ${PUBLIC_SCOPE}), 0),
              p.rating_count = (
                SELECT COUNT(*) FROM reviews r
                 WHERE r.product_id = p.id AND ${PUBLIC_SCOPE}),
              p.review_count = (
                SELECT COUNT(*) FROM reviews r
                 WHERE r.product_id = p.id AND ${PUBLIC_SCOPE}
                   AND r.body IS NOT NULL AND TRIM(r.body) <> '')
        WHERE p.shop_id = ? AND p.id = ?`,
      [shopId(), productId],
      exec,
    );
  },

  /** Resets every product in the current shop at once. */
  async refreshAllProductAggregates(exec: Executor = pool): Promise<number> {
    const result = await execute(
      `UPDATE products p
          SET p.rating_average = COALESCE((
                SELECT ROUND(AVG(r.rating), 2) FROM reviews r
                 WHERE r.product_id = p.id AND ${PUBLIC_SCOPE}), 0),
              p.rating_count = (
                SELECT COUNT(*) FROM reviews r
                 WHERE r.product_id = p.id AND ${PUBLIC_SCOPE}),
              p.review_count = (
                SELECT COUNT(*) FROM reviews r
                 WHERE r.product_id = p.id AND ${PUBLIC_SCOPE}
                   AND r.body IS NOT NULL AND TRIM(r.body) <> '')
        WHERE p.shop_id = ? AND p.deleted_at IS NULL`,
      [shopId()],
      exec,
    );
    return result.affectedRows;
  },

  /** Resolves a public slug to an id without leaking anything else about it. */
  async productIdBySlug(slug: string, exec: Executor = pool): Promise<number | null> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      `SELECT id FROM products
        WHERE shop_id = ? AND slug = ? AND deleted_at IS NULL AND status = 'active' AND visibility = 'public'
        LIMIT 1`,
      [shopId(), slug],
      exec,
    );
    return row?.id ?? null;
  },
};
