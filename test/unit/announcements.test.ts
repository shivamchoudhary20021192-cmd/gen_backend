import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { AnnouncementRow } from '../../src/modules/content/announcements/announcements.repository';
import { storefrontLines } from '../../src/modules/content/announcements/announcements.service';
import { engineFor } from '../../src/platform/onlineStore/engine/engine';
import type { LoadedTheme, RenderEnv, ThemeFileEntry } from '../../src/platform/onlineStore/engine/types';

// Pure helpers and the kit's Liquid: nothing here touches a database.

let id = 0;
function row(overrides: Partial<AnnouncementRow> = {}): AnnouncementRow {
  id += 1;
  return {
    id,
    message: `Line ${id}`,
    coupon_id: null,
    link_type: 'none',
    link_url: null,
    link_ref_id: null,
    cta_label: null,
    starts_at: null,
    ends_at: null,
    is_active: 1,
    sort_order: id,
    created_at: new Date(),
    updated_at: new Date(),
    kind: 'message',
    success_message: null,
    free_shipping_threshold: null,
    show_countdown: 0,
    background_hex: null,
    text_hex: null,
    visibility: 'all',
    show_on: null,
    audience: 'all',
    countries: null,
    ref_handle: null,
    coupon_code: null,
    coupon_title: null,
    coupon_type: null,
    coupon_value: null,
    coupon_live: null,
    ...overrides,
  } as AnnouncementRow;
}

const home = { template: 'index', signedIn: false, country: 'IN' };

describe('which announcement lines a page shows', () => {
  it('drops a line whose code has lapsed, and one advertising free shipping without an amount', () => {
    const lines = storefrontLines(
      [
        row({ coupon_id: 7, coupon_code: 'SAVE10', coupon_live: 1 }),
        row({ coupon_id: 8, coupon_code: 'OLD', coupon_live: 0 }),
        row({ kind: 'free_shipping', free_shipping_threshold: null }),
        row({ kind: 'free_shipping', free_shipping_threshold: '999.00', message: 'Spend {amount} more' }),
      ],
      home,
    );
    assert.deepEqual(lines.map((line) => line.code ?? line.kind), ['SAVE10', 'free_shipping']);
    assert.equal(lines[1].free_shipping_threshold, 999);
  });

  it('follows the page: an alternate template is still that kind of page', () => {
    const rows = [row({ show_on: JSON.stringify(['product']) }), row({ show_on: '["index","cart"]' }), row()];
    assert.equal(storefrontLines(rows, { ...home, template: 'product.alternate' }).length, 2);
    assert.equal(storefrontLines(rows, { ...home, template: 'cart' }).length, 2);
    assert.equal(storefrontLines(rows, { ...home, template: 'customers/account' }).length, 1);
  });

  it('follows the shopper: guests, signed-in customers, and the country they buy in', () => {
    const rows = [row({ audience: 'guests' }), row({ audience: 'customers' }), row({ countries: '["US","CA"]' }), row()];
    assert.equal(storefrontLines(rows, home).length, 2);
    assert.equal(storefrontLines(rows, { ...home, signedIn: true }).length, 2);
    assert.equal(storefrontLines(rows, { ...home, country: 'US' }).length, 3);
    assert.equal(storefrontLines(rows, { ...home, country: null }).length, 2);
  });

  it('links to the Online Store’s own pages, and counts down only when asked', () => {
    const ends = new Date('2030-01-01T00:00:00Z');
    const [product, collection, category, page, article, url, none, timed, untimed] = storefrontLines(
      [
        row({ link_type: 'product', link_ref_id: 1, ref_handle: 'hydra-serum' }),
        row({ link_type: 'collection', link_ref_id: 2, ref_handle: 'summer' }),
        row({ link_type: 'category', link_ref_id: 3, ref_handle: 'skincare' }),
        row({ link_type: 'page', link_ref_id: 4, ref_handle: 'about' }),
        row({ link_type: 'article', link_ref_id: 5, ref_handle: 'journal/spf-myths' }),
        row({ link_type: 'url', link_url: 'https://example.com/sale' }),
        row({ link_type: 'none' }),
        row({ ends_at: ends, show_countdown: 1 }),
        row({ ends_at: ends, show_countdown: 0 }),
      ],
      home,
    );
    assert.equal(product.href, '/products/hydra-serum');
    assert.equal(collection.href, '/collections/summer');
    assert.equal(category.href, '/collections/skincare');
    assert.equal(page.href, '/pages/about');
    assert.equal(article.href, '/blogs/journal/spf-myths');
    assert.equal(url.href, 'https://example.com/sale');
    assert.equal(none.href, null);
    assert.equal(timed.countdown_ends_at, ends.toISOString());
    assert.equal(untimed.countdown_ends_at, null);
  });
});

// ── the kit's section, rendered by the real engine ─────────────────────────

const KIT = path.resolve(__dirname, '../../themes/_kit');
let counter = 0;
function kitTheme(): LoadedTheme {
  counter += 1;
  const files = new Map<string, ThemeFileEntry>();
  for (const file of ['sections/announcement-bar.liquid', 'snippets/announcement-line.liquid', 'snippets/icon.liquid']) {
    const content = fs.readFileSync(path.join(KIT, file), 'utf8');
    files.set(file === 'sections/announcement-bar.liquid' ? 'snippets/bar.liquid' : file, { content, contentType: 'text/x-liquid', storageKey: null, checksum: `ab${counter}${file}` });
  }
  return { shopId: 1, id: 30_000 + counter, publicId: `ab-${counter}`, name: 'Kit', role: 'main', libraryHandle: 'kit', filesVersion: 1, draftStamp: null, files };
}

const SETTINGS = {
  is_enabled: true, display_mode: 'rotate', transition: 'slide', autoplay: true, rotation_seconds: 6, pause_on_hover: true,
  marquee_speed: 60, marquee_direction: 'left', marquee_separator: '✦', height_mode: 'fixed', fixed_height_desktop: 42,
  fixed_height_mobile: 48, max_lines: 1, font_size_desktop: 14, font_size_mobile: 12, font_weight: 'bold',
  text_transform: 'uppercase', text_align: 'center', background_hex: '#101010', background_gradient_hex: '#7a1f3d',
  text_hex: '#ffffff', bar_visibility: 'all', arrows_visibility: 'desktop', link_arrow_visibility: 'none',
  is_dismissible: true, dismiss_days: 7,
};

const LINES = [
  { id: 1, message: 'Free delivery over ₹999', kind: 'message', code: null, href: '/collections/all', cta_label: null, countdown_ends_at: null, background: null, text_color: null, visibility: 'all', success_message: null, threshold_cents: null },
  { id: 2, message: 'Festive sale', kind: 'message', code: 'DIWALI20', href: null, cta_label: null, countdown_ends_at: '2030-01-01T00:00:00.000Z', background: '#7a1f3d', text_color: '#fff4d6', visibility: 'desktop', success_message: null, threshold_cents: null },
  { id: 3, message: 'Spend {amount} more for free delivery', kind: 'free_shipping', code: null, href: null, cta_label: null, countdown_ends_at: null, background: null, text_color: null, visibility: 'mobile', success_message: 'Free delivery unlocked', threshold_cents: 99900 },
];

async function renderBar(bar: Record<string, unknown>, sectionSettings: Record<string, unknown> = { source: 'admin', color_scheme: 'inverse' }, blocks: unknown[] = []) {
  const theme = kitTheme();
  const { engine, parse } = engineFor(theme);
  const env: RenderEnv = {
    theme,
    currency: 'INR',
    moneyLocale: 'en-IN',
    shopCurrency: 'INR',
    locale: 'en',
    translations: {},
    assetBase: '/cdn/shop/t/test/assets/',
    designMode: false,
    currentPage: 1,
    requestPath: '/',
    requestQuery: new URLSearchParams(),
    templateName: 'index',
    state: { layout: null, stylesheets: [], scripts: [] },
    forms: {},
    renderSection: async () => '',
    renderGroup: async () => '',
  };
  return engine.render(parse('snippets/bar.liquid'), { section: { id: 'announcement-bar', settings: sectionSettings, blocks } }, { globals: { __env: env, announcement_bar: bar } }) as Promise<string>;
}

describe('the announcement bar section', () => {
  it('draws the admin’s lines with the bar’s motion, size and colours', async () => {
    const html = await renderBar({ enabled: true, version: 'v1', settings: SETTINGS, lines: LINES });
    for (const needle of ['vl-ab--rotate', 'vl-ab--h-fixed', 'vl-ab--t-slide', 'vl-ab--w-bold', 'vl-ab--upper', 'vl-ab--hover-pause', '--ab-h: 42px', '--ab-h-m: 48px', '--ab-fs: 14px', 'linear-gradient(90deg, #101010, #7a1f3d)', 'data-autoplay="true"', 'data-interval="6"', 'data-dismiss-days="7"', 'data-version="v1"', 'data-track']) {
      assert.ok(html.includes(needle), needle);
    }
  });

  it('shows each line where it was meant, with its code, countdown and free-shipping amount', async () => {
    const html = await renderBar({ enabled: true, version: 'v1', settings: SETTINGS, lines: LINES });
    const lines = html.split('class="vl-ab__line').slice(1);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^ is-active/);
    assert.match(lines[1], /^ small-hide/);
    assert.match(lines[1], /aria-hidden="true"/);
    assert.match(lines[1], /data-ab-copy="DIWALI20"/);
    assert.match(lines[1], /data-ab-countdown="2030-01-01T00:00:00.000Z"/);
    assert.match(lines[1], /data-bg="#7a1f3d"/);
    assert.match(lines[2], /^ medium-hide/);
    assert.match(lines[2], /data-free-shipping="99900"/);
    assert.match(lines[2], /Spend ₹999(\.00)? more for free delivery/);
  });

  it('puts the arrows and the link arrow where the admin said', async () => {
    const html = await renderBar({ enabled: true, version: 'v1', settings: SETTINGS, lines: LINES });
    assert.match(html, /vl-ab__arrow vl-ab__arrow--prev small-hide/);
    assert.match(html, /vl-ab__link-arrow vl-ab__hidden/);
    const mobileOnly = await renderBar({ enabled: true, version: 'v1', settings: { ...SETTINGS, arrows_visibility: 'mobile', link_arrow_visibility: 'all', bar_visibility: 'mobile' }, lines: LINES });
    assert.match(mobileOnly, /vl-ab__arrow--next medium-hide/);
    assert.match(mobileOnly, /class="vl-ab medium-hide/);
    assert.doesNotMatch(mobileOnly, /vl-ab__link-arrow vl-ab__hidden/);
  });

  it('turns into a ticker, with its separator and a pause button', async () => {
    const html = await renderBar({ enabled: true, version: 'v1', settings: { ...SETTINGS, display_mode: 'marquee' }, lines: LINES });
    assert.match(html, /vl-ab--marquee/);
    assert.match(html, /--ab-sep: &quot;✦&quot;/);
    assert.match(html, /data-ab-pause/);
    assert.doesNotMatch(html, /data-ab-prev/);
  });

  it('falls back to the theme’s blocks without admin lines, and says nothing when switched off', async () => {
    const blocks = [{ id: 'b1', type: 'announcement', settings: { text: 'From the theme', link: '' }, shopify_attributes: '' }];
    const fallback = await renderBar({ enabled: false, version: '', settings: SETTINGS, lines: [] }, { source: 'admin', color_scheme: 'inverse' }, blocks);
    assert.match(fallback, /From the theme/);
    assert.doesNotMatch(fallback, /data-track/);
    const off = await renderBar({ enabled: false, version: '', settings: { ...SETTINGS, is_enabled: false }, lines: LINES }, { source: 'admin', color_scheme: 'inverse' }, blocks);
    assert.equal(off.trim(), '');
    const blocksChosen = await renderBar({ enabled: true, version: 'v1', settings: SETTINGS, lines: LINES }, { source: 'blocks', color_scheme: 'inverse' }, blocks);
    assert.match(blocksChosen, /From the theme/);
    assert.doesNotMatch(blocksChosen, /Festive sale/);
  });
});
