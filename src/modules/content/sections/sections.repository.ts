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
  AssignmentRow,
  BlockInput,
  BlockRow,
  HotspotInput,
  HotspotRow,
  SectionInput,
  SectionRow,
} from './sections.types';
import { shopId } from '../../../platform/tenancy/context';

/**
 * Story sections, their blocks, and the labels pinned onto them.
 *
 * Reads are three queries stitched in the service rather than one joined query:
 * a section with four blocks and three hotspots each would come back as twelve
 * rows to be de-duplicated in JavaScript, and the stitching is the same work
 * either way with none of the fan-out.
 */

const SECTION_SQL = `
  SELECT s.id, s.section_key, s.name, s.heading, s.standfirst, s.footnote,
         s.layout, s.background, s.padding_top, s.padding_bottom, s.settings,
         s.created_at, s.updated_at,
         (SELECT COUNT(*) FROM content_section_assignments a
           WHERE a.shop_id = s.shop_id AND a.section_id = s.id) AS usage_count
    FROM content_sections s`;

/**
 * Everything a block needs to render, resolved here rather than in six
 * follow-up queries — the media and its poster, the creator, the claim that
 * carries the footnote, and the shade the look is wearing.
 */
const BLOCK_SQL = `
  SELECT b.id, b.section_id, b.block_type, b.sort_order, b.is_enabled,
         b.heading, b.body,
         b.media_id, m.storage_key AS media_key, m.alt_text AS media_alt,
         m.media_type AS media_type,
         (SELECT v.storage_key FROM media_variants v
           WHERE v.shop_id = m.shop_id AND v.media_id = m.id AND v.format = 'webp'
           ORDER BY v.width DESC LIMIT 1) AS media_poster_key,
         b.secondary_media_id, sm.storage_key AS secondary_media_key,
         b.creator_id, b.credit_creator, c.is_identity_public AS creator_identity_public,
         c.name AS creator_name, c.handle AS creator_handle,
         c.role AS creator_role, cp.storage_key AS creator_portrait_key,
         cp.alt_text AS creator_portrait_alt, c.instagram_url AS creator_instagram_url,
         b.claim_id, cl.claim_text, cl.footnote AS claim_footnote, cl.status AS claim_status,
         b.option_value_id, ov.value AS option_value_label,
         ov.descriptor AS option_value_descriptor, ov.swatch_hex AS option_value_hex,
         b.link_type, b.link_ref_id, b.link_url, b.cta_label, b.settings
    FROM content_section_blocks b
    LEFT JOIN media m  ON m.id = b.media_id AND m.shop_id = b.shop_id
    LEFT JOIN media sm ON sm.id = b.secondary_media_id AND sm.shop_id = b.shop_id
    LEFT JOIN creators c ON c.id = b.creator_id AND c.shop_id = b.shop_id
    LEFT JOIN media cp ON cp.id = c.portrait_media_id AND cp.shop_id = b.shop_id
    LEFT JOIN claims cl ON cl.id = b.claim_id AND cl.shop_id = b.shop_id
    LEFT JOIN product_option_values ov ON ov.id = b.option_value_id AND ov.shop_id = b.shop_id`;

const HOTSPOT_SQL = `
  SELECT h.id, h.block_id, h.x_pct, h.y_pct, h.label, h.body,
         h.product_id, p.slug AS product_slug, p.name AS product_name,
         h.media_id, m.storage_key AS media_key,
         h.line_direction, h.sort_order
    FROM content_block_hotspots h
    LEFT JOIN products p ON p.id = h.product_id AND p.shop_id = h.shop_id AND p.deleted_at IS NULL
    LEFT JOIN media m ON m.id = h.media_id AND m.shop_id = h.shop_id`;

export const sectionsRepository = {
  // ── the library ───────────────────────────────────────────────────────────
  async list(
    filters: { sectionKey?: string; search?: string },
    exec: Executor = pool,
  ): Promise<SectionRow[]> {
    const where: string[] = ['s.shop_id = ?', 's.deleted_at IS NULL'];
    const params: unknown[] = [shopId()];

    if (filters.sectionKey) {
      where.push('s.section_key = ?');
      params.push(filters.sectionKey);
    }
    if (filters.search) {
      where.push('(s.name LIKE ? OR s.heading LIKE ?)');
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }

    return query<SectionRow>(
      `${SECTION_SQL} WHERE ${where.join(' AND ')} ORDER BY s.updated_at DESC`,
      params,
      exec,
    );
  },

  async findById(id: number, exec: Executor = pool): Promise<SectionRow | null> {
    return queryOne<SectionRow>(
      `${SECTION_SQL} WHERE s.shop_id = ? AND s.id = ? AND s.deleted_at IS NULL`,
      [shopId(), id],
      exec,
    );
  },

  async findManyByIds(ids: number[], exec: Executor = pool): Promise<SectionRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return query<SectionRow>(
      `${SECTION_SQL} WHERE s.shop_id = ? AND s.id IN (${placeholders}) AND s.deleted_at IS NULL`,
      [shopId(), ...ids],
      exec,
    );
  },

  async create(
    data: SectionInput & { name: string; section_key: string; createdByAdminId: number | null },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO content_sections
         (shop_id, section_key, name, heading, standfirst, footnote, layout, background,
          padding_top, padding_bottom, settings, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.section_key,
        data.name,
        data.heading ?? null,
        data.standfirst ?? null,
        data.footnote ?? null,
        data.layout ?? 'split',
        data.background ?? null,
        data.padding_top ?? 'md',
        data.padding_bottom ?? 'md',
        data.settings === undefined || data.settings === null ? null : JSON.stringify(data.settings),
        data.createdByAdminId,
      ],
      exec,
    );
  },

  async update(id: number, data: SectionInput, exec: Executor = pool): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (data.section_key !== undefined) assign('section_key', data.section_key);
    if (data.name !== undefined) assign('name', data.name);
    if (data.heading !== undefined) assign('heading', data.heading);
    if (data.standfirst !== undefined) assign('standfirst', data.standfirst);
    if (data.footnote !== undefined) assign('footnote', data.footnote);
    if (data.layout !== undefined) assign('layout', data.layout);
    if (data.background !== undefined) assign('background', data.background);
    if (data.padding_top !== undefined) assign('padding_top', data.padding_top);
    if (data.padding_bottom !== undefined) assign('padding_bottom', data.padding_bottom);
    if (data.settings !== undefined) {
      assign('settings', data.settings === null ? null : JSON.stringify(data.settings));
    }

    if (sets.length === 0) return;
    params.push(shopId(), id);
    await execute(`UPDATE content_sections SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`, params, exec);
  },

  async softDelete(id: number, exec: Executor = pool): Promise<void> {
    await execute(`UPDATE content_sections SET deleted_at = NOW() WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
  },

  // ── blocks ────────────────────────────────────────────────────────────────
  async blocksFor(sectionIds: number[], exec: Executor = pool): Promise<BlockRow[]> {
    if (sectionIds.length === 0) return [];
    const placeholders = sectionIds.map(() => '?').join(', ');
    return query<BlockRow>(
      `${BLOCK_SQL} WHERE b.shop_id = ? AND b.section_id IN (${placeholders}) ORDER BY b.sort_order ASC, b.id ASC`,
      [shopId(), ...sectionIds],
      exec,
    );
  },

  async findBlock(id: number, exec: Executor = pool): Promise<BlockRow | null> {
    return queryOne<BlockRow>(`${BLOCK_SQL} WHERE b.shop_id = ? AND b.id = ?`, [shopId(), id], exec);
  },

  async createBlock(
    sectionId: number,
    data: BlockInput & { block_type: string },
    exec: Executor = pool,
  ): Promise<number> {
    const next = await queryOne<RowDataPacket & { next: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM content_section_blocks WHERE shop_id = ? AND section_id = ?`,
      [shopId(), sectionId],
      exec,
    );

    return insert(
      `INSERT INTO content_section_blocks
         (shop_id, section_id, block_type, sort_order, is_enabled, heading, body,
          media_id, secondary_media_id, creator_id, credit_creator, claim_id, option_value_id,
          link_type, link_ref_id, link_url, cta_label, settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        sectionId,
        data.block_type,
        data.sort_order ?? Number(next?.next ?? 0),
        data.is_enabled === false ? 0 : 1,
        data.heading ?? null,
        data.body ?? null,
        data.media_id ?? null,
        data.secondary_media_id ?? null,
        data.creator_id ?? null,
        data.credit_creator === false ? 0 : 1,
        data.claim_id ?? null,
        data.option_value_id ?? null,
        data.link_type ?? 'none',
        data.link_ref_id ?? null,
        data.link_url ?? null,
        data.cta_label ?? null,
        data.settings === undefined || data.settings === null ? null : JSON.stringify(data.settings),
      ],
      exec,
    );
  },

  async updateBlock(id: number, data: BlockInput, exec: Executor = pool): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (data.block_type !== undefined) assign('block_type', data.block_type);
    if (data.sort_order !== undefined) assign('sort_order', data.sort_order);
    if (data.is_enabled !== undefined) assign('is_enabled', data.is_enabled ? 1 : 0);
    if (data.heading !== undefined) assign('heading', data.heading);
    if (data.body !== undefined) assign('body', data.body);
    if (data.media_id !== undefined) assign('media_id', data.media_id);
    if (data.secondary_media_id !== undefined) assign('secondary_media_id', data.secondary_media_id);
    if (data.creator_id !== undefined) assign('creator_id', data.creator_id);
    if (data.credit_creator !== undefined) assign('credit_creator', data.credit_creator ? 1 : 0);
    if (data.claim_id !== undefined) assign('claim_id', data.claim_id);
    if (data.option_value_id !== undefined) assign('option_value_id', data.option_value_id);
    if (data.link_type !== undefined) assign('link_type', data.link_type);
    if (data.link_ref_id !== undefined) assign('link_ref_id', data.link_ref_id);
    if (data.link_url !== undefined) assign('link_url', data.link_url);
    if (data.cta_label !== undefined) assign('cta_label', data.cta_label);
    if (data.settings !== undefined) {
      assign('settings', data.settings === null ? null : JSON.stringify(data.settings));
    }

    if (sets.length === 0) return;
    params.push(shopId(), id);
    await execute(`UPDATE content_section_blocks SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`, params, exec);
  },

  async removeBlock(id: number, exec: Executor = pool): Promise<void> {
    await execute(`DELETE FROM content_section_blocks WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
  },

  async reorderBlocks(sectionId: number, ids: number[], exec: Executor = pool): Promise<void> {
    for (const [index, id] of ids.entries()) {
      await execute(
        `UPDATE content_section_blocks SET sort_order = ? WHERE shop_id = ? AND id = ? AND section_id = ?`,
        [index, shopId(), id, sectionId],
        exec,
      );
    }
  },

  // ── hotspots ──────────────────────────────────────────────────────────────
  async hotspotsFor(blockIds: number[], exec: Executor = pool): Promise<HotspotRow[]> {
    if (blockIds.length === 0) return [];
    const placeholders = blockIds.map(() => '?').join(', ');
    return query<HotspotRow>(
      `${HOTSPOT_SQL} WHERE h.shop_id = ? AND h.block_id IN (${placeholders}) ORDER BY h.sort_order ASC, h.id ASC`,
      [shopId(), ...blockIds],
      exec,
    );
  },

  /**
   * Replaces a block's hotspots wholesale.
   *
   * The editor is a picture people drag dots around on; there is no meaningful
   * "update hotspot 3" from the user's point of view, and diffing a handful of
   * rows to avoid rewriting them buys nothing.
   */
  async replaceHotspots(
    blockId: number,
    hotspots: HotspotInput[],
    exec: Executor = pool,
  ): Promise<void> {
    await execute(`DELETE FROM content_block_hotspots WHERE shop_id = ? AND block_id = ?`, [shopId(), blockId], exec);
    for (const [index, spot] of hotspots.entries()) {
      await execute(
        `INSERT INTO content_block_hotspots
           (shop_id, block_id, x_pct, y_pct, label, body, product_id, media_id, line_direction, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          shopId(),
          blockId,
          spot.x_pct,
          spot.y_pct,
          spot.label,
          spot.body ?? null,
          spot.product_id ?? null,
          spot.media_id ?? null,
          spot.line_direction ?? 'right',
          index,
        ],
        exec,
      );
    }
  },

  // ── assignments ───────────────────────────────────────────────────────────
  async assignmentsFor(
    ownerType: string,
    ownerId: number,
    exec: Executor = pool,
  ): Promise<AssignmentRow[]> {
    return query<AssignmentRow>(
      `SELECT id, section_id, owner_type, owner_id, sort_order, is_enabled,
              visible_from, visible_until
         FROM content_section_assignments
        WHERE shop_id = ? AND owner_type = ? AND owner_id = ?
        ORDER BY sort_order ASC, id ASC`,
      [shopId(), ownerType, ownerId],
      exec,
    );
  },

  async findAssignment(id: number, exec: Executor = pool): Promise<AssignmentRow | null> {
    return queryOne<AssignmentRow>(
      `SELECT id, section_id, owner_type, owner_id, sort_order, is_enabled,
              visible_from, visible_until
         FROM content_section_assignments WHERE shop_id = ? AND id = ?`,
      [shopId(), id],
      exec,
    );
  },

  async attach(
    sectionId: number,
    ownerType: string,
    ownerId: number,
    exec: Executor = pool,
  ): Promise<number> {
    const next = await queryOne<RowDataPacket & { next: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
         FROM content_section_assignments WHERE shop_id = ? AND owner_type = ? AND owner_id = ?`,
      [shopId(), ownerType, ownerId],
      exec,
    );

    return insert(
      `INSERT INTO content_section_assignments (shop_id, section_id, owner_type, owner_id, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
      [shopId(), sectionId, ownerType, ownerId, Number(next?.next ?? 0)],
      exec,
    );
  },

  async updateAssignment(
    id: number,
    data: { is_enabled?: boolean; visible_from?: Date | null; visible_until?: Date | null },
    exec: Executor = pool,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (data.is_enabled !== undefined) {
      sets.push('is_enabled = ?');
      params.push(data.is_enabled ? 1 : 0);
    }
    if (data.visible_from !== undefined) {
      sets.push('visible_from = ?');
      params.push(data.visible_from);
    }
    if (data.visible_until !== undefined) {
      sets.push('visible_until = ?');
      params.push(data.visible_until);
    }
    if (sets.length === 0) return;
    params.push(shopId(), id);
    await execute(
      `UPDATE content_section_assignments SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`,
      params,
      exec,
    );
  },

  async detach(id: number, exec: Executor = pool): Promise<void> {
    await execute(`DELETE FROM content_section_assignments WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
  },

  async reorderAssignments(
    ownerType: string,
    ownerId: number,
    ids: number[],
    exec: Executor = pool,
  ): Promise<void> {
    for (const [index, id] of ids.entries()) {
      await execute(
        `UPDATE content_section_assignments SET sort_order = ?
          WHERE shop_id = ? AND id = ? AND owner_type = ? AND owner_id = ?`,
        [index, shopId(), id, ownerType, ownerId],
        exec,
      );
    }
  },

  /**
   * The assignments a visitor should see: enabled, and inside their window.
   * The window is checked here rather than in the service so that a section
   * whose run has ended is never one presenter change away from reappearing.
   */
  async liveAssignmentsFor(
    ownerType: string,
    ownerId: number,
    exec: Executor = pool,
  ): Promise<AssignmentRow[]> {
    return query<AssignmentRow>(
      `SELECT a.id, a.section_id, a.owner_type, a.owner_id, a.sort_order, a.is_enabled,
              a.visible_from, a.visible_until
         FROM content_section_assignments a
         JOIN content_sections s ON s.id = a.section_id AND s.deleted_at IS NULL
        WHERE a.shop_id = ? AND a.owner_type = ? AND a.owner_id = ?
          AND a.is_enabled = 1
          AND (a.visible_from IS NULL OR a.visible_from <= NOW())
          AND (a.visible_until IS NULL OR a.visible_until > NOW())
        ORDER BY a.sort_order ASC, a.id ASC`,
      [shopId(), ownerType, ownerId],
      exec,
    );
  },
};
