import crypto from 'node:crypto';
import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination } from '../../core/pagination';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { reviewsRepository, type ReviewFilters, type ReviewRow, type SummaryRow } from './reviews.repository';
import { eventBus } from '../../platform/events/eventBus';
import { tenancy } from '../../platform/tenancy/context';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

/**
 * How long after delivery a review may still be written.
 *
 * Generous on purpose — skincare is judged over weeks, and "did this work?" is
 * a more useful review at day 60 than at day 2. Enforced as a refusal rather
 * than a warning, because an unbounded window invites review farming against
 * ancient orders.
 */
/** How long after delivery a review may be written. Shared with the order
 * tracking page, which shows the shopper the date it closes. */
export const REVIEW_WINDOW_DAYS = 180;

/**
 * Phrases that make a review a safety signal rather than an opinion.
 *
 * A cosmetics seller has to notice "this burned my face" faster than it notices
 * a three-star. Matching is deliberately broad: a false positive costs a
 * moderator two seconds, a false negative is an adverse event nobody logged.
 * The flag routes the review to the top of the queue — it never blocks or
 * silently discards the customer's words.
 */
const ADVERSE_PATTERNS = [
  /\b(burn|burnt|burning|burned)\b/i,
  /\b(rash|hives|blister|blisters|swell|swollen|swelling)\b/i,
  /\b(allerg\w*)\b/i,
  /\b(itch\w*)\b/i,
  /\b(irritat\w*)\b/i,
  /\b(reaction|reacted)\b/i,
  /\b(chemical burn|peeling badly|skin came off)\b/i,
  /\b(hospital|doctor|dermatologist|emergency)\b/i,
  /\b(infection|infected)\b/i,
];

export function detectAdverseReaction(...parts: (string | null | undefined)[]): boolean {
  const text = parts.filter(Boolean).join(' ');
  if (!text.trim()) return false;
  return ADVERSE_PATTERNS.some((pattern) => pattern.test(text));
}

const SORTABLE: Record<string, string> = {
  newest: 'r.created_at DESC, r.id DESC',
  oldest: 'r.created_at ASC, r.id ASC',
  rating_high: 'r.rating DESC, r.created_at DESC',
  rating_low: 'r.rating ASC, r.created_at DESC',
  helpful: 'r.helpful_count DESC, r.created_at DESC',
};

function orderClause(raw: unknown, fallback: string): string {
  return SORTABLE[String(raw ?? '')] ?? SORTABLE[fallback];
}

// ── presenters ───────────────────────────────────────────────────────────────

/**
 * What a shopper sees. Deliberately narrower than the admin view: no email, no
 * IP, no moderation trail, no order number, and no customer id.
 */
function presentPublic(row: ReviewRow) {
  return {
    id: row.public_id,
    rating: row.rating,
    title: row.title,
    body: row.body,
    author_name: row.author_name,
    author_location: row.author_location,
    age_range: row.age_range,
    usage_duration: row.usage_duration,
    would_recommend: row.would_recommend === null ? null : row.would_recommend === 1,
    is_verified_purchase: row.is_verified_purchase === 1,
    variant_title: row.variant_title ?? null,
    helpful_count: row.helpful_count,
    published_at: row.published_at,
    reply: row.reply_body
      ? {
          body: row.reply_body,
          author: row.reply_author ?? tenancy.current().name,
          published_at: row.reply_published_at ?? null,
        }
      : null,
  };
}

function presentAdmin(row: ReviewRow) {
  return {
    id: row.id,
    public_id: row.public_id,
    product: { id: row.product_id, name: row.product_name, slug: row.product_slug },
    variant_title: row.variant_title ?? null,
    order_number: row.order_number ?? null,
    author_name: row.author_name,
    author_location: row.author_location,
    rating: row.rating,
    title: row.title,
    body: row.body,
    age_range: row.age_range,
    usage_duration: row.usage_duration,
    would_recommend: row.would_recommend === null ? null : row.would_recommend === 1,
    is_verified_purchase: row.is_verified_purchase === 1,
    flagged_adverse_reaction: row.flagged_adverse_reaction === 1,
    status: row.status,
    rejection_reason: row.rejection_reason,
    moderation_note: row.moderation_note,
    moderated_by: row.moderator_name ?? null,
    moderated_at: row.moderated_at,
    open_reports: Number(row.open_reports ?? 0),
    helpful_count: row.helpful_count,
    report_count: row.report_count,
    source: row.source,
    published_at: row.published_at,
    created_at: row.created_at,
    reply: row.reply_body
      ? { body: row.reply_body, author: row.reply_author ?? tenancy.current().name, published_at: row.reply_published_at ?? null }
      : null,
    next_statuses: nextStatuses(row.status),
  };
}

/**
 * Which moves the queue offers for a review in this state.
 *
 * The screen renders buttons from this rather than showing all five and letting
 * the server refuse — the same rule the orders screen follows.
 */
function nextStatuses(status: ReviewRow['status']): string[] {
  switch (status) {
    case 'pending':
      return ['approved', 'rejected', 'spam'];
    case 'approved':
      return ['hidden', 'rejected'];
    case 'hidden':
      return ['approved', 'rejected'];
    case 'rejected':
    case 'spam':
      return ['approved'];
    default:
      return [];
  }
}

function presentSummary(row: SummaryRow) {
  const count = Number(row.rating_count ?? 0);
  return {
    rating_count: count,
    review_count: Number(row.review_count ?? 0),
    // Null when nothing has been approved. A product with no reviews shows no
    // score rather than a zero that reads as "rated badly".
    rating_average: count > 0 ? Number(row.rating_average) : null,
    recommend_percent:
      count > 0 ? Math.round((Number(row.recommend_count ?? 0) / count) * 100) : null,
    breakdown: {
      5: Number(row.five ?? 0),
      4: Number(row.four ?? 0),
      3: Number(row.three ?? 0),
      2: Number(row.two ?? 0),
      1: Number(row.one ?? 0),
    },
  };
}

function readFilters(queryParams: Record<string, unknown>): ReviewFilters {
  return {
    status: (queryParams.status as string | undefined) || undefined,
    productId: queryParams.product_id as number | undefined,
    rating: queryParams.rating as number | undefined,
    flagged: queryParams.flagged === true || queryParams.flagged === 'true',
    reported: queryParams.reported === true || queryParams.reported === 'true',
    search: (queryParams.q as string | undefined) || undefined,
  };
}

// ── service ──────────────────────────────────────────────────────────────────

export const reviewsService = {
  // ── admin ────────────────────────────────────────────────────────────────

  async list(queryParams: Record<string, unknown>) {
    const page = parsePagination(queryParams);
    const filters = readFilters(queryParams);
    // Anything flagged as an adverse reaction sorts to the top regardless of the
    // chosen order: it is a safety queue first and a marketing queue second.
    const orderBy = `r.flagged_adverse_reaction DESC, ${orderClause(queryParams.sort, 'newest')}`;

    const [rows, total, counts] = await Promise.all([
      reviewsRepository.list(filters, orderBy, page.limit, page.offset),
      reviewsRepository.count(filters),
      reviewsRepository.statusCounts(),
    ]);

    return {
      reviews: rows.map(presentAdmin),
      pagination: buildMeta(total, page),
      counts,
    };
  },

  async get(id: number) {
    const row = await reviewsRepository.findById(id);
    if (!row) throw ApiError.notFound('Review');
    return { review: presentAdmin(row) };
  },

  async changeStatus(
    id: number,
    input: { status: 'approved' | 'rejected' | 'spam' | 'hidden'; note?: string; reason?: string },
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    return withTransaction(async (tx) => {
      const existing = await reviewsRepository.findById(id, tx);
      if (!existing) throw ApiError.notFound('Review');

      if (!nextStatuses(existing.status).includes(input.status)) {
        throw new ApiError(
          409,
          'INVALID_TRANSITION',
          `A ${existing.status} review cannot be moved to ${input.status}.`,
          { from: existing.status, allowed: nextStatuses(existing.status) },
        );
      }

      if (input.status === 'rejected' && !input.reason?.trim()) {
        throw ApiError.badRequest('Give a reason for rejecting — it is kept with the review.');
      }

      await reviewsRepository.setStatus(
        id,
        input.status,
        admin.id,
        input.note?.trim() || null,
        input.status === 'rejected' ? input.reason!.trim() : null,
        tx,
      );

      // Moving into or out of 'approved' changes what the catalogue claims, so
      // the product's counters are recomputed inside the same transaction.
      await reviewsRepository.refreshProductAggregates(existing.product_id, tx);

      // A decision on the review is a decision on the reports against it.
      if (Number(existing.open_reports ?? 0) > 0) {
        await reviewsRepository.resolveReports(id, admin.id, tx);
      }

      await auditService.log(
        {
          actorId: admin.id,
          actorLabel: admin.email,
          action: `review.${input.status}`,
          entityType: 'review',
          entityId: id,
          summary: `${input.status} review of ${existing.product_name} by ${existing.author_name} (${existing.rating}★)`,
          changes: {
            status: { from: existing.status, to: input.status },
            reason: input.reason ?? null,
            flagged_adverse_reaction: existing.flagged_adverse_reaction === 1,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      const updated = await reviewsRepository.findById(id, tx);
      return { review: presentAdmin(updated!) };
    });
  },

  async reply(
    id: number,
    input: { body: string; display_name?: string },
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const existing = await reviewsRepository.findById(id);
    if (!existing) throw ApiError.notFound('Review');
    if (existing.status !== 'approved') {
      throw ApiError.badRequest('Approve the review before replying — a reply on a hidden review is never seen.');
    }

    await reviewsRepository.addReply(
      id,
      admin.id,
      // Replies are signed by the store unless someone chose a name.
      input.display_name?.trim() || tenancy.current().name,
      input.body.trim(),
    );

    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'review.replied',
      entityType: 'review',
      entityId: id,
      summary: `Replied to ${existing.author_name}'s review of ${existing.product_name}`,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const updated = await reviewsRepository.findById(id);
    return { review: presentAdmin(updated!) };
  },

  // ── storefront ───────────────────────────────────────────────────────────

  async publicList(slug: string, queryParams: Record<string, unknown>) {
    const productId = await reviewsRepository.productIdBySlug(slug);
    if (!productId) throw ApiError.notFound('Product');

    const page = parsePagination(queryParams);
    const orderBy = orderClause(queryParams.sort, 'newest');

    const [rows, total, summary] = await Promise.all([
      reviewsRepository.listPublic(productId, orderBy, page.limit, page.offset),
      reviewsRepository.countPublic(productId),
      reviewsRepository.summary(productId),
    ]);

    return {
      reviews: rows.map(presentPublic),
      pagination: buildMeta(total, page),
      summary: presentSummary(summary),
    };
  },

  /**
   * Answers "may I review this?" before showing the form.
   *
   * Returning the reason rather than a bare false is the whole point: "that
   * order has not been delivered yet" and "you have already reviewed this" send
   * a shopper to different next steps, and a single `eligible: false` sends
   * them to neither.
   */
  async checkEligibility(slug: string, orderNumber: string, phone: string) {
    const productId = await reviewsRepository.productIdBySlug(slug);
    if (!productId) throw ApiError.notFound('Product');

    const line = await reviewsRepository.findPurchasedLine(productId, orderNumber.trim(), phone.trim());
    if (!line) {
      return {
        eligible: false,
        reason: 'no_matching_order' as const,
        message: 'We could not find that order number and phone number with this product on it.',
      };
    }

    const delivered = line.order_status === 'delivered' || line.delivered_at !== null;
    if (!delivered) {
      return {
        eligible: false,
        reason: 'not_delivered' as const,
        message: 'This order has not been delivered yet. You can review once it arrives.',
      };
    }

    if (line.delivered_at) {
      const days = (Date.now() - new Date(line.delivered_at).getTime()) / 86_400_000;
      if (days > REVIEW_WINDOW_DAYS) {
        return {
          eligible: false,
          reason: 'window_closed' as const,
          message: `Reviews close ${REVIEW_WINDOW_DAYS} days after delivery.`,
        };
      }
    }

    const already = await reviewsRepository.findByOrderItem(line.order_item_id);
    if (already) {
      return {
        eligible: false,
        reason: 'already_reviewed' as const,
        message: 'You have already reviewed this product from this order. Thank you.',
      };
    }

    return {
      eligible: true as const,
      // Pre-fills the form without making the shopper retype what we know.
      suggested_name: line.first_name ?? null,
      suggested_location: line.city ?? null,
    };
  },

  async submit(
    slug: string,
    input: {
      order_number: string;
      phone: string;
      rating: number;
      title?: string | null;
      body?: string | null;
      author_name: string;
      author_location?: string | null;
      author_email?: string | null;
      age_range?: string | null;
      usage_duration?: string | null;
      would_recommend?: boolean | null;
    },
    meta: { ip: string | null },
  ) {
    const productId = await reviewsRepository.productIdBySlug(slug);
    if (!productId) throw ApiError.notFound('Product');

    return withTransaction(async (tx) => {
      const line = await reviewsRepository.findPurchasedLine(
        productId,
        input.order_number.trim(),
        input.phone.trim(),
        tx,
      );

      // Every refusal below is deliberately the same shape as checkEligibility,
      // because the form can be submitted without ever calling that endpoint.
      if (!line) {
        throw ApiError.badRequest(
          'We could not find that order number and phone number with this product on it.',
        );
      }
      if (line.order_status !== 'delivered' && line.delivered_at === null) {
        throw ApiError.badRequest('This order has not been delivered yet. You can review once it arrives.');
      }
      if (line.delivered_at) {
        const days = (Date.now() - new Date(line.delivered_at).getTime()) / 86_400_000;
        if (days > REVIEW_WINDOW_DAYS) {
          throw ApiError.badRequest(`Reviews close ${REVIEW_WINDOW_DAYS} days after delivery.`);
        }
      }

      const already = await reviewsRepository.findByOrderItem(line.order_item_id, tx);
      if (already) {
        throw ApiError.conflict('You have already reviewed this product from this order.');
      }

      const flagged = detectAdverseReaction(input.title, input.body);

      const id = await reviewsRepository.create(
        {
          publicId: crypto.randomUUID(),
          productId,
          variantId: line.variant_id,
          customerId: line.customer_id,
          orderId: line.order_id,
          orderItemId: line.order_item_id,
          authorName: input.author_name.trim(),
          authorLocation: input.author_location?.trim() || null,
          authorEmail: input.author_email?.trim() || null,
          rating: input.rating,
          title: input.title?.trim() || null,
          body: input.body?.trim() || null,
          ageRange: input.age_range?.trim() || null,
          usageDuration: input.usage_duration?.trim() || null,
          wouldRecommend: input.would_recommend ?? null,
          flaggedAdverseReaction: flagged,
          ip: meta.ip,
        },
        tx,
      );
      await eventBus.publish(
        'reviews/create',
        { id, product_id: productId, rating: input.rating, title: input.title?.trim() || null, status: 'pending', flagged_adverse_reaction: flagged },
        { resourceType: 'review', resourceId: id, actorType: 'customer', actorId: line.customer_id ?? null, tx },
      );

      return {
        review: { id, status: 'pending' as const },
        // Said plainly rather than implying the review is live. A shopper who
        // reloads and cannot find their words otherwise assumes it was lost.
        message: flagged
          ? 'Thank you. Your review mentions a possible reaction, so our team will look at it before it is published and may contact you.'
          : 'Thank you. Your review will appear once our team has checked it.',
      };
    });
  },
};
