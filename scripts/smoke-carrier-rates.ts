/**
 * Carrier-calculated shipping rates, against a running API.
 *
 *   npm run dev
 *   npm run smoke:carrier-rates
 *
 * Runs in the `veylor` shop (SMOKE_SHOP to change it) with its stand-in
 * Delhivery carrier, inside a zone of its own (Bengaluru, postcodes 5600…) so
 * the shop's real rates are not touched. Everything it creates it deletes.
 *
 * What it is written to catch:
 *
 *   - a carrier row charges the courier's price plus markup, by service:
 *     surface for standard, air or express for express
 *   - free-above still applies to a live price
 *   - when the courier cannot answer — nothing to price, switched off, its
 *     provider not connected — the row's own rate is charged and checkout
 *     carries on
 *   - a carrier row must name a carrier of this shop, and never prices pickup
 */
import { env } from '../src/config/env';
import { closePool, execute } from '../src/db/pool';

const ADMIN = `http://127.0.0.1:${env.port}${env.apiPrefix}`;
const SHOP = process.env.SMOKE_SHOP ?? 'veylor';
const CARRIER_CODE = 'delhivery';

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  ✗ ${label}\n`);
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail).slice(0, 600)}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

let token = '';
async function admin(path: string, options: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${ADMIN}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Veylog-Shop': SHOP,
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

type Option = { method: string; price: number; basePrice: number; rateSource: string; carrierService: string | null; etaMinDays: number; etaMaxDays: number };

async function quote(body: { postal_code: string; subtotal: number; weight_grams: number }) {
  const response = await admin('/shipping/quote-preview', { method: 'POST', body: { country: 'IN', ...body } });
  const options: Option[] = response.body?.options ?? response.body?.quote?.options ?? [];
  return { response, standard: options.find((o) => o.method === 'standard'), express: options.find((o) => o.method === 'express') };
}

async function main(): Promise<void> {
  process.stdout.write('\nVeylog — carrier-calculated shipping rates\n');
  await execute("DELETE FROM rate_limits WHERE bucket_key LIKE 'admin.%'");

  const login = await fetch(`${ADMIN}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.superAdmin.email, password: env.superAdmin.password }),
  }).then((r) => r.json() as Promise<{ access_token: string }>);
  token = login.access_token;

  const carriers = await admin('/shipping/carriers');
  const carrier = (carriers.body?.carriers ?? []).find((c: { code: string }) => c.code === CARRIER_CODE);
  ok(`the ${CARRIER_CODE} stand-in carrier is there`, Boolean(carrier), carriers.body);
  const carrierId: number = carrier?.id;

  // A previous run that stopped half way leaves its zone behind.
  for (const zone of (await admin('/shipping/zones')).body?.zones ?? []) {
    if (String(zone.name).startsWith('Live rates ')) await admin(`/shipping/zones/${zone.id}`, { method: 'DELETE' });
  }

  const run = Date.now().toString(36);
  const zone = await admin('/shipping/zones', { method: 'POST', body: { name: `Live rates ${run}`, areas: [{ postal_prefix: '5600' }] } });
  const zoneId: number = zone.body?.zone?.id ?? zone.body?.id;
  ok('a zone of its own', zone.status === 201 && Boolean(zoneId), zone.body);

  section('Validation');
  const noCarrier = await admin('/shipping/rates', { method: 'POST', body: { name: 'x', zone_id: zoneId, method: 'standard', rate_type: 'carrier', rate: 10 } });
  ok('a carrier rate without a carrier → 422', noCarrier.status === 422 && Boolean(noCarrier.body?.error?.details?.carrier_id), noCarrier.body);
  const unknown = await admin('/shipping/rates', { method: 'POST', body: { name: 'x', zone_id: zoneId, method: 'standard', rate_type: 'carrier', carrier_id: 999999, rate: 10 } });
  ok('…or with one that does not exist → 422', unknown.status === 422, unknown.body);
  const pickup = await admin('/shipping/rates', { method: 'POST', body: { name: 'x', zone_id: zoneId, method: 'pickup', rate_type: 'carrier', carrier_id: carrierId, rate: 0 } });
  ok('store pickup cannot be carrier-priced → 422', pickup.status === 422 && Boolean(pickup.body?.error?.details?.rate_type), pickup.body);

  const markup = { carrier_markup_percent: 10, carrier_markup_amount: 5 };
  const standardRate = await admin('/shipping/rates', {
    method: 'POST',
    body: { name: 'Live standard', zone_id: zoneId, method: 'standard', rate_type: 'carrier', carrier_id: carrierId, rate: 999, ...markup },
  });
  const expressRate = await admin('/shipping/rates', {
    method: 'POST',
    body: { name: 'Live express', zone_id: zoneId, method: 'express', rate_type: 'carrier', carrier_id: carrierId, rate: 1999, ...markup },
  });
  ok('carrier rates for standard and express', standardRate.status === 201 && expressRate.status === 201, { standardRate: standardRate.body, expressRate: expressRate.body });
  ok('…read back with their carrier and markup', standardRate.body?.rate?.rate_type === 'carrier' && standardRate.body?.rate?.carrier_id === carrierId && standardRate.body?.rate?.carrier_markup_percent === 10);
  const standardId: number = standardRate.body?.rate?.id;

  section('Live prices');
  // 1.2 kg is three 500 g slabs: surface 79 + 2×30 = 139, air 119 + 60 = 179.
  const live = await quote({ postal_code: '560001', subtotal: 1000, weight_grams: 1200 });
  ok('standard: the surface price plus 10% and ₹5 (139 → 157.90)', live.standard?.price === 157.9 && live.standard?.rateSource === 'carrier', live.response.body);
  ok('…names the service it priced', live.standard?.carrierService === `${CARRIER_CODE} Surface`, live.standard);
  ok('…with the courier’s delivery estimate', live.standard?.etaMinDays === 3 && live.standard?.etaMaxDays === 4, live.standard);
  ok('express: the cheapest air or express service (179 → 201.90)', live.express?.price === 201.9 && live.express?.carrierService === `${CARRIER_CODE} Air`, live.express);

  const heavier = await quote({ postal_code: '560001', subtotal: 1000, weight_grams: 2600 });
  ok('a heavier parcel costs more (six slabs: 229 → 256.90)', heavier.standard?.price === 256.9, heavier.standard);

  await admin(`/shipping/rates/${standardId}`, { method: 'PATCH', body: { free_above_amount: 500 } });
  const free = await quote({ postal_code: '560001', subtotal: 1000, weight_grams: 1200 });
  ok('free-above still applies to a live price', free.standard?.price === 0 && free.standard?.basePrice === 157.9, free.standard);
  await admin(`/shipping/rates/${standardId}`, { method: 'PATCH', body: { free_above_amount: null } });

  section('When the courier cannot answer');
  const nothing = await quote({ postal_code: '560001', subtotal: 1000, weight_grams: 0 });
  ok('nothing to price (no weight): the row’s own rate', nothing.standard?.price === 999 && nothing.standard?.rateSource === 'carrier_fallback', nothing.standard);

  await admin(`/shipping/carriers/${carrierId}`, { method: 'PATCH', body: { is_active: false } });
  const off = await quote({ postal_code: '560002', subtotal: 1000, weight_grams: 1200 });
  ok('carrier switched off: the fallback, and checkout carries on', off.response.status === 200 && off.standard?.price === 999 && off.standard?.rateSource === 'carrier_fallback', off.response.body);
  await admin(`/shipping/carriers/${carrierId}`, { method: 'PATCH', body: { is_active: true } });

  // Booked through an integration this shop never connected.
  await execute(`UPDATE shipping_carriers SET api_provider = 'shiprocket' WHERE id = ?`, [carrierId]);
  await admin(`/shipping/carriers/${carrierId}`, { method: 'PATCH', body: { priority: carrier.priority ?? 0 } });
  const unconnected = await quote({ postal_code: '560003', subtotal: 1000, weight_grams: 1200 });
  ok('provider not connected: the fallback, not an error', unconnected.response.status === 200 && unconnected.standard?.price === 999 && unconnected.express?.price === 1999, unconnected.response.body);
  await execute(`UPDATE shipping_carriers SET api_provider = ? WHERE id = ?`, [carrier.api_provider ?? 'dummy', carrierId]);
  await admin(`/shipping/carriers/${carrierId}`, { method: 'PATCH', body: { priority: carrier.priority ?? 0 } });

  const back = await quote({ postal_code: '560001', subtotal: 1000, weight_grams: 1200 });
  ok('reconnected: live prices again', back.standard?.price === 157.9 && back.standard?.rateSource === 'carrier', back.standard);

  section('Outside the zone, nothing changes');
  const elsewhere = await quote({ postal_code: '110001', subtotal: 1000, weight_grams: 1200 });
  ok('the shop’s own rates', (elsewhere.standard?.rateSource ?? 'table') === 'table', elsewhere.response.body);

  await admin(`/shipping/rates/${standardId}`, { method: 'DELETE' });
  await admin(`/shipping/rates/${expressRate.body?.rate?.id}`, { method: 'DELETE' });
  await admin(`/shipping/zones/${zoneId}`, { method: 'DELETE' });

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  await closePool();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  process.stderr.write(`Smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  await closePool().catch(() => undefined);
  process.exit(1);
});
