import { execute, pool, query, queryOne, type Executor, type RowDataPacket } from '../../../db/pool';
import { shopId } from '../../../platform/tenancy/context';

/**
 * Reads for the public side of the CMS.
 *
 * Deliberately not the admin repositories, for the same reason the storefront
 * product reads are not the admin ones: the admin needs drafts, preview tokens,
 * internal notes and review dates, and the site must never be one forgotten
 * `WHERE` away from serving them. Every query here hard-codes its published
 * gate and names its columns instead of selecting `*`.
 */

export interface PublicPageRow extends RowDataPacket {
  id: number;
  slug: string;
  full_path: string;
  title: string;
  subtitle: string | null;
  page_type: string;
  template: string;
  body_html: string | null;
  hero_key: string | null;
  hero_alt: string | null;
  is_indexable: number;
  published_at: Date | null;
  updated_at: Date;
  status: string;
  meta_title: string | null;
  meta_description: string | null;
}

export interface PublicSectionRow extends RowDataPacket {
  id: number;
  section_key: string;
  name: string | null;
  sort_order: number;
  background: string | null;
  padding_top: string;
  padding_bottom: string;
  settings: unknown;
}

export interface PublicBlockRow extends RowDataPacket {
  id: number;
  section_id: number;
  block_type: string;
  sort_order: number;
  heading: string | null;
  body: string | null;
  media_key: string | null;
  media_alt: string | null;
  link_type: string;
  link_ref_id: number | null;
  link_url: string | null;
  cta_label: string | null;
  settings: unknown;
}

export interface PublicBannerRow extends RowDataPacket {
  id: number;
  placement: string;
  title: string | null;
  subtitle: string | null;
  body: string | null;
  cta_label: string | null;
  cta_link_type: string;
  cta_link_ref_id: number | null;
  cta_url: string | null;
  desktop_key: string | null;
  desktop_alt: string | null;
  desktop_type: string | null;
  desktop_mime: string | null;
  desktop_duration_ms: number | null;
  /** The widest still frame generated from the video on upload. */
  auto_poster_key: string | null;
  /** A poster chosen by hand on the banner, which wins over the auto one. */
  chosen_poster_key: string | null;
  mobile_key: string | null;
  mobile_type: string | null;
  background_hex: string | null;
  text_hex: string | null;
  priority: number;
  is_dismissible: number;
}

export interface PublicFaqRow extends RowDataPacket {
  id: number;
  question: string;
  answer: string;
  sort_order: number;
  group_id: number | null;
  group_slug: string | null;
  group_name: string | null;
}

/**
 * The published gate, written once.
 *
 * `scheduled_at` is not consulted: a page is live when its status says so and
 * its publish moment has passed. `unpublish_at` is, because an expired policy
 * page still sitting on the site is the failure this column exists to prevent.
 */
const PAGE_LIVE = `
  p.shop_id = ?
  AND p.deleted_at IS NULL
  AND p.status = 'published'
  AND (p.published_at IS NULL OR p.published_at <= NOW())
  AND (p.unpublish_at IS NULL OR p.unpublish_at > NOW())`;

/** What a visitor may see of a page. Listed by name, never `p.*`. */
const PAGE_COLUMNS = `
  p.id, p.slug, p.full_path, p.title, p.subtitle, p.page_type, p.template,
  p.body_html, p.is_indexable, p.published_at, p.updated_at, p.status,
  hero.storage_key AS hero_key, hero.alt_text AS hero_alt,
  seo.meta_title, seo.meta_description
    FROM cms_pages p
    LEFT JOIN media hero ON hero.id = p.hero_media_id AND hero.shop_id = p.shop_id
    LEFT JOIN seo_meta seo ON seo.shop_id = p.shop_id AND seo.entity_type = 'page' AND seo.entity_id = p.id`;

export const contentPublicRepository = {
  async pageBySlug(slug: string, exec: Executor = pool): Promise<PublicPageRow | null> {
    return queryOne<PublicPageRow>(
      `SELECT ${PAGE_COLUMNS}
        WHERE (p.slug = ? OR p.full_path = ?) AND ${PAGE_LIVE}
        LIMIT 1`,
      [slug, slug, shopId()],
      exec,
    );
  },

  /**
   * A page by its preview link, whatever its state short of archived or
   * deleted. The published gate deliberately does not apply: showing what is
   * not live yet is the point. Nothing but the preview route reads this.
   */
  async pageByPreviewToken(token: string, exec: Executor = pool): Promise<PublicPageRow | null> {
    return queryOne<PublicPageRow>(
      `SELECT ${PAGE_COLUMNS}
        WHERE p.shop_id = ? AND p.preview_token = ? AND p.deleted_at IS NULL AND p.status <> 'archived'
        LIMIT 1`,
      [shopId(), token],
      exec,
    );
  },

  /** Every live page, for the footer and the sitemap. */
  async pageIndex(exec: Executor = pool) {
    return query<RowDataPacket & { slug: string; title: string; page_type: string; updated_at: Date }>(
      `SELECT p.slug, p.title, p.page_type, p.updated_at
         FROM cms_pages p
        WHERE ${PAGE_LIVE} AND p.show_in_sitemap = 1
        ORDER BY p.page_type ASC, p.title ASC`,
      [shopId()],
      exec,
    );
  },

  async sectionsFor(pageId: number, exec: Executor = pool): Promise<PublicSectionRow[]> {
    return query<PublicSectionRow>(
      `SELECT s.id, s.section_key, s.name, s.sort_order, s.background,
              s.padding_top, s.padding_bottom, s.settings
         FROM cms_page_sections s
        WHERE s.shop_id = ?
          AND s.page_id = ?
          AND s.is_enabled = 1
          AND (s.visible_from IS NULL OR s.visible_from <= NOW())
          AND (s.visible_until IS NULL OR s.visible_until > NOW())
        ORDER BY s.sort_order ASC, s.id ASC`,
      [shopId(), pageId],
      exec,
    );
  },

  async blocksFor(sectionIds: number[], exec: Executor = pool): Promise<PublicBlockRow[]> {
    if (sectionIds.length === 0) return [];
    const placeholders = sectionIds.map(() => '?').join(', ');
    return query<PublicBlockRow>(
      `SELECT b.id, b.section_id, b.block_type, b.sort_order, b.heading, b.body,
              b.link_type, b.link_ref_id, b.link_url, b.cta_label, b.settings,
              m.storage_key AS media_key, m.alt_text AS media_alt
         FROM cms_section_blocks b
         LEFT JOIN media m ON m.id = b.media_id AND m.shop_id = b.shop_id
        WHERE b.shop_id = ? AND b.section_id IN (${placeholders}) AND b.is_enabled = 1
        ORDER BY b.section_id ASC, b.sort_order ASC, b.id ASC`,
      [shopId(), ...sectionIds],
      exec,
    );
  },

  /**
   * Live banners for a placement.
   *
   * The window and the active flag are both checked here rather than in the
   * service: a banner whose run has ended must not be one presenter change away
   * from reappearing on the site.
   */
  async bannersFor(placements: string[], exec: Executor = pool): Promise<PublicBannerRow[]> {
    if (placements.length === 0) return [];
    const placeholders = placements.map(() => '?').join(', ');
    return query<PublicBannerRow>(
      `SELECT b.id, b.placement, b.title, b.subtitle, b.body, b.cta_label,
              b.cta_link_type, b.cta_link_ref_id, b.cta_url,
              b.background_hex, b.text_hex, b.priority, b.is_dismissible,
              d.storage_key AS desktop_key, d.alt_text AS desktop_alt,
              d.media_type AS desktop_type, d.mime_type AS desktop_mime,
              d.duration_ms AS desktop_duration_ms,
              -- The widest still generated from the video. One subquery beats
              -- a join that would multiply every banner by its variant count.
              (SELECT v.storage_key
                 FROM media_variants v
                WHERE v.shop_id = d.shop_id AND v.media_id = d.id AND v.format = 'webp'
                ORDER BY v.width DESC
                LIMIT 1) AS auto_poster_key,
              po.storage_key AS chosen_poster_key,
              mo.storage_key AS mobile_key, mo.media_type AS mobile_type
         FROM cms_banners b
         LEFT JOIN media d ON d.id = b.desktop_media_id AND d.shop_id = b.shop_id
         LEFT JOIN media mo ON mo.id = b.mobile_media_id AND mo.shop_id = b.shop_id
         LEFT JOIN media po ON po.id = b.poster_media_id AND po.shop_id = b.shop_id
        WHERE b.shop_id = ?
          AND b.placement IN (${placeholders})
          AND b.is_active = 1
          AND (b.starts_at IS NULL OR b.starts_at <= NOW())
          AND (b.ends_at IS NULL OR b.ends_at > NOW())
        ORDER BY b.priority DESC, b.id DESC`,
      [shopId(), ...placements],
      exec,
    );
  },

  /** Resolves a banner or block link target to a path the site can route to. */
  async resolveLinkTargets(
    targets: { type: string; id: number }[],
    exec: Executor = pool,
  ): Promise<Map<string, string>> {
    const resolved = new Map<string, string>();
    const byType = new Map<string, number[]>();
    for (const target of targets) {
      if (!target.id) continue;
      byType.set(target.type, [...(byType.get(target.type) ?? []), target.id]);
    }

    const lookups: { type: string; sql: string; prefix: string }[] = [
      { type: 'page', sql: 'SELECT id, slug FROM cms_pages WHERE shop_id = ? AND id IN (?)', prefix: '/pages/' },
      { type: 'product', sql: 'SELECT id, slug FROM products WHERE shop_id = ? AND id IN (?)', prefix: '/product/' },
      { type: 'collection', sql: 'SELECT id, slug FROM collections WHERE shop_id = ? AND id IN (?)', prefix: '/shop?collection=' },
      { type: 'category', sql: 'SELECT id, slug FROM categories WHERE shop_id = ? AND id IN (?)', prefix: '/shop?category=' },
      { type: 'article', sql: 'SELECT id, slug FROM cms_articles WHERE shop_id = ? AND id IN (?)', prefix: '/journal/' },
    ];

    for (const lookup of lookups) {
      const ids = byType.get(lookup.type);
      if (!ids || ids.length === 0) continue;
      const placeholders = ids.map(() => '?').join(', ');
      const rows = await query<RowDataPacket & { id: number; slug: string }>(
        lookup.sql.replace('(?)', `(${placeholders})`),
        [shopId(), ...ids],
        exec,
      );
      for (const row of rows) {
        resolved.set(`${lookup.type}:${row.id}`, `${lookup.prefix}${row.slug}`);
      }
    }

    return resolved;
  },

  async trackBanner(id: number, kind: 'impression' | 'click', exec: Executor = pool): Promise<void> {
    const column = kind === 'click' ? 'click_count' : 'impression_count';
    await execute(`UPDATE cms_banners SET ${column} = ${column} + 1 WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
  },

  async faqGroups(exec: Executor = pool) {
    return query<RowDataPacket & { id: number; slug: string; name: string; description: string | null }>(
      `SELECT g.id, g.slug, g.name, g.description
         FROM cms_faq_groups g
        WHERE g.shop_id = ?
          AND g.is_active = 1
          AND EXISTS (SELECT 1 FROM cms_faqs f WHERE f.shop_id = g.shop_id AND f.group_id = g.id AND f.is_published = 1)
        ORDER BY g.sort_order ASC, g.name ASC`,
      [shopId()],
      exec,
    );
  },

  /**
   * Published FAQs.
   *
   * `entity_type` is left out on purpose when no group is asked for: a FAQ
   * attached to a product belongs on that product's page, not in the shop-wide
   * list, and including it here would answer a question nobody asked.
   */
  async faqs(groupSlug: string | undefined, exec: Executor = pool): Promise<PublicFaqRow[]> {
    const params: unknown[] = [shopId()];
    let gate = 'f.group_id IS NOT NULL';
    if (groupSlug) {
      gate = 'g.slug = ?';
      params.push(groupSlug);
    }
    return query<PublicFaqRow>(
      `SELECT f.id, f.question, f.answer, f.sort_order,
              f.group_id, g.slug AS group_slug, g.name AS group_name
         FROM cms_faqs f
         JOIN cms_faq_groups g ON g.id = f.group_id AND g.shop_id = f.shop_id AND g.is_active = 1
        WHERE f.shop_id = ? AND f.is_published = 1 AND ${gate}
        ORDER BY g.sort_order ASC, f.sort_order ASC, f.id ASC`,
      params,
      exec,
    );
  },

  /** FAQs attached to one product, for the product page. */
  async faqsForEntity(
    entityType: string,
    entityId: number,
    exec: Executor = pool,
  ): Promise<PublicFaqRow[]> {
    return query<PublicFaqRow>(
      `SELECT f.id, f.question, f.answer, f.sort_order,
              f.group_id, NULL AS group_slug, NULL AS group_name
         FROM cms_faqs f
        WHERE f.shop_id = ? AND f.is_published = 1 AND f.entity_type = ? AND f.entity_id = ?
        ORDER BY f.sort_order ASC, f.id ASC`,
      [shopId(), entityType, entityId],
      exec,
    );
  },

  async markFaqHelpful(id: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE cms_faqs SET helpful_count = helpful_count + 1 WHERE shop_id = ? AND id = ? AND is_published = 1`,
      [shopId(), id],
      exec,
    );
  },
};
