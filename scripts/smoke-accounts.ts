/**
 * End-to-end smoke test for customer accounts, saved products and re-engagement.
 *
 *   npm run dev
 *   npm run smoke:accounts
 *
 * The code is never returned over HTTP, so this reads it back out of
 * `notification_logs` — the same place a developer would look. That is
 * deliberate: an endpoint that hands you the OTP in development is an endpoint
 * that hands it to anyone the day someone runs production without NODE_ENV set.
 *
 * What it is written to catch:
 *
 *   - the wrong code does not sign anyone in, and five wrong codes end the
 *     attempt rather than allowing a sixth
 *   - a code cannot be used twice
 *   - requesting a code says the same thing whether or not the number is known
 *   - saving is idempotent, and saved items are private to their owner
 *   - browsing done before signing in is claimed by the account afterwards
 *   - **nothing is sent to anyone who has not opted in**, and withdrawing
 *     consent takes effect immediately
 *   - someone who bought the product drops out of the audience
 *   - one person who saved four things is messaged once, not four times
 */
import { env } from '../src/config/env';
import { closePool, execute, query, queryOne, type RowDataPacket } from '../src/db/pool';

const ADMIN = `http://127.0.0.1:${env.port}${env.apiPrefix}`;
const SHOP = `http://127.0.0.1:${env.port}/api/v1`;

let passed = 0;
const failures: string[] = [];

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failures.push(label);
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

let adminToken = '';

interface Raw<T> {
  status: number;
  body: T;
}

async function raw<T>(
  base: string,
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<Raw<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed as T };
}

const shop = <T>(path: string, options: { method?: string; body?: unknown; token?: string } = {}) =>
  raw<T>(SHOP, path, options);
const admin = <T>(path: string, options: { method?: string; body?: unknown } = {}) =>
  raw<T>(ADMIN, path, { ...options, token: adminToken });

async function adminOrThrow<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const result = await admin<T>(path, options);
  if (result.status >= 400) throw new Error(`${path} → ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
  return result.body;
}

/** A fresh Indian mobile number, so runs never collide. */
function newPhone(): string {
  return `9${String(Date.now() + Math.floor(Math.random() * 100000)).slice(-9)}`;
}

/**
 * The code that was sent, read from the outbox.
 *
 * Nothing exposes it over HTTP. The provider records what it would have sent,
 * and this reads it back the way a developer would.
 */
async function codeSentTo(phone: string): Promise<string> {
  const row = await queryOne<RowDataPacket & { payload: unknown }>(
    `SELECT payload FROM notification_logs
      WHERE event_key = 'otp.login' AND recipient = ?
      ORDER BY id DESC LIMIT 1`,
    [`91${phone}`],
  );
  const payload = (typeof row?.payload === 'string' ? JSON.parse(row.payload) : row?.payload) as
    | { variables?: { otp?: string } }
    | undefined;
  const code = payload?.variables?.otp;
  if (!code) throw new Error(`no code was recorded for ${phone}`);
  return code;
}

interface SignedIn {
  access_token: string;
  refresh_token: string;
  is_new_account: boolean;
  customer: { id: string; phone: string; accepts_whatsapp_marketing: boolean };
}

async function signIn(phone: string, sessionToken?: string): Promise<SignedIn> {
  const requested = await shop<{ request_id: string }>('/account/otp', {
    method: 'POST',
    body: { phone, channel: 'whatsapp' },
  });
  if (requested.status >= 400) throw new Error(`otp → ${requested.status} ${JSON.stringify(requested.body)}`);

  const code = await codeSentTo(phone);
  const verified = await shop<SignedIn>('/account/otp/verify', {
    method: 'POST',
    body: { request_id: requested.body.request_id, code, session_token: sessionToken },
  });
  if (verified.status >= 400) throw new Error(`verify → ${verified.status} ${JSON.stringify(verified.body)}`);
  return verified.body;
}

async function firstProductSlug(): Promise<string> {
  const listed = await shop<{ products: { slug: string }[] }>('/products?limit=2&sort=featured');
  return listed.body.products[0].slug;
}

async function main(): Promise<void> {
  process.stdout.write('\nVeylor — accounts, saved products and re-engagement\n');

  // Repeat runs must not trip the throttles this suite is not testing.
  await execute("DELETE FROM rate_limits WHERE bucket_key LIKE 'shop.%' OR bucket_key LIKE 'admin.%'");
  await execute('DELETE FROM otp_throttle');

  const login = await raw<{ tokens?: { access_token: string }; access_token?: string }>(ADMIN, '/auth/login', {
    method: 'POST',
    body: { email: env.superAdmin.email, password: env.superAdmin.password },
  });
  adminToken = login.body.tokens?.access_token ?? login.body.access_token ?? '';
  if (!adminToken) throw new Error(`admin sign-in failed: ${JSON.stringify(login.body).slice(0, 200)}`);

  const slug = await firstProductSlug();

  // ── signing in ────────────────────────────────────────────────────────────
  section('Signing in by phone');
  const phone = newPhone();

  const first = await shop<{ request_id: string; sent_to: string }>('/account/otp', {
    method: 'POST',
    body: { phone, channel: 'whatsapp' },
  });
  ok('a code can be requested', first.status === 200, first.body);
  ok('the response does not contain the code', !JSON.stringify(first.body).match(/\b\d{6}\b/), first.body);
  ok('and only shows the last two digits of the number', first.body.sent_to.endsWith(phone.slice(-2)));

  const stored = await queryOne<RowDataPacket & { otp_hash: string; status: string }>(
    `SELECT otp_hash, status FROM otp_requests WHERE request_id = ?`,
    [first.body.request_id],
  );
  const code = await codeSentTo(phone);
  ok('the code itself is not stored', stored !== null && stored.otp_hash !== code, {
    hash_length: stored?.otp_hash.length,
  });
  ok('only a 64-character hash is', stored?.otp_hash.length === 64);

  const wrong = await shop<{ error?: { message: string } }>('/account/otp/verify', {
    method: 'POST',
    body: { request_id: first.body.request_id, code: code === '000000' ? '111111' : '000000' },
  });
  ok('the wrong code is refused', wrong.status === 400, wrong.body);
  ok('and says how many tries are left', /tries? left/.test(JSON.stringify(wrong.body)), wrong.body);

  const right = await shop<SignedIn>('/account/otp/verify', {
    method: 'POST',
    body: { request_id: first.body.request_id, code },
  });
  ok('the right code signs them in', right.status === 200 && Boolean(right.body.access_token));
  ok('and creates the account', right.body.is_new_account === true);
  ok('the customer id is a uuid, not a row number', /^[0-9a-f-]{36}$/.test(right.body.customer.id), right.body.customer.id);

  const replay = await shop('/account/otp/verify', {
    method: 'POST',
    body: { request_id: first.body.request_id, code },
  });
  ok('the same code cannot be used twice', replay.status === 400, replay.status);

  const token = right.body.access_token;

  const me = await shop<{ customer: { phone: string } }>('/account/me', { token });
  ok('the session works', me.status === 200 && me.body.customer.phone === phone);

  const anonymous = await shop('/account/me');
  ok('and a request with no token is refused', anonymous.status === 401, anonymous.status);

  // A returning customer is not a new account.
  const second = await signIn(phone);
  ok('signing in again is not a new account', second.is_new_account === false);

  // ── attempts are limited ──────────────────────────────────────────────────
  section('Guessing is limited');
  const guessPhone = newPhone();
  const guessRequest = await shop<{ request_id: string }>('/account/otp', {
    method: 'POST',
    body: { phone: guessPhone },
  });
  const realCode = await codeSentTo(guessPhone);
  const wrongCode = realCode === '000000' ? '111111' : '000000';

  let lastMessage = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await shop<{ error?: { message: string } }>('/account/otp/verify', {
      method: 'POST',
      body: { request_id: guessRequest.body.request_id, code: wrongCode },
    });
    lastMessage = JSON.stringify(response.body);
  }
  ok('after five wrong codes it stops asking', /request a new/.test(lastMessage), lastMessage);

  const tooLate = await shop('/account/otp/verify', {
    method: 'POST',
    body: { request_id: guessRequest.body.request_id, code: realCode },
  });
  ok('and the real code no longer works either', tooLate.status === 400, tooLate.status);

  // ── saving ────────────────────────────────────────────────────────────────
  section('Saving a product');
  const saved = await shop<{ saved: boolean; newly_added: boolean }>(`/account/saved/${slug}`, {
    method: 'PUT',
    token,
  });
  ok('a product can be saved', saved.status === 200 && saved.body.saved === true);
  ok('and the save is new', saved.body.newly_added === true);

  const again = await shop<{ saved: boolean; newly_added: boolean }>(`/account/saved/${slug}`, {
    method: 'PUT',
    token,
  });
  ok('saving twice is not an error', again.status === 200 && again.body.saved === true);
  ok('and does not add a second row', again.body.newly_added === false);

  const list = await shop<{ saved: { slug: string; name: string; price: number | null }[]; count: number }>(
    '/account/saved',
    { token },
  );
  ok('the saved list has it once', list.body.saved.filter((item) => item.slug === slug).length === 1, list.body.count);
  ok('with enough to render a card', Boolean(list.body.saved[0]?.name && list.body.saved[0]?.price !== undefined));

  const anonymousList = await shop('/account/saved');
  ok('saved items are not readable without signing in', anonymousList.status === 401);

  // Another customer must not see them.
  const otherPhone = newPhone();
  const other = await signIn(otherPhone);
  const otherList = await shop<{ saved: unknown[] }>('/account/saved', { token: other.access_token });
  ok('and are private to their owner', otherList.body.saved.length === 0, otherList.body.saved.length);

  const removed = await shop<{ saved: boolean }>(`/account/saved/${slug}`, { method: 'DELETE', token });
  ok('a product can be unsaved', removed.status === 200 && removed.body.saved === false);
  await shop(`/account/saved/${slug}`, { method: 'PUT', token });

  // ── browsing before signing in ────────────────────────────────────────────
  section('Browsing before signing in');
  const cart = await shop<{ cart: { token: string } }>('/cart', { method: 'POST' });
  const cartToken = cart.body.cart.token;

  await shop(`/account/views/${slug}`, {
    method: 'POST',
    body: { session_token: cartToken, source: 'product_page' },
  });
  const guestViews = await query<RowDataPacket & { id: number }>(
    `SELECT id FROM product_views WHERE session_token = ? AND customer_id IS NULL`,
    [cartToken],
  );
  ok('a signed-out view is recorded', guestViews.length >= 1, guestViews.length);

  const claimer = newPhone();
  const claimed = await signIn(claimer, cartToken);
  const afterClaim = await query<RowDataPacket & { id: number }>(
    `SELECT id FROM product_views WHERE session_token = ? AND customer_id IS NULL`,
    [cartToken],
  );
  ok('and becomes theirs when they sign in', afterClaim.length === 0, afterClaim.length);
  void claimed;

  // ── consent ───────────────────────────────────────────────────────────────
  section('Nobody is messaged without opting in');
  const audienceBefore = await adminOrThrow<{
    audience: { customer: { contactable: boolean; reason: string | null } }[];
    summary: { people: number; contactable: number; can_send: boolean };
  }>('/reengagement/audience?limit=100');

  const mine = audienceBefore.audience.find((entry) => entry.customer.contactable === false);
  ok('the person who saved something is in the audience', audienceBefore.summary.people >= 1, audienceBefore.summary);
  ok('marked as not contactable', Boolean(mine), audienceBefore.audience.slice(0, 2));
  ok('with the reason said plainly', mine?.customer.reason === 'Never opted in to WhatsApp', mine?.customer.reason);
  ok(
    'and the screen knows nothing would actually be delivered',
    audienceBefore.summary.can_send === false,
    audienceBefore.summary.can_send,
  );

  /**
   * Asked about this customer, not about the whole database.
   *
   * Other runs leave consenting customers behind, so "the batch sent nothing"
   * is only true on an empty database — and a test that passes only when it
   * runs first is a test everyone learns to ignore. What must hold is that
   * *this* person, who has not opted in, is not among those messaged.
   */
  await adminOrThrow('/reengagement/send?limit=100', {
    method: 'POST',
    body: { dry_run: false, limit: 50 },
  });
  const messagedWithoutConsent = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
       FROM notification_logs nl
       JOIN customers c ON c.id = nl.customer_id
      WHERE c.phone = ? AND nl.event_key = 'cart.abandoned'`,
    [phone],
  );
  ok(
    'a customer who has not opted in is not messaged',
    Number(messagedWithoutConsent?.total ?? 0) === 0,
    messagedWithoutConsent,
  );

  // Now opt in.
  const optIn = await shop<{ accepts_whatsapp_marketing: boolean }>('/account/marketing/whatsapp', {
    method: 'PUT',
    token,
    body: { granted: true },
  });
  ok('a customer can opt in', optIn.status === 200 && optIn.body.accepts_whatsapp_marketing === true);

  const consentRow = await queryOne<RowDataPacket & { status: string; source: string }>(
    `SELECT status, source FROM customer_consents
      WHERE purpose = 'marketing_whatsapp' ORDER BY id DESC LIMIT 1`,
  );
  ok('and the consent is recorded with its source', consentRow?.status === 'granted', consentRow);

  const audienceAfter = await adminOrThrow<{ summary: { contactable: number } }>(
    '/reengagement/audience?limit=100',
  );
  ok('they now count as contactable', audienceAfter.summary.contactable >= 1, audienceAfter.summary);

  const dry = await adminOrThrow<{ attempted: number; sent: number; dry_run: boolean }>(
    '/reengagement/send?contactable=true&limit=100',
    { method: 'POST', body: { limit: 50 } },
  );
  ok('a send defaults to a dry run', dry.dry_run === true, dry);
  ok('which sends nothing', dry.sent === 0);
  ok('but reports who would be reached', dry.attempted >= 1, dry.attempted);

  const real = await adminOrThrow<{ attempted: number; sent: number; message: string }>(
    '/reengagement/send?contactable=true&limit=100',
    { method: 'POST', body: { dry_run: false, limit: 50 } },
  );
  const messagedWithConsent = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
       FROM notification_logs nl
       JOIN customers c ON c.id = nl.customer_id
      WHERE c.phone = ? AND nl.event_key = 'cart.abandoned'`,
    [phone],
  );
  ok(
    'an explicit send reaches the customer once they have opted in',
    Number(messagedWithConsent?.total ?? 0) === 1,
    messagedWithConsent,
  );
  ok('and the batch reports it', real.sent >= 1, real);
  ok(
    'and says plainly that nothing was delivered without a provider',
    /no whatsapp provider is connected/i.test(real.message),
    real.message,
  );

  // ── the frequency cap ─────────────────────────────────────────────────────
  section('One message, not four');
  const again2 = await adminOrThrow<{ sent: number; skipped: { reason: string }[] }>(
    '/reengagement/send?contactable=true&limit=100',
    { method: 'POST', body: { dry_run: false, limit: 50 } },
  );
  const messagedTwice = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total
       FROM notification_logs nl
       JOIN customers c ON c.id = nl.customer_id
      WHERE c.phone = ? AND nl.event_key = 'cart.abandoned'`,
    [phone],
  );
  ok(
    'sending again does not message them a second time',
    Number(messagedTwice?.total ?? 0) === 1,
    messagedTwice,
  );
  ok(
    'because the person was messaged too recently',
    again2.skipped.some((entry) => /within the last/.test(entry.reason)),
    again2.skipped.slice(0, 2),
  );

  // ── withdrawing ───────────────────────────────────────────────────────────
  section('Opting out works immediately');
  await shop('/account/marketing/whatsapp', { method: 'PUT', token, body: { granted: false } });

  const withdrawn = await queryOne<RowDataPacket & { status: string }>(
    `SELECT status FROM customer_consents WHERE purpose = 'marketing_whatsapp' ORDER BY id DESC LIMIT 1`,
  );
  ok('the withdrawal is recorded rather than the grant deleted', withdrawn?.status === 'withdrawn', withdrawn);

  const consentHistory = await query<RowDataPacket & { status: string }>(
    `SELECT status FROM customer_consents WHERE purpose = 'marketing_whatsapp' ORDER BY id`,
  );
  ok('so the history shows both', consentHistory.length >= 2, consentHistory.map((r) => r.status));

  const afterWithdraw = await adminOrThrow<{
    audience: { customer: { contactable: boolean; reason: string | null } }[];
  }>('/reengagement/audience?limit=100');
  const nowOut = afterWithdraw.audience.find((entry) => entry.customer.reason === 'Opted out of WhatsApp');
  ok('and they read as opted out', Boolean(nowOut), afterWithdraw.audience.slice(0, 2));

  // ── buying removes you from the audience ──────────────────────────────────
  section('Buying it takes you out of the list');
  const buyer = newPhone();
  const buyerSession = await signIn(buyer);
  await shop(`/account/saved/${slug}`, { method: 'PUT', token: buyerSession.access_token });

  const beforeBuying = await adminOrThrow<{ audience: { customer: { id: string } }[] }>(
    '/reengagement/audience?limit=100',
  );
  ok(
    'the buyer is in the audience before they buy',
    beforeBuying.audience.some((entry) => entry.customer.id === buyerSession.customer.id),
  );

  // Place and confirm an order for that product as this customer.
  const detail = await shop<{ product: { id: number; variants: { id: number; in_stock: boolean }[] } }>(
    `/products/${slug}`,
  );
  const variant = detail.body.product.variants.find((v) => v.in_stock) ?? detail.body.product.variants[0];
  await execute(
    `UPDATE inventory_items SET quantity_on_hand = GREATEST(quantity_on_hand, 25) WHERE variant_id = ?`,
    [variant.id],
  );
  const buyerCart = await shop<{ cart: { token: string } }>('/cart', { method: 'POST' });
  await shop(`/cart/${buyerCart.body.cart.token}/items`, {
    method: 'POST',
    body: { variant_id: variant.id, quantity: 1 },
  });
  const placed = await shop<{ order: { id: number } }>(`/cart/${buyerCart.body.cart.token}/checkout`, {
    method: 'POST',
    body: {
      payment_method: 'cod',
      contact: { first_name: 'Saved', last_name: 'Buyer', phone: buyer, email: `${buyer}@example.com` },
      shipping_address: { line1: '3 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
    },
  });
  ok('the order is placed', placed.status === 201 || placed.status === 200, placed.status);

  const afterBuying = await adminOrThrow<{ audience: { customer: { id: string } }[] }>(
    '/reengagement/audience?limit=100',
  );
  ok(
    'and buying it removes them from the audience',
    !afterBuying.audience.some((entry) => entry.customer.id === buyerSession.customer.id),
    afterBuying.audience.length,
  );

  // ── what the admin list does not leak ─────────────────────────────────────
  section('What the audience list does not say');
  const serialised = JSON.stringify(afterBuying);
  ok('full phone numbers are not in the list', !serialised.includes(buyer), buyer);
  ok('nor internal customer ids', !/"customer":\{"id":\d+/.test(serialised));

  process.stdout.write(`\n${'='.repeat(52)}\n  ${passed} passed, ${failures.length} failed\n${'='.repeat(52)}\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failures) process.stdout.write(`  • ${failure}\n`);
  }
  process.stdout.write('\n');
  await closePool();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(async (error) => {
  process.stdout.write(`\nFATAL: ${error instanceof Error ? error.message : String(error)}\n\n`);
  await closePool().catch(() => undefined);
  process.exit(1);
});
