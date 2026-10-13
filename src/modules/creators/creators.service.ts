import { ApiError } from '../../core/ApiError';
import { slugify } from '../../core/slug';
import { storage } from '../media/storage';
import { pool, type Executor } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { creatorsRepository } from './creators.repository';
import type { CreatorInput, CreatorRow } from './creators.types';

/**
 * Creators — the models, founders and artists whose looks appear on a product.
 *
 * A library rather than rows on each product: one person cast for a campaign
 * turns up on the serum, the sunscreen and a journal article, and when she
 * changes her handle it is corrected in one place rather than eleven.
 */

/**
 * An outbound link the site will send a shopper to.
 *
 * Only absolute http(s) is accepted. A `javascript:` or `data:` URL in a field
 * an admin types into is a stored cross-site script the moment it is rendered
 * as an href, and a relative path is meaningless for someone's Instagram.
 */
function socialUrl(raw: string | null | undefined, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  if (value === '') return null;
  if (!/^https?:\/\//i.test(value)) {
    throw ApiError.validation({ [field]: ['Give the whole address, starting with https://'] });
  }
  return value.slice(0, 500);
}

function present(row: CreatorRow) {
  return {
    id: row.id,
    public_id: row.public_id,
    slug: row.slug,
    name: row.name,
    handle: row.handle,
    role: row.role,
    bio: row.bio,
    portrait: row.portrait_key ? storage.publicUrl(row.portrait_key) : null,
    portrait_alt: row.portrait_alt,
    portrait_media_id: row.portrait_media_id,
    instagram_url: row.instagram_url,
    youtube_url: row.youtube_url,
    tiktok_url: row.tiktok_url,
    website_url: row.website_url,
    is_active: row.is_active === 1,
    /** May this person be named on the site at all — a fact about the booking. */
    is_identity_public: row.is_identity_public === 1,
    sort_order: row.sort_order,
    block_count: Number(row.block_count),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** What a visitor sees: a name, a face, and somewhere to follow her. */
export function presentCreatorPublic(row: {
  name: string;
  handle: string | null;
  role: string | null;
  portrait_key: string | null;
  portrait_alt: string | null;
  instagram_url: string | null;
}) {
  return {
    name: row.name,
    handle: row.handle,
    role: row.role,
    portrait: row.portrait_key ? storage.publicUrl(row.portrait_key) : null,
    portrait_alt: row.portrait_alt,
    instagram_url: row.instagram_url,
  };
}

async function uniqueCreatorSlug(
  desired: string,
  excludeId: number | null,
  exec: Executor = pool,
): Promise<string> {
  const base = slugify(desired) || 'creator';
  let candidate = base;
  let suffix = 2;
  while (suffix < 200 && (await creatorsRepository.slugExists(candidate, excludeId, exec))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** Every writable field, cleaned once, so create and update cannot disagree. */
function cleanInput(input: CreatorInput): CreatorInput {
  const cleaned: CreatorInput = { ...input };
  if (input.instagram_url !== undefined) {
    cleaned.instagram_url = socialUrl(input.instagram_url, 'instagram_url');
  }
  if (input.youtube_url !== undefined) {
    cleaned.youtube_url = socialUrl(input.youtube_url, 'youtube_url');
  }
  if (input.tiktok_url !== undefined) {
    cleaned.tiktok_url = socialUrl(input.tiktok_url, 'tiktok_url');
  }
  if (input.website_url !== undefined) {
    cleaned.website_url = socialUrl(input.website_url, 'website_url');
  }
  // Typed with or without the @; stored one way so the site never prints '@@'.
  if (input.handle !== undefined && input.handle) {
    cleaned.handle = `@${String(input.handle).trim().replace(/^@+/, '')}`.slice(0, 80);
  }
  return cleaned;
}

export const creatorsService = {
  async list(filters: { activeOnly?: boolean; search?: string } = {}) {
    const rows = await creatorsRepository.list(filters);
    return { creators: rows.map(present) };
  },

  async get(id: number) {
    const row = await creatorsRepository.findById(id);
    if (!row) throw ApiError.notFound('That person is not in the library.');
    return { creator: present(row) };
  },

  async create(input: CreatorInput, actor: AuthenticatedAdmin) {
    if (!input.name || input.name.trim().length < 2) {
      throw ApiError.validation({ name: ['Give the person a name.'] });
    }
    const cleaned = cleanInput(input);

    const id = await withTransaction(async (tx) => {
      const slug = await uniqueCreatorSlug(cleaned.slug || cleaned.name || '', null, tx);
      return creatorsRepository.create(
        { ...cleaned, slug, name: cleaned.name!.trim(), createdByAdminId: actor.id },
        tx,
      );
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'creator.created',
      entityType: 'creator',
      entityId: id,
      context: { name: input.name },
    });

    return this.get(id);
  },

  async update(id: number, input: CreatorInput, actor: AuthenticatedAdmin) {
    const existing = await creatorsRepository.findById(id);
    if (!existing) throw ApiError.notFound('That person is not in the library.');

    const cleaned = cleanInput(input);

    await withTransaction(async (tx) => {
      if (cleaned.slug !== undefined) {
        cleaned.slug = await uniqueCreatorSlug(cleaned.slug || existing.name, id, tx);
      }
      await creatorsRepository.update(id, cleaned, tx);
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'creator.updated',
      entityType: 'creator',
      entityId: id,
    });

    return this.get(id);
  },

  /**
   * Removing someone from the library does not remove her from the looks she
   * already appears in — those blocks keep their reference and keep rendering.
   * Deleting is about the picker, not about rewriting history.
   */
  async remove(id: number, actor: AuthenticatedAdmin) {
    const existing = await creatorsRepository.findById(id);
    if (!existing) throw ApiError.notFound('That person is not in the library.');

    await creatorsRepository.softDelete(id);

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'creator.deleted',
      entityType: 'creator',
      entityId: id,
      context: { name: existing.name, featured_in_blocks: Number(existing.block_count) },
    });

    return { deleted: true, featured_in_blocks: Number(existing.block_count) };
  },
};
