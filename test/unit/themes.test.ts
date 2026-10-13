import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { engineFor } from '../../src/platform/onlineStore/engine/engine';
import type { LoadedTheme, RenderEnv, ThemeFileEntry } from '../../src/platform/onlineStore/engine/types';
import { loadBundles } from '../../src/platform/themes/bundles';
import { settingProblem } from '../../src/platform/themes/settingValidation';
import { fileProblems } from '../../src/platform/themes/themeFiles.service';
import { extractSchema, parseJsonTemplate, templateName, validateTemplate } from '../../src/platform/themes/themeSchema';
import { createZip, readZip, ZipError } from '../../src/platform/themes/zip';

// ── a theme in memory, and a render environment ───────────────────────────

let themeCounter = 0;
function themeOf(files: Record<string, string>): LoadedTheme {
  themeCounter += 1;
  const map = new Map<string, ThemeFileEntry>();
  for (const [path, content] of Object.entries(files)) map.set(path, { content, contentType: 'text/x-liquid', storageKey: null, checksum: `c${path.length}abcdefghij` });
  return { shopId: 1, id: 10_000 + themeCounter, publicId: `t-${themeCounter}`, name: 'Test', role: 'main', libraryHandle: 'test', filesVersion: 1, draftStamp: null, files: map };
}

function envFor(theme: LoadedTheme, overrides: Partial<RenderEnv> = {}): RenderEnv {
  return {
    theme,
    currency: 'INR',
    moneyLocale: 'en-IN',
    shopCurrency: 'INR',
    locale: 'en',
    translations: { products: { product: { add_to_cart: 'Add to cart', reviews: { one: '{{ count }} review', other: '{{ count }} reviews' } } } },
    assetBase: '/cdn/shop/t/test/assets/',
    designMode: false,
    currentPage: 1,
    requestPath: '/collections/all',
    requestQuery: new URLSearchParams(),
    templateName: 'collection',
    state: { layout: null, stylesheets: [], scripts: [] },
    forms: {},
    renderSection: async () => '',
    renderGroup: async () => '',
    ...overrides,
  };
}

async function render(source: string, scope: Record<string, unknown> = {}, files: Record<string, string> = {}, env: Partial<RenderEnv> = {}) {
  const theme = themeOf({ 'snippets/probe.liquid': source, ...files });
  const { engine, parse } = engineFor(theme);
  return engine.render(parse('snippets/probe.liquid'), scope, { globals: { __env: envFor(theme, env) } });
}

// ── schema and templates ───────────────────────────────────────────────────

describe('section schemas and JSON templates', () => {
  it("reads a section's {% schema %}", () => {
    const schema = extractSchema('<div>{{ section.settings.title }}</div>\n{% schema %}{ "name": "Hero", "settings": [{ "type": "text", "id": "title" }] }{% endschema %}');
    assert.equal(schema?.name, 'Hero');
    assert.equal(schema?.settings?.[0].id, 'title');
  });

  it('refuses a schema that is not JSON', () => {
    assert.throws(() => extractSchema('{% schema %}{ name: Hero }{% endschema %}', 'sections/hero.liquid'), /sections\/hero.liquid/);
  });

  it('accepts the comment banner Shopify writes at the top of JSON templates', () => {
    const template = parseJsonTemplate('/* Auto-generated */\n{ "sections": {}, "order": [] }', 'templates/index.json');
    assert.deepEqual(template.order, []);
  });

  it('names what is wrong with a template', () => {
    const schemas = new Map([['hero', { name: 'Hero', blocks: [{ type: 'heading', name: 'Heading' }] }]]);
    const problems = validateTemplate(
      {
        sections: {
          a: { type: 'hero', blocks: { b1: { type: 'button' } }, block_order: ['b1', 'b9'] },
          c: { type: 'missing' },
        },
        order: ['a', 'c', 'z'],
      },
      schemas,
      'templates/index.json',
    );
    assert.ok(problems.some((problem) => problem.includes('"z"')), 'unknown id in order');
    assert.ok(problems.some((problem) => problem.includes('sections/missing.liquid')), 'missing section file');
    assert.ok(problems.some((problem) => problem.includes('"button"')), 'undeclared block type');
    assert.ok(problems.some((problem) => problem.includes('"b9"')), 'unknown block in block_order');
  });

  it('splits a template file name into type and alternate', () => {
    assert.deepEqual(templateName('templates/product.gift-card.json'), { type: 'product', suffix: 'gift-card' });
    assert.deepEqual(templateName('templates/index.json'), { type: 'index', suffix: null });
  });
});

describe('setting values', () => {
  it('checks colours, ranges and options against their definition', () => {
    assert.equal(settingProblem({ type: 'color', id: 'c', label: 'Colour' }, '#1A1A1A'), null);
    assert.match(String(settingProblem({ type: 'color', id: 'c', label: 'Colour' }, 'red')), /colour/);
    assert.match(String(settingProblem({ type: 'range', id: 'r', label: 'Width', min: 0, max: 10 }, 12)), /at most 10/);
    assert.match(String(settingProblem({ type: 'select', id: 's', label: 'Layout', options: [{ value: 'a', label: 'A' }] }, 'b')), /not one of/);
    assert.equal(settingProblem({ type: 'url', id: 'u', label: 'Link' }, '/collections/all'), null);
    assert.match(String(settingProblem({ type: 'url', id: 'u', label: 'Link' }, 'javascript:alert(1)')), /link/);
  });

  it('takes a media id or a URL for an image, and a handle for a collection', () => {
    assert.equal(settingProblem({ type: 'image_picker', id: 'i' }, 42), null);
    assert.equal(settingProblem({ type: 'collection', id: 'c' }, 'summer-sale'), null);
    assert.ok(settingProblem({ type: 'collection', id: 'c' }, 'Summer Sale!'));
  });

  it('lets any setting be cleared', () => {
    assert.equal(settingProblem({ type: 'color', id: 'c' }, null), null);
    assert.equal(settingProblem({ type: 'range', id: 'r', min: 1 }, ''), null);
  });
});

describe('theme files before they are saved', () => {
  const files = new Map([['sections/hero.liquid', { content: '<h1>hi</h1>{% schema %}{ "name": "Hero" }{% endschema %}' }]]);

  it('refuses Liquid that does not parse', () => {
    const problems = fileProblems('sections/broken.liquid', '{% if x %}open', files);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /sections\/broken.liquid/);
  });

  it('refuses a template that uses a section the theme does not have', () => {
    const problems = fileProblems('templates/index.json', JSON.stringify({ sections: { a: { type: 'nope' } }, order: ['a'] }), files);
    assert.ok(problems.some((problem) => problem.includes('nope')));
  });

  it('accepts a valid template', () => {
    assert.deepEqual(fileProblems('templates/index.json', JSON.stringify({ sections: { a: { type: 'hero' } }, order: ['a'] }), files), []);
  });

  it('insists settings_data.json has a current', () => {
    assert.equal(fileProblems('config/settings_data.json', '{"presets":{}}', files).length, 1);
    assert.deepEqual(fileProblems('config/settings_data.json', '{"current":"Default","presets":{"Default":{}}}', files), []);
  });
});

describe('theme zips', () => {
  it('round-trips files, compressed and stored', () => {
    const files = [
      { path: 'layout/theme.liquid', data: Buffer.from('<html>{{ content_for_layout }}</html>'.repeat(50)) },
      { path: 'assets/tiny.css', data: Buffer.from('a{}') },
    ];
    const back = readZip(createZip(files));
    assert.deepEqual(
      back.map((file) => [file.path, file.data.toString()]),
      files.map((file) => [file.path, file.data.toString()]),
    );
  });

  it('refuses what is not a zip, and zips that unpack too large', () => {
    assert.throws(() => readZip(Buffer.from('not a zip at all')), ZipError);
    const big = createZip([{ path: 'assets/big.txt', data: Buffer.alloc(2 * 1024 * 1024, 97) }]);
    assert.throws(() => readZip(big, { maxFiles: 10, maxTotalBytes: 1024 * 1024 }), /too large/);
  });
});

// ── the built-in themes ────────────────────────────────────────────────────

describe('the built-in themes', () => {
  const bundles = loadBundles({ fresh: true });

  it('are all there, each a complete theme', () => {
    assert.deepEqual(bundles.map((bundle) => bundle.manifest.handle).sort(), ['atelier', 'aurora', 'circuit', 'folio', 'gleam', 'harvest', 'hearth', 'lumen', 'stride']);
    for (const bundle of bundles) {
      for (const path of ['layout/theme.liquid', 'layout/password.liquid', 'config/settings_schema.json', 'config/settings_data.json', 'templates/index.json', 'templates/product.json', 'sections/header-group.json', 'locales/en.default.json']) {
        assert.ok(bundle.files.has(path), `${bundle.manifest.handle} has ${path}`);
      }
    }
  });

  it("carry their own defaults in settings_schema.json, and their styles in settings_data.json", () => {
    const atelier = bundles.find((bundle) => bundle.manifest.handle === 'atelier')!;
    const schema = JSON.parse(atelier.files.get('config/settings_schema.json')!) as { name: string; settings?: { id?: string; default?: unknown }[]; theme_name?: string }[];
    assert.equal(schema[0].name, 'theme_info');
    assert.equal(schema[0].theme_name, 'Atelier');
    const font = schema.flatMap((group) => group.settings ?? []).find((setting) => setting.id === 'font_heading');
    assert.equal(font?.default, 'Cormorant Garamond');
    const data = JSON.parse(atelier.files.get('config/settings_data.json')!) as { presets: Record<string, unknown> };
    assert.deepEqual(Object.keys(data.presets), ['Monochrome', 'Sand', 'Noir']);
  });

  it('have signature sections of their own', () => {
    const has = (handle: string, section: string) => bundles.find((bundle) => bundle.manifest.handle === handle)!.files.has(`sections/${section}.liquid`);
    assert.ok(has('lumen', 'ingredients-spotlight'));
    assert.ok(has('atelier', 'lookbook'));
    assert.ok(has('circuit', 'comparison-table'));
    assert.ok(!has('aurora', 'lookbook'), 'one theme’s signature section is not in the others');
  });

  it('pass the same checks a save through the code editor would', () => {
    for (const bundle of bundles) {
      const files = new Map([...bundle.files.entries()].map(([path, content]) => [path, { content }]));
      const problems = [...bundle.files.entries()].flatMap(([path, content]) => (path.endsWith('.liquid') || path.endsWith('.json') ? fileProblems(path, content, files) : []));
      assert.deepEqual(problems, [], bundle.manifest.handle);
    }
  });
});

// ── Liquid as Shopify themes write it ─────────────────────────────────────

describe('Liquid filters', () => {
  it('formats money from minor units in the shopper’s currency', async () => {
    assert.equal(await render('{{ 149900 | money }}'), '₹1,499.00');
    assert.equal(await render('{{ 149900 | money_with_currency }}'), '₹1,499.00 INR');
    assert.equal(await render('{{ 149900 | money_without_trailing_zeros }}'), '₹1,499');
    assert.equal(await render('{{ 1999 | money }}', {}, {}, { currency: 'USD', moneyLocale: 'en-US' }), '$19.99');
  });

  it('translates with interpolation and plural forms', async () => {
    assert.equal(await render("{{ 'products.product.add_to_cart' | t }}"), 'Add to cart');
    assert.equal(await render("{{ 'products.product.reviews' | t: count: 1 }}"), '1 review');
    assert.equal(await render("{{ 'products.product.reviews' | t: count: 4 }}"), '4 reviews');
    assert.match(await render("{{ 'nope.key' | t }}"), /translation missing/);
  });

  it('builds image URLs and responsive tags', async () => {
    assert.equal(await render("{{ image | image_url: width: 400 }}", { image: { src: '/media/a.jpg', alt: 'A' } }), '/media/a.jpg?width=400');
    const tag = await render("{{ image | image_url: width: 800 | image_tag: widths: '200, 400', loading: 'eager' }}", { image: { src: '/media/a.jpg', alt: 'A' } });
    assert.match(tag, /srcset="\/media\/a.jpg\?width=200 200w, \/media\/a.jpg\?width=400 400w"/);
    assert.match(tag, /loading="eager"/);
  });

  it('versions asset URLs by their content', async () => {
    const out = await render("{{ 'base.css' | asset_url }}", {}, { 'assets/base.css': 'body{}' });
    assert.match(out, /^\/cdn\/shop\/t\/test\/assets\/base\.css\?v=[0-9a-z]{10}$/);
  });

  it('handleizes the way Shopify does', async () => {
    assert.equal(await render("{{ 'Crème Brûlée & Co.' | handleize }}"), 'creme-brulee-co');
  });

  it('draws placeholders for images not chosen yet', async () => {
    assert.match(await render("{{ 'product-1' | placeholder_svg_tag: 'ph' }}"), /^<svg class="ph"/);
  });
});

describe('Liquid tags', () => {
  it('renders snippets from the theme', async () => {
    assert.equal(await render("{% render 'greet', name: 'Asha' %}", {}, { 'snippets/greet.liquid': 'Hello {{ name }}' }), 'Hello Asha');
  });

  it('writes a product form that posts to the cart', async () => {
    const html = await render("{% form 'product', product, class: 'f' %}<input name=\"id\" value=\"7\">{% endform %}", { product: { handle: 'serum' } });
    assert.match(html, /<form method="post" action="\/cart\/add"/);
    assert.match(html, /class="f"/);
    assert.match(html, /name="form_type" value="product"/);
    assert.match(html, /data-product-handle="serum"/);
  });

  it('shows a form’s result to the template', async () => {
    const html = await render("{% form 'contact' %}{% if form.posted_successfully %}thanks{% endif %}{% endform %}", {}, {}, { forms: { contact: { posted_successfully: true, errors: null } } });
    assert.match(html, /thanks/);
  });

  it('paginates a list and builds page links', async () => {
    const items = Array.from({ length: 25 }, (_unused, index) => index + 1);
    const html = await render('{% paginate list by 10 %}{{ list | join: "," }}|{{ paginate.pages }}|{{ paginate.next.url }}{% endpaginate %}', { list: items }, {}, { currentPage: 2, requestQuery: new URLSearchParams('sort_by=price-ascending&page=2') });
    assert.equal(html, '11,12,13,14,15,16,17,18,19,20|3|/collections/all?sort_by=price-ascending&page=3');
  });

  it('keeps {% schema %} out of the page and puts {% style %} in it', async () => {
    assert.equal(await render('a{% schema %}{"name":"x"}{% endschema %}b'), 'ab');
    assert.equal(await render('{% style %}.x{color:{{ c }}}{% endstyle %}', { c: 'red' }), '<style data-veylog>.x{color:red}</style>');
  });

  it('sets the layout from a Liquid template', async () => {
    const theme = themeOf({ 'templates/page.liquid': "{% layout 'password' %}x" });
    const env = envFor(theme);
    const { engine, parse } = engineFor(theme);
    await engine.render(parse('templates/page.liquid'), {}, { globals: { __env: env } });
    assert.equal(env.state.layout, 'password');
  });
});
