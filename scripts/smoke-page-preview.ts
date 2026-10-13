/**
 * Draft page preview links and the legal-review sign-off, against a running API.
 *
 *   npm run dev
 *   npm run smoke:page-preview
 *
 * Runs in the `veylor` shop (SMOKE_SHOP to change it). What it is written to
 * catch:
 *
 *   - a draft is not served at its slug, only through its preview link
 *   - the link is the secret: an unknown token, a rotated-out token, a revoked
 *     token and another shop's host all get 404
 *   - the preview is never cached or indexed
 *   - it still works while the store is behind its password
 *   - signing off legal review is cms.review, not cms.edit
 */
import { env } from '../src/config/env';
import { closePool, execute } from '../src/db/pool';

const ROOT = `http://127.0.0.1:${env.port}`;
const ADMIN = `${ROOT}${env.apiPrefix}`;
const SHOP = process.env.SMOKE_SHOP ?? 'veylor';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  ✗ ${label}\n`);
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail).slice(0, 500)}\n`);
  }
}

async function call(url: string, options: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

const storefront = (path: string, shop = SHOP, headers: Record<string, string> = {}) =>
  call(`${ROOT}/api/v1${path}`, { headers: { 'X-Veylog-Shop-Domain': shop, ...headers } });

async function main(): Promise<void> {
  process.stdout.write('\nVeylog — page preview links and legal review\n\n');
  await execute("DELETE FROM rate_limits WHERE bucket_key LIKE 'admin.%' OR bucket_key LIKE 'shop.%'");

  const login = await call(`${ADMIN}/auth/login`, { method: 'POST', body: { email: env.superAdmin.email, password: env.superAdmin.password } });
  const token: string = login.body?.access_token;
  const admin = (path: string, options: { method?: string; body?: unknown; token?: string } = {}) =>
    call(`${ADMIN}${path}`, { ...options, token: options.token ?? token, headers: { 'X-Veylog-Shop': SHOP } });

  const run = Date.now().toString(36);
  const created = await admin('/content/pages', {
    method: 'POST',
    body: { title: `Preview ${run}`, slug: `preview-${run}`, page_type: 'standard', body_html: '<p>Not live yet.</p>', requires_legal_review: true },
  });
  const pageId: number = created.body?.id ?? created.body?.page?.id;
  ok('a draft page that needs legal review', [200, 201].includes(created.status) && Boolean(pageId), created.body);

  const live = await storefront(`/content/pages/preview-${run}`);
  ok('a draft is not served at its slug → 404', live.status === 404, live.body);

  const unknown = await storefront('/content/pages/preview/00000000-0000-4000-8000-000000000000');
  ok('an unknown preview token → 404', unknown.status === 404, unknown.body);
  const malformed = await storefront('/content/pages/preview/not-a-token');
  ok('a malformed token → 422', malformed.status === 422, malformed.body);

  const issued = await admin(`/content/pages/${pageId}/preview-link`, { method: 'POST' });
  const previewToken: string = issued.body?.preview_token;
  ok('the admin issues a preview link', issued.status === 200 && /^[0-9a-f-]{36}$/.test(previewToken ?? '') && issued.body?.preview_path === `/api/v1/content/pages/preview/${previewToken}`, issued.body);

  const preview = await storefront(`/content/pages/preview/${previewToken}`);
  ok('the link shows the draft, in the live page shape', preview.status === 200 && preview.body?.page?.title === `Preview ${run}` && Array.isArray(preview.body?.sections), preview.body);
  ok('…says it is a draft', preview.body?.preview?.status === 'draft', preview.body?.preview);
  ok('…and is never indexable', preview.body?.page?.seo?.is_indexable === false, preview.body?.page?.seo);
  ok('…never cached', preview.headers.get('cache-control') === 'private, no-store');
  ok('…never indexed', preview.headers.get('x-robots-tag') === 'noindex, nofollow');

  const shops = await call(`${ROOT}/platform/api/v1/shops?limit=50`, { token });
  const other = (shops.body?.shops ?? []).find((s: { handle: string; status: string }) => s.handle !== SHOP && s.status === 'active');
  if (other) {
    const crossShop = await storefront(`/content/pages/preview/${previewToken}`, other.handle);
    ok(`the same token on another shop (${other.handle}) → 404`, crossShop.status === 404, crossShop.body);
  } else {
    process.stdout.write('  - no second shop to test isolation against (run smoke:platform first)\n');
  }

  section('Rotating and revoking');
  const reissued = await admin(`/content/pages/${pageId}/preview-link`, { method: 'POST' });
  const rotated: string = reissued.body?.preview_token;
  ok('issuing again gives a new token', reissued.status === 200 && rotated !== previewToken);
  ok('…the old one stops working', (await storefront(`/content/pages/preview/${previewToken}`)).status === 404);
  ok('…the new one works', (await storefront(`/content/pages/preview/${rotated}`)).status === 200);

  section('Behind the store password');
  const locked = await admin('/shop', { method: 'PATCH', body: { storefront_password: { enabled: true, password: 'opening-soon' } } });
  ok('the store is locked', locked.status === 200, locked.body);
  const gated = await storefront('/content/pages');
  ok('ordinary content needs the password → 401', gated.status === 401, gated.body);
  const throughGate = await storefront(`/content/pages/preview/${rotated}`);
  ok('a preview link still opens the draft', throughGate.status === 200, throughGate.body);
  const badThroughGate = await storefront('/content/pages/preview/00000000-0000-4000-8000-000000000000');
  ok('…but an invalid one still gets nothing → 404', badThroughGate.status === 404, badThroughGate.body);
  await admin('/shop', { method: 'PATCH', body: { storefront_password: { enabled: false } } });

  section('Legal review is cms.review');
  const permissions = await admin('/permissions');
  // Grouped by module: { permissions: { cms: [{ id, slug, … }], … } }
  const flat = Object.values((permissions.body?.permissions ?? {}) as Record<string, { id: number; slug: string }[]>).flat();
  const id = (slug: string) => flat.find((p) => p.slug === slug)?.id;
  ok('cms.review is in the permission catalogue', Boolean(id('cms.review')), permissions.body);

  const role = await admin('/roles', {
    method: 'POST',
    body: { role: { slug: `editor-${run}`, name: `Editor ${run}`, permission_ids: [id('cms.view'), id('cms.edit')].filter(Boolean) } },
  });
  const email = `editor.${run}@veylor.test`;
  const password = 'EditorOnly2026!';
  const staff = await admin('/admin-users', {
    method: 'POST',
    body: { admin_user: { email, password, first_name: 'Edit', last_name: 'Only', role_ids: [role.body?.role?.id], must_change_password: false } },
  });
  ok('an editor with cms.edit but not cms.review', role.status === 201 && staff.status === 201, { role: role.body, staff: staff.body });
  const editorLogin = await call(`${ADMIN}/auth/login`, { method: 'POST', body: { email, password } });
  const editorToken: string = editorLogin.body?.access_token;

  const editorEdits = await admin(`/content/pages/${pageId}`, { method: 'PUT', token: editorToken, body: { subtitle: 'Edited by the editor' } });
  ok('the editor can edit the page', editorEdits.status === 200, editorEdits.body);
  const editorReviews = await admin(`/content/pages/${pageId}/review`, { method: 'POST', token: editorToken });
  ok('…but cannot sign off its legal review → 403', editorReviews.status === 403, editorReviews.body);
  section('Publishing is cms.publish, on every route');
  const editorPublishes = await admin(`/content/pages/${pageId}/publish`, { method: 'POST', token: editorToken, body: {} });
  ok('the editor cannot POST /publish → 403', editorPublishes.status === 403, editorPublishes.body);
  const editorPuts = await admin(`/content/pages/${pageId}`, { method: 'PUT', token: editorToken, body: { status: 'published' } });
  ok('…nor PUT status: published → 403', editorPuts.status === 403, editorPuts.body);
  const editorCreatesLive = await admin('/content/pages', { method: 'POST', token: editorToken, body: { title: `Live ${run}`, page_type: 'standard', status: 'published' } });
  ok('…nor create a page already published → 403', editorCreatesLive.status === 403, editorCreatesLive.body);
  const editorBulk = await admin('/content/pages/bulk-update', { method: 'POST', token: editorToken, body: { ids: [pageId], status: 'published' } });
  ok('…nor bulk-publish → 403', editorBulk.status === 403, editorBulk.body);
  const editorDraft = await admin('/content/pages', { method: 'POST', token: editorToken, body: { title: `Draft ${run}`, page_type: 'standard', status: 'in_review' } });
  ok('the editor can still create a page and send it for review', [200, 201].includes(editorDraft.status), editorDraft.body);
  const createdLive = await admin('/content/pages', { method: 'POST', body: { title: `Unreviewed ${run}`, page_type: 'policy', status: 'published', requires_legal_review: true } });
  ok('a page needing legal review cannot be created live → 400', createdLive.status === 400, createdLive.body);
  const bulk = await admin('/content/pages/bulk-update', { method: 'POST', body: { ids: [pageId], status: 'published' } });
  ok('bulk publish skips a page whose review is not signed off', bulk.status === 200 && bulk.body?.updatedCount === 0, bulk.body);

  const tooEarly = await admin(`/content/pages/${pageId}/publish`, { method: 'POST', body: {} });
  ok('publishing before the review is signed off → 400', tooEarly.status === 400 && /legal review/.test(tooEarly.body?.error?.message ?? ''), tooEarly.body);
  const viaUpdate = await admin(`/content/pages/${pageId}`, { method: 'PUT', body: { status: 'published' } });
  ok('…and the update route cannot go round the gate', viaUpdate.status === 400, viaUpdate.body);
  const reviewed = await admin(`/content/pages/${pageId}/review`, { method: 'POST' });
  ok('someone with cms.review can sign it off', reviewed.status === 200, reviewed.body);
  const published = await admin(`/content/pages/${pageId}/publish`, { method: 'POST', body: {} });
  ok('…after which it publishes', published.status === 200, published.body);
  const nowLive = await storefront(`/content/pages/preview-${run}`);
  ok('…and is served at its slug', nowLive.status === 200, nowLive.body);
  await admin(`/content/pages/${pageId}/unpublish`, { method: 'POST' });

  section('Duplicating');
  const source = await admin('/content/pages', {
    method: 'POST',
    body: { title: `Dup ${run}`, slug: `dup-${run}`, page_type: 'landing', body_html: '<p>copied body</p>', is_indexable: false, requires_legal_review: true },
  });
  const sourceId: number = source.body?.id ?? source.body?.page?.id;
  await admin(`/content/pages/${sourceId}/sections`, { method: 'POST', body: { section_key: 'hero', name: 'Hero', padding_top: 'lg' } });
  const copy = await admin(`/content/pages/${sourceId}/duplicate`, { method: 'POST' });
  const copied = copy.body?.page ?? copy.body;
  ok('duplicating a page works', copy.status === 201, copy.body);
  const read = (row: any, snake: string, camel: string) => row?.[snake] ?? row?.[camel];
  ok('…and keeps its type, body and settings', read(copied, 'page_type', 'pageType') === 'landing' && read(copied, 'body_html', 'bodyHtml') === '<p>copied body</p>' && Number(read(copied, 'is_indexable', 'isIndexable')) === 0 && Number(read(copied, 'requires_legal_review', 'requiresLegalReview')) === 1, copied);
  ok('…and its sections', copied?.sections?.length === 1 && read(copied.sections[0], 'section_key', 'sectionKey') === 'hero' && read(copied.sections[0], 'padding_top', 'paddingTop') === 'lg', copied?.sections);

  section('Revoking and archiving');
  const revoked = await admin(`/content/pages/${pageId}/preview-link`, { method: 'DELETE' });
  ok('revoking → 204', revoked.status === 204, revoked.body);
  ok('…and the link is dead', (await storefront(`/content/pages/preview/${rotated}`)).status === 404);
  await admin(`/content/pages/${pageId}/archive`, { method: 'POST' });
  const archivedLink = await admin(`/content/pages/${pageId}/preview-link`, { method: 'POST' });
  ok('an archived page cannot get a preview link → 409', archivedLink.status === 409, archivedLink.body);

  await admin(`/admin-users/${staff.body?.admin_user?.id}`, { method: 'DELETE' });

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  await closePool();
  process.exit(failed === 0 ? 0 : 1);
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

main().catch(async (error) => {
  process.stderr.write(`Smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  await closePool().catch(() => undefined);
  process.exit(1);
});
