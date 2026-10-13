import { ApiError } from '../../../core/ApiError';
import { slugify } from '../../../core/slug';
import { pool, type Executor } from '../../../db/pool';
import { withTransaction } from '../../../db/transaction';
import { auditService } from '../../../shared/audit.service';
import type { AuthenticatedAdmin } from '../../auth/auth.types';
import { blogsRepository } from './blogs.repository';
import type { BlogInput, BlogListRow } from './blogs.types';

/**
 * Blogs.
 *
 * The rules that matter are all about not losing writing. Deleting a blog
 * cascades to its articles at the database level, so the destructive paths here
 * are deliberately narrow: an empty blog can go, a blog with articles needs
 * somewhere to put them, and the last blog cannot be deleted at all because an
 * article has nowhere to live without one.
 */

function present(row: BlogListRow) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    is_active: row.is_active === 1,
    comments_policy: row.comments_policy ?? 'disabled',
    article_count: Number(row.article_count),
    published_count: Number(row.published_count),
    last_published_at: row.last_published_at,
    created_at: row.created_at,
  };
}

/** What a visitor sees: no counts of unpublished work, no internal flags. */
function presentPublic(row: BlogListRow) {
  return {
    slug: row.slug,
    title: row.title,
    description: row.description,
    article_count: Number(row.published_count),
  };
}

async function uniqueSlug(
  desired: string,
  excludeId: number | null,
  exec: Executor = pool,
): Promise<string> {
  const base = slugify(desired) || 'blog';
  let candidate = base;
  let suffix = 2;
  while (suffix < 100 && (await blogsRepository.slugExists(candidate, excludeId, exec))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export const blogsService = {
  // ── admin ────────────────────────────────────────────────────────────────
  async list(activeOnly = false) {
    const rows = await blogsRepository.list(activeOnly);
    return { blogs: rows.map(present) };
  },

  async get(id: number) {
    const row = await blogsRepository.findById(id);
    if (!row) throw ApiError.notFound('That blog does not exist.');
    return { blog: present(row) };
  },

  async create(input: BlogInput, actor: AuthenticatedAdmin) {
    const id = await withTransaction(async (tx) => {
      const slug = await uniqueSlug(input.slug || input.title, null, tx);
      return blogsRepository.create({ ...input, slug }, tx);
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'blog.created',
      entityType: 'blog',
      entityId: id,
      context: { title: input.title },
    });

    return this.get(id);
  },

  async update(id: number, input: BlogInput, actor: AuthenticatedAdmin) {
    const existing = await blogsRepository.findById(id);
    if (!existing) throw ApiError.notFound('That blog does not exist.');

    await withTransaction(async (tx) => {
      const patch: BlogInput = { ...input };
      if (input.slug !== undefined) {
        patch.slug = await uniqueSlug(input.slug || existing.title, id, tx);
      }
      await blogsRepository.update(id, patch, tx);
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'blog.updated',
      entityType: 'blog',
      entityId: id,
    });

    return this.get(id);
  },

  /**
   * Deletes a blog.
   *
   * `reassignTo` is how a blog with articles goes: every article moves first,
   * inside the same transaction, so a failure halfway cannot leave writing
   * pointing at a blog that is about to disappear. Without it, a non-empty blog
   * is refused rather than quietly cascading — the foreign key would happily
   * delete every article in it.
   */
  async remove(id: number, reassignTo: number | undefined, actor: AuthenticatedAdmin) {
    const existing = await blogsRepository.findById(id);
    if (!existing) throw ApiError.notFound('That blog does not exist.');

    const total = await blogsRepository.countBlogs();
    if (total <= 1) {
      throw ApiError.conflict(
        'This is the only blog. Articles have to belong to one, so create another before deleting it.',
      );
    }

    const articleCount = Number(existing.article_count);
    let moved = 0;
    let rehomed = 0;
    let movedTo: number | null = null;

    await withTransaction(async (tx) => {
      if (articleCount > 0 && !reassignTo) {
        throw ApiError.conflict(
          `"${existing.title}" holds ${articleCount} ${articleCount === 1 ? 'article' : 'articles'}. ` +
            'Choose another blog to move them to first.',
        );
      }

      // Somewhere for the articles to land. A blog that looks empty can still
      // hold deleted ones, and those are recoverable until the foreign key
      // cascades and destroys them — so when nobody named a destination, the
      // remaining blog takes them rather than the delete taking them with it.
      const target = reassignTo
        ? await blogsRepository.findById(reassignTo, tx)
        : await blogsRepository.findAny(id, tx);
      if (!target) throw ApiError.badRequest('The blog to move the articles to does not exist.');
      if (target.id === id) {
        throw ApiError.badRequest('Articles cannot be moved to the blog being deleted.');
      }

      rehomed = await blogsRepository.moveArticles(id, target.id, tx);
      // What a person will actually see arrive in the other blog — the deleted
      // ones came along, but they are not articles anyone can read.
      moved = articleCount;
      movedTo = target.id;

      await blogsRepository.remove(id, tx);
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'blog.deleted',
      entityType: 'blog',
      entityId: id,
      context: {
        title: existing.title,
        articles_moved: moved,
        rows_rehomed: rehomed,
        moved_to: movedTo,
      },
    });

    return { deleted: true, articles_moved: moved };
  },

  /**
   * The blog a new article goes into when nobody picked one.
   *
   * Prefers an active blog, and creates one if the table is somehow empty —
   * an article cannot exist without a blog, so this must never return nothing.
   */
  async defaultBlogId(exec: Executor = pool): Promise<number> {
    const rows = await blogsRepository.list(true, exec);
    if (rows.length > 0) return rows[0].id;

    const all = await blogsRepository.list(false, exec);
    if (all.length > 0) return all[0].id;

    return blogsRepository.create(
      { slug: 'blog', title: 'Blog', description: null, is_active: true },
      exec,
    );
  },

  // ── storefront ───────────────────────────────────────────────────────────
  async publicList() {
    const rows = await blogsRepository.list(true);
    return {
      // A blog with nothing published in it is not a page worth linking to.
      blogs: rows.filter((row) => Number(row.published_count) > 0).map(presentPublic),
    };
  },

  async publicBySlug(slug: string) {
    const row = await blogsRepository.findBySlug(slug);
    if (!row || row.is_active !== 1) throw ApiError.notFound('That blog does not exist.');
    return presentPublic(row);
  },
};
