import { ApiError } from '../../../core/ApiError';
import { pool, type Executor } from '../../../db/pool';
import { withTransaction } from '../../../db/transaction';
import { auditService } from '../../../shared/audit.service';
import type { AuthenticatedAdmin } from '../../auth/auth.types';
import { storage } from '../../media/storage';
import { sectionsRepository } from './sections.repository';
import type {
  BlockInput,
  BlockRow,
  HotspotInput,
  HotspotRow,
  SectionInput,
  SectionRow,
} from './sections.types';

/**
 * Story sections — the claims strip, the packaging diagram, a model's routine.
 *
 * A section is authored once and attached wherever it belongs. "Less harm, more
 * pearl" is the same words on every product in a range, and the alternative —
 * pasting it into twelve products — means correcting it in eleven of them and
 * missing one.
 */

function mediaUrl(key: string | null): string | null {
  return key ? storage.publicUrl(key) : null;
}

function parseJson(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * An href an admin typed. Relative paths and http(s) only: anything else in an
 * href is a stored cross-site script the moment it renders.
 */
function safeUrl(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.startsWith('/')) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

function presentHotspot(row: HotspotRow) {
  return {
    id: row.id,
    x: Number(row.x_pct),
    y: Number(row.y_pct),
    label: row.label,
    body: row.body,
    line_direction: row.line_direction,
    image: mediaUrl(row.media_key),
    product: row.product_slug ? { slug: row.product_slug, name: row.product_name } : null,
  };
}

function presentBlock(row: BlockRow, hotspots: HotspotRow[]) {
  return {
    id: row.id,
    block_type: row.block_type,
    sort_order: row.sort_order,
    is_enabled: row.is_enabled === 1,
    heading: row.heading,
    body: row.body,
    media: mediaUrl(row.media_key),
    media_alt: row.media_alt,
    /** 'video' or 'image' — a look can be a film, and the site must know which. */
    media_type: row.media_type === 'video' ? 'video' : row.media_id ? 'image' : null,
    /** The still to paint before a film loads, and what phones get instead. */
    poster: row.media_type === 'video' ? mediaUrl(row.media_poster_key) : null,
    secondary_media: mediaUrl(row.secondary_media_key),
    creator: row.creator_id
      ? {
          id: row.creator_id,
          name: row.creator_name,
          handle: row.creator_handle,
          role: row.creator_role,
          portrait: mediaUrl(row.creator_portrait_key),
          portrait_alt: row.creator_portrait_alt,
          instagram_url: safeUrl(row.creator_instagram_url),
        }
      : null,
    /**
     * Whether a shopper may be told who this is.
     *
     * Both have to agree: the person's record has to allow being named at all,
     * and this particular use has to want the credit. The block can withhold a
     * credit that is permitted; it can never grant one that is not.
     *
     * The admin still sees the person on every block — it has to, or nobody
     * could manage the shoot. This flag is what `publicFor` uses to take the
     * identity out before the storefront ever sees it.
     */
    credit_creator: Number(row.credit_creator ?? 1) === 1,
    creator_identity_public: Number(row.creator_identity_public ?? 1) === 1,
    /**
     * An efficacy line can be free text or can point at a claim. When it points
     * at one, the claim's footnote travels with it — which is the whole reason
     * to point at one rather than retyping the number.
     */
    claim: row.claim_id
      ? { id: row.claim_id, text: row.claim_text, footnote: row.claim_footnote, status: row.claim_status }
      : null,
    shade: row.option_value_id
      ? {
          id: row.option_value_id,
          name: row.option_value_label,
          descriptor: row.option_value_descriptor,
          hex: row.option_value_hex,
        }
      : null,
    link: {
      type: row.link_type,
      ref_id: row.link_ref_id,
      url: safeUrl(row.link_url),
      label: row.cta_label,
    },
    settings: parseJson(row.settings),
    hotspots: hotspots.filter((spot) => spot.block_id === row.id).map(presentHotspot),
  };
}

function presentSection(row: SectionRow, blocks: BlockRow[], hotspots: HotspotRow[]) {
  return {
    id: row.id,
    section_key: row.section_key,
    name: row.name,
    heading: row.heading,
    standfirst: row.standfirst,
    footnote: row.footnote,
    layout: row.layout,
    background: row.background,
    padding: { top: row.padding_top, bottom: row.padding_bottom },
    settings: parseJson(row.settings),
    usage_count: Number(row.usage_count),
    created_at: row.created_at,
    updated_at: row.updated_at,
    blocks: blocks
      .filter((block) => block.section_id === row.id)
      .map((block) => presentBlock(block, hotspots)),
  };
}

/** Loads sections with their blocks and hotspots, in three queries. */
async function compose(sectionIds: number[], exec: Executor = pool) {
  if (sectionIds.length === 0) return [];
  const sections = await sectionsRepository.findManyByIds(sectionIds, exec);
  const blocks = await sectionsRepository.blocksFor(
    sections.map((section) => section.id),
    exec,
  );
  const hotspots = await sectionsRepository.hotspotsFor(
    blocks.map((block) => block.id),
    exec,
  );
  return sections.map((section) => presentSection(section, blocks, hotspots));
}

/**
 * A block with the model's identity removed, when it is not to be shown.
 *
 * Removed here rather than hidden in the browser, because hiding it in the
 * browser does not hide it at all: the name, the handle and the profile link
 * would still be sitting in the JSON behind the page for anyone who opened the
 * network tab. A model booked without a credit has to be absent from the
 * response, not merely absent from the layout.
 *
 * The photograph stays, and so does everything the block says about the
 * product. What goes is who the person is.
 */
function withheldIdentity<T extends { creator: unknown; credit_creator?: boolean; creator_identity_public?: boolean }>(
  block: T,
): T {
  const allowed = block.creator_identity_public !== false && block.credit_creator !== false;
  if (allowed) return block;
  return { ...block, creator: null };
}

export const sectionsService = {
  // ── the library ───────────────────────────────────────────────────────────
  async list(filters: { sectionKey?: string; search?: string } = {}) {
    const rows = await sectionsRepository.list(filters);
    const blocks = await sectionsRepository.blocksFor(rows.map((row) => row.id));
    return {
      sections: rows.map((row) => ({
        id: row.id,
        section_key: row.section_key,
        name: row.name,
        heading: row.heading,
        layout: row.layout,
        usage_count: Number(row.usage_count),
        block_count: blocks.filter((block) => block.section_id === row.id).length,
        updated_at: row.updated_at,
      })),
    };
  },

  async get(id: number) {
    const composed = await compose([id]);
    if (composed.length === 0) throw ApiError.notFound('That section does not exist.');
    return { section: composed[0] };
  },

  async create(input: SectionInput, actor: AuthenticatedAdmin) {
    if (!input.name || input.name.trim().length < 2) {
      throw ApiError.validation({ name: ['Give the section a name you will recognise later.'] });
    }
    if (!input.section_key) {
      throw ApiError.validation({ section_key: ['Pick what kind of section this is.'] });
    }

    const id = await sectionsRepository.create({
      ...input,
      name: input.name.trim(),
      section_key: input.section_key,
      createdByAdminId: actor.id,
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.created',
      entityType: 'content_section',
      entityId: id,
      context: { name: input.name, kind: input.section_key },
    });

    return this.get(id);
  },

  async update(id: number, input: SectionInput, actor: AuthenticatedAdmin) {
    const existing = await sectionsRepository.findById(id);
    if (!existing) throw ApiError.notFound('That section does not exist.');

    await sectionsRepository.update(id, input);

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.updated',
      entityType: 'content_section',
      entityId: id,
      // Worth recording: editing a shared section changes every product it is
      // attached to, and whoever reads the log later will want to know that.
      context: { name: existing.name, attached_to: Number(existing.usage_count) },
    });

    return this.get(id);
  },

  /**
   * Deleting a section it is still attached to would silently strip a block of
   * copy from every product using it, so it is refused with the count. Detach
   * it first, deliberately.
   */
  async remove(id: number, actor: AuthenticatedAdmin) {
    const existing = await sectionsRepository.findById(id);
    if (!existing) throw ApiError.notFound('That section does not exist.');

    const usage = Number(existing.usage_count);
    if (usage > 0) {
      throw ApiError.conflict(
        `"${existing.name}" is still on ${usage} ${usage === 1 ? 'product' : 'products'}. ` +
          'Take it off those first.',
      );
    }

    await sectionsRepository.softDelete(id);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.deleted',
      entityType: 'content_section',
      entityId: id,
      context: { name: existing.name },
    });

    return { deleted: true };
  },

  // ── blocks ────────────────────────────────────────────────────────────────
  async addBlock(sectionId: number, input: BlockInput, actor: AuthenticatedAdmin) {
    const section = await sectionsRepository.findById(sectionId);
    if (!section) throw ApiError.notFound('That section does not exist.');
    if (!input.block_type) {
      throw ApiError.validation({ block_type: ['Pick what kind of block this is.'] });
    }

    const id = await sectionsRepository.createBlock(sectionId, {
      ...input,
      block_type: input.block_type,
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.block_added',
      entityType: 'content_section',
      entityId: sectionId,
      context: { block_id: id, kind: input.block_type },
    });

    return this.get(sectionId);
  },

  async updateBlock(
    sectionId: number,
    blockId: number,
    input: BlockInput,
    actor: AuthenticatedAdmin,
  ) {
    const block = await sectionsRepository.findBlock(blockId);
    if (!block || block.section_id !== sectionId) {
      throw ApiError.notFound('That block does not exist.');
    }

    await sectionsRepository.updateBlock(blockId, input);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.block_updated',
      entityType: 'content_section',
      entityId: sectionId,
      context: { block_id: blockId },
    });

    return this.get(sectionId);
  },

  async removeBlock(sectionId: number, blockId: number, actor: AuthenticatedAdmin) {
    const block = await sectionsRepository.findBlock(blockId);
    if (!block || block.section_id !== sectionId) {
      throw ApiError.notFound('That block does not exist.');
    }

    await sectionsRepository.removeBlock(blockId);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.block_removed',
      entityType: 'content_section',
      entityId: sectionId,
      context: { block_id: blockId },
    });

    return this.get(sectionId);
  },

  async reorderBlocks(sectionId: number, ids: number[], actor: AuthenticatedAdmin) {
    const section = await sectionsRepository.findById(sectionId);
    if (!section) throw ApiError.notFound('That section does not exist.');

    await withTransaction(async (tx) => {
      await sectionsRepository.reorderBlocks(sectionId, ids, tx);
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.blocks_reordered',
      entityType: 'content_section',
      entityId: sectionId,
    });

    return this.get(sectionId);
  },

  // ── hotspots ──────────────────────────────────────────────────────────────
  async setHotspots(
    sectionId: number,
    blockId: number,
    hotspots: HotspotInput[],
    actor: AuthenticatedAdmin,
  ) {
    const block = await sectionsRepository.findBlock(blockId);
    if (!block || block.section_id !== sectionId) {
      throw ApiError.notFound('That block does not exist.');
    }
    if (!block.media_id) {
      throw ApiError.conflict('Add the image first — a label needs something to be pinned to.');
    }

    await withTransaction(async (tx) => {
      await sectionsRepository.replaceHotspots(blockId, hotspots, tx);
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.hotspots_set',
      entityType: 'content_section',
      entityId: sectionId,
      context: { block_id: blockId, count: hotspots.length },
    });

    return this.get(sectionId);
  },

  // ── assignments ───────────────────────────────────────────────────────────
  async listFor(ownerType: string, ownerId: number) {
    const assignments = await sectionsRepository.assignmentsFor(ownerType, ownerId);
    const composed = await compose(assignments.map((a) => a.section_id));
    const byId = new Map(composed.map((section) => [section.id, section]));

    return {
      sections: assignments
        .map((assignment) => {
          const section = byId.get(assignment.section_id);
          if (!section) return null;
          return {
            assignment_id: assignment.id,
            sort_order: assignment.sort_order,
            is_enabled: assignment.is_enabled === 1,
            visible_from: assignment.visible_from,
            visible_until: assignment.visible_until,
            ...section,
          };
        })
        .filter(Boolean),
    };
  },

  async attach(ownerType: string, ownerId: number, sectionId: number, actor: AuthenticatedAdmin) {
    const section = await sectionsRepository.findById(sectionId);
    if (!section) throw ApiError.notFound('That section does not exist.');

    const already = await sectionsRepository.assignmentsFor(ownerType, ownerId);
    if (already.some((assignment) => assignment.section_id === sectionId)) {
      throw ApiError.conflict(`"${section.name}" is already on this ${ownerType}.`);
    }

    await sectionsRepository.attach(sectionId, ownerType, ownerId);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.attached',
      entityType: ownerType,
      entityId: ownerId,
      context: { section_id: sectionId, name: section.name },
    });

    return this.listFor(ownerType, ownerId);
  },

  async updateAssignment(
    ownerType: string,
    ownerId: number,
    assignmentId: number,
    data: { is_enabled?: boolean; visible_from?: Date | null; visible_until?: Date | null },
    actor: AuthenticatedAdmin,
  ) {
    const assignment = await sectionsRepository.findAssignment(assignmentId);
    if (!assignment || assignment.owner_type !== ownerType || assignment.owner_id !== ownerId) {
      throw ApiError.notFound('That section is not on this product.');
    }

    await sectionsRepository.updateAssignment(assignmentId, data);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.assignment_updated',
      entityType: ownerType,
      entityId: ownerId,
      context: { assignment_id: assignmentId },
    });

    return this.listFor(ownerType, ownerId);
  },

  /** Takes the section off this product. The section itself is untouched. */
  async detach(ownerType: string, ownerId: number, assignmentId: number, actor: AuthenticatedAdmin) {
    const assignment = await sectionsRepository.findAssignment(assignmentId);
    if (!assignment || assignment.owner_type !== ownerType || assignment.owner_id !== ownerId) {
      throw ApiError.notFound('That section is not on this product.');
    }

    await sectionsRepository.detach(assignmentId);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.detached',
      entityType: ownerType,
      entityId: ownerId,
      context: { section_id: assignment.section_id },
    });

    return this.listFor(ownerType, ownerId);
  },

  async reorder(ownerType: string, ownerId: number, ids: number[], actor: AuthenticatedAdmin) {
    await withTransaction(async (tx) => {
      await sectionsRepository.reorderAssignments(ownerType, ownerId, ids, tx);
    });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'section.reordered',
      entityType: ownerType,
      entityId: ownerId,
    });

    return this.listFor(ownerType, ownerId);
  },

  // ── storefront ────────────────────────────────────────────────────────────
  /**
   * What a visitor sees. Disabled sections, sections outside their window and
   * blocks switched off are all gone before this returns, so the site cannot
   * accidentally render one by forgetting a filter.
   */
  async publicFor(ownerType: string, ownerId: number) {
    const assignments = await sectionsRepository.liveAssignmentsFor(ownerType, ownerId);
    const composed = await compose(assignments.map((a) => a.section_id));
    const byId = new Map(composed.map((section) => [section.id, section]));

    return assignments
      .map((assignment) => byId.get(assignment.section_id))
      .filter((section): section is NonNullable<typeof section> => Boolean(section))
      .map((section) => ({
        ...section,
        usage_count: undefined,
        blocks: section.blocks.filter((block) => block.is_enabled).map(withheldIdentity),
      }));
  },
};
