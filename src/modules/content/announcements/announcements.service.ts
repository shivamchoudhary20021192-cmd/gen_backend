import crypto from 'node:crypto';
import { ApiError } from '../../../core/ApiError';
import { withTransaction } from '../../../db/transaction';
import { ShopScopedCache } from '../../../platform/cache/shopCache';
import { announcementsRepository, type AnnouncementRow, type AnnouncementSettingsRow } from './announcements.repository';

/**
 * The strip above the header.
 *
 * Two audiences, two shapes. The admin sees every line with its schedule, its
 * targeting, the state of its coupon and how it is doing; the storefront sees
 * only what it may show right now, to this shopper, already resolved.
 *
 * How the bar behaves is the market's announcement bar: rotating lines (fade,
 * slide, slide up, typewriter) or a scrolling ticker; a height that fits each
 * line, the tallest line, or a fixed size; colours per bar and per line; arrows
 * and the bar itself per device; a countdown to a line's end; a free-shipping
 * line that follows the cart; lines for some pages, audiences and countries.
 */

/** Sane bounds for the rotation. Enforced here as well as in the schema. */
export const MIN_ROTATION_SECONDS = 3;
export const MAX_ROTATION_SECONDS = 120;

/** The template types a line can be limited to (what `request.page_type` says). */
export const PAGE_TYPES = ['index', 'product', 'collection', 'list-collections', 'cart', 'page', 'blog', 'article', 'search', 'policy'] as const;

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function list(value: unknown): string[] {
  const parsed = json<unknown>(value, null);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
}

function couponSummary(row: AnnouncementRow) {
  if (!row.coupon_id) return null;
  const value = row.coupon_value === null ? null : Number(row.coupon_value);
  return {
    id: row.coupon_id,
    code: row.coupon_code,
    title: row.coupon_title,
    type: row.coupon_type,
    value,
    /** Whether it may be advertised — see COUPON_LIVE in the repository. */
    live: row.coupon_live === 1,
  };
}

function presentAdmin(row: AnnouncementRow, stats?: { views: number; clicks: number }) {
  const coupon = couponSummary(row);
  return {
    id: row.id,
    message: row.message,
    kind: row.kind,
    success_message: row.success_message,
    free_shipping_threshold: row.free_shipping_threshold === null ? null : Number(row.free_shipping_threshold),
    coupon,
    link: {
      type: row.link_type,
      url: row.link_url,
      ref_id: row.link_ref_id,
      label: row.cta_label,
    },
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    show_countdown: row.show_countdown === 1,
    background_hex: row.background_hex,
    text_hex: row.text_hex,
    visibility: row.visibility,
    show_on: list(row.show_on),
    audience: row.audience,
    countries: list(row.countries),
    is_active: row.is_active === 1,
    sort_order: row.sort_order,
    /**
     * Why this line is not on the site, in the admin's own words.
     *
     * A list of rows that are all "active" but half of which nobody can see is
     * the sort of screen people stop trusting. Saying it on the row is cheaper
     * than a support conversation.
     */
    hidden_because: hiddenBecause(row, coupon),
    stats: stats ?? { views: 0, clicks: 0 },
    updated_at: row.updated_at,
  };
}

function hiddenBecause(row: AnnouncementRow, coupon: ReturnType<typeof couponSummary>): string | null {
  if (row.is_active !== 1) return 'Switched off';
  const now = Date.now();
  if (row.starts_at && new Date(row.starts_at).getTime() > now) return 'Scheduled — not started yet';
  if (row.ends_at && new Date(row.ends_at).getTime() < now) return 'Finished';
  if (coupon && !coupon.live) return 'Its code is no longer valid, so the line is withheld';
  if (row.kind === 'free_shipping' && !(Number(row.free_shipping_threshold) > 0)) return 'Needs a free-shipping amount';
  return null;
}

/**
 * The public shape of one line (the headless storefront's API).
 *
 * The code is a field of its own rather than being written into the message,
 * so the storefront can draw it as something to copy and — more importantly —
 * so it can be withheld without mangling the sentence around it.
 */
function presentPublic(row: AnnouncementRow) {
  const coupon = couponSummary(row);
  return {
    id: row.id,
    message: row.message,
    code: coupon?.live ? coupon.code : null,
    cta: row.cta_label
      ? { label: row.cta_label, href: hrefFor(row.link_type, row.link_url, row.link_ref_id) }
      : null,
    kind: row.kind,
    success_message: row.success_message,
    free_shipping_threshold: row.free_shipping_threshold === null ? null : Number(row.free_shipping_threshold),
    countdown_ends_at: row.show_countdown === 1 && row.ends_at ? new Date(row.ends_at).toISOString() : null,
    background: row.background_hex,
    text_color: row.text_hex,
    visibility: row.visibility,
  };
}

/**
 * Where a line points, for the headless storefront.
 *
 * The same vocabulary the banners use. A type whose target needs a slug the
 * strip does not have falls back to a listing filtered by id, which is a real
 * page rather than a dead link.
 */
function hrefFor(type: string, url: string | null, refId: number | null): string | null {
  switch (type) {
    case 'url':
      return url;
    case 'product':
      return refId ? `/shop?product=${refId}` : null;
    case 'category':
      return refId ? `/shop?category_id=${refId}` : null;
    case 'collection':
      return refId ? `/shop?collection_id=${refId}` : null;
    case 'article':
      return refId ? `/journal` : null;
    case 'page':
    case 'policy':
      return url ?? null;
    default:
      return null;
  }
}

/** Where a line points on the Online Store (the Liquid themes), from the handle resolved in SQL. */
function onlineStoreHref(row: AnnouncementRow): string | null {
  const handle = row.ref_handle;
  switch (row.link_type) {
    case 'url':
    case 'policy':
      return row.link_url || null;
    case 'product':
      return handle ? `/products/${handle}` : null;
    case 'collection':
    case 'category':
      return handle ? `/collections/${handle}` : null;
    case 'page':
      return handle ? `/pages/${handle}` : row.link_url || null;
    case 'article':
      return handle ? `/blogs/${handle}` : null;
    default:
      return null;
  }
}

function presentSettings(row: AnnouncementSettingsRow) {
  return {
    is_enabled: row.is_enabled === 1,
    display_mode: row.display_mode,
    transition: row.transition,
    autoplay: row.autoplay === 1,
    rotation_seconds: row.rotation_seconds,
    pause_on_hover: row.pause_on_hover === 1,
    marquee_speed: row.marquee_speed,
    marquee_direction: row.marquee_direction,
    marquee_separator: row.marquee_separator,
    height_mode: row.height_mode,
    fixed_height_desktop: row.fixed_height_desktop,
    fixed_height_mobile: row.fixed_height_mobile,
    max_lines: row.max_lines,
    font_size_desktop: row.font_size_desktop,
    font_size_mobile: row.font_size_mobile,
    font_weight: row.font_weight,
    text_transform: row.text_transform,
    text_align: row.text_align,
    background_hex: row.background_hex,
    background_gradient_hex: row.background_gradient_hex,
    text_hex: row.text_hex,
    bar_visibility: row.bar_visibility,
    arrows_visibility: row.arrows_visibility,
    link_arrow_visibility: row.link_arrow_visibility,
    is_dismissible: row.is_dismissible === 1,
    dismiss_days: row.dismiss_days,
  };
}

export type AnnouncementBarSettings = ReturnType<typeof presentSettings>;

/** What one page of the Online Store is told about the bar. */
export interface StorefrontBar {
  enabled: boolean;
  settings: AnnouncementBarSettings;
  /** Changes whenever what the bar says changes: a shopper who closed an old bar sees the new one. */
  version: string;
  lines: {
    id: number;
    message: string;
    kind: 'message' | 'free_shipping';
    success_message: string | null;
    free_shipping_threshold: number | null;
    code: string | null;
    href: string | null;
    cta_label: string | null;
    countdown_ends_at: string | null;
    background: string | null;
    text_color: string | null;
    visibility: 'all' | 'desktop' | 'mobile';
  }[];
}

/**
 * Which live lines one Online Store page shows, and how: a pure function of
 * the rows and the request, so it can be tested without a database.
 *
 * Dropped: a line whose code is no longer valid, a free-shipping line with no
 * amount, and lines meant for other pages, other shoppers (guests or
 * signed-in) or other countries. Devices are left to the browser.
 */
export function storefrontLines(rows: AnnouncementRow[], context: { template: string; signedIn: boolean; country: string | null }): StorefrontBar['lines'] {
  // "product.alternate" and "customers/account" are a product page and an account page.
  const template = context.template.split('.')[0].split('/').pop() ?? context.template;
  return rows
    .filter((row) => !row.coupon_id || row.coupon_live === 1)
    .filter((row) => row.kind !== 'free_shipping' || Number(row.free_shipping_threshold) > 0)
    .filter((row) => {
      const pages = list(row.show_on);
      return pages.length === 0 || pages.includes(template);
    })
    .filter((row) => row.audience === 'all' || (row.audience === 'customers') === context.signedIn)
    .filter((row) => {
      const countries = list(row.countries);
      return countries.length === 0 || (context.country !== null && countries.includes(context.country));
    })
    .map((row) => {
      const coupon = couponSummary(row);
      return {
        id: Number(row.id),
        message: row.message,
        kind: row.kind,
        success_message: row.success_message,
        free_shipping_threshold: row.free_shipping_threshold === null ? null : Number(row.free_shipping_threshold),
        code: coupon?.live ? coupon.code : null,
        href: onlineStoreHref(row),
        cta_label: row.cta_label,
        countdown_ends_at: row.show_countdown === 1 && row.ends_at ? new Date(row.ends_at).toISOString() : null,
        background: row.background_hex,
        text_color: row.text_hex,
        visibility: row.visibility,
      };
    });
}

/**
 * The live lines and the settings, per shop, for a few seconds. Every page
 * render asks, so the question should not be a query each time; a change made
 * here clears it at once on this process, and the page cache's version moves
 * on for every process.
 */
const storefrontCache = new ShopScopedCache<{ rows: AnnouncementRow[]; settings: AnnouncementSettingsRow }>(10_000);

const BOOLEAN_SETTINGS = ['is_enabled', 'autoplay', 'pause_on_hover', 'is_dismissible'] as const;
const PLAIN_SETTINGS = [
  'display_mode', 'transition', 'marquee_speed', 'marquee_direction', 'marquee_separator', 'height_mode',
  'fixed_height_desktop', 'fixed_height_mobile', 'max_lines', 'font_size_desktop', 'font_size_mobile', 'font_weight',
  'text_transform', 'text_align', 'background_hex', 'background_gradient_hex', 'text_hex', 'bar_visibility',
  'arrows_visibility', 'link_arrow_visibility', 'dismiss_days',
] as const;

export const announcementsService = {
  async list() {
    const [rows, stats] = await Promise.all([announcementsRepository.list(), announcementsRepository.stats(30)]);
    return { announcements: rows.map((row) => presentAdmin(row, stats.get(Number(row.id)))), settings: await this.settings() };
  },

  async byId(id: number) {
    const row = await announcementsRepository.byId(id);
    if (!row) throw ApiError.notFound('Announcement');
    return { announcement: presentAdmin(row) };
  },

  /**
   * What the headless storefront shows.
   *
   * A line whose coupon has lapsed is dropped entirely rather than shown
   * without its code: the sentence exists to advertise the offer, and "20% off
   * for students" with nothing to type is worse than silence. Lines meant only
   * for some pages, shoppers or countries are left out: this API cannot tell.
   */
  async publicList() {
    const [rows, settings] = await Promise.all([
      announcementsRepository.live(),
      announcementsRepository.settings(),
    ]);

    const announcements = rows
      .filter((row) => !row.coupon_id || row.coupon_live === 1)
      .filter((row) => row.audience === 'all' && list(row.show_on).length === 0 && list(row.countries).length === 0)
      .map(presentPublic);

    return {
      enabled: settings.is_enabled === 1 && announcements.length > 0,
      rotation_seconds: settings.rotation_seconds,
      dismissible: settings.is_dismissible === 1,
      background: settings.background_hex,
      text_color: settings.text_hex,
      settings: presentSettings(settings),
      announcements,
    };
  },

  /**
   * What one Online Store page shows: the live lines this shopper may see on
   * this kind of page, in this country, signed in or not. Devices are left to
   * the browser (a page is cached for every device), as are countdowns and the
   * free-shipping arithmetic.
   */
  async forStorefront(context: { template: string; signedIn: boolean; country: string | null }): Promise<StorefrontBar> {
    const { rows, settings } = await storefrontCache.get('bar', async () => {
      const [live, row] = await Promise.all([announcementsRepository.live(), announcementsRepository.settings()]);
      return { rows: live, settings: row };
    });
    const lines = storefrontLines(rows, context);
    const present = presentSettings(settings);
    const version = crypto
      .createHash('sha1')
      .update(JSON.stringify(lines.map((line) => [line.id, line.message, line.code, line.href])))
      .digest('hex')
      .slice(0, 10);
    return { enabled: present.is_enabled && lines.length > 0, settings: present, version, lines };
  },

  /**
   * Views and clicks from the storefront — sent only with the shopper's
   * analytics consent. One of each per line per request: a page cannot report
   * a thousand views of itself.
   */
  async track(events: { id: number; event: 'view' | 'click' }[]) {
    const totals = new Map<number, { views: number; clicks: number }>();
    for (const { id, event } of events.slice(0, 20)) {
      const entry = totals.get(id) ?? { views: 0, clicks: 0 };
      if (event === 'view') entry.views = 1;
      else entry.clicks = 1;
      totals.set(id, entry);
    }
    await announcementsRepository.recordStats([...totals].map(([id, entry]) => ({ id, ...entry })));
  },

  async create(input: Record<string, unknown>) {
    const id = await announcementsRepository.create(writable(input, true));
    storefrontCache.clear();
    return this.byId(id);
  },

  async update(id: number, input: Record<string, unknown>) {
    const existing = await announcementsRepository.byId(id);
    if (!existing) throw ApiError.notFound('Announcement');
    await announcementsRepository.update(id, writable(input, false));
    storefrontCache.clear();
    return this.byId(id);
  },

  async remove(id: number) {
    const existing = await announcementsRepository.byId(id);
    if (!existing) throw ApiError.notFound('Announcement');
    await announcementsRepository.remove(id);
    storefrontCache.clear();
    return { deleted: true };
  },

  async reorder(ids: number[]) {
    await withTransaction(async (connection) => {
      await announcementsRepository.setOrder(ids, connection);
    });
    storefrontCache.clear();
    return this.list();
  },

  async settings() {
    return presentSettings(await announcementsRepository.settings());
  },

  async updateSettings(input: Record<string, unknown>) {
    const data: Record<string, unknown> = {};
    for (const key of BOOLEAN_SETTINGS) if (key in input) data[key] = input[key] ? 1 : 0;
    for (const key of PLAIN_SETTINGS) if (key in input) data[key] = input[key] ?? null;
    // The separator ends up inside a CSS string: nothing that could close it.
    if ('marquee_separator' in data) data.marquee_separator = String(data.marquee_separator ?? '').replace(/["'\\<>;{}]/g, '').slice(0, 8);
    if ('rotation_seconds' in input) {
      const seconds = Number(input.rotation_seconds);
      if (!Number.isInteger(seconds) || seconds < MIN_ROTATION_SECONDS || seconds > MAX_ROTATION_SECONDS) {
        throw ApiError.badRequest(
          `Rotation must be between ${MIN_ROTATION_SECONDS} and ${MAX_ROTATION_SECONDS} seconds.`,
        );
      }
      data.rotation_seconds = seconds;
    }
    // The row is created on first read; make sure there is one to update.
    await announcementsRepository.settings();
    await announcementsRepository.updateSettings(data);
    storefrontCache.clear();
    return this.settings();
  },
};

/** Only these columns are writable, and `message` is required on create. */
function writable(input: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const copy = (key: string) => {
    if (key in input) out[key] = input[key] ?? null;
  };

  if (creating || 'message' in input) {
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (!message) throw ApiError.badRequest('An announcement needs something to say.');
    out.message = message;
  }

  for (const key of ['coupon_id', 'link_type', 'link_url', 'link_ref_id', 'cta_label', 'starts_at', 'ends_at', 'sort_order', 'kind', 'success_message', 'free_shipping_threshold', 'background_hex', 'text_hex', 'visibility', 'audience']) {
    copy(key);
  }
  if ('is_active' in input) out.is_active = input.is_active ? 1 : 0;
  if ('show_countdown' in input) out.show_countdown = input.show_countdown ? 1 : 0;
  // An empty targeting list means "everywhere": stored as NULL, not [].
  for (const key of ['show_on', 'countries']) {
    if (key in input) {
      const value = input[key];
      out[key] = Array.isArray(value) && value.length ? JSON.stringify(value) : null;
    }
  }
  if (creating && input.kind === 'free_shipping' && !(Number(input.free_shipping_threshold) > 0)) {
    throw ApiError.validation({ free_shipping_threshold: ['Say how much a cart has to reach for free shipping.'] });
  }

  return out;
}
