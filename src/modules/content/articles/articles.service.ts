import { ApiError } from '../../../core/ApiError';
import { nowForDb } from '../../../core/now';
import { slugify } from '../../../core/slug';
import { pool, type Executor } from '../../../db/pool';
import { withTransaction } from '../../../db/transaction';
import { auditService } from '../../../shared/audit.service';
import { storage } from '../../media/storage';
import type { AuthenticatedAdmin } from '../../auth/auth.types';
import { blogsRepository } from '../blogs/blogs.repository';
import { blogsService } from '../blogs/blogs.service';
import { articlesRepository } from './articles.repository';
import type {
  ArticleDetailRow,
  ArticleFilters,
  ArticleInput,
  ArticleListRow,
  ArticleStatus,
} from './articles.types';

/**
 * The Journal.
 *
 * Two audiences read the same rows: the admin, which needs drafts and review
 * dates, and the storefront, which must only ever see published ones. Both go
 * through `present*` below so the shape can never diverge, and the public
 * presenter drops the fields a visitor has no business seeing.
 */

/** Roughly what a person reads in a minute, used when nobody set a read time. */
const WORDS_PER_MINUTE = 220;

function mediaUrl(key: string | null): string | null {
  return key ? storage.publicUrl(key) : null;
}

/** Strips tags well enough to count words — never used to render anything. */
function estimateReadMinutes(html: string | null): number | null {
  if (!html) return null;
  const words = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean).length;
  if (words === 0) return null;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}

function asDateOnly(value: Date | string | null): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function presentList(row: ArticleListRow) {
  return {
    id: row.id,
    public_id: row.public_id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    excerpt: row.excerpt,
    cover: mediaUrl(row.cover_key),
    cover_alt: row.cover_alt,
    blog: { id: row.blog_id, slug: row.blog_slug, title: row.blog_title },
    category: row.category_id
      ? { id: row.category_id, name: row.category_name, slug: row.category_slug }
      : null,
    author: { name: row.author_name, title: row.author_title },
    medically_reviewed_by: row.medically_reviewed_by,
    reviewed_at: asDateOnly(row.reviewed_at),
    next_review_due: asDateOnly(row.next_review_due),
    read_time_minutes: row.read_time_minutes,
    status: row.status,
    is_featured: row.is_featured === 1,
    is_indexable: row.is_indexable === 1,
    published_at: row.published_at,
    scheduled_at: row.scheduled_at,
    view_count: row.view_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function presentDetail(row: ArticleDetailRow) {
  return {
    ...presentList(row),
    blog_id: row.blog_id,
    category_id: row.category_id,
    cover_media_id: row.cover_media_id,
    author_media_id: row.author_media_id,
    author_image: mediaUrl(row.author_media_key),
    body_html: row.body_html,
    seo: { meta_title: row.meta_title, meta_description: row.meta_description },
  };
}

/**
 * What a visitor gets. Deliberately a different function from the admin's, not
 * a flag on it: every field here was added on purpose.
 */
function presentPublic(row: ArticleListRow) {
  return {
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    excerpt: row.excerpt,
    cover: mediaUrl(row.cover_key),
    cover_alt: row.cover_alt,
    blog: { slug: row.blog_slug, title: row.blog_title },
    category: row.category_slug ? { name: row.category_name, slug: row.category_slug } : null,
    author: { name: row.author_name, title: row.author_title },
    medically_reviewed_by: row.medically_reviewed_by,
    reviewed_at: asDateOnly(row.reviewed_at),
    read_time_minutes: row.read_time_minutes,
    published_at: row.published_at,
  };
}

async function uniqueSlug(
  desired: string,
  excludeId: number | null,
  exec: Executor = pool,
): Promise<string> {
  const base = slugify(desired) || 'article';
  let candidate = base;
  let suffix = 2;
  // Bounded: an unbounded loop here is a request that never returns.
  while (suffix < 100 && (await articlesRepository.slugExists(candidate, excludeId, exec))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function parsePagination(queryParams: Record<string, unknown>) {
  const page = Math.max(1, Number(queryParams.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(queryParams.limit ?? 25) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

function parseFilters(queryParams: Record<string, unknown>): ArticleFilters {
  return {
    q: typeof queryParams.q === 'string' && queryParams.q ? queryParams.q : undefined,
    status: (queryParams.status as ArticleStatus) || undefined,
    category_id: queryParams.category_id ? Number(queryParams.category_id) : undefined,
    blog_id: queryParams.blog_id ? Number(queryParams.blog_id) : undefined,
    featured:
      queryParams.featured === undefined
        ? undefined
        : queryParams.featured === true || queryParams.featured === 'true',
    review_due: queryParams.review_due === true || queryParams.review_due === 'true',
  };
}

export const articlesService = {
  // ── admin ────────────────────────────────────────────────────────────────
  async list(queryParams: Record<string, unknown>) {
    const page = parsePagination(queryParams);
    const filters = parseFilters(queryParams);

    const [rows, total, counts] = await Promise.all([
      articlesRepository.list(filters, page.limit, page.offset),
      articlesRepository.count(filters),
      articlesRepository.statusCounts(),
    ]);

    return {
      articles: rows.map(presentList),
      pagination: {
        total,
        page: page.page,
        limit: page.limit,
        pages: Math.max(1, Math.ceil(total / page.limit)),
        has_next: page.page * page.limit < total,
        has_prev: page.page > 1,
      },
      counts,
    };
  },

  async get(id: number) {
    const row = await articlesRepository.findById(id);
    if (!row) throw ApiError.notFound('That article does not exist.');
    const products = await articlesRepository.productsFor(id);
    return {
      article: presentDetail(row),
      products: products.map((product) => ({
        id: product.id,
        slug: product.slug,
        name: product.name,
        price: product.price === null ? null : Number(product.price),
        image: mediaUrl(product.image_key),
      })),
    };
  },

  async create(input: ArticleInput, actor: AuthenticatedAdmin) {
    // `blogsService.defaultBlogId` creates one if the table is somehow empty,
    // so an article can always be filed somewhere.
    const blogId = input.blog_id ?? (await blogsService.defaultBlogId());

    const id = await withTransaction(async (tx) => {
      const slug = await uniqueSlug(input.slug || input.title, null, tx);
      const newId = await articlesRepository.create(
        {
          ...input,
          slug,
          blog_id: blogId,
          author_admin_id: actor.id,
          read_time_minutes: input.read_time_minutes ?? estimateReadMinutes(input.body_html ?? null),
        },
        tx,
      );
      if (input.product_ids) await articlesRepository.setProducts(newId, input.product_ids, tx);
      return newId;
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'article.created',
      entityType: 'article',
      entityId: id,
      context: { title: input.title },
    });

    return this.get(id);
  },

  async update(id: number, input: ArticleInput, actor: AuthenticatedAdmin) {
    const existing = await articlesRepository.findById(id);
    if (!existing) throw ApiError.notFound('That article does not exist.');

    await withTransaction(async (tx) => {
      const patch: ArticleInput = { ...input };
      if (input.slug !== undefined) {
        patch.slug = await uniqueSlug(input.slug || existing.title, id, tx);
      }
      // Recomputed only when the body changed and nobody typed a figure in.
      if (input.body_html !== undefined && input.read_time_minutes === undefined) {
        patch.read_time_minutes = estimateReadMinutes(input.body_html);
      }
      await articlesRepository.update(id, patch, tx);
      if (input.product_ids) await articlesRepository.setProducts(id, input.product_ids, tx);
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'article.updated',
      entityType: 'article',
      entityId: id,
    });

    return this.get(id);
  },

  /**
   * Publishing is its own call, not a status field on update.
   *
   * It is the moment the content becomes public, and a skincare article that
   * makes a claim nobody reviewed is exactly what the review fields exist to
   * prevent — so the refusal lives here, where it cannot be bypassed by a PATCH.
   */
  async publish(id: number, actor: AuthenticatedAdmin) {
    const existing = await articlesRepository.findById(id);
    if (!existing) throw ApiError.notFound('That article does not exist.');
    if (!existing.body_html || existing.body_html.trim().length === 0) {
      throw ApiError.conflict('An article needs a body before it can be published.');
    }
    if (!existing.excerpt) {
      throw ApiError.conflict(
        'Add a short excerpt first — it is what appears in the journal list and in search results.',
      );
    }

    await articlesRepository.setStatus(id, 'published', nowForDb());
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'article.published',
      entityType: 'article',
      entityId: id,
      context: { title: existing.title, slug: existing.slug },
    });
    return this.get(id);
  },

  async unpublish(id: number, actor: AuthenticatedAdmin) {
    const existing = await articlesRepository.findById(id);
    if (!existing) throw ApiError.notFound('That article does not exist.');

    // published_at is kept: it is when this was first public, and losing it
    // would reorder the journal the next time it is published.
    await articlesRepository.setStatus(id, 'draft', null);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'article.unpublished',
      entityType: 'article',
      entityId: id,
    });
    return this.get(id);
  },

  async archive(id: number, actor: AuthenticatedAdmin) {
    const existing = await articlesRepository.findById(id);
    if (!existing) throw ApiError.notFound('That article does not exist.');
    await articlesRepository.setStatus(id, 'archived', null);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'article.archived',
      entityType: 'article',
      entityId: id,
    });
    return this.get(id);
  },

  async remove(id: number, actor: AuthenticatedAdmin) {
    const existing = await articlesRepository.findById(id);
    if (!existing) throw ApiError.notFound('That article does not exist.');
    await articlesRepository.softDelete(id);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'article.deleted',
      entityType: 'article',
      entityId: id,
      context: { title: existing.title },
    });
    return { deleted: true };
  },

  async categories(activeOnly = false) {
    const rows = await articlesRepository.categories(activeOnly);
    return {
      categories: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        sort_order: row.sort_order,
        is_active: row.is_active === 1,
        article_count: Number(row.article_count),
      })),
    };
  },

  // ── storefront ───────────────────────────────────────────────────────────
  async publicList(queryParams: Record<string, unknown>) {
    const page = parsePagination({ ...queryParams, limit: queryParams.limit ?? 12 });
    const categorySlug = typeof queryParams.category === 'string' ? queryParams.category : undefined;

    // Scoped to one blog when the caller names one. An unknown handle is an
    // empty list rather than every article, for the same reason an unknown
    // category is: a typo in a URL must not silently widen the results.
    const blogSlug = typeof queryParams.blog === 'string' ? queryParams.blog : undefined;
    let blogId: number | undefined;
    if (blogSlug) {
      const blog = await blogsRepository.findBySlug(blogSlug);
      if (!blog || blog.is_active !== 1) {
        return {
          articles: [],
          categories: [],
          blog: null,
          pagination: { total: 0, page: page.page, limit: page.limit, pages: 1, has_next: false, has_prev: false },
        };
      }
      blogId = blog.id;
    }

    let categoryId: number | undefined;
    if (categorySlug) {
      const categories = await articlesRepository.categories(true);
      const match = categories.find((row) => row.slug === categorySlug);
      // An unknown category is an empty journal, not every article — otherwise a
      // typo in the URL silently shows the unfiltered list.
      if (!match) {
        return {
          articles: [],
          blog: null,
          categories: categories.map((row) => ({
            slug: row.slug,
            name: row.name,
            article_count: Number(row.article_count),
          })),
          pagination: { total: 0, page: page.page, limit: page.limit, pages: 1, has_next: false, has_prev: false },
        };
      }
      categoryId = match.id;
    }

    const filters: ArticleFilters = { status: 'published', category_id: categoryId, blog_id: blogId };
    const [rows, total, categories] = await Promise.all([
      articlesRepository.list(filters, page.limit, page.offset),
      articlesRepository.count(filters),
      articlesRepository.categories(true),
    ]);

    return {
      articles: rows.map(presentPublic),
      blog: blogSlug ? await blogsService.publicBySlug(blogSlug) : null,
      categories: categories.map((row) => ({
        slug: row.slug,
        name: row.name,
        article_count: Number(row.article_count),
      })),
      pagination: {
        total,
        page: page.page,
        limit: page.limit,
        pages: Math.max(1, Math.ceil(total / page.limit)),
        has_next: page.page * page.limit < total,
        has_prev: page.page > 1,
      },
    };
  },

  async publicDetail(slug: string) {
    const row = await articlesRepository.findBySlug(slug, true);
    if (!row) throw ApiError.notFound('That article does not exist.');

    const [products, related] = await Promise.all([
      articlesRepository.productsFor(row.id),
      articlesRepository.related(row.id, row.category_id, 3),
    ]);

    // Fire-and-forget: a view counter must never fail the page.
    void articlesRepository.incrementViews(row.id).catch(() => undefined);

    return {
      article: {
        ...presentPublic(row),
        body_html: row.body_html,
        seo: {
          meta_title: row.meta_title ?? row.title,
          meta_description: row.meta_description ?? row.excerpt,
          is_indexable: row.is_indexable === 1,
        },
      },
      products: products.map((product) => ({
        slug: product.slug,
        name: product.name,
        price: product.price === null ? null : Number(product.price),
        image: mediaUrl(product.image_key),
      })),
      related: related.map(presentPublic),
    };
  },
};
