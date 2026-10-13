import { ApiError } from '../../../core/ApiError';
import { storage } from '../../media/storage';
import { articlesService } from '../articles/articles.service';
import { blogsService } from '../blogs/blogs.service';
import {
  contentPublicRepository,
  type PublicBannerRow,
  type PublicBlockRow,
  type PublicFaqRow,
  type PublicPageRow,
} from './contentPublic.repository';

/**
 * What the shop is allowed to know about the CMS.
 *
 * Every presenter here is written out field by field rather than spreading a
 * row. It is more typing and it is the point: a column added to `cms_pages`
 * next month cannot reach a visitor's browser unless somebody decides it
 * should.
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
    // A hand-edited row should not take a page down.
    return null;
  }
}

/**
 * Turns a stored link into something the site can put in an href.
 *
 * A `url` link is passed through only when it is http(s) or site-relative.
 * `javascript:` and `data:` in a CTA are how a CMS becomes an XSS vector, and
 * the admin is not the right place to rely on for that check — a row can be
 * edited in the database directly.
 */
function safeUrl(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.startsWith('/')) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

function resolveLink(
  type: string,
  refId: number | null,
  url: string | null,
  resolved: Map<string, string>,
): string | null {
  if (type === 'none') return null;
  if (type === 'url') return safeUrl(url);
  if (!refId) return null;
  return resolved.get(`${type}:${refId}`) ?? null;
}

function presentBanner(row: PublicBannerRow, resolved: Map<string, string>) {
  return {
    id: row.id,
    placement: row.placement,
    title: row.title,
    subtitle: row.subtitle,
    body: row.body,
    cta: row.cta_label
      ? { label: row.cta_label, href: resolveLink(row.cta_link_type, row.cta_link_ref_id, row.cta_url, resolved) }
      : null,
    /**
     * `image` is the desktop file whatever it is — a photograph or a video.
     * `media_type` says which, and the site decides how to render it. Keeping
     * one field rather than adding `video` beside `image` means a banner
     * cannot be in the impossible state of having both.
     */
    image: mediaUrl(row.desktop_key),
    media_type: row.desktop_type === 'video' ? 'video' : 'image',
    mime_type: row.desktop_mime,
    duration_ms: row.desktop_duration_ms === null ? null : Number(row.desktop_duration_ms),
    /**
     * What to paint before a video has loaded a single byte — and what a phone
     * sees instead of the video. A poster chosen by hand wins; otherwise it is
     * the frame pulled out of the file on upload.
     */
    poster:
      row.desktop_type === 'video'
        ? (mediaUrl(row.chosen_poster_key) ?? mediaUrl(row.auto_poster_key))
        : null,
    image_mobile: mediaUrl(row.mobile_key),
    /**
     * A video in the mobile slot would defeat the point of having one, so it is
     * ignored there. Phones get the poster instead.
     */
    mobile_is_video: row.mobile_type === 'video',
    image_alt: row.desktop_alt,
    background: row.background_hex,
    text_color: row.text_hex,
    dismissible: row.is_dismissible === 1,
    priority: row.priority,
  };
}

function presentFaq(row: PublicFaqRow) {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    group: row.group_slug ? { slug: row.group_slug, name: row.group_name } : null,
  };
}

function presentBlock(row: PublicBlockRow, resolved: Map<string, string>) {
  return {
    id: row.id,
    type: row.block_type,
    heading: row.heading,
    body: row.body,
    image: mediaUrl(row.media_key),
    image_alt: row.media_alt,
    cta: row.cta_label
      ? { label: row.cta_label, href: resolveLink(row.link_type, row.link_ref_id, row.link_url, resolved) }
      : null,
    settings: parseJson(row.settings),
  };
}

function presentPage(row: PublicPageRow) {
  return {
    slug: row.slug,
    path: row.full_path,
    title: row.title,
    subtitle: row.subtitle,
    page_type: row.page_type,
    template: row.template,
    body_html: row.body_html,
    hero: mediaUrl(row.hero_key),
    hero_alt: row.hero_alt,
    published_at: row.published_at,
    updated_at: row.updated_at,
    seo: {
      meta_title: row.meta_title ?? row.title,
      meta_description: row.meta_description ?? row.subtitle,
      is_indexable: row.is_indexable === 1,
    },
  };
}

export const contentPublicService = {
  async page(slug: string) {
    const row = await contentPublicRepository.pageBySlug(slug);
    if (!row) throw ApiError.notFound('That page does not exist.');

    const sections = await contentPublicRepository.sectionsFor(row.id);
    const blocks = await contentPublicRepository.blocksFor(sections.map((section) => section.id));

    const resolved = await contentPublicRepository.resolveLinkTargets(
      blocks
        .filter((block) => block.link_ref_id)
        .map((block) => ({ type: block.link_type, id: Number(block.link_ref_id) })),
    );

    return {
      page: presentPage(row),
      sections: sections.map((section) => ({
        key: section.section_key,
        name: section.name,
        background: section.background,
        padding: { top: section.padding_top, bottom: section.padding_bottom },
        settings: parseJson(section.settings),
        blocks: blocks
          .filter((block) => block.section_id === section.id)
          .map((block) => presentBlock(block, resolved)),
      })),
    };
  },

  async pageIndex() {
    const rows = await contentPublicRepository.pageIndex();
    return {
      pages: rows.map((row) => ({
        slug: row.slug,
        title: row.title,
        page_type: row.page_type,
        updated_at: row.updated_at,
      })),
    };
  },

  /**
   * Banners for one or more placements, grouped by placement.
   *
   * Grouped rather than flat so a page asking for two slots makes one request
   * and still knows which banner belongs where.
   */
  async banners(placements: string[]) {
    const rows = await contentPublicRepository.bannersFor(placements);
    const resolved = await contentPublicRepository.resolveLinkTargets(
      rows
        .filter((row) => row.cta_link_ref_id)
        .map((row) => ({ type: row.cta_link_type, id: Number(row.cta_link_ref_id) })),
    );

    const grouped: Record<string, ReturnType<typeof presentBanner>[]> = {};
    for (const placement of placements) grouped[placement] = [];
    for (const row of rows) {
      grouped[row.placement] = [...(grouped[row.placement] ?? []), presentBanner(row, resolved)];
    }
    return { banners: grouped };
  },

  async trackBanner(id: number, kind: 'impression' | 'click') {
    await contentPublicRepository.trackBanner(id, kind);
    // 202-shaped: analytics must never be something a page waits on or fails for.
    return { recorded: true };
  },

  async faqs(groupSlug?: string) {
    const [groups, rows] = await Promise.all([
      contentPublicRepository.faqGroups(),
      contentPublicRepository.faqs(groupSlug),
    ]);

    if (groupSlug && rows.length === 0 && !groups.some((group) => group.slug === groupSlug)) {
      throw ApiError.notFound('That FAQ section does not exist.');
    }

    return {
      groups: groups.map((group) => ({
        slug: group.slug,
        name: group.name,
        description: group.description,
      })),
      faqs: rows.map(presentFaq),
    };
  },

  async productFaqs(productId: number) {
    const rows = await contentPublicRepository.faqsForEntity('product', productId);
    return { faqs: rows.map(presentFaq) };
  },

  async markFaqHelpful(id: number) {
    await contentPublicRepository.markFaqHelpful(id);
    return { recorded: true };
  },

  // The journal already has a public presenter of its own; this is here so the
  // storefront has one content service to talk to rather than two.
  journal: {
    list: (queryParams: Record<string, unknown>) => articlesService.publicList(queryParams),
    detail: (slug: string) => articlesService.publicDetail(slug),
    blogs: () => blogsService.publicList(),
  },
};
