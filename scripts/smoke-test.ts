/**
 * End-to-end smoke test against a running server.
 *
 *   npm run dev          # in one shell
 *   npm run smoke        # in another
 *
 * Exercises the whole admin flow the way the portal will: sign in, create a
 * staff account, prove RBAC denies what it should, upload an image, build a
 * Shopify-shaped product, gate its publish, then variants, collections and
 * bulk actions. Exits non-zero on the first failure.
 */
import sharp from 'sharp';
import { env } from '../src/config/env';
import { closePool, execute } from '../src/db/pool';

const BASE = `http://127.0.0.1:${env.port}${env.apiPrefix}`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failed += 1;
    failures.push(label);
    process.stdout.write(`  ✗ ${label}\n`);
    if (detail !== undefined) {
      process.stdout.write(`      ${JSON.stringify(detail).slice(0, 500)}\n`);
    }
  }
}

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
  raw?: BodyInit;
}

async function call(path: string, options: CallOptions = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body: BodyInit | undefined = options.raw;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${BASE}${path}`, { method: options.method ?? 'GET', headers, body });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

async function main(): Promise<void> {
  process.stdout.write('\nVeylog Admin API — smoke test\n');

  // The login limiter is deliberately strict (10 per email per 15 min), which
  // would make the second consecutive run of this suite fail on a 429. Clearing
  // our own buckets keeps the test repeatable without weakening the limiter —
  // and the limiter itself is asserted at the end of the run.
  await execute("DELETE FROM rate_limits WHERE bucket_key LIKE 'admin.%'");

  // ── health ────────────────────────────────────────────────────────────────
  section('Health');
  const health: any = await fetch(`http://127.0.0.1:${env.port}/health`).then((r) => r.json());
  ok('GET /health reports ok', health.status === 'ok' && health.database === 'connected', health);

  // ── auth ──────────────────────────────────────────────────────────────────
  section('Authentication');
  const badLogin = await call('/auth/login', {
    method: 'POST',
    body: { email: env.superAdmin.email, password: 'definitely-wrong-password' },
  });
  ok('wrong password → 401 INVALID_CREDENTIALS', badLogin.status === 401, badLogin.body);

  const unknownUser = await call('/auth/login', {
    method: 'POST',
    body: { email: 'nobody@example.com', password: 'Whatever12345' },
  });
  ok('unknown email → same 401 (no user enumeration)', unknownUser.status === 401 && unknownUser.body?.error?.code === badLogin.body?.error?.code);

  const badShape = await call('/auth/login', { method: 'POST', body: { email: 'not-an-email' } });
  ok('malformed body → 422 with field errors', badShape.status === 422 && Boolean(badShape.body?.error?.details?.email), badShape.body);

  const login = await call('/auth/login', {
    method: 'POST',
    body: { email: env.superAdmin.email, password: env.superAdmin.password },
  });
  ok('super admin logs in', login.status === 200 && Boolean(login.body?.access_token), login.body);
  const token: string = login.body?.access_token;
  const refreshToken: string = login.body?.refresh_token;
  ok('super admin gets wildcard permissions', login.body?.permissions?.[0] === '*');

  const noAuth = await call('/products');
  ok('no token → 401', noAuth.status === 401);

  const badToken = await call('/products', { token: 'garbage.token.here' });
  ok('invalid token → 401', badToken.status === 401);

  const me = await call('/auth/me', { token });
  ok('GET /auth/me returns the account', me.body?.admin?.email === env.superAdmin.email, me.body);

  // ── refresh rotation ──────────────────────────────────────────────────────
  section('Refresh token rotation');
  const refreshed = await call('/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } });
  ok('refresh issues a new pair', refreshed.status === 200 && refreshed.body.refresh_token !== refreshToken);
  const replay = await call('/auth/refresh', { method: 'POST', body: { refresh_token: refreshToken } });
  ok('replaying the old refresh token → 401', replay.status === 401, replay.body);

  // ── RBAC ──────────────────────────────────────────────────────────────────
  section('Admin users and RBAC');
  const roles = await call('/roles', { token });
  ok('roles are seeded', Array.isArray(roles.body?.roles) && roles.body.roles.length >= 6, roles.body);
  const contentRole = roles.body.roles.find((r: any) => r.slug === 'content');
  ok('content role exists with permissions', Boolean(contentRole) && contentRole.permission_count > 0);

  const permissions = await call('/permissions', { token });
  ok('permissions are grouped by module', Boolean(permissions.body?.permissions?.products), permissions.body);

  const staffEmail = `content.${Date.now()}@veylor.test`;
  const staffPassword = 'ContentTeam2026!';
  const createStaff = await call('/admin-users', {
    method: 'POST',
    token,
    body: {
      admin_user: {
        email: staffEmail,
        password: staffPassword,
        first_name: 'Content',
        last_name: 'Editor',
        role_ids: [contentRole.id],
        must_change_password: false,
      },
    },
  });
  ok('super admin creates a staff account', createStaff.status === 201, createStaff.body);
  const staffId = createStaff.body?.admin_user?.id;
  ok('new account carries its role', createStaff.body?.admin_user?.roles?.[0]?.slug === 'content');

  const dupEmail = await call('/admin-users', {
    method: 'POST',
    token,
    body: { admin_user: { email: staffEmail, password: staffPassword, first_name: 'Dup', role_ids: [contentRole.id] } },
  });
  ok('duplicate email → 409 EMAIL_TAKEN', dupEmail.status === 409 && dupEmail.body?.error?.code === 'EMAIL_TAKEN', dupEmail.body);

  const staffLogin = await call('/auth/login', { method: 'POST', body: { email: staffEmail, password: staffPassword } });
  ok('staff account can sign in', staffLogin.status === 200, staffLogin.body);
  const staffToken: string = staffLogin.body?.access_token;
  ok('staff permissions exclude products.create', !staffLogin.body?.permissions?.includes('products.create'));

  const staffCreatesProduct = await call('/products', {
    method: 'POST',
    token: staffToken,
    body: { product: { name: 'Should not exist', variants: [{ sku: 'NOPE-1', mrp: 100, price: 90 }] } },
  });
  ok('content role blocked from creating products → 403', staffCreatesProduct.status === 403, staffCreatesProduct.body);

  const staffMakesSuperAdmin = await call('/admin-users', {
    method: 'POST',
    token: staffToken,
    body: { admin_user: { email: 'x@y.test', password: 'Password12345', first_name: 'X', is_super_admin: true } },
  });
  ok('content role cannot mint a super admin → 403', staffMakesSuperAdmin.status === 403);

  const staffReadsMedia = await call('/media', { token: staffToken });
  ok('content role CAN read the media library → 200', staffReadsMedia.status === 200);

  // ── media ─────────────────────────────────────────────────────────────────
  section('Media library');
  // Randomised colour so every run produces a distinct checksum: otherwise the
  // second run would dedupe against the first run's row and never exercise the
  // upload + variant pipeline at all.
  const png = await sharp({
    create: {
      width: 1400,
      height: 1750,
      channels: 3,
      background: {
        r: Math.floor(Math.random() * 256),
        g: Math.floor(Math.random() * 256),
        b: Math.floor(Math.random() * 256),
      },
    },
  })
    .png()
    .toBuffer();

  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'serum-pack-front.png');
  form.append('alt_text', 'Veylor brightening serum, front of pack');

  const uploadRes = await fetch(`${BASE}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const uploaded: any = await uploadRes.json();
  ok('image uploads', uploadRes.status === 201 && uploaded.media?.length === 1, uploaded);
  const mediaId: number = uploaded.media?.[0]?.id;
  ok('dimensions were read from the file', uploaded.media?.[0]?.width === 1400 && uploaded.media?.[0]?.height === 1750);
  ok('LQIP placeholder generated', (uploaded.media?.[0]?.placeholder ?? '').startsWith('data:image/webp;base64,'));
  ok('dominant colour extracted', /^#[0-9a-f]{6}$/.test(uploaded.media?.[0]?.dominant_color ?? ''));

  // dedupe: same bytes again
  const form2 = new FormData();
  form2.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'same-file-again.png');
  const dedupeRes = await fetch(`${BASE}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form2,
  });
  const dedupe: any = await dedupeRes.json();
  ok('identical bytes are deduplicated to the same row', typeof mediaId === 'number' && dedupe.media?.[0]?.id === mediaId, dedupe.media?.[0]);

  // wait for variant generation (runs after the response)
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const mediaDetail = await call(`/media/${mediaId}`, { token });
  ok('variants generated (webp + avif)', (mediaDetail.body?.media?.variants?.length ?? 0) >= 4, {
    count: mediaDetail.body?.media?.variants?.length,
  });
  ok('media reaches status=ready', mediaDetail.body?.media?.status === 'ready', mediaDetail.body?.media?.status);

  const fileUrl = mediaDetail.body?.media?.url;
  const fileRes = await fetch(`http://127.0.0.1:${env.port}${fileUrl}`);
  ok('uploaded file is served over HTTP', fileRes.status === 200 && Boolean(fileRes.headers.get('cache-control')?.includes('immutable')));

  const traversal = await fetch(`http://127.0.0.1:${env.port}/media/../../../etc/passwd`);
  ok('path traversal is refused', traversal.status === 400 || traversal.status === 404, traversal.status);

  // ── categories ────────────────────────────────────────────────────────────
  section('Categories');
  const cat = await call('/categories', {
    method: 'POST',
    token,
    body: { category: { name: `Serums ${Date.now()}`, short_description: 'High-concentration actives.' } },
  });
  ok('category created', cat.status === 201, cat.body);
  const categoryId: number = cat.body?.category?.id;

  const child = await call('/categories', {
    method: 'POST',
    token,
    body: { category: { name: 'Brightening Serums', parent_id: categoryId } },
  });
  ok('child category inherits a nested path', child.body?.category?.path?.includes('/'), child.body?.category?.path);
  ok('child depth is 1', child.body?.category?.depth === 1);

  const cycle = await call(`/categories/${child.body.category.id}`, {
    method: 'PATCH',
    token,
    body: { category: { parent_id: child.body.category.id } },
  });
  ok('a category cannot be its own parent → 422', cycle.status === 422, cycle.body);

  const tree = await call('/categories?tree=true', { token });
  ok('tree view nests children', Array.isArray(tree.body?.categories), tree.body?.categories?.length);

  // ── products ──────────────────────────────────────────────────────────────
  section('Products');
  const skuBase = `VEY-${Date.now().toString(36).toUpperCase()}`;

  const badProduct = await call('/products', {
    method: 'POST',
    token,
    body: { product: { name: 'No variants', variants: [] } },
  });
  ok('product without variants → 422', badProduct.status === 422, badProduct.body?.error?.details);

  const badPrice = await call('/products', {
    method: 'POST',
    token,
    body: { product: { name: 'Bad price', variants: [{ sku: `${skuBase}-X`, mrp: 100, price: 200 }] } },
  });
  ok('price above MRP → 422', badPrice.status === 422, badPrice.body?.error?.details);

  const created = await call('/products', {
    method: 'POST',
    token,
    headers: { 'Idempotency-Key': `smoke-${skuBase}` },
    body: {
      product: {
        name: 'Rhodo Cica 5D Bright Serum',
        subtitle: '5-dimensional brightening with Rhodiola & Centella',
        category_id: categoryId,
        status: 'draft',
        short_description: 'Brightening serum with 10% Niacinamide and Tranexamic Acid.',
        description: '<p>Two years of formulation work.</p>',
        texture: 'Lightweight, water-thin serum.',
        scent: 'Fragrance-free',
        manufacturer_name: 'Veylor Labs Pvt Ltd',
        country_of_origin: 'India',
        shelf_life_months: 24,
        pao_months: 6,
        options: [{ name: 'Size', values: ['30ml', '50ml'] }],
        variants: [
          {
            sku: `${skuBase}-30`,
            variant_title: '30ml',
            net_quantity: '30 ml',
            volume_ml: 30,
            weight_grams: 120,
            mrp: 799,
            price: 699,
            is_default: true,
            inventory_quantity: 120,
            option_values: ['30ml'],
          },
          {
            sku: `${skuBase}-50`,
            variant_title: '50ml',
            net_quantity: '50 ml',
            volume_ml: 50,
            weight_grams: 180,
            mrp: 1199,
            price: 1049,
            inventory_quantity: 40,
            option_values: ['50ml'],
          },
        ],
        images: [{ media_id: mediaId, alt: 'Serum, front of pack', is_primary: true }],
        benefits: [
          { benefit: 'Visibly reduces dark spots in 28 days', benefit_kind: 'long_term' },
          { benefit: 'Absorbs in under 30 seconds', benefit_kind: 'immediate' },
        ],
        usage_steps: [
          { instruction: 'Apply to clean, dry skin.', time_of_day: 'BOTH', amount: '3-4 drops' },
          { instruction: 'Follow with moisturiser.', time_of_day: 'BOTH' },
        ],
        tags: ['brightening', 'niacinamide'],
        seo: { meta_title: 'Rhodo Cica 5D Bright Serum | Veylor', meta_description: 'Brightening serum for uneven tone.' },
      },
    },
  });
  ok('product created with full graph', created.status === 201, created.body?.error ?? created.status);
  const productId: number = created.body?.product?.id;
  ok('two variants persisted', created.body?.product?.variants?.length === 2);
  ok('option values linked', created.body?.product?.options?.[0]?.values?.length === 2, created.body?.product?.options);
  ok('image attached with a resolvable URL', created.body?.product?.images?.[0]?.url?.startsWith('/media/'));
  ok('inventory initialised on the default variant', created.body?.product?.variants?.[0]?.inventory_quantity === 120);
  ok('price band derived across variants', created.body?.product?.min_price === 699 && created.body?.product?.max_price === 1049);
  ok('in_stock derived from inventory', created.body?.product?.in_stock === true);
  ok('discount percent computed', created.body?.product?.variants?.[0]?.discount_percent === 13);
  ok('benefits and usage steps saved', created.body?.product?.benefits?.length === 2 && created.body?.product?.usage_steps?.length === 2);
  ok('SEO row saved', created.body?.product?.seo?.meta_title?.includes('Veylor'));
  ok('tags saved', created.body?.product?.tags?.includes('brightening'));

  // ── an option value keeps its id across saves ──────────────────────────────
  //
  // Options used to be deleted and reinserted on every save, so every shade got
  // a new id each time. A shade's photographs live in `media_attachments` under
  // `attachable_id` — polymorphic, no foreign key — so nothing cascaded and
  // nothing complained: the rows just stopped matching any shade and the
  // photographs disappeared off the product. A story block tied to a shade lost
  // its link the same way, via ON DELETE SET NULL. Both were silent.
  const shadeBefore = created.body?.product?.options?.[0]?.values?.[0]?.id;
  const optionBefore = created.body?.product?.options?.[0]?.id;

  const resaved = await call(`/products/${productId}`, {
    method: 'PATCH',
    token,
    body: {
      product: {
        name: created.body.product.name,
        options: [{ name: 'Size', values: ['30ml', '50ml'] }],
      },
    },
  });
  ok('re-saving a product succeeds', resaved.status === 200, resaved.body?.error);

  const afterSave = await call(`/products/${productId}`, { token });
  ok(
    'an option value keeps its id across a save',
    afterSave.body?.product?.options?.[0]?.values?.[0]?.id === shadeBefore,
    `${shadeBefore} → ${afterSave.body?.product?.options?.[0]?.values?.[0]?.id}`,
  );
  ok(
    'and so does the option itself',
    afterSave.body?.product?.options?.[0]?.id === optionBefore,
    `${optionBefore} → ${afterSave.body?.product?.options?.[0]?.id}`,
  );
  ok(
    'a value dropped from the payload is removed',
    (
      await call(`/products/${productId}`, {
        method: 'PATCH',
        token,
        body: { product: { options: [{ name: 'Size', values: ['30ml'] }] } },
      })
    ).body?.product?.options?.[0]?.values?.length === 1,
  );
  // Put it back so the assertions below still see the shape they expect.
  await call(`/products/${productId}`, {
    method: 'PATCH',
    token,
    body: { product: { options: [{ name: 'Size', values: ['30ml', '50ml'] }] } },
  });

  const replayCreate = await call('/products', {
    method: 'POST',
    token,
    headers: { 'Idempotency-Key': `smoke-${skuBase}` },
    body: { product: { name: 'Should be replayed', variants: [{ sku: `${skuBase}-ZZ`, mrp: 10, price: 10 }] } },
  });
  ok('Idempotency-Key replays the first response', replayCreate.body?.product?.id === productId, replayCreate.body?.product?.id);

  const dupSku = await call('/products', {
    method: 'POST',
    token,
    body: { product: { name: 'Duplicate SKU', variants: [{ sku: `${skuBase}-30`, mrp: 100, price: 90 }] } },
  });
  ok('duplicate SKU → 409 SKU_TAKEN', dupSku.status === 409 && dupSku.body?.error?.code === 'SKU_TAKEN', dupSku.body);

  const badRef = await call('/products', {
    method: 'POST',
    token,
    body: {
      product: {
        name: 'Bad reference',
        concern_ids: [999999],
        variants: [{ sku: `${skuBase}-BR`, mrp: 100, price: 90 }],
      },
    },
  });
  ok('unknown concern id → 422 before hitting the FK', badRef.status === 422, badRef.body?.error?.details);

  // ── publish gate ──────────────────────────────────────────────────────────
  section('Publish gate');
  const publishBlocked = await call(`/products/${productId}/publish`, { method: 'POST', token });
  ok('publish blocked while full INCI is missing → 422', publishBlocked.status === 422, publishBlocked.body?.error?.details);

  const addInci = await call(`/products/${productId}`, {
    method: 'PATCH',
    token,
    body: { product: { full_inci: 'Aqua, Niacinamide (10%), Tranexamic Acid (3%), Phenoxyethanol.' } },
  });
  ok('INCI added via PATCH', addInci.status === 200 && Boolean(addInci.body?.product?.full_inci));

  const published = await call(`/products/${productId}/publish`, { method: 'POST', token });
  ok('publish succeeds once compliance fields are present', published.body?.product?.status === 'active', published.body?.error);
  ok('published_at stamped', Boolean(published.body?.product?.published_at));

  // ── variants ──────────────────────────────────────────────────────────────
  section('Variants');
  const addVariant = await call(`/products/${productId}/variants`, {
    method: 'POST',
    token,
    body: {
      variant: { sku: `${skuBase}-100`, variant_title: '100ml', mrp: 1999, price: 1799, inventory_quantity: 10 },
    },
  });
  ok('variant added', addVariant.status === 201 && addVariant.body?.variants?.length === 3, addVariant.body?.error);

  const variantId = addVariant.body.variants.find((v: any) => v.sku === `${skuBase}-100`).id;
  const updateVariant = await call(`/products/${productId}/variants/${variantId}`, {
    method: 'PATCH',
    token,
    body: { variant: { price: 1699, inventory_quantity: 25 } },
  });
  const updated = updateVariant.body?.variants?.find((v: any) => v.id === variantId);
  ok('variant price updated', updated?.price === 1699, updateVariant.body?.error);
  ok('inventory adjustment applied', updated?.inventory_quantity === 25);

  const badVariantPrice = await call(`/products/${productId}/variants/${variantId}`, {
    method: 'PATCH',
    token,
    body: { variant: { price: 99999 } },
  });
  ok('variant price above MRP → 422', badVariantPrice.status === 422);

  const delVariant = await call(`/products/${productId}/variants/${variantId}`, { method: 'DELETE', token });
  ok('variant deleted', delVariant.status === 204);

  // ── media protection ──────────────────────────────────────────────────────
  section('Media in use');
  const deleteUsedMedia = await call(`/media/${mediaId}`, { method: 'DELETE', token });
  ok('cannot delete media still attached to a product → 409 IN_USE', deleteUsedMedia.status === 409 && deleteUsedMedia.body?.error?.code === 'IN_USE', deleteUsedMedia.body);

  // ── listing and filters ───────────────────────────────────────────────────
  section('Product listing');
  const list = await call('/products?limit=10&sort=created_at:desc', { token });
  ok('list returns products with pagination meta', Array.isArray(list.body?.products) && typeof list.body?.pagination?.total === 'number', list.body?.pagination);
  ok('list rows carry a primary image', list.body.products.find((p: any) => p.id === productId)?.primary_image?.url?.startsWith('/media/'));

  const search = await call(`/products?q=${encodeURIComponent(skuBase)}`, { token });
  ok('search by SKU fragment finds the product', search.body?.products?.some((p: any) => p.id === productId), search.body?.pagination);

  const byCategory = await call(`/products?category_id=${categoryId}`, { token });
  ok('filter by category works', byCategory.body?.products?.some((p: any) => p.id === productId));

  const byStatus = await call('/products?status=active', { token });
  ok('filter by status works', byStatus.body?.products?.every((p: any) => p.status === 'active'));

  const badSort = await call('/products?sort=;DROP TABLE products;--:asc', { token });
  ok('unknown sort column falls back safely', badSort.status === 200, badSort.body?.error);

  // ── collections ───────────────────────────────────────────────────────────
  section('Collections');
  const manual = await call('/collections', {
    method: 'POST',
    token,
    body: {
      collection: {
        title: `Bestsellers ${Date.now()}`,
        collection_type: 'manual',
        product_ids: [productId],
      },
    },
  });
  ok('manual collection created with a member', manual.status === 201 && manual.body?.collection?.product_count === 1, manual.body);

  const auto = await call('/collections', {
    method: 'POST',
    token,
    body: {
      collection: {
        title: `Under 1000 ${Date.now()}`,
        collection_type: 'automatic',
        match_condition: 'all',
        rules: [{ field: 'price', operator: 'less_than', value: '1000' }],
      },
    },
  });
  ok('automatic collection created', auto.status === 201, auto.body);
  ok('rules materialised into members', auto.body?.collection?.product_count >= 1, auto.body?.collection);

  const autoNoRules = await call('/collections', {
    method: 'POST',
    token,
    body: { collection: { title: 'No rules', collection_type: 'automatic', rules: [] } },
  });
  ok('automatic collection without rules → 422', autoNoRules.status === 422, autoNoRules.body?.error?.details);

  const badRuleField = await call('/collections', {
    method: 'POST',
    token,
    body: {
      collection: {
        title: 'Injection attempt',
        collection_type: 'automatic',
        rules: [{ field: 'name); DROP TABLE products; --', operator: 'equals', value: 'x' }],
      },
    },
  });
  ok('rule field outside the whitelist → 422', badRuleField.status === 422, badRuleField.body?.error?.details);

  const recalc = await call(`/collections/${auto.body.collection.id}/recalculate`, { method: 'POST', token });
  ok('recalculate re-runs the rules', recalc.status === 200 && typeof recalc.body?.product_count === 'number', recalc.body);

  const recalcManual = await call(`/collections/${manual.body.collection.id}/recalculate`, { method: 'POST', token });
  ok('recalculating a manual collection → 409', recalcManual.status === 409);

  // ── bulk ──────────────────────────────────────────────────────────────────
  section('Bulk actions');
  const draft = await call('/products', {
    method: 'POST',
    token,
    body: {
      product: {
        name: 'Incomplete draft product',
        variants: [{ sku: `${skuBase}-DRAFT`, mrp: 500, price: 450, inventory_quantity: 5 }],
      },
    },
  });
  const draftId = draft.body?.product?.id;
  const bulk = await call('/products/bulk', {
    method: 'POST',
    token,
    body: { ids: [productId, draftId], action: 'publish' },
  });
  ok('bulk publish skips the product that fails the gate', bulk.body?.skipped?.some((s: any) => s.id === draftId), bulk.body);

  const bulkArchive = await call('/products/bulk', { method: 'POST', token, body: { ids: [draftId], action: 'archive' } });
  ok('bulk archive applies', bulkArchive.body?.affected === 1, bulkArchive.body);

  // ── duplicate ─────────────────────────────────────────────────────────────
  section('Duplicate');
  const dup = await call(`/products/${productId}/duplicate`, { method: 'POST', token });
  ok('duplicate creates a draft copy', dup.status === 201 && dup.body?.product?.status === 'draft', dup.body?.error);
  ok('duplicate suffixes SKUs to stay unique', dup.body?.product?.variants?.[0]?.sku !== `${skuBase}-30`);
  ok('duplicate starts with zero stock', dup.body?.product?.variants?.[0]?.inventory_quantity === 0);

  // ── account lifecycle ─────────────────────────────────────────────────────
  section('Account lifecycle');
  const suspend = await call(`/admin-users/${staffId}/suspend`, { method: 'POST', token });
  ok('staff account suspended', suspend.body?.admin_user?.status === 'suspended', suspend.body);

  // Suspending revokes every live session, so the next call fails at the
  // session check (401 SESSION_REVOKED) rather than the status check (403).
  // Either is a correct rejection; what matters is that access stops instantly.
  const suspendedCall = await call('/media', { token: staffToken });
  ok(
    'suspended account loses access immediately',
    suspendedCall.status === 401 || suspendedCall.status === 403,
    { status: suspendedCall.status, code: suspendedCall.body?.error?.code },
  );

  const selfSuspend = await call(`/admin-users/${login.body.admin.id}/suspend`, { method: 'POST', token });
  ok('cannot suspend your own account → 409', selfSuspend.status === 409, selfSuspend.body?.error);

  const permsView = await call(`/admin-users/${staffId}/permissions`, { token });
  ok('resolved permissions are inspectable', Array.isArray(permsView.body?.permissions), permsView.body);

  // ── cleanup ───────────────────────────────────────────────────────────────
  section('Cleanup');
  const del = await call(`/products/${productId}`, { method: 'DELETE', token });
  ok('product soft-deleted', del.status === 204);
  const gone = await call(`/products/${productId}`, { token });
  ok('deleted product returns 404', gone.status === 404);

  await call(`/products/${dup.body.product.id}`, { method: 'DELETE', token });
  await call(`/admin-users/${staffId}`, { method: 'DELETE', token });

  // The categories this run created go too. They were left behind for months,
  // and because categories are what the storefront's nav is built from, every
  // run added another "Serums 1789366000773" to the menu a visitor sees.
  // Children first: a category with children refuses to be deleted.
  await call(`/categories/${child.body.category.id}`, { method: 'DELETE', token });
  const categoryGone = await call(`/categories/${categoryId}`, { method: 'DELETE', token });
  ok('the scratch categories are cleaned up', categoryGone.status === 204 || categoryGone.status === 200, categoryGone.body);

  // ── rate limiting (last, because it deliberately trips the limiter) ───────
  section('Rate limiting');
  const victim = `bruteforce.${Date.now()}@veylor.test`;
  let sawLimit = false;
  let retryAfterPresent = false;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const response = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: victim, password: 'WrongPassword123' }),
    });
    if (response.status === 429) {
      sawLimit = true;
      retryAfterPresent = response.headers.has('retry-after');
      break;
    }
  }
  ok('repeated failed logins are rate limited → 429', sawLimit);
  ok('429 carries a Retry-After header', retryAfterPresent);
  await execute("DELETE FROM rate_limits WHERE bucket_key LIKE 'admin.%'");

  // ── summary ───────────────────────────────────────────────────────────────
  process.stdout.write(`\n${'='.repeat(52)}\n`);
  process.stdout.write(`  ${passed} passed, ${failed} failed\n`);
  if (failures.length > 0) {
    process.stdout.write(`\n  Failed:\n${failures.map((f) => `    - ${f}`).join('\n')}\n`);
  }
  process.stdout.write(`${'='.repeat(52)}\n\n`);
  await closePool();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`\nSmoke test crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
