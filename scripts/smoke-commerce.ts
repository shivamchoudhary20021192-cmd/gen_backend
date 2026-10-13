/**
 * End-to-end smoke test for the orders and customers admin APIs.
 *
 *   npm run dev              # in one shell
 *   npm run smoke:commerce   # in another
 *
 * There is no checkout yet, so this seeds a realistic paid order straight into
 * the tables the storefront will eventually write, then drives it through the
 * whole lifecycle over HTTP: confirm → pack → ship → deliver, and separately
 * cancel-with-restock and refund on their own orders.
 *
 * What it is actually checking is the arithmetic and the guards, not the happy
 * path: that stock comes back exactly once, that a refund cannot exceed what
 * was paid, and that illegal transitions are refused rather than quietly
 * written.
 */
import { env } from '../src/config/env';
import { closePool, execute, query, queryOne, type RowDataPacket } from '../src/db/pool';

const BASE = `http://127.0.0.1:${env.port}${env.apiPrefix}`;

/**
 * The shop the fixtures below belong to: the founding shop unless told
 * otherwise. Tenant tables have no shop_id default, so every seeded row names
 * its shop — exactly what application code has to do.
 */
const SHOP_ID = Number(process.env.SMOKE_SHOP_ID ?? 1);

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
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail).slice(0, 400)}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string;
  headers?: Record<string, string>;
}

async function call(path: string, options: CallOptions = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const stamp = Date.now().toString(36).toUpperCase().slice(-6);

interface SeededOrder {
  orderId: number;
  orderNumber: string;
  variantId: number;
  quantity: number;
  stockBefore: number;
  grandTotal: number;
}

/** A variant that has an inventory row, so restock assertions mean something. */
async function pickVariant(): Promise<{ variantId: number; productId: number; sku: string; name: string }> {
  const row = await queryOne<RowDataPacket & { variant_id: number; product_id: number; sku: string; name: string }>(
    `SELECT v.id AS variant_id, v.product_id, v.sku, p.name
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       JOIN inventory_items i ON i.variant_id = v.id
      WHERE p.shop_id = ? AND p.deleted_at IS NULL
      ORDER BY v.id LIMIT 1`,
    [SHOP_ID],
  );
  if (!row) throw new Error('No variant with an inventory row — run the product smoke test first.');
  return { variantId: row.variant_id, productId: row.product_id, sku: row.sku, name: row.name };
}

async function stockOf(variantId: number): Promise<number> {
  const row = await queryOne<RowDataPacket & { quantity_on_hand: number }>(
    'SELECT quantity_on_hand FROM inventory_items WHERE variant_id = ? ORDER BY id LIMIT 1',
    [variantId],
  );
  return Number(row?.quantity_on_hand ?? 0);
}

async function seedOrder(
  customerId: number,
  suffix: string,
  options: { paid: boolean; codPending?: boolean } = { paid: true },
): Promise<SeededOrder> {
  const variant = await pickVariant();
  const stockBefore = await stockOf(variant.variantId);

  const quantity = 2;
  const unitPrice = 699;
  const subtotal = unitPrice * quantity;
  const taxRate = 18;
  const taxable = Number((subtotal / (1 + taxRate / 100)).toFixed(2));
  const tax = Number((subtotal - taxable).toFixed(2));
  const shipping = 0;
  const grandTotal = subtotal + shipping;

  const orderNumber = `VEY${stamp}${suffix}`;
  const paid = options.paid ? grandTotal : 0;

  const orderId = await execute(
    `INSERT INTO orders
       (shop_id, order_number, public_id, customer_id, is_guest, contact_phone, contact_email, customer_name,
        currency, order_status, payment_status, fulfillment_status, payment_method,
        subtotal, discount_total, shipping_total, tax_total, cgst_total, sgst_total, grand_total,
        amount_paid, amount_due, pincode, shipping_method, source_channel, placed_at)
     VALUES (?, ?, UUID(), ?, 0, ?, ?, ?, 'INR', 'pending', ?, 'unfulfilled', ?,
             ?, 0, ?, ?, ?, ?, ?, ?, ?, '560001', 'standard', 'web', NOW())`,
    [
      SHOP_ID,
      orderNumber,
      customerId,
      '9000000001',
      `smoke.${stamp.toLowerCase()}@example.com`,
      'Smoke Customer',
      options.codPending ? 'cod_pending' : options.paid ? 'paid' : 'pending',
      options.codPending ? 'cod' : 'razorpay',
      subtotal,
      shipping,
      tax,
      Number((tax / 2).toFixed(2)),
      Number((tax / 2).toFixed(2)),
      grandTotal,
      paid,
      grandTotal - paid,
    ],
  ).then((r) => r.insertId);

  await execute(
    `INSERT INTO order_items
       (shop_id, order_id, product_id, variant_id, line_type, sku, product_name, unit_mrp, unit_price,
        quantity, discount_amount, taxable_amount, tax_rate, cgst_amount, sgst_amount, tax_amount, line_total)
     VALUES (?, ?, ?, ?, 'product', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    [
      SHOP_ID,
      orderId,
      variant.productId,
      variant.variantId,
      variant.sku,
      variant.name,
      799,
      unitPrice,
      quantity,
      taxable,
      taxRate,
      Number((tax / 2).toFixed(2)),
      Number((tax / 2).toFixed(2)),
      tax,
      subtotal,
    ],
  );

  await execute(
    `INSERT INTO order_addresses
       (shop_id, order_id, address_type, first_name, last_name, phone, line1, city, state, state_code, pincode, country)
     VALUES (?, ?, 'shipping', 'Smoke', 'Customer', '9000000001', '1 Test Street', 'Bengaluru', 'Karnataka', '29', '560001', 'IN')`,
    [SHOP_ID, orderId],
  );

  if (options.paid) {
    await execute(
      `INSERT INTO payments (shop_id, order_id, gateway, gateway_payment_id, signature_verified, method, amount, currency, status, captured_at)
       VALUES (?, ?, 'razorpay', ?, 1, 'upi', ?, 'INR', 'captured', NOW())`,
      [SHOP_ID, orderId, `pay_smoke_${stamp}${suffix}`, grandTotal],
    );
  }

  return { orderId, orderNumber, variantId: variant.variantId, quantity, stockBefore, grandTotal };
}

async function seedCustomer(): Promise<number> {
  const phone = `98${Date.now().toString().slice(-8)}`;
  const result = await execute(
    `INSERT INTO customers (shop_id, public_id, country_code, phone, email, first_name, last_name, status, phone_verified_at, signup_source)
     VALUES (?, UUID(), '+91', ?, ?, 'Smoke', 'Customer', 'active', NOW(), 'admin')`,
    [SHOP_ID, phone, `smoke.${stamp.toLowerCase()}@example.com`],
  );
  return result.insertId;
}

async function main(): Promise<void> {
  process.stdout.write('\nVeylog — orders & customers API\n');

  // Repeat runs must not trip the login limiter.
  await execute("DELETE FROM rate_limits WHERE bucket_key LIKE 'admin.%'");

  section('Auth');
  const login = await call('/auth/login', {
    method: 'POST',
    body: { email: env.superAdmin.email, password: env.superAdmin.password },
  });
  ok('super admin signs in', login.status === 200, login.body);
  const token = login.body?.access_token as string;
  if (!token) throw new Error('No token — cannot continue.');

  // ── customers ──────────────────────────────────────────────────────────────
  section('Customers');
  const customerId = await seedCustomer();

  const list = await call('/customers?limit=5', { token });
  ok('customer list responds', list.status === 200, list.body);
  const listed = list.body?.customers?.find((c: any) => c.id === customerId);
  ok('the seeded customer is listed', Boolean(listed));
  ok(
    'phone is masked in the list',
    typeof listed?.phone === 'string' && listed.phone.includes('•'),
    listed?.phone,
  );

  const detail = await call(`/customers/${customerId}`, { token });
  ok('detail responds', detail.status === 200, detail.body);
  ok(
    'phone is NOT masked in the detail view',
    typeof detail.body?.customer?.phone === 'string' && !detail.body.customer.phone.includes('•'),
    detail.body?.customer?.phone,
  );
  ok('detail carries addresses, notes and consents', Array.isArray(detail.body?.customer?.notes));

  const search = await call(`/customers?q=${detail.body.customer.phone.slice(-4)}`, { token });
  ok(
    'searching by the last four digits of a phone finds them',
    search.body?.customers?.some((c: any) => c.id === customerId),
  );

  const patched = await call(`/customers/${customerId}`, {
    method: 'PATCH',
    token,
    body: { customer: { first_name: 'Renamed', accepts_email_marketing: true } },
  });
  ok('customer update applies', patched.status === 200 && patched.body?.customer?.first_name === 'Renamed', patched.body);
  ok('marketing consent flag round-trips', patched.body?.customer?.marketing?.email === true);

  const noted = await call(`/customers/${customerId}/notes`, {
    method: 'POST',
    token,
    body: { note: 'Called about a late delivery.', is_pinned: true },
  });
  ok('a note can be added', noted.status === 201 && noted.body?.notes?.length > 0, noted.body);
  ok('the note records who wrote it', Boolean(noted.body?.notes?.[0]?.author));

  const blocked = await call(`/customers/${customerId}/block`, {
    method: 'POST',
    token,
    body: { reason: 'Smoke test' },
  });
  ok('blocking works', blocked.status === 200 && blocked.body?.customer?.status === 'blocked', blocked.body);
  const unblocked = await call(`/customers/${customerId}/unblock`, { method: 'POST', token });
  ok('unblocking works', unblocked.body?.customer?.status === 'active');

  // ── order lifecycle ────────────────────────────────────────────────────────
  section('Order lifecycle');
  const main = await seedOrder(customerId, 'A', { paid: true });

  const orderDetail = await call(`/orders/${main.orderId}`, { token });
  ok('order detail responds', orderDetail.status === 200, orderDetail.body);
  ok('items are included', orderDetail.body?.order?.items?.length === 1);
  ok('the shipping address is included', Boolean(orderDetail.body?.order?.shipping_address));
  ok(
    'totals include what is still refundable',
    orderDetail.body?.order?.totals?.refundable === main.grandTotal,
    orderDetail.body?.order?.totals,
  );
  ok(
    'the response advertises the legal next statuses',
    Array.isArray(orderDetail.body?.order?.next_statuses) &&
      orderDetail.body.order.next_statuses.includes('confirmed'),
    orderDetail.body?.order?.next_statuses,
  );

  const illegal = await call(`/orders/${main.orderId}/status`, {
    method: 'POST',
    token,
    body: { status: 'delivered' },
  });
  ok(
    'pending → delivered is refused',
    illegal.status === 409 && illegal.body?.error?.code === 'INVALID_TRANSITION',
    illegal.body,
  );

  const confirmed = await call(`/orders/${main.orderId}/status`, {
    method: 'POST',
    token,
    body: { status: 'confirmed', note: 'Payment verified' },
  });
  ok('pending → confirmed is allowed', confirmed.body?.order?.order_status === 'confirmed', confirmed.body);

  await call(`/orders/${main.orderId}/status`, { method: 'POST', token, body: { status: 'packed' } });

  const shipped = await call(`/orders/${main.orderId}/ship`, {
    method: 'POST',
    token,
    headers: { 'Idempotency-Key': `ship-${stamp}` },
    body: { awb_number: `AWB${stamp}`, shipping_mode: 'surface', weight_grams: 400 },
  });
  ok('shipping the whole order works', shipped.status === 200, shipped.body);
  ok('it becomes fulfilled', shipped.body?.order?.fulfillment_status === 'fulfilled');
  ok('it moves to shipped', shipped.body?.order?.order_status === 'shipped');
  ok('a shipment row is attached', shipped.body?.order?.shipments?.length === 1, shipped.body?.order?.shipments);
  ok('the AWB is recorded', shipped.body?.order?.shipments?.[0]?.awb_number === `AWB${stamp}`);

  const delivered = await call(`/orders/${main.orderId}/status`, {
    method: 'POST',
    token,
    body: { status: 'delivered' },
  });
  ok('it can be delivered', delivered.body?.order?.order_status === 'delivered', delivered.body);
  ok(
    'the shipment is marked delivered too',
    delivered.body?.order?.shipments?.[0]?.status === 'delivered',
  );
  ok(
    'the timeline records every step',
    (delivered.body?.order?.timeline?.length ?? 0) >= 4,
    delivered.body?.order?.timeline?.map((t: any) => t.to),
  );

  // ── cancel restores stock ──────────────────────────────────────────────────
  section('Cancel and restock');
  const toCancel = await seedOrder(customerId, 'B', { paid: true });
  await call(`/orders/${toCancel.orderId}/status`, { method: 'POST', token, body: { status: 'confirmed' } });

  const stockBeforeCancel = await stockOf(toCancel.variantId);
  const cancelled = await call(`/orders/${toCancel.orderId}/cancel`, {
    method: 'POST',
    token,
    body: { reason: 'Customer changed their mind' },
  });
  ok('cancelling works', cancelled.body?.order?.order_status === 'cancelled', cancelled.body);
  const stockAfterCancel = await stockOf(toCancel.variantId);
  ok(
    'stock comes back exactly once',
    stockAfterCancel === stockBeforeCancel + toCancel.quantity,
    { before: stockBeforeCancel, after: stockAfterCancel, expected: stockBeforeCancel + toCancel.quantity },
  );

  const movement = await queryOne<RowDataPacket & { movement_type: string; quantity_delta: number }>(
    `SELECT movement_type, quantity_delta FROM inventory_movements
      WHERE reference_type = 'order' AND reference_id = ? ORDER BY id DESC LIMIT 1`,
    [toCancel.orderId],
  );
  ok(
    'the ledger explains why stock moved',
    movement?.movement_type === 'cancellation' && Number(movement.quantity_delta) === toCancel.quantity,
    movement,
  );

  const cancelAgain = await call(`/orders/${toCancel.orderId}/cancel`, {
    method: 'POST',
    token,
    body: { reason: 'Double click' },
  });
  ok('a cancelled order cannot be cancelled twice', cancelAgain.status === 409, cancelAgain.body);
  ok(
    'and stock is not restored a second time',
    (await stockOf(toCancel.variantId)) === stockAfterCancel,
  );

  // ── refunds ────────────────────────────────────────────────────────────────
  section('Refunds');
  const toRefund = await seedOrder(customerId, 'C', { paid: true });

  const tooMuch = await call(`/orders/${toRefund.orderId}/refund`, {
    method: 'POST',
    token,
    headers: { 'Idempotency-Key': `refund-over-${stamp}` },
    body: { amount: toRefund.grandTotal + 1000, reason: 'Overshoot' },
  });
  ok('a refund larger than the payment is refused', tooMuch.status === 422, tooMuch.body);

  const partial = await call(`/orders/${toRefund.orderId}/refund`, {
    method: 'POST',
    token,
    headers: { 'Idempotency-Key': `refund-part-${stamp}` },
    body: { amount: 100, reason: 'Damaged outer box' },
  });
  ok('a partial refund is recorded', partial.status === 200, partial.body);
  ok('payment status becomes partially_refunded', partial.body?.order?.payment_status === 'partially_refunded');
  ok('the refundable balance drops', partial.body?.order?.totals?.refundable === toRefund.grandTotal - 100);
  /**
   * The invariant is "not processed", not "pending".
   *
   * `pending` was the only possible state while nothing called the gateway.
   * Now a gateway-backed refund is sent immediately and sits at `processing`
   * until Razorpay's webhook says the bank has it, while a COD or manual refund
   * still rests at `pending` for someone to pay out by hand. Either is correct;
   * what must never be true yet is `processed`, because that is the word the
   * customer is shown to mean "your money is back".
   */
  ok(
    'the refund has not been marked processed — no money has landed yet',
    ['pending', 'processing'].includes(partial.body?.order?.refunds?.[0]?.status ?? ''),
    partial.body?.order?.refunds,
  );

  const rest = await call(`/orders/${toRefund.orderId}/refund`, {
    method: 'POST',
    token,
    headers: { 'Idempotency-Key': `refund-rest-${stamp}` },
    body: { reason: 'Returned in full' },
  });
  ok('omitting the amount refunds the remaining balance', rest.status === 200, rest.body);
  ok('payment status becomes refunded', rest.body?.order?.payment_status === 'refunded');
  ok('nothing is left refundable', rest.body?.order?.totals?.refundable === 0);

  const overRefund = await call(`/orders/${toRefund.orderId}/refund`, {
    method: 'POST',
    token,
    headers: { 'Idempotency-Key': `refund-again-${stamp}` },
    body: { amount: 50, reason: 'Third attempt' },
  });
  ok('a fully refunded order refuses more', overRefund.status === 409, overRefund.body);

  // ── COD is collected on delivery ───────────────────────────────────────────
  section('Cash on delivery');
  const cod = await seedOrder(customerId, 'D', { paid: false, codPending: true });
  await call(`/orders/${cod.orderId}/status`, { method: 'POST', token, body: { status: 'confirmed' } });
  await call(`/orders/${cod.orderId}/status`, { method: 'POST', token, body: { status: 'packed' } });
  await call(`/orders/${cod.orderId}/ship`, {
    method: 'POST',
    token,
    headers: { 'Idempotency-Key': `ship-cod-${stamp}` },
    body: { awb_number: `AWBCOD${stamp}` },
  });
  const codDelivered = await call(`/orders/${cod.orderId}/status`, {
    method: 'POST',
    token,
    body: { status: 'delivered' },
  });
  ok(
    'delivering a COD order collects the money',
    codDelivered.body?.order?.payment_status === 'cod_collected',
    codDelivered.body?.order,
  );
  ok('and clears the amount due', codDelivered.body?.order?.amount_due === 0);

  // ── filters and stats ──────────────────────────────────────────────────────
  section('Filters and stats');
  const byCustomer = await call(`/orders?customer_id=${customerId}`, { token });
  ok('orders can be filtered by customer', (byCustomer.body?.pagination?.total ?? 0) >= 4, byCustomer.body?.pagination);

  const byNumber = await call(`/orders?q=${main.orderNumber}`, { token });
  ok('searching by order number finds it', byNumber.body?.orders?.[0]?.order_number === main.orderNumber);

  const counts = await call('/orders/counts', { token });
  ok('status counts respond', counts.status === 200 && typeof counts.body?.counts === 'object', counts.body);
  ok('"counts" is not read as an order id', counts.body?.error === undefined);

  const cancelledOnly = await call('/orders?order_status=cancelled', { token });
  ok(
    'filtering by status returns only that status',
    (cancelledOnly.body?.orders ?? []).every((o: any) => o.order_status === 'cancelled'),
  );

  const stats = await call(`/customers/${customerId}`, { token });
  ok(
    'customer order stats are recomputed, not left at zero',
    (stats.body?.customer?.stats?.orders_count ?? 0) > 0,
    stats.body?.customer?.stats,
  );

  // ── permissions ────────────────────────────────────────────────────────────
  section('Permissions');
  const roles = await call('/roles', { token });
  const contentRole = roles.body?.roles?.find((r: any) => r.slug === 'content');
  if (contentRole) {
    const email = `commerce.smoke.${stamp.toLowerCase()}@veylor.com`;
    const password = `SmokePass${stamp}1`;
    const created = await call('/admin-users', {
      method: 'POST',
      token,
      body: {
        admin_user: {
          email,
          password,
          first_name: 'Commerce',
          last_name: 'Smoke',
          role_ids: [contentRole.id],
          must_change_password: false,
        },
      },
    });
    ok('a content-only admin can be created', created.status === 201, created.body);

    const theirLogin = await call('/auth/login', { method: 'POST', body: { email, password } });
    const theirToken = theirLogin.body?.access_token as string;
    const theirOrders = await call('/orders', { token: theirToken });
    ok('a role without orders.view is refused the order list', theirOrders.status === 403, theirOrders.status);
    const theirCustomers = await call('/customers', { token: theirToken });
    ok('and refused the customer list', theirCustomers.status === 403, theirCustomers.status);

    await execute('DELETE FROM admin_users WHERE email = ?', [email]);
  } else {
    ok('the content role exists to test against', false, roles.body);
  }

  // ── audit ──────────────────────────────────────────────────────────────────
  section('Audit trail');
  const auditRows = await query<RowDataPacket & { action: string }>(
    "SELECT action FROM audit_logs WHERE entity_type = 'order' AND entity_id = ? ORDER BY id",
    [main.orderId],
  );
  ok(
    'every order action is audited',
    auditRows.length >= 3,
    auditRows.map((r) => r.action),
  );

  process.stdout.write(`\n${'='.repeat(52)}\n`);
  process.stdout.write(`  ${passed} passed, ${failed} failed\n`);
  if (failures.length) process.stdout.write(`\n  Failed:\n${failures.map((f) => `    - ${f}`).join('\n')}\n`);
  process.stdout.write(`${'='.repeat(52)}\n\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`\nCommerce smoke crashed: ${String(error?.stack ?? error)}\n`);
    failed += 1;
  })
  .finally(async () => {
    await closePool();
    process.exit(failed === 0 ? 0 : 1);
  });
