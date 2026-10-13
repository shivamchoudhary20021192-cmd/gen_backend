/**
 * Products (new) end to end, against a running server:
 *
 *   BASE_URL=http://localhost:4100 SMOKE_SHOP=veylor npx tsx scripts/smoke-catalog.ts
 *
 * Signs in as SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD. Creates a field, a
 * metaobject type, products and moves one classic product — run it on a
 * scratch database, not on a store anyone uses.
 */
import 'dotenv/config';
import http from 'node:http';

export {};

const BASE = (process.env.BASE_URL ?? 'http://localhost:4100').replace(/\/$/, '');
const SHOP = process.env.SMOKE_SHOP ?? 'veylor';
const run = Date.now().toString(36);

let failures = 0;
function check(label: string, condition: unknown, detail?: unknown): void {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : `\n      ${JSON.stringify(detail).slice(0, 600)}`}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
let token = '';

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Any }> {
  const response = await fetch(`${BASE}/admin/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Veylog-Shop-Domain': SHOP,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method === 'POST' ? { 'Idempotency-Key': `${run}-${Math.random()}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

/** A storefront page by the shop's own host (Node's fetch drops a Host header). */
function storePage(path: string): Promise<{ status: number; body: string }> {
  const url = new URL(BASE);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, path, headers: { Host: `${SHOP}.localhost:${url.port}`, 'cf-ipcountry': 'SG' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function main() {
  console.log(`Products (new) smoke — ${BASE}, shop ${SHOP}`);
  const login = await call('POST', '/auth/login', { email: process.env.SUPERADMIN_EMAIL, password: process.env.SUPERADMIN_PASSWORD });
  token = login.body.access_token;
  if (!token) throw new Error(`Sign-in failed (${login.status})`);

  console.log('\n1. Lookups');
  const types = await call('GET', '/catalog/field-types');
  check('the field types are listed (text, numbers, references, lists…)', types.status === 200 && JSON.stringify(types.body).includes('metaobject_reference'), types.status);
  const roots = await call('GET', '/catalog/taxonomy');
  const search = await call('GET', '/catalog/taxonomy?q=serum');
  check('the standard categories: a top level, and search by name', roots.body.categories?.length > 10 && search.body.categories?.some((c: Any) => c.code.endsWith('/serums')), [roots.body.categories?.length, search.body]);
  const blank = await call('GET', '/catalog/products/new');
  check('"Add product" gets the fields and the stock locations', blank.status === 200 && Array.isArray(blank.body.fields?.product) && blank.body.locations?.length > 0, blank.body);
  const location = blank.body.locations?.[0]?.id;

  const cleanup: (() => Promise<unknown>)[] = [];
  try {
    await steps(location, cleanup);
  } finally {
    console.log('\n8. Clean up');
    for (const undo of cleanup.reverse()) await undo();
  }
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exitCode = failures ? 1 : 0;
}

async function steps(location: number, cleanup: (() => Promise<unknown>)[]) {
  console.log('\n2. Custom data');
  const fabricType = await call('POST', '/catalog/metaobject-definitions', {
    definition: { type: `fabric-${run}`, name: 'Fabric', display_name_key: 'name', fields: [{ key: 'name', name: 'Name', type: 'single_line_text_field', required: true }, { key: 'gsm', name: 'GSM', type: 'number_integer' }] },
  });
  check('a metaobject type "Fabric" is made', fabricType.status === 201, fabricType.body);
  if (fabricType.body.definition?.id) cleanup.push(() => call('DELETE', `/catalog/metaobject-definitions/${fabricType.body.definition.id}`));
  const linen = await call('POST', `/catalog/metaobjects/fabric-${run}`, { entry: { fields: { name: 'Linen', gsm: 180 } } });
  check('with an entry "Linen"', linen.status === 201 && linen.body.entry?.display_name === 'Linen', linen.body);
  const badEntry = await call('POST', `/catalog/metaobjects/fabric-${run}`, { entry: { fields: { gsm: 'heavy' } } });
  check('an entry without its required name, or with words for a number, is refused', badEntry.status === 422, badEntry.body);

  const material = await call('POST', '/catalog/definitions', {
    definition: { owner_type: 'product', name: 'Material', key: `material_${run}`, type: 'single_line_text_field', validations: { choices: ['Cotton', 'Linen', 'Wool'] }, filterable: true, pinned: true },
  });
  const fabricRef = await call('POST', '/catalog/definitions', {
    definition: { owner_type: 'product', name: 'Fabric', key: `fabric_${run}`, type: 'metaobject_reference', validations: { metaobject_type: `fabric-${run}` } },
  });
  const careList = await call('POST', '/catalog/definitions', { definition: { owner_type: 'product', name: 'Care', key: `care_${run}`, type: 'list.single_line_text_field' } });
  const privateNote = await call('POST', '/catalog/definitions', { definition: { owner_type: 'product', name: 'Supplier note', key: `supplier_${run}`, type: 'single_line_text_field', storefront: false } });
  check('fields: a dropdown (text with choices), a metaobject reference and a list', material.status === 201 && fabricRef.status === 201 && careList.status === 201, [material.body, fabricRef.body, careList.body]);
  for (const def of [material, fabricRef, careList, privateNote]) if (def.body.definition?.id) cleanup.push(() => call('DELETE', `/catalog/definitions/${def.body.definition.id}`));
  const ns = material.body.definition?.namespace ?? 'custom';

  console.log('\n3. A product with options and variants');
  const handle = `smoke-tee-${run}`;
  const created = await call('POST', '/catalog/products', {
    product: {
      title: `Smoke tee ${run}`,
      handle,
      status: 'active',
      vendor: 'Smoke Co',
      product_type: 'T-shirt',
      category_code: 'apparel-accessories/clothing/shirts-tops',
      description_html: '<p>Soft.</p><script>alert(1)</script>',
      tags: ['summer', 'Summer', 'basics'],
      options: [
        { name: 'Size', values: [{ name: 'S' }, { name: 'M' }] },
        { name: 'Colour', values: [{ name: 'Red', swatch_color: '#ff0000' }, { name: 'Blue', swatch_color: '#0000ff' }] },
      ],
      variants: [
        { option_values: ['S', 'Red'], price: 499, compare_at_price: 699, inventory: [{ location_id: location, on_hand: 5 }] },
        { option_values: ['S', 'Blue'], price: 499 },
        { option_values: ['M', 'Red'], price: 549, unit_price: { quantity: 250, quantity_unit: 'g', reference: 100, reference_unit: 'g' } },
        { option_values: ['M', 'Blue'], price: 549, sku: `SMK-${run}-MB` },
      ],
      metafields: [
        { namespace: ns, key: `material_${run}`, value: 'Linen' },
        { namespace: ns, key: `fabric_${run}`, value: linen.body.entry?.id },
        { namespace: ns, key: `care_${run}`, value: ['Cold wash', 'Line dry'] },
        { namespace: ns, key: `supplier_${run}`, value: 'Buy from Vendor X only' },
      ],
    },
  });
  const product = created.body.product;
  check('created with 4 variants, SKUs filled in, tags de-duplicated', created.status === 201 && product?.variants?.length === 4 && product.variants.every((v: Any) => v.sku) && product.tags.length === 2, created.body);
  check('the description lost its script', product && !product.description_html.includes('<script'), product?.description_html);
  check('the swatches display as swatches', product?.options?.[1]?.display_style === 'swatches', product?.options);
  check('stock set in the editor is on hand', product?.variants?.[0]?.inventory?.on_hand === 5, product?.variants?.[0]?.inventory);
  check('custom fields saved and read back typed', product?.metafields?.length === 4 && product.metafields.some((m: Any) => Array.isArray(m.value)), product?.metafields);
  if (!product) throw new Error('Cannot continue without the product');
  cleanup.push(async () => {
    const removed = await call('DELETE', `/catalog/products/${product.id}`);
    const gone = await call('GET', `/products/${product.id}`);
    check('deleting removes it from both', removed.status === 204 && gone.status === 404, [removed.status, gone.status]);
  });

  const badChoice = await call('PATCH', `/catalog/products/${product.id}`, { product: { version: product.version, metafields: [{ namespace: ns, key: `material_${run}`, value: 'Plastic' }] } });
  check('a value outside the dropdown\'s choices is refused, under the field', badChoice.status === 422 && JSON.stringify(badChoice.body).includes('metafields'), badChoice.body);

  console.log('\n3b. On the storefront');
  const shopper = await fetch(`${BASE}/api/v1/products/${handle}`, { headers: { 'X-Veylog-Shop-Domain': SHOP } }).then((r) => r.json() as Promise<Any>);
  const fields: Any[] = shopper.product?.custom_fields ?? [];
  const byKey = (key: string) => fields.find((field) => field.key === key);
  check('the storefront API lists the public custom fields, in order', fields.length === 3, fields.map((field) => field.key));
  check('a dropdown value reads as its text', byKey(`material_${run}`)?.text === 'Linen', byKey(`material_${run}`));
  check('a metaobject reference comes back as the entry, with its fields', byKey(`fabric_${run}`)?.value?.display_name === 'Linen' && byKey(`fabric_${run}`)?.value?.fields?.gsm?.value === 180, byKey(`fabric_${run}`));
  check('a list reads as a list and as text', Array.isArray(byKey(`care_${run}`)?.value) && byKey(`care_${run}`)?.text === 'Cold wash, Line dry', byKey(`care_${run}`));
  check('a field not readable by the storefront is left out', !byKey(`supplier_${run}`), fields.map((field) => field.key));
  // A store whose product template was customised keeps it on a theme update,
  // so the "Custom fields" block is added the way a merchant would, in the editor.
  const themes = await call('GET', '/themes');
  const live = (themes.body.themes ?? []).find((theme: Any) => theme.role === 'main');
  if (live) {
    const file = (await call('GET', `/themes/${live.id}/files/content?path=${encodeURIComponent('templates/product.json')}`)).body.file;
    const template = file?.content ? JSON.parse(file.content) : null;
    const main: Any = template && Object.values(template.sections).find((section: Any) => section.type === 'main-product');
    if (main && !Object.values(main.blocks).some((block: Any) => block.type === 'custom_fields')) {
      main.blocks.custom_fields = { type: 'custom_fields', settings: { heading: 'Product details', open: true } };
      main.block_order.push('custom_fields');
      const saved = await call('PUT', `/themes/${live.id}/files`, { path: 'templates/product.json', content: JSON.stringify(template, null, 2), checksum: file.checksum ?? null });
      check('the block is added to the live theme\'s product template', saved.status === 200, saved.body);
    }
  }
  const page = await storePage(`/products/${handle}`);
  if (page.status === 200) {
    check('the product page shows them in its "Product details" block', page.body.includes('Product details') && page.body.includes('Cold wash, Line dry') && page.body.includes('Linen'), page.body.length);
    check('and never the private one', !page.body.includes('Buy from Vendor X only'));
  } else console.log(`  (product page not checked: the store answered ${page.status} — is a theme installed?)`);

  console.log('\n4. The classic twin');
  const twin = await call('GET', `/products/${product.id}`);
  check('the classic API sees the same product (same id) with its 4 variants', twin.status === 200 && twin.body.product?.variants?.length === 4, twin.body.product?.variants?.length ?? twin.body);
  check('and knows Products (new) owns it', twin.body.product?.catalog_managed === true, twin.body.product?.catalog_managed);
  const classicEdit = await call('PATCH', `/products/${product.id}`, { product: { name: 'Hijacked' } });
  check('the classic editor may not change it (409 CATALOG_MANAGED)', classicEdit.status === 409 && classicEdit.body.error?.code === 'CATALOG_MANAGED', classicEdit.body);

  console.log('\n5. Editing keeps ids');
  const ids = product.variants.map((v: Any) => v.id);
  const colour = product.options[1];
  const renamed = await call('PATCH', `/catalog/products/${product.id}`, {
    product: {
      version: product.version,
      options: [
        product.options[0],
        { id: colour.id, name: 'Color', values: colour.values.map((v: Any) => (v.name === 'Red' ? { ...v, name: 'Crimson' } : v)) },
      ],
      variants: product.variants.map((v: Any) => ({ id: v.id, option_values: v.option_values.map((x: string) => (x === 'Red' ? 'Crimson' : x)) })),
    },
  });
  const after = renamed.body.product;
  check('renaming Colour→Color and Red→Crimson keeps every variant id', renamed.status === 200 && JSON.stringify(after?.variants?.map((v: Any) => v.id)) === JSON.stringify(ids), renamed.body);
  check('and the titles follow ("S / Crimson")', after?.variants?.[0]?.title === 'S / Crimson', after?.variants?.[0]?.title);

  const stale = await call('PATCH', `/catalog/products/${product.id}`, { product: { version: product.version, title: 'Stale' } });
  check('a save from an older copy is refused (409 VERSION_CONFLICT)', stale.status === 409 && stale.body.error?.code === 'VERSION_CONFLICT', stale.body);

  const dropBlue = await call('PATCH', `/catalog/products/${product.id}`, {
    product: {
      version: after.version,
      options: after.options.map((o: Any) => ({ ...o, values: o.values.filter((v: Any) => v.name !== 'Blue') })),
      variants: after.variants.filter((v: Any) => !v.option_values.includes('Blue')).map((v: Any) => ({ id: v.id, option_values: v.option_values })),
    },
  });
  check('removing Blue retires its two variants', dropBlue.status === 200 && dropBlue.body.product?.variants?.length === 2, dropBlue.body);
  const twinAfter = await call('GET', `/products/${product.id}`);
  check('and the classic twin follows', twinAfter.body.product?.variants?.length === 2, twinAfter.body.product?.variants?.length);

  const priced = await call('PATCH', `/catalog/products/${product.id}/variants`, { version: dropBlue.body.product?.version, variants: [{ id: ids[0], price: 399 }] });
  check('one variant\'s price changes without resending the product', priced.status === 200 && priced.body.product?.variants?.[0]?.price === 399, priced.body);

  console.log('\n6. List, duplicate, bulk');
  const list = await call('GET', `/catalog/products?q=${encodeURIComponent(`Smoke tee ${run}`)}`);
  check('search finds it, with status counts', list.body.products?.some((p: Any) => p.id === product.id) && typeof list.body.counts?.all === 'number', list.body);
  const bySku = await call('GET', `/catalog/products?q=SMK-${run}`);
  check('search by SKU prefix', bySku.body.products?.length === 0 || bySku.body.products?.some((p: Any) => p.id === product.id), bySku.body.products?.length);
  const copy = await call('POST', `/catalog/products/${product.id}/duplicate`, {});
  if (copy.body.product?.id) cleanup.push(() => call('DELETE', `/catalog/products/${copy.body.product.id}`));
  check('Duplicate makes a draft copy with new SKUs', copy.status === 201 && copy.body.product?.status === 'draft' && copy.body.product.variants[0].sku !== priced.body.product?.variants?.[0]?.sku, copy.body);
  const bulk = await call('POST', '/catalog/products/bulk', { ids: [product.id, copy.body.product?.id, 999999999], action: 'add_tags', tags: ['sale'] });
  check('bulk tagging does the two, reports the missing one', bulk.body.done?.length === 2 && bulk.body.failed?.length === 1, bulk.body);

  console.log('\n7. Moving a classic product');
  const candidates = await call('GET', '/catalog/classic?limit=200');
  check('the classic products not yet moved are listed', candidates.status === 200 && typeof candidates.body.remaining === 'number', candidates.body.remaining);
  const pick = candidates.body.products?.find((p: Any) => p.variant_count > 1) ?? candidates.body.products?.[0];
  if (pick) {
    const before = (await call('GET', `/products/${pick.id}`)).body.product;
    const moved = await call('POST', '/catalog/classic/adopt', { ids: [pick.id] });
    check(`"${pick.title}" moves`, moved.body.done?.includes(pick.id), moved.body);
    if (moved.body.done?.includes(pick.id)) {
      const now = (await call('GET', `/catalog/products/${pick.id}`)).body.product;
      const beforeIds = before.variants.map((v: Any) => v.id).sort();
      const nowIds = now.variants.map((v: Any) => v.id).sort();
      check('same product id and variant ids (orders, stock, reviews stay attached)', now.id === pick.id && JSON.stringify(beforeIds) === JSON.stringify(nowIds), [beforeIds, nowIds]);
      const classicAfter = (await call('GET', `/products/${pick.id}`)).body.product;
      const prices = (p: Any) => p.variants.map((v: Any) => [v.id, Number(v.price), Number(v.mrp), v.sku]).sort();
      check('prices, MRP and SKUs on the classic side are unchanged', JSON.stringify(prices(before)) === JSON.stringify(prices(classicAfter)), [prices(before), prices(classicAfter)]);
      check('the beauty columns Products (new) does not own are kept', JSON.stringify(before.full_inci ?? null) === JSON.stringify(classicAfter.full_inci ?? null), null);
      const twice = await call('POST', '/catalog/classic/adopt', { ids: [pick.id] });
      check('moving it again is refused', twice.body.failed?.length === 1, twice.body);
    }
  } else console.log('  (no classic products to move)');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
