/**
 * Idempotency-Key across API nodes, against two running servers on one database.
 *
 *   npm run dev                                   # node A, :4000
 *   PORT=4001 WORKER_EMBEDDED=false npm run dev   # node B, :4001
 *   npm run smoke:idempotency
 *
 * NODE_B_URL defaults to http://127.0.0.1:4001. With only one node running,
 * set NODE_B_URL to node A's address: everything still runs, it just proves
 * less.
 *
 * Uses POST /products/:id/duplicate because each run makes a new product
 * (its SKUs get a fresh suffix), so a request that runs twice in sequence
 * makes two products — a broken key cannot hide behind a unique index the
 * way it could on a discount code. Two duplicates racing CAN collide on the
 * suffix, which is why the burst checks that the losers waited or replayed,
 * not only how many products there are.
 */
import { env } from '../src/config/env';
import { closePool, execute } from '../src/db/pool';

const NODE_A = `http://127.0.0.1:${env.port}${env.apiPrefix}`;
const NODE_B = `${(process.env.NODE_B_URL ?? 'http://127.0.0.1:4001').replace(/\/$/, '')}${env.apiPrefix}`;

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

async function call(base: string, path: string, options: { method?: string; body?: unknown; token?: string; key?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.key) headers['Idempotency-Key'] = options.key;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
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
  return { status: response.status, body, replay: response.headers.get('Idempotent-Replay') === 'true' };
}

async function main(): Promise<void> {
  process.stdout.write(`\nIdempotency-Key across nodes\n  A: ${NODE_A}\n  B: ${NODE_B}\n\n`);
  await execute("DELETE FROM rate_limits WHERE bucket_key LIKE 'admin.%'");

  const login = await call(NODE_A, '/auth/login', { method: 'POST', body: { email: env.superAdmin.email, password: env.superAdmin.password } });
  const token: string = login.body?.access_token;
  const onB = await call(NODE_B, '/auth/me', { token });
  ok('both nodes are up and share sessions', Boolean(token) && onB.status === 200, onB.body);

  const run = Date.now().toString(36);
  const name = `Idempotency ${run}`;
  const source = await call(NODE_A, '/products', {
    method: 'POST',
    token,
    body: { product: { name, variants: [{ sku: `IDEM-${run}`, mrp: 100, price: 90 }] } },
  });
  ok('a product to duplicate', source.status === 201, source.body);
  const sourceId: number = source.body?.product?.id;
  const count = async () => Number((await call(NODE_A, `/products?q=${encodeURIComponent(name)}&limit=1`, { token })).body?.pagination?.total ?? NaN);
  const duplicate = (base: string, key: string) => call(base, `/products/${sourceId}/duplicate`, { method: 'POST', token, key, body: {} });

  // ── one key, two nodes ──────────────────────────────────────────────────────
  const first = await duplicate(NODE_A, `${run}-k1`);
  const second = await duplicate(NODE_B, `${run}-k1`);
  ok('the first request runs on node A', first.status === 201 && !first.replay, first.body);
  ok('node B replays it instead of running it again', second.replay && second.status === 201 && second.body?.product?.id === first.body?.product?.id, second);
  ok('one product, not two', (await count()) === 2);

  // ── many at once, across both nodes ─────────────────────────────────────────
  const before = await count();
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => duplicate(i % 2 ? NODE_B : NODE_A, `${run}-k2`)));
  const ran = burst.filter((r) => r.status === 201 && !r.replay);
  const busy = burst.filter((r) => r.status === 409 && /still in progress/.test(r.body?.error?.message ?? ''));
  const replays = burst.filter((r) => r.replay);
  ok('ten at once across two nodes: exactly one runs', ran.length === 1, burst.map((r) => [r.status, r.replay]));
  ok('…the rest wait (409) or replay its answer', busy.length + replays.length === 9 && replays.every((r) => r.body?.product?.id === ran[0]?.body?.product?.id));
  ok('…and exactly one product was made', (await count()) === before + 1);

  // ── a failure frees the key ─────────────────────────────────────────────────
  const invalid = await call(NODE_A, '/products', { method: 'POST', token, key: `${run}-k3`, body: { product: { name: '' } } });
  ok('a 422 is not stored', invalid.status === 422, invalid.body);
  const corrected = await call(NODE_B, '/products', {
    method: 'POST',
    token,
    key: `${run}-k3`,
    body: { product: { name: `${name} corrected`, variants: [{ sku: `IDEM-${run}-C`, mrp: 100, price: 90 }] } },
  });
  ok('the corrected retry with the same key runs', corrected.status === 201 && !corrected.replay, corrected.body);

  // ── a node that died mid-request ────────────────────────────────────────────
  const fourth = await duplicate(NODE_A, `${run}-k4`);
  // Make the row look like a claim still in flight on a node that is alive…
  await execute(
    `UPDATE idempotency_keys SET state = 'in_flight', lease_expires_at = NOW(3) + INTERVAL 1 MINUTE ORDER BY created_at DESC LIMIT 1`,
  );
  const held = await duplicate(NODE_B, `${run}-k4`);
  ok('a live claim answers 409', held.status === 409, held.body);
  // …then like one whose node died and whose lease has run out.
  await execute(
    `UPDATE idempotency_keys SET lease_expires_at = NOW(3) - INTERVAL 1 SECOND ORDER BY created_at DESC LIMIT 1`,
  );
  const takenOver = await duplicate(NODE_B, `${run}-k4`);
  ok('an abandoned claim is taken over and the request runs', takenOver.status === 201 && !takenOver.replay && takenOver.body?.product?.id !== fourth.body?.product?.id, takenOver.body);

  // ── no key, no change ───────────────────────────────────────────────────────
  const plainA = await duplicate(NODE_A, '');
  const plainB = await duplicate(NODE_A, '');
  ok('without a key every request runs', plainA.status === 201 && plainB.status === 201 && plainA.body?.product?.id !== plainB.body?.product?.id);

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  await closePool();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  process.stderr.write(`Smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  await closePool().catch(() => undefined);
  process.exit(1);
});
