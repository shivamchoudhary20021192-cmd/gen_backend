import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { appBlockType, extensionProblems, isAppBlockType } from '../../src/platform/apps/themeExtensions';
import { appBlockTemplates, extensionWords } from '../../src/platform/onlineStore/renderer';
import { presentmentPrice, storeAmount } from '../../src/platform/markets/fx';
import { sampleCustomer } from '../../src/platform/onlineStore/customerDrops';
import { customerSession } from '../../src/platform/onlineStore/customerSession';
import { engineFor } from '../../src/platform/onlineStore/engine/engine';
import type { LoadedTheme, RenderEnv, ThemeFileEntry } from '../../src/platform/onlineStore/engine/types';
import { localizeHtml, localizePath, safeReturn } from '../../src/platform/onlineStore/storefrontHttp';
import { tr } from '../../src/platform/onlineStore/translations';
import { loadBundles } from '../../src/platform/themes/bundles';
import { validateTemplate } from '../../src/platform/themes/themeSchema';

let counter = 0;
function themeOf(files: Record<string, string>): LoadedTheme {
  counter += 1;
  const map = new Map<string, ThemeFileEntry>();
  for (const [path, content] of Object.entries(files)) map.set(path, { content, contentType: 'text/x-liquid', storageKey: null, checksum: `os${counter}${path.length}` });
  return { shopId: 1, id: 20_000 + counter, publicId: `os-${counter}`, name: 'Test', role: 'main', libraryHandle: 'test', filesVersion: 1, draftStamp: null, files: map };
}

async function render(source: string, scope: Record<string, unknown>, env: Partial<RenderEnv> = {}) {
  const theme = themeOf({ 'snippets/probe.liquid': source });
  const { engine, parse } = engineFor(theme);
  const base: RenderEnv = {
    theme,
    currency: 'INR',
    moneyLocale: 'en-IN',
    shopCurrency: 'INR',
    locale: 'en',
    translations: {},
    assetBase: '/cdn/shop/t/test/assets/',
    designMode: false,
    currentPage: 1,
    requestPath: '/account/addresses',
    requestQuery: new URLSearchParams(),
    templateName: 'customers/addresses',
    state: { layout: null, stylesheets: [], scripts: [] },
    forms: {},
    renderSection: async () => '',
    renderGroup: async () => '',
  };
  return engine.render(parse('snippets/probe.liquid'), scope, { globals: { __env: { ...base, ...env } } });
}

// ── languages ──────────────────────────────────────────────────────────────

describe('storefront languages', () => {
  it('puts a page under its language prefix', () => {
    assert.equal(localizePath('/products/serum', '/hi'), '/hi/products/serum');
    assert.equal(localizePath('/', '/hi'), '/hi');
    assert.equal(localizePath('/collections/all?page=2', '/fr'), '/fr/collections/all?page=2');
  });

  it('leaves alone what is already localised, other sites, assets and checkout', () => {
    assert.equal(localizePath('/hi/products/serum', '/hi'), '/hi/products/serum');
    assert.equal(localizePath('/hi', '/hi'), '/hi');
    assert.equal(localizePath('//cdn.example.com/x.js', '/hi'), '//cdn.example.com/x.js');
    assert.equal(localizePath('https://example.com/', '/hi'), 'https://example.com/');
    for (const path of ['/cdn/shop/t/1/assets/base.css', '/checkouts/abc', '/checkout', '/localization', '/api/v1/cart', '/media/a.jpg']) {
      assert.equal(localizePath(path, '/hi'), path, path);
    }
  });

  it('rewrites every same-site link and form in a page, and nothing else', () => {
    const html = '<a href="/products/a">A</a><form action="/cart/add"></form><link href="/cdn/x.css"><a href="https://x.com/">x</a><img src="/media/y.jpg">';
    assert.equal(localizeHtml(html, '/hi'), '<a href="/hi/products/a">A</a><form action="/hi/cart/add"></form><link href="/cdn/x.css"><a href="https://x.com/">x</a><img src="/media/y.jpg">');
    assert.equal(localizeHtml(html, ''), html);
  });

  it('returns the original text synchronously outside a translated request', () => {
    assert.equal(tr('product', 1, 'title', 'Serum'), 'Serum');
    assert.equal(tr('page', null, 'title', 'About'), 'About');
  });

  it('ships every theme string in every bundled language, placeholders intact', () => {
    const bundle = loadBundles({ fresh: true })[0];
    const english = JSON.parse(bundle.files.get('locales/en.default.json')!);
    const flat = (value: unknown, prefix = ''): Record<string, string> =>
      Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((out, [key, child]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return typeof child === 'string' ? { ...out, [path]: child } : { ...out, ...flat(child, path) };
      }, {});
    const placeholders = (text: string) => (text.match(/{{\s*\w+\s*}}/g) ?? []).map((token) => token.replace(/\s/g, '')).sort().join();
    const source = flat(english);
    for (const code of ['hi', 'fr', 'es', 'de']) {
      const translated = flat(JSON.parse(bundle.files.get(`locales/${code}.json`)!));
      for (const [key, text] of Object.entries(source)) {
        assert.ok(key in translated, `${code} is missing ${key}`);
        assert.equal(placeholders(translated[key]), placeholders(text), `${code} ${key} placeholders`);
      }
    }
  });
});

// ── prices in the shopper's currency ──────────────────────────────────────

describe('price filters in the market currency', () => {
  it('turns a price the shopper typed back into the store currency', () => {
    const market = { rate: 0.012, adjustmentPercent: 5, currency: 'USD', rounding: 'none' as const };
    const base = 2499;
    const shown = presentmentPrice(base, market);
    assert.ok(Math.abs(storeAmount(shown, market) - base) < 1, 'round trip within a unit');
    assert.equal(storeAmount(500, { rate: 1, adjustmentPercent: 0 }), 500);
  });
});

// ── customer accounts ──────────────────────────────────────────────────────

describe('customer accounts', () => {
  it('points an address form at the address it edits, and a new one at the list', async () => {
    const html = await render("{% form 'customer_address', address %}{{ form.first_name }}{% endform %}|{% form 'customer_address', fresh %}{% endform %}", {
      address: { id: 5, first_name: 'Asha', city: 'Pune' },
      fresh: { id: null },
    });
    assert.match(html, /action="\/account\/addresses\/5"/);
    assert.match(html, />Asha<\/form>/);
    assert.match(html, /\|<form method="post" action="\/account\/addresses"/);
  });

  it("shows a failed save's errors only on the form it came from", async () => {
    const source = "{% form 'customer_address', a %}{{ form.errors | join: ',' }}{% endform %}{% form 'customer_address', b %}{{ form.errors | join: ',' }}{% endform %}";
    const html = await render(source, { a: { id: 1 }, b: { id: 2 } }, { forms: { customer_address: { posted_successfully: false, errors: ['Enter a city.'], address_id: 2 } } });
    const [first, second] = html.split('</form>');
    assert.ok(!first.includes('Enter a city.'));
    assert.ok(second.includes('Enter a city.'));
  });

  it('carries a sign-in in progress in a signed cookie, and refuses a tampered one', () => {
    const jar: string[] = [];
    const res = { append: (_name: string, value: string) => jar.push(value) } as unknown as Response;
    customerSession.setPending(res, { requestId: '00000000-0000-4000-8000-000000000000', sentTo: '••••••10', channel: 'sms', phone: '9876543210', returnTo: '/account', resendAt: Date.now() });
    const cookie = jar[0].split(';')[0];
    const request = (header: string) => ({ header: (name: string) => (name === 'Cookie' ? header : undefined) }) as unknown as Request;
    assert.equal(customerSession.pending(request(cookie))?.phone, '9876543210');
    assert.equal(customerSession.pending(request(`${cookie}x`)), null);
  });

  it('only returns to paths on this site', () => {
    assert.equal(safeReturn('/account/orders/1', '/'), '/account/orders/1');
    assert.equal(safeReturn('//evil.example/', '/account'), '/account');
    assert.equal(safeReturn('https://evil.example/', '/account'), '/account');
    assert.equal(safeReturn('/\\evil.example', '/account'), '/account');
  });

  it("gives the theme editor a made-up customer, never a real one", () => {
    const { customer, order } = sampleCustomer('INR');
    assert.equal(customer.orders.length, 2);
    assert.equal(order.name, '#SAMPLE1002');
    assert.equal(customer.default_address.country_code, 'IN');
  });
});

// ── app blocks ─────────────────────────────────────────────────────────────

describe('theme app extensions', () => {
  const block = `<p>{{ block.settings.text }}</p>{% schema %}{ "name": "Note", "target": "section", "stylesheet": "note.css", "settings": [{ "type": "text", "id": "text" }] }{% endschema %}`;

  it('accepts a bundle of blocks and assets', () => {
    assert.deepEqual(extensionProblems(new Map([['blocks/note.liquid', block], ['assets/note.css', '.n{}']])), []);
  });

  it('accepts snippets and locales, as Shopify extensions have', () => {
    assert.deepEqual(
      extensionProblems(new Map([['blocks/note.liquid', block], ['assets/note.css', '.n{}'], ['snippets/star.liquid', '<i>★</i>'], ['locales/en.default.json', '{"note":{"title":"Note"}}'], ['locales/fr.json', '{"note":{"title":"Remarque"}}']])),
      [],
    );
  });

  it('renders a block with its own snippets and words, not the theme’s', async () => {
    const files = {
      'blocks/stars.liquid': '<p>{% render "star" %} {{ "stars.label" | t: count: block.settings.count }}</p>{% schema %}{ "name": "Stars", "target": "section" }{% endschema %}',
      'snippets/star.liquid': '<i>app-star</i>',
      'locales/en.default.json': '{"stars":{"label":"{{ count }} stars"}}',
      'locales/fr.json': '{"stars":{"label":"{{ count }} étoiles"}}',
    };
    const definition = { type: 'shopify://apps/r/blocks/stars/1', handle: 'stars', name: 'Stars', target: 'section' as const, settings: [], stylesheet: null, javascript: null, liquid: files['blocks/stars.liquid'], app: { id: '11111111-1111-4111-8111-111111111111', handle: 'r', name: 'Reviews', version: 3 }, files };
    const { runtime, templates } = appBlockTemplates(definition);
    const render = (locale: string) =>
      runtime.engine.render(templates, { block: { settings: { count: 5 } } }, { globals: { __env: { theme: runtime.theme, translations: extensionWords(files, locale), locale, assetBase: '/cdn/apps/x/3/assets/', forms: {}, state: { layout: null, stylesheets: [], scripts: [] } } } });
    assert.equal((await render('en')).trim(), '<p><i>app-star</i> 5 stars</p>');
    assert.equal((await render('fr')).trim(), '<p><i>app-star</i> 5 étoiles</p>');
  });

  it('names what is wrong with a bundle', () => {
    const problems = extensionProblems(
      new Map([
        ['blocks/note.liquid', block],
        ['blocks/bad.liquid', '{% schema %}{ "name": "Bad", "target": "footer" }{% endschema %}'],
        ['blocks/nameless.liquid', '<p>no schema</p>'],
        ['blocks/broken.liquid', '{% if %}{% schema %}{ "name": "B", "target": "body" }{% endschema %}'],
        ['templates/x.liquid', ''],
        ['snippets/card.liquid', '{% if %}'],
        ['locales/fr.json', '{"a": '],
        ['assets/run.exe', ''],
      ]),
    );
    const text = problems.join('\n');
    assert.match(text, /stylesheet "note.css" is not in assets/);
    assert.match(text, /bad.liquid: "target" must be/);
    assert.match(text, /nameless.liquid needs a \{% schema %\}/);
    assert.match(text, /broken.liquid/);
    assert.match(text, /templates\/x.liquid: extensions have blocks\/, snippets\/, locales\/ and assets\/ only/);
    assert.match(text, /snippets\/card.liquid/);
    assert.match(text, /locales\/fr.json/);
    assert.match(text, /locales\/ needs a default file/);
    assert.match(text, /run.exe: only CSS/);
  });

  it("names a block the way Shopify's theme JSON does", () => {
    const type = appBlockType('reviews', 'stars', '11111111-1111-4111-8111-111111111111');
    assert.equal(type, 'shopify://apps/reviews/blocks/stars/11111111-1111-4111-8111-111111111111');
    assert.ok(isAppBlockType(type));
    assert.ok(!isAppBlockType('text'));
  });

  it('allows app blocks only in sections that accept them', () => {
    const type = appBlockType('reviews', 'stars', '11111111-1111-4111-8111-111111111111');
    const schemas = new Map([
      ['product', { name: 'Product', blocks: [{ type: '@app' }, { type: 'title', name: 'Title' }] }],
      ['hero', { name: 'Hero', blocks: [{ type: 'button', name: 'Button' }] }],
    ]);
    const ok = validateTemplate({ sections: { main: { type: 'product', blocks: { a: { type } } } }, order: ['main'] }, schemas as never, 't');
    const bad = validateTemplate({ sections: { main: { type: 'hero', blocks: { a: { type } } } }, order: ['main'] }, schemas as never, 't');
    const junk = validateTemplate({ sections: { main: { type: 'product', blocks: { a: { type: 'made-up' } } } }, order: ['main'] }, schemas as never, 't');
    assert.deepEqual(ok, []);
    assert.equal(bad.length, 1);
    assert.equal(junk.length, 1);
  });

  it('hands {% render block %} for an app block to the platform, and renders snippets as before', async () => {
    const calls: unknown[] = [];
    const theme = themeOf({ 'snippets/probe.liquid': '{% for block in blocks %}{% render block %}{% endfor %}|{% render "hello", name: "x" %}', 'snippets/hello.liquid': 'hi {{ name }}' });
    const { engine, parse } = engineFor(theme);
    const html = await engine.render(parse('snippets/probe.liquid'), { blocks: [{ id: 'b1', __app_block: {} }] }, {
      globals: {
        __env: {
          ...{ theme, currency: 'INR', moneyLocale: 'en-IN', shopCurrency: 'INR', locale: 'en', translations: {}, assetBase: '/', designMode: false, currentPage: 1, requestPath: '/', requestQuery: new URLSearchParams(), templateName: 'index', state: { layout: null, stylesheets: [], scripts: [] }, forms: {} },
          renderSection: async () => '',
          renderGroup: async () => '',
          renderAppBlock: async (block: Record<string, unknown>) => {
            calls.push(block.id);
            return '<app-block>';
          },
        },
      },
    });
    assert.deepEqual(calls, ['b1']);
    assert.equal(html, '<app-block>|hi x');
  });
});
