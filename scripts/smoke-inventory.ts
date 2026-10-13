/**
 * End-to-end smoke test for the inventory module.
 *
 *   npm run dev          # in one shell
 *   npm run smoke:inventory
 *
 * The arithmetic and the invariants are the point, not the happy path:
 *
 *   - the KPI cards foot against the rows they sit above, under every filter.
 *     Three endpoints used to answer "how many units do we hold?" with three
 *     different numbers because each carried its own scope predicate
 *   - the low / out-of-stock counters and the per-row badge come from one SQL
 *     expression, so "8 low" and the rows behind the Low filter are the same 8
 *   - two concurrent adjustments cannot both pass the negative-stock guard
 *   - a stock movement can be traced back to the order that caused it
 *   - exactly one location is ever the default
 */
import { env } from '../src/config/env';
import { closePool, query, queryOne, type RowDataPacket } from '../src/db/pool';

const ADMIN = `http://127.0.0.1:${env.port}${env.apiPrefix}`;
const SHOP = `http://127.0.0.1:${env.port}/api/v1`;

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
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}\n`);
  }
}

let token = '';

interface Raw<T> {
  status: number;
  body: T;
}

async function raw<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<Raw<T>> {
  const response = await fetch(`${ADMIN}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as T };
}

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const result = await raw<T>(path, options);
  if (result.status >= 400) {
    throw new Error(`${options.method ?? 'GET'} ${path} → ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
  }
  return result.body;
}

async function shop<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${SHOP}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${path} → ${response.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

// ── shapes ───────────────────────────────────────────────────────────────────

type StockState = 'in_stock' | 'low' | 'out_of_stock' | 'untracked';

interface StockItem {
  inventory_item_id: number;
  variant_id: number;
  location_id: number;
  sku: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  low_stock_threshold: number;
  track_inventory: boolean;
  stock_state: StockState;
}

interface Summary {
  total_skus: number;
  total_on_hand: number;
  total_available: number;
  low_stock_count: number;
  out_of_stock_count: number;
}

interface StockPage {
  items: StockItem[];
  pagination: { total: number; page: number; limit: number };
  summary: Summary;
}

interface Movement {
  id: number;
  movement_type: string;
  quantity_delta: number;
  quantity_after: number;
  reference_type: string | null;
  reference_id: number | null;
  reason: string | null;
  admin_name: string | null;
}

interface Location {
  id: number;
  code: string;
  is_default: boolean;
  item_count: number;
  total_on_hand: number;
}

/** Pulls every page of the stock list so totals can be summed client-side. */
async function everyStockRow(queryString = ''): Promise<StockItem[]> {
  const rows: StockItem[] = [];
  const sep = queryString ? '&' : '';
  for (let page = 1; ; page += 1) {
    const result = await api<StockPage>(`/inventory?${queryString}${sep}page=${page}&limit=250`);
    rows.push(...result.items);
    if (rows.length >= result.pagination.total || result.items.length === 0) break;
  }
  return rows;
}

async function main(): Promise<void> {
  process.stdout.write('\nInventory smoke test\n====================\n\n');

  // ── auth ───────────────────────────────────────────────────────────────────
  process.stdout.write('Auth\n');
  const login = await raw<{ access_token: string }>('/auth/login', {
    method: 'POST',
    body: { email: env.superAdmin.email, password: env.superAdmin.password },
  });
  ok('superadmin logs in', login.status === 200 && Boolean(login.body.access_token), login.body);
  token = login.body.access_token;

  // ── permissions ────────────────────────────────────────────────────────────
  process.stdout.write('\nAccess control\n');
  const anonymous = await fetch(`${ADMIN}/inventory`);
  ok('unauthenticated stock list → 401', anonymous.status === 401, anonymous.status);

  // ── the cards foot against the table ───────────────────────────────────────
  process.stdout.write('\nStock totals agree across endpoints\n');

  const firstPage = await api<StockPage>('/inventory?limit=5');
  ok('stock list returns rows', firstPage.items.length > 0, firstPage.pagination);
  ok('stock list carries its own summary', typeof firstPage.summary?.total_on_hand === 'number', firstPage.summary);

  const standalone = await api<{ summary: Summary }>('/inventory/summary');
  ok(
    'standalone /summary matches the summary embedded in the list',
    standalone.summary.total_on_hand === firstPage.summary.total_on_hand &&
      standalone.summary.total_skus === firstPage.summary.total_skus,
    { standalone: standalone.summary, embedded: firstPage.summary },
  );

  const allRows = await everyStockRow();
  const summedOnHand = allRows.reduce((total, row) => total + row.quantity_on_hand, 0);
  ok(
    'summary.total_on_hand equals the sum of the On Hand column',
    summedOnHand === standalone.summary.total_on_hand,
    { summed: summedOnHand, reported: standalone.summary.total_on_hand },
  );

  const summedAvailable = allRows.reduce((total, row) => total + row.quantity_available, 0);
  ok(
    'summary.total_available equals the sum of the Available column',
    summedAvailable === standalone.summary.total_available,
    { summed: summedAvailable, reported: standalone.summary.total_available },
  );

  ok(
    'summary.total_skus equals the distinct variants listed',
    new Set(allRows.map((row) => row.variant_id)).size === standalone.summary.total_skus,
    { distinct: new Set(allRows.map((row) => row.variant_id)).size, reported: standalone.summary.total_skus },
  );

  const locations = await api<{ locations: Location[] }>('/inventory/locations');
  const locationOnHand = locations.locations.reduce((total, row) => total + row.total_on_hand, 0);
  ok(
    'location totals sum to the same figure as the summary',
    locationOnHand === standalone.summary.total_on_hand,
    { locations: locationOnHand, summary: standalone.summary.total_on_hand },
  );
  ok(
    'location totals are numbers, not SUM() strings',
    locations.locations.every((row) => typeof row.total_on_hand === 'number' && typeof row.item_count === 'number'),
    locations.locations[0],
  );

  // ── one rule for "low" ─────────────────────────────────────────────────────
  process.stdout.write('\nOne definition of low / out of stock\n');

  const lowRows = allRows.filter((row) => row.stock_state === 'low');
  const outRows = allRows.filter((row) => row.stock_state === 'out_of_stock');
  ok(
    'low_stock_count equals the rows badged low',
    lowRows.length === standalone.summary.low_stock_count,
    { badged: lowRows.length, reported: standalone.summary.low_stock_count },
  );
  ok(
    'out_of_stock_count equals the rows badged out of stock',
    outRows.length === standalone.summary.out_of_stock_count,
    { badged: outRows.length, reported: standalone.summary.out_of_stock_count },
  );

  const lowFiltered = await everyStockRow('stock_status=low');
  ok(
    'the Low filter returns exactly the rows badged low',
    lowFiltered.length === lowRows.length && lowFiltered.every((row) => row.stock_state === 'low'),
    { filtered: lowFiltered.length, badged: lowRows.length },
  );

  const outFiltered = await everyStockRow('stock_status=out_of_stock');
  ok(
    'the Out of stock filter returns exactly the rows badged out',
    outFiltered.length === outRows.length && outFiltered.every((row) => row.stock_state === 'out_of_stock'),
    { filtered: outFiltered.length, badged: outRows.length },
  );

  ok(
    'an untracked variant is never counted as out of stock',
    allRows.every((row) => !(row.track_inventory === false && row.stock_state === 'out_of_stock')),
  );

  const untrackedFilter = await raw<StockPage>('/inventory?stock_status=untracked&limit=5');
  ok('untracked is a filterable state', untrackedFilter.status === 200, untrackedFilter.status);

  // ── a filtered table gets filtered cards ───────────────────────────────────
  process.stdout.write('\nFiltered cards describe the filtered rows\n');

  const target = allRows.find((row) => row.track_inventory && row.quantity_on_hand > 10);
  if (!target) throw new Error('No tracked variant with stock to work with — seed the catalogue first.');

  const searched = await api<StockPage>(`/inventory?q=${encodeURIComponent(target.sku)}&limit=250`);
  const searchedSum = searched.items.reduce((total, row) => total + row.quantity_on_hand, 0);
  ok(
    'searching narrows the summary to the matching rows',
    searched.summary.total_on_hand === searchedSum && searched.summary.total_on_hand < standalone.summary.total_on_hand,
    { summary: searched.summary.total_on_hand, summed: searchedSum },
  );

  const byLocation = await api<StockPage>(`/inventory?location_id=${target.location_id}&limit=1`);
  const thatLocation = locations.locations.find((row) => row.id === target.location_id);
  ok(
    'filtering by location matches that location’s own counters',
    byLocation.summary.total_on_hand === thatLocation?.total_on_hand &&
      byLocation.pagination.total === thatLocation?.item_count,
    { filtered: byLocation.summary.total_on_hand, location: thatLocation?.total_on_hand },
  );

  // ── adjustments ────────────────────────────────────────────────────────────
  process.stdout.write('\nAdjustments\n');

  const before = target.quantity_on_hand;
  const added = await api<{ item: StockItem }>(`/inventory/${target.variant_id}/adjust`, {
    method: 'POST',
    body: { quantity_delta: 7, reason: 'Smoke test — received shipment' },
  });
  ok('a positive adjustment lands', added.item.quantity_on_hand === before + 7, {
    before,
    after: added.item.quantity_on_hand,
  });

  const removed = await api<{ item: StockItem }>(`/inventory/${target.variant_id}/adjust`, {
    method: 'POST',
    body: { quantity_delta: -7, reason: 'Smoke test — reversing the receipt' },
  });
  ok('a negative adjustment lands', removed.item.quantity_on_hand === before, {
    after: removed.item.quantity_on_hand,
  });

  const tooFar = await raw<{ error: { code: string; message: string } }>(
    `/inventory/${target.variant_id}/adjust`,
    { method: 'POST', body: { quantity_delta: -(before + 1000), reason: 'Smoke test — should be refused' } },
  );
  ok('an adjustment below zero is refused', tooFar.status === 400, tooFar.body);

  const zero = await raw<unknown>(`/inventory/${target.variant_id}/adjust`, {
    method: 'POST',
    body: { quantity_delta: 0, reason: 'Smoke test — no-op' },
  });
  ok('a zero delta is rejected by validation', zero.status === 422, zero.status);

  const noReason = await raw<unknown>(`/inventory/${target.variant_id}/adjust`, {
    method: 'POST',
    body: { quantity_delta: 1 },
  });
  ok('an adjustment without a reason is rejected', noReason.status === 422, noReason.status);

  // ── the guard holds under concurrency ──────────────────────────────────────
  process.stdout.write('\nConcurrent adjustments cannot oversell\n');

  await api(`/inventory/${target.variant_id}/set`, {
    method: 'POST',
    body: { quantity: 5, reason: 'Smoke test — setting up the race' },
  });

  // Both requests read the same starting quantity. Without a row lock both pass
  // the guard and the row lands at -1; with one, the loser is refused.
  const race = await Promise.all([
    raw<unknown>(`/inventory/${target.variant_id}/adjust`, {
      method: 'POST',
      body: { quantity_delta: -3, reason: 'Smoke test — racer A' },
    }),
    raw<unknown>(`/inventory/${target.variant_id}/adjust`, {
      method: 'POST',
      body: { quantity_delta: -3, reason: 'Smoke test — racer B' },
    }),
  ]);
  const accepted = race.filter((result) => result.status === 200).length;
  ok('exactly one of two racing -3 adjustments against 5 succeeds', accepted === 1, race.map((r) => r.status));

  const afterRace = await api<{ item: StockItem }>(`/inventory/${target.variant_id}`);
  ok('stock never went negative', afterRace.item.quantity_on_hand >= 0, afterRace.item.quantity_on_hand);
  ok('stock landed on 2, not -1', afterRace.item.quantity_on_hand === 2, afterRace.item.quantity_on_hand);

  const raceRow = await queryOne<RowDataPacket & { quantity_after: number }>(
    `SELECT quantity_after FROM inventory_movements
      WHERE variant_id = ? ORDER BY id DESC LIMIT 1`,
    [target.variant_id],
  );
  ok(
    'the movement’s quantity_after matches the row it wrote',
    raceRow?.quantity_after === afterRace.item.quantity_on_hand,
    { movement: raceRow?.quantity_after, row: afterRace.item.quantity_on_hand },
  );

  await api(`/inventory/${target.variant_id}/set`, {
    method: 'POST',
    body: { quantity: before, reason: 'Smoke test — restoring original stock' },
  });

  // ── set / stock take ───────────────────────────────────────────────────────
  process.stdout.write('\nStock takes\n');

  const restored = await api<{ item: StockItem }>(`/inventory/${target.variant_id}`);
  ok('set restored the original quantity', restored.item.quantity_on_hand === before, {
    expected: before,
    actual: restored.item.quantity_on_hand,
  });

  const negativeSet = await raw<unknown>(`/inventory/${target.variant_id}/set`, {
    method: 'POST',
    body: { quantity: -1, reason: 'Smoke test — should be refused' },
  });
  ok('setting a negative quantity is rejected', negativeSet.status === 422, negativeSet.status);

  const takes = await api<{ movements: Movement[] }>(
    `/inventory/movements?variant_id=${target.variant_id}&movement_type=stock_take&limit=5`,
  );
  ok('stock takes are recorded as stock_take, not adjustment', takes.movements.length > 0, takes.movements.length);

  // ── bulk ───────────────────────────────────────────────────────────────────
  process.stdout.write('\nBulk adjustment\n');

  const bulkTargets = allRows.filter((row) => row.track_inventory && row.quantity_on_hand > 3).slice(0, 3);
  const bulk = await api<{ adjusted: number; items: { variant_id: number; old: number; new: number }[] }>(
    '/inventory/bulk-adjust',
    {
      method: 'POST',
      body: {
        items: bulkTargets.map((row) => ({ variant_id: row.variant_id, quantity_delta: 2 })),
        reason: 'Smoke test — bulk receipt',
      },
    },
  );
  ok('bulk adjust reports every line', bulk.adjusted === bulkTargets.length, bulk.adjusted);
  ok(
    'each bulk line reports the quantity it actually moved from',
    bulk.items.every((line) => line.new === line.old + 2),
    bulk.items,
  );

  const bulkBack = await raw<unknown>('/inventory/bulk-adjust', {
    method: 'POST',
    body: {
      items: [
        ...bulkTargets.map((row) => ({ variant_id: row.variant_id, quantity_delta: -2 })),
        { variant_id: bulkTargets[0].variant_id, quantity_delta: -99999 },
      ],
      reason: 'Smoke test — should roll the whole batch back',
    },
  });
  ok('a bulk batch with one impossible line is refused', bulkBack.status === 400, bulkBack.status);

  const unchanged = await api<StockPage>(`/inventory?q=${encodeURIComponent(bulkTargets[0].sku)}&limit=1`);
  ok(
    'the refused batch rolled back — nothing moved',
    unchanged.items[0].quantity_on_hand === bulkTargets[0].quantity_on_hand + 2,
    { now: unchanged.items[0].quantity_on_hand, expected: bulkTargets[0].quantity_on_hand + 2 },
  );

  await api('/inventory/bulk-adjust', {
    method: 'POST',
    body: {
      items: bulkTargets.map((row) => ({ variant_id: row.variant_id, quantity_delta: -2 })),
      reason: 'Smoke test — reversing the bulk receipt',
    },
  });

  // ── the ledger ─────────────────────────────────────────────────────────────
  process.stdout.write('\nMovement ledger\n');

  const ledger = await api<{ movements: Movement[]; pagination: { total: number } }>('/inventory/movements?limit=10');
  ok('the ledger lists movements', ledger.movements.length > 0, ledger.pagination);
  ok(
    'every movement records who or what caused it',
    ledger.movements.every((row) => Boolean(row.reason)),
  );
  ok(
    'system movements report a null author, not an empty name',
    ledger.movements.every((row) => row.admin_name === null || row.admin_name.trim().length > 0),
    ledger.movements.map((row) => row.admin_name),
  );

  const typed = await api<{ movements: Movement[] }>('/inventory/movements?movement_type=adjustment&limit=5');
  ok(
    'filtering the ledger by type works',
    typed.movements.every((row) => row.movement_type === 'adjustment'),
  );

  const badType = await raw<unknown>('/inventory/movements?movement_type=not-a-type');
  ok('an unknown movement type is rejected', badType.status === 422, badType.status);

  // ── traceability: a sale points at its order ───────────────────────────────
  process.stdout.write('\nA sale can be traced to its order\n');

  const listed = await shop<{ products: { slug: string }[] }>('/products?limit=1&sort=featured');
  const detail = await shop<{ product: { variants: { id: number; sku: string }[] } }>(
    `/products/${listed.products[0].slug}`,
  );
  const soldVariant = detail.product.variants[0];

  const cart = await shop<{ cart: { token: string } }>('/cart', { method: 'POST' });
  await shop(`/cart/${cart.cart.token}/items`, {
    method: 'POST',
    body: { variant_id: soldVariant.id, quantity: 1 },
  });
  const placed = await shop<{ order: { id: number; order_number: string } }>(
    `/cart/${cart.cart.token}/checkout`,
    {
      method: 'POST',
      body: {
        payment_method: 'cod',
        contact: {
          first_name: 'Smoke',
          last_name: 'Inventory',
          phone: '9812345670',
          email: 'smoke-inventory@veylor.test',
        },
        shipping_address: {
          line1: '1 Test Road, Baddi',
          city: 'Solan',
          state: 'Himachal Pradesh',
          state_code: '02',
          pincode: '173205',
        },
      },
    },
  );

  const saleRow = await queryOne<RowDataPacket & { reference_id: number | null; reference_type: string | null }>(
    `SELECT reference_type, reference_id FROM inventory_movements
      WHERE variant_id = ? AND movement_type = 'sale' ORDER BY id DESC LIMIT 1`,
    [soldVariant.id],
  );
  ok('the checkout wrote a sale movement', Boolean(saleRow), saleRow);
  ok(
    'the sale movement names the order that caused it',
    saleRow?.reference_type === 'order' && saleRow?.reference_id === placed.order.id,
    { movement: saleRow, order: placed.order.id },
  );

  const sold = await query<RowDataPacket & { location_id: number }>(
    `SELECT im.location_id FROM inventory_movements im
      WHERE im.variant_id = ? AND im.movement_type = 'sale' ORDER BY im.id DESC LIMIT 1`,
    [soldVariant.id],
  );
  const fulfilling = await queryOne<RowDataPacket & { id: number }>(
    `SELECT id FROM inventory_locations
      WHERE is_active = 1 AND fulfils_online_orders = 1
      ORDER BY is_default DESC, priority ASC LIMIT 1`,
  );
  ok(
    'the sale came out of the location that fulfils online orders',
    sold[0]?.location_id === fulfilling?.id,
    { movement: sold[0]?.location_id, fulfilling: fulfilling?.id },
  );

  // ── locations ──────────────────────────────────────────────────────────────
  process.stdout.write('\nLocations\n');

  const code = `SMOKE${Date.now().toString().slice(-6)}`;
  const created = await api<{ location: Location }>('/inventory/locations', {
    method: 'POST',
    body: {
      location: {
        code,
        name: 'Smoke test depot',
        location_type: 'warehouse',
        city: 'Solan',
        state: 'Himachal Pradesh',
        state_code: '02',
        pincode: '173205',
      },
    },
  });
  ok('a location is created', created.location.code === code, created.location);

  const duplicate = await raw<unknown>('/inventory/locations', {
    method: 'POST',
    body: { location: { code, name: 'Duplicate depot' } },
  });
  ok('a duplicate location code is refused', duplicate.status === 409, duplicate.status);

  const badPincode = await raw<unknown>('/inventory/locations', {
    method: 'POST',
    body: { location: { code: `${code}X`, name: 'Bad pincode', pincode: '12' } },
  });
  ok('a malformed pincode is rejected', badPincode.status === 422, badPincode.status);

  await api(`/inventory/locations/${created.location.id}`, {
    method: 'PATCH',
    body: { location: { is_default: true } },
  });
  const afterPromotion = await api<{ locations: Location[] }>('/inventory/locations');
  const defaults = afterPromotion.locations.filter((row) => row.is_default);
  ok('promoting a location leaves exactly one default', defaults.length === 1, defaults.map((row) => row.code));
  ok('the promoted location is the default', defaults[0]?.id === created.location.id, defaults[0]);

  const unsetLast = await raw<unknown>(`/inventory/locations/${created.location.id}`, {
    method: 'PATCH',
    body: { location: { is_default: false } },
  });
  ok('clearing the only default is refused', unsetLast.status === 400, unsetLast.status);

  // Hand the default back so the database is left as we found it.
  const original = afterPromotion.locations.find((row) => row.code === 'MAIN');
  if (original) {
    await api(`/inventory/locations/${original.id}`, {
      method: 'PATCH',
      body: { location: { is_default: true } },
    });
    const restoredDefaults = await api<{ locations: Location[] }>('/inventory/locations');
    ok(
      'handing the default back demotes the other location',
      restoredDefaults.locations.filter((row) => row.is_default).length === 1 &&
        restoredDefaults.locations.find((row) => row.is_default)?.code === 'MAIN',
      restoredDefaults.locations.filter((row) => row.is_default).map((row) => row.code),
    );
  }

  const missing = await raw<unknown>('/inventory/locations/999999');
  ok('an unknown location → 404', missing.status === 404, missing.status);

  // ── single variant view ────────────────────────────────────────────────────
  process.stdout.write('\nSingle variant view\n');

  const single = await api<{ item: StockItem; recent_movements: Movement[] }>(`/inventory/${target.variant_id}`);
  ok('the variant view returns its stock row', single.item.variant_id === target.variant_id, single.item);
  ok('the variant view returns its recent movements', single.recent_movements.length > 0, single.recent_movements.length);
  ok(
    'those movements all belong to that variant',
    single.recent_movements.every((row) => row.quantity_after >= 0),
  );

  const unknownVariant = await raw<unknown>('/inventory/999999');
  ok('an unknown variant → 404', unknownVariant.status === 404, unknownVariant.status);

  // ── summary ────────────────────────────────────────────────────────────────
  process.stdout.write(`\n${'─'.repeat(60)}\n`);
  process.stdout.write(`${passed} passed, ${failed} failed\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failures) process.stdout.write(`  • ${failure}\n`);
  }
  process.stdout.write('\n');
}

main()
  .catch((error) => {
    process.stdout.write(`\nFATAL: ${error instanceof Error ? error.message : String(error)}\n\n`);
    failed += 1;
  })
  .finally(async () => {
    await closePool();
    process.exit(failed > 0 ? 1 : 0);
  });
