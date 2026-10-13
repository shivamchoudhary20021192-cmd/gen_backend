import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../../db/pool';
import { shopId } from '../../../platform/tenancy/context';

/**
 * The rows behind a built page.
 *
 * Reads and writes `content_sections`, `content_section_blocks` and
 * `content_section_assignments` — the tables product storytelling already uses
 * — narrowed to `surface = 'page'` and to assignments whose owner is a
 * template. Narrowing rather than separating is deliberate: the two editors
 * must never see each other's sections, and one predicate in one file is a
 * cheaper guarantee of that than a second set of tables.
 */

export interface TemplateRow extends RowDataPacket {
  id: number;
  template_key: string;
  name: string;
  description: string | null;
  is_system: number;
  is_active: number;
}

export interface PageSectionRow extends RowDataPacket {
  assignment_id: number;
  section_id: number;
  section_key: string;
  name: string;
  settings: unknown;
  sort_order: number;
  is_enabled: number;
  visible_from: Date | null;
  visible_until: Date | null;
  updated_at: Date;
}

export interface PageBlockRow extends RowDataPacket {
  id: number;
  section_id: number;
  block_type: string;
  sort_order: number;
  is_enabled: number;
  media_id: number | null;
  link_type: string;
  link_ref_id: number | null;
  link_url: string | null;
  cta_label: string | null;
  settings: unknown;
}

const SECTION_COLUMNS = `
  a.id AS assignment_id, s.id AS section_id, s.section_key, s.name, s.settings,
  a.sort_order, a.is_enabled, a.visible_from, a.visible_until, s.updated_at`;

export const pageBuilderRepository = {
  async templates(exec: Executor = pool): Promise<TemplateRow[]> {
    return query<TemplateRow>(
      'SELECT * FROM page_templates WHERE shop_id = ? AND is_active = 1 ORDER BY is_system DESC, name',
      [shopId()],
      exec,
    );
  },

  async template(key: string, exec: Executor = pool): Promise<TemplateRow | null> {
    return (
      (await queryOne<TemplateRow>('SELECT * FROM page_templates WHERE shop_id = ? AND template_key = ? LIMIT 1', [shopId(), key], exec)) ??
      null
    );
  },

  /**
   * The sections of one template, in order.
   *
   * `live` applies the schedule and the enabled flag — what a visitor may see.
   * The admin passes false and gets everything, including a section scheduled
   * for next month, because not showing it is exactly what it is there to do
   * and a builder that hides it looks broken.
   */
  async sections(templateId: number, live: boolean, exec: Executor = pool): Promise<PageSectionRow[]> {
    const conditions = [
      'a.shop_id = ?',
      "a.owner_type = 'template'",
      'a.owner_id = ?',
      's.deleted_at IS NULL',
      "s.surface = 'page'",
    ];
    if (live) {
      conditions.push('a.is_enabled = 1');
      conditions.push('(a.visible_from IS NULL OR a.visible_from <= NOW())');
      conditions.push('(a.visible_until IS NULL OR a.visible_until >= NOW())');
    }
    return query<PageSectionRow>(
      `SELECT ${SECTION_COLUMNS}
         FROM content_section_assignments a
         JOIN content_sections s ON s.id = a.section_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.sort_order, a.id`,
      [shopId(), templateId],
      exec,
    );
  },

  async section(sectionId: number, exec: Executor = pool): Promise<PageSectionRow | null> {
    return (
      (await queryOne<PageSectionRow>(
        `SELECT ${SECTION_COLUMNS}
           FROM content_sections s
           LEFT JOIN content_section_assignments a
             ON a.section_id = s.id AND a.shop_id = s.shop_id AND a.owner_type = 'template'
          WHERE s.shop_id = ? AND s.id = ? AND s.deleted_at IS NULL AND s.surface = 'page'
          LIMIT 1`,
        [shopId(), sectionId],
        exec,
      )) ?? null
    );
  },

  /** Which template a section is placed on, so a copy lands on the same page. */
  async templateOf(sectionId: number, exec: Executor = pool): Promise<number | null> {
    const row = await queryOne<RowDataPacket & { owner_id: number }>(
      "SELECT owner_id FROM content_section_assignments WHERE shop_id = ? AND section_id = ? AND owner_type = 'template' LIMIT 1",
      [shopId(), sectionId],
      exec,
    );
    return row?.owner_id ?? null;
  },

  async blocks(sectionIds: number[], live: boolean, exec: Executor = pool): Promise<PageBlockRow[]> {
    if (sectionIds.length === 0) return [];
    return query<PageBlockRow>(
      `SELECT id, section_id, block_type, sort_order, is_enabled,
              media_id, link_type, link_ref_id, link_url, cta_label, settings
         FROM content_section_blocks
        WHERE shop_id = ? AND section_id IN (${sectionIds.map(() => '?').join(', ')})
          ${live ? 'AND is_enabled = 1' : ''}
        ORDER BY section_id, sort_order, id`,
      [shopId(), ...sectionIds],
      exec,
    );
  },

  // ── writes ─────────────────────────────────────────────────────────────────

  async createSection(
    data: { section_key: string; name: string; settings: unknown },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      "INSERT INTO content_sections (shop_id, section_key, surface, name, settings) VALUES (?, ?, 'page', ?, ?)",
      [shopId(), data.section_key, data.name, JSON.stringify(data.settings ?? {})],
      exec,
    );
  },

  async updateSection(id: number, data: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const columns = Object.keys(data);
    if (columns.length === 0) return;
    await execute(
      `UPDATE content_sections SET ${columns.map((column) => `${column} = ?`).join(', ')}
        WHERE shop_id = ? AND id = ? AND surface = 'page'`,
      [...Object.values(data), shopId(), id],
      exec,
    );
  },

  /** Soft, like everything else in the CMS: a section removed is often restored. */
  async removeSection(id: number, exec: Executor = pool): Promise<void> {
    await execute("UPDATE content_sections SET deleted_at = NOW() WHERE shop_id = ? AND id = ? AND surface = 'page'", [shopId(), id], exec);
    await execute(
      "DELETE FROM content_section_assignments WHERE shop_id = ? AND section_id = ? AND owner_type = 'template'",
      [shopId(), id],
      exec,
    );
  },

  async attach(
    templateId: number,
    sectionId: number,
    sortOrder: number,
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO content_section_assignments (shop_id, section_id, owner_type, owner_id, sort_order, is_enabled)
       VALUES (?, ?, 'template', ?, ?, 1)`,
      [shopId(), sectionId, templateId, sortOrder],
      exec,
    );
  },

  async nextSortOrder(templateId: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { next: number }>(
      `SELECT COALESCE(MAX(sort_order), 0) + 10 AS next
         FROM content_section_assignments WHERE shop_id = ? AND owner_type = 'template' AND owner_id = ?`,
      [shopId(), templateId],
      exec,
    );
    return Number(row?.next ?? 10);
  },

  async updateAssignment(sectionId: number, data: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const columns = Object.keys(data);
    if (columns.length === 0) return;
    await execute(
      `UPDATE content_section_assignments SET ${columns.map((column) => `${column} = ?`).join(', ')}
        WHERE shop_id = ? AND section_id = ? AND owner_type = 'template'`,
      [...Object.values(data), shopId(), sectionId],
      exec,
    );
  },

  /**
   * Reorder by section id, inside the caller's transaction.
   *
   * Gapped by ten so a later insert between two rows does not need every row
   * after it rewritten.
   */
  async setOrder(templateId: number, sectionIds: number[], exec: Executor = pool): Promise<void> {
    for (const [index, sectionId] of sectionIds.entries()) {
      await execute(
        `UPDATE content_section_assignments SET sort_order = ?
          WHERE shop_id = ? AND owner_type = 'template' AND owner_id = ? AND section_id = ?`,
        [(index + 1) * 10, shopId(), templateId, sectionId],
        exec,
      );
    }
  },

  async createBlock(
    sectionId: number,
    data: { block_type: string; sort_order: number; media_id: number | null; link_type: string; link_ref_id: number | null; link_url: string | null; cta_label: string | null; settings: unknown },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO content_section_blocks
         (shop_id, section_id, block_type, sort_order, is_enabled, media_id, link_type, link_ref_id, link_url, cta_label, settings)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        sectionId,
        data.block_type,
        data.sort_order,
        data.media_id,
        data.link_type,
        data.link_ref_id,
        data.link_url,
        data.cta_label,
        JSON.stringify(data.settings ?? {}),
      ],
      exec,
    );
  },

  async updateBlock(blockId: number, data: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const columns = Object.keys(data);
    if (columns.length === 0) return;
    await execute(
      `UPDATE content_section_blocks SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE shop_id = ? AND id = ?`,
      [...Object.values(data), shopId(), blockId],
      exec,
    );
  },

  async removeBlock(blockId: number, exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM content_section_blocks WHERE shop_id = ? AND id = ?', [shopId(), blockId], exec);
  },

  async setBlockOrder(sectionId: number, blockIds: number[], exec: Executor = pool): Promise<void> {
    for (const [index, blockId] of blockIds.entries()) {
      await execute(
        'UPDATE content_section_blocks SET sort_order = ? WHERE shop_id = ? AND id = ? AND section_id = ?',
        [index, shopId(), blockId, sectionId],
        exec,
      );
    }
  },

  async nextBlockOrder(sectionId: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { next: number }>(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM content_section_blocks WHERE shop_id = ? AND section_id = ?',
      [shopId(), sectionId],
      exec,
    );
    return Number(row?.next ?? 0);
  },

  // ── the things settings point at ───────────────────────────────────────────

  async media(ids: number[], exec: Executor = pool): Promise<RowDataPacket[]> {
    if (ids.length === 0) return [];
    return query<RowDataPacket>(
      `SELECT id, storage_key, alt_text, media_type, width, height
         FROM media WHERE shop_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
      [shopId(), ...ids],
      exec,
    );
  },

  async collections(ids: number[], exec: Executor = pool): Promise<RowDataPacket[]> {
    if (ids.length === 0) return [];
    return query<RowDataPacket>(
      `SELECT c.id, c.slug, c.title, c.subtitle,
              (SELECT m.storage_key FROM media m WHERE m.shop_id = c.shop_id AND m.id = c.image_media_id) AS image_key
         FROM collections c
        WHERE c.shop_id = ? AND c.id IN (${ids.map(() => '?').join(', ')}) AND c.deleted_at IS NULL AND c.is_active = 1`,
      [shopId(), ...ids],
      exec,
    );
  },

  /** The collections the menu shows, for a tile row left on automatic. */
  async menuCollections(limit: number, exec: Executor = pool): Promise<RowDataPacket[]> {
    return query<RowDataPacket>(
      `SELECT c.id, c.slug, c.title, c.subtitle,
              (SELECT m.storage_key FROM media m WHERE m.shop_id = c.shop_id AND m.id = c.image_media_id) AS image_key
         FROM collections c
        WHERE c.shop_id = ? AND c.deleted_at IS NULL AND c.is_active = 1 AND c.show_in_menu = 1
        ORDER BY c.sort_order, c.id
        LIMIT ?`,
      [shopId(), limit],
      exec,
    );
  },
};
