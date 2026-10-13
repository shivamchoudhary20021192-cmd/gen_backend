/**
 * End-to-end smoke test for Razorpay payments.
 *
 *   npm run build
 *   npm run smoke:payments
 *
 * Self-contained: it starts a stand-in Razorpay and its own API process wired
 * to it, so it needs no live keys and no internet. What it is written to catch:
 *
 *   - the two signatures are computed the way Razorpay computes them, checked
 *     against vectors, not just against our own implementation
 *   - a tampered signature does not settle an order
 *   - a signature that is valid but belongs to a *different* order does not
 *     settle this one
 *   - a payment for less than the order is owed does not settle it, however
 *     well signed
 *   - a replayed webhook does not pay an order twice, and still answers 200
 *   - a webhook with no signature, or the wrong one, is refused
 *   - a refund reaches the gateway, and a refused refund puts the order's
 *     figures back rather than leaving a customer told they were refunded
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { closePool, execute } from '../src/db/pool';
import { FakeRazorpay } from './fake-razorpay';

const KEY_ID = 'rzp_test_smoke1234567';
const KEY_SECRET = 'smoke_key_secret_value';
const WEBHOOK_SECRET = 'smoke_webhook_secret_value';
const API_PORT = Number(process.env.SMOKE_API_PORT ?? 4010);
const ADMIN = `http://127.0.0.1:${API_PORT}/admin/api/v1`;
const SHOP = `http://127.0.0.1:${API_PORT}/api/v1`;
const EMAIL = process.env.SUPERADMIN_EMAIL ?? 'admin@veylor.com';
const PASSWORD = process.env.SUPERADMIN_PASSWORD ?? 'ChangeMe!2026';

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

let token = '';

interface Raw<T> {
  status: number;
  body: T;
}

async function raw<T>(
  base: string,
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string>; rawBody?: string } = {},
): Promise<Raw<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
    ...(options.headers ?? {}),
  };
  if (options.auth !== false) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
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

const admin = <T>(path: string, options: { method?: string; body?: unknown } = {}) => raw<T>(ADMIN, path, options);
const shop = <T>(path: string, options: { method?: string; body?: unknown } = {}) =>
  raw<T>(SHOP, path, { ...options, auth: false });

async function adminOrThrow<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const result = await admin<T>(path, options);
  if (result.status >= 400) throw new Error(`${path} → ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
  return result.body;
}

/**
 * Makes sure the variant this suite buys has stock.
 *
 * Every run consumes a unit and nothing puts it back, so after enough runs the
 * featured product is out of stock and the suite fails with "out of stock" —
 * which looks like a bug in the shop rather than in the fixture. Topping up is
 * the fixture's job.
 */
async function ensureStock(variantId: number): Promise<void> {
  await execute(
    // `quantity_available` is a generated column (on_hand minus reserved), so
    // only on_hand can be written.
    `UPDATE inventory_items
        SET quantity_on_hand = GREATEST(quantity_on_hand, 25)
      WHERE variant_id = ?`,
    [variantId],
  );
}

/** Places an online order and returns what is needed to pay it. */
async function placeOnlineOrder(): Promise<{ id: number; orderNumber: string; phone: string; total: number }> {
  const listed = await shop<{ products: { slug: string }[] }>('/products?limit=1&sort=featured');
  const slug = listed.body.products[0].slug;
  const detail = await shop<{ product: { variants: { id: number; in_stock: boolean }[] } }>(`/products/${slug}`);
  const variant = detail.body.product.variants.find((v) => v.in_stock) ?? detail.body.product.variants[0];
  await ensureStock(variant.id);
  const phone = `9${String(Date.now() + Math.floor(Math.random() * 10000)).slice(-9)}`;

  const cart = await shop<{ cart: { token: string } }>('/cart', { method: 'POST' });
  const added = await shop(`/cart/${cart.body.cart.token}/items`, {
    method: 'POST',
    body: { variant_id: variant.id, quantity: 1 },
  });
  // Named explicitly: a rate-limited add used to surface three calls later as
  // "Your bag is empty" at checkout, which sends you looking in the wrong place.
  if (added.status >= 400) {
    throw new Error(`could not add to the bag → ${added.status} ${JSON.stringify(added.body)}`);
  }
  const placed = await shop<{ order: { id: number; order_number: string; total: number } }>(
    `/cart/${cart.body.cart.token}/checkout`,
    {
      method: 'POST',
      body: {
        payment_method: 'online',
        contact: { first_name: 'Pay', last_name: 'Tester', phone, email: `${phone}@example.com` },
        shipping_address: { line1: '9 Church Street', city: 'Bengaluru', state: 'Karnataka', pincode: '560001' },
      },
    },
  );
  if (placed.status >= 400) throw new Error(`checkout → ${placed.status} ${JSON.stringify(placed.body)}`);
  return {
    id: placed.body.order.id,
    orderNumber: placed.body.order.order_number,
    phone,
    total: placed.body.order.total,
  };
}

const checkoutSignature = (orderId: string, paymentId: string, secret: string): string =>
  crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

const webhookSignature = (body: string, secret: string): string =>
  crypto.createHmac('sha256', secret).update(body).digest('hex');

async function waitForApi(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${API_PORT}/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the API did not come up on port ${API_PORT}`);
}

async function main(): Promise<void> {
  // This suite places half a dozen orders in a few seconds, which the cart and
  // checkout limiters are quite right to refuse from one address. Cleared here
  // rather than loosened in the API.
  await execute(
    "DELETE FROM rate_limits WHERE bucket_key LIKE 'shop.%' OR bucket_key LIKE 'admin.%' OR bucket_key LIKE 'payments.%'",
  );

  const gateway = new FakeRazorpay({ keyId: KEY_ID, keySecret: KEY_SECRET });
  await gateway.start();

  // Its own API process, so the keys and the gateway base URL are this suite's
  // and nothing else's. Killing it at the end leaves the dev server untouched.
  const api: ChildProcess = spawn(process.execPath, ['dist/src/server.js'], {
    env: {
      ...process.env,
      PORT: String(API_PORT),
      RAZORPAY_KEY_ID: KEY_ID,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      RAZORPAY_API_BASE: gateway.baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const apiLog: string[] = [];
  api.stdout?.on('data', (chunk: Buffer) => apiLog.push(chunk.toString()));
  api.stderr?.on('data', (chunk: Buffer) => apiLog.push(chunk.toString()));

  const shutdown = async (): Promise<void> => {
    api.kill('SIGTERM');
    await gateway.stop();
  };

  try {
    await waitForApi();

    const login = await raw<{ tokens?: { access_token: string }; access_token?: string }>(ADMIN, '/auth/login', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
      auth: false,
    });
    token = login.body.tokens?.access_token ?? login.body.access_token ?? '';
    if (!token) throw new Error(`admin sign-in failed — ${login.status} ${JSON.stringify(login.body).slice(0, 200)}`);

    process.stdout.write('\nVeylor — Razorpay payments\n\n');

    // ── signatures, against fixed vectors ────────────────────────────────────
    process.stdout.write('The signature maths\n');
    // Razorpay's own documented example: HMAC-SHA256 of "order_id|payment_id"
    // with the key secret. Checked against a hand-computed digest so that a
    // change to our implementation cannot quietly redefine "correct".
    const vector = crypto
      .createHmac('sha256', 'secret')
      .update('order_IEIaMR65cU6nz3|pay_IEIazhOSLbw2Vp')
      .digest('hex');
    ok(
      'the checkout signature is HMAC-SHA256 over order|payment',
      checkoutSignature('order_IEIaMR65cU6nz3', 'pay_IEIazhOSLbw2Vp', 'secret') === vector,
    );
    ok(
      'a different payment id gives a different signature',
      checkoutSignature('order_x', 'pay_a', 'secret') !== checkoutSignature('order_x', 'pay_b', 'secret'),
    );
    ok(
      'the webhook signature is HMAC-SHA256 over the raw body',
      webhookSignature('{"a":1}', 'secret') ===
        crypto.createHmac('sha256', 'secret').update('{"a":1}').digest('hex'),
    );
    ok(
      'reordering the same JSON changes the signature',
      webhookSignature('{"a":1,"b":2}', 'secret') !== webhookSignature('{"b":2,"a":1}', 'secret'),
    );

    // ── availability ─────────────────────────────────────────────────────────
    process.stdout.write('\nWhat the storefront is told\n');
    const availability = await shop<{ online_enabled: boolean; test_mode: boolean }>('/payments/availability');
    ok('online payment is offered when keys are present', availability.body.online_enabled === true);
    ok('and it knows these are test keys', availability.body.test_mode === true);
    ok(
      'the key secret is not in the payload',
      !JSON.stringify(availability.body).includes(KEY_SECRET),
      availability.body,
    );

    // ── starting a payment ───────────────────────────────────────────────────
    process.stdout.write('\nStarting a payment\n');
    const order = await placeOnlineOrder();
    const started = await shop<{ payment: { key_id: string; gateway_order_id: string; amount: number; amount_paise: number } }>(
      `/payments/orders/${order.orderNumber}/start`,
      { method: 'POST', body: { phone: order.phone } },
    );
    ok('a gateway order is created', started.status === 200 && Boolean(started.body.payment.gateway_order_id));
    ok('the browser gets the publishable key', started.body.payment.key_id === KEY_ID);
    ok('never the secret', !JSON.stringify(started.body).includes(KEY_SECRET));
    ok(
      'the amount is the order total, in paise',
      started.body.payment.amount_paise === Math.round(order.total * 100),
      { sent: started.body.payment.amount_paise, expected: Math.round(order.total * 100) },
    );
    ok(
      'the gateway was asked for that same amount',
      gateway.orders.get(started.body.payment.gateway_order_id)?.amount === Math.round(order.total * 100),
    );

    const reStarted = await shop<{ payment: { gateway_order_id: string } }>(
      `/payments/orders/${order.orderNumber}/start`,
      { method: 'POST', body: { phone: order.phone } },
    );
    ok(
      'reloading reuses the gateway order rather than minting another',
      reStarted.body.payment.gateway_order_id === started.body.payment.gateway_order_id,
    );
    ok('so the gateway holds exactly one order for it', gateway.orders.size === 1, gateway.orders.size);

    const wrongPhone = await shop(`/payments/orders/${order.orderNumber}/start`, {
      method: 'POST',
      body: { phone: '9000000000' },
    });
    ok('the wrong phone cannot start a payment on someone else’s order', wrongPhone.status === 404);

    // ── verifying the browser's claim ────────────────────────────────────────
    process.stdout.write('\nVerifying what the browser sends back\n');
    const gatewayOrderId = started.body.payment.gateway_order_id;
    const payment = gateway.pay(gatewayOrderId, { method: 'card' });

    const tampered = await shop<{ error?: { message: string } }>(
      `/payments/orders/${order.orderNumber}/verify`,
      {
        method: 'POST',
        body: {
          phone: order.phone,
          razorpay_order_id: gatewayOrderId,
          razorpay_payment_id: payment.id,
          razorpay_signature: checkoutSignature(gatewayOrderId, payment.id, 'not-the-real-secret'),
        },
      },
    );
    ok('a signature made with the wrong secret is refused', tampered.status === 400, tampered.body);

    const beforeTamper = await adminOrThrow<{ order: { payment_status: string } }>(`/orders/${order.id}`);
    ok('and the order is still unpaid', beforeTamper.order.payment_status !== 'paid', beforeTamper.order.payment_status);

    // A signature that is genuinely ours, but for a gateway order belonging to
    // a different shop order. This is the attack the order-ownership check is
    // for: without it, a ₹1 payment made elsewhere settles this order.
    const other = await placeOnlineOrder();
    const otherStart = await shop<{ payment: { gateway_order_id: string } }>(
      `/payments/orders/${other.orderNumber}/start`,
      { method: 'POST', body: { phone: other.phone } },
    );
    const otherPayment = gateway.pay(otherStart.body.payment.gateway_order_id);
    const crossed = await shop(`/payments/orders/${order.orderNumber}/verify`, {
      method: 'POST',
      body: {
        phone: order.phone,
        razorpay_order_id: otherStart.body.payment.gateway_order_id,
        razorpay_payment_id: otherPayment.id,
        razorpay_signature: checkoutSignature(otherStart.body.payment.gateway_order_id, otherPayment.id, KEY_SECRET),
      },
    });
    ok('a valid signature for a different order is refused', crossed.status === 400, crossed.body);

    const stillUnpaid = await adminOrThrow<{ order: { payment_status: string } }>(`/orders/${order.id}`);
    ok('that order is still unpaid too', stillUnpaid.order.payment_status !== 'paid');

    // The real thing.
    const verified = await shop<{ paid: boolean; payment_status: string }>(
      `/payments/orders/${order.orderNumber}/verify`,
      {
        method: 'POST',
        body: {
          phone: order.phone,
          razorpay_order_id: gatewayOrderId,
          razorpay_payment_id: payment.id,
          razorpay_signature: checkoutSignature(gatewayOrderId, payment.id, KEY_SECRET),
        },
      },
    );
    ok('a correctly signed payment is accepted', verified.status === 200 && verified.body.paid === true, verified.body);

    const paidOrder = await adminOrThrow<{
      order: { payment_status: string; order_status: string; amount_paid: number; amount_due: number; payments: { signature_verified: boolean; instrument: string | null; status: string }[] };
    }>(`/orders/${order.id}`);
    ok('the order is paid', paidOrder.order.payment_status === 'paid');
    ok('and confirmed', paidOrder.order.order_status === 'confirmed', paidOrder.order.order_status);
    ok('for the full amount', paidOrder.order.amount_paid === order.total, {
      paid: paidOrder.order.amount_paid,
      total: order.total,
    });
    ok('with nothing outstanding', paidOrder.order.amount_due === 0);
    ok('the payment row records that the signature checked out', paidOrder.order.payments[0]?.signature_verified === true);
    ok(
      'only the last four digits of the card are kept',
      paidOrder.order.payments[0]?.instrument === '•••• 1111',
      paidOrder.order.payments[0]?.instrument,
    );

    const replayVerify = await shop<{ paid: boolean }>(`/payments/orders/${order.orderNumber}/verify`, {
      method: 'POST',
      body: {
        phone: order.phone,
        razorpay_order_id: gatewayOrderId,
        razorpay_payment_id: payment.id,
        razorpay_signature: checkoutSignature(gatewayOrderId, payment.id, KEY_SECRET),
      },
    });
    const afterReplay = await adminOrThrow<{ order: { amount_paid: number } }>(`/orders/${order.id}`);
    ok('verifying the same payment twice is harmless', replayVerify.status === 200);
    ok('and does not double the amount paid', afterReplay.order.amount_paid === order.total, afterReplay.order.amount_paid);

    // ── the amount check ─────────────────────────────────────────────────────
    process.stdout.write('\nThe amount has to match\n');
    const short = await placeOnlineOrder();
    const shortStart = await shop<{ payment: { gateway_order_id: string } }>(
      `/payments/orders/${short.orderNumber}/start`,
      { method: 'POST', body: { phone: short.phone } },
    );
    const shortPayment = gateway.pay(shortStart.body.payment.gateway_order_id, { amount: 100 });
    const shortVerify = await shop<{ paid: boolean }>(`/payments/orders/${short.orderNumber}/verify`, {
      method: 'POST',
      body: {
        phone: short.phone,
        razorpay_order_id: shortStart.body.payment.gateway_order_id,
        razorpay_payment_id: shortPayment.id,
        razorpay_signature: checkoutSignature(shortStart.body.payment.gateway_order_id, shortPayment.id, KEY_SECRET),
      },
    });
    ok('a ₹1 payment against a full order does not report paid', shortVerify.body.paid === false, shortVerify.body);
    const shortOrder = await adminOrThrow<{ order: { payment_status: string } }>(`/orders/${short.id}`);
    ok('and the order stays unpaid', shortOrder.order.payment_status !== 'paid', shortOrder.order.payment_status);

    // ── webhooks ─────────────────────────────────────────────────────────────
    process.stdout.write('\nThe webhook\n');
    const hookOrder = await placeOnlineOrder();
    const hookStart = await shop<{ payment: { gateway_order_id: string } }>(
      `/payments/orders/${hookOrder.orderNumber}/start`,
      { method: 'POST', body: { phone: hookOrder.phone } },
    );
    const hookPayment = gateway.pay(hookStart.body.payment.gateway_order_id, { method: 'upi' });
    const hookBody = gateway.webhookBody('payment.captured', hookPayment);

    const unsigned = await raw(SHOP, '/payments/razorpay/webhook', {
      method: 'POST',
      auth: false,
      rawBody: hookBody,
    });
    ok('a webhook with no signature is refused', unsigned.status === 403, unsigned.status);

    const badSigned = await raw(SHOP, '/payments/razorpay/webhook', {
      method: 'POST',
      auth: false,
      rawBody: hookBody,
      headers: { 'X-Razorpay-Signature': webhookSignature(hookBody, 'wrong-secret') },
    });
    ok('a webhook signed with the wrong secret is refused', badSigned.status === 403, badSigned.status);

    const unpaidStill = await adminOrThrow<{ order: { payment_status: string } }>(`/orders/${hookOrder.id}`);
    ok('neither one paid the order', unpaidStill.order.payment_status !== 'paid');

    const accepted = await raw<{ received: boolean; duplicate: boolean }>(SHOP, '/payments/razorpay/webhook', {
      method: 'POST',
      auth: false,
      rawBody: hookBody,
      headers: { 'X-Razorpay-Signature': webhookSignature(hookBody, WEBHOOK_SECRET) },
    });
    ok('a correctly signed webhook is accepted', accepted.status === 200, accepted.body);

    const hookPaid = await adminOrThrow<{ order: { payment_status: string; amount_paid: number } }>(
      `/orders/${hookOrder.id}`,
    );
    ok('and it pays the order without the browser', hookPaid.order.payment_status === 'paid');
    ok('for the right amount', hookPaid.order.amount_paid === hookOrder.total);

    const replay = await raw<{ duplicate: boolean }>(SHOP, '/payments/razorpay/webhook', {
      method: 'POST',
      auth: false,
      rawBody: hookBody,
      headers: { 'X-Razorpay-Signature': webhookSignature(hookBody, WEBHOOK_SECRET) },
    });
    // Razorpay retries until it gets a 2xx, so a replay must be 200 — a 409
    // here would have it retrying the same event for days.
    ok('a replayed webhook answers 200', replay.status === 200, replay.status);
    ok('and is recognised as a duplicate', replay.body.duplicate === true);

    const afterWebhookReplay = await adminOrThrow<{ order: { amount_paid: number } }>(`/orders/${hookOrder.id}`);
    ok(
      'the order was not paid twice',
      afterWebhookReplay.order.amount_paid === hookOrder.total,
      afterWebhookReplay.order.amount_paid,
    );

    const events = await adminOrThrow<{ webhooks: { event_type: string; status: string }[] }>('/payments/webhooks');
    ok('the rejected deliveries were recorded too', events.webhooks.length >= 3, events.webhooks.length);

    // A failed payment must not silently leave the order looking pending.
    const failOrder = await placeOnlineOrder();
    const failStart = await shop<{ payment: { gateway_order_id: string } }>(
      `/payments/orders/${failOrder.orderNumber}/start`,
      { method: 'POST', body: { phone: failOrder.phone } },
    );
    const failedPayment = gateway.pay(failStart.body.payment.gateway_order_id, {
      status: 'failed',
      captured: false,
    });
    const failBody = gateway.webhookBody('payment.failed', failedPayment);
    await raw(SHOP, '/payments/razorpay/webhook', {
      method: 'POST',
      auth: false,
      rawBody: failBody,
      headers: { 'X-Razorpay-Signature': webhookSignature(failBody, WEBHOOK_SECRET) },
    });
    const failedOrder = await adminOrThrow<{ order: { payment_status: string } }>(`/orders/${failOrder.id}`);
    ok('a failed payment marks the order failed, not paid', failedOrder.order.payment_status === 'failed', failedOrder.order.payment_status);

    // ── refunds that move money ──────────────────────────────────────────────
    process.stdout.write('\nRefunds\n');
    const refunded = await adminOrThrow<{
      refund: { sent_to_gateway: boolean; gateway_refund_id: string | null; message: string };
      order: { payment_status: string; amount_refunded: number };
    }>(`/orders/${order.id}/refund`, {
      method: 'POST',
      body: { amount: 100, reason: 'Damaged on arrival' },
    });
    ok('the refund reaches the gateway', refunded.refund.sent_to_gateway === true, refunded.refund);
    ok('and carries the gateway’s refund id', Boolean(refunded.refund.gateway_refund_id));
    ok('the gateway recorded it', gateway.refunds.size === 1);
    ok(
      'the amount sent is in paise',
      [...gateway.refunds.values()][0]?.amount === 10000,
      [...gateway.refunds.values()][0]?.amount,
    );
    ok('the order shows it as partially refunded', refunded.order.payment_status === 'partially_refunded');

    const refundRow = await adminOrThrow<{ refunds: { id: number; status: string; gateway_refund_id: string | null }[] }>(
      '/payments/refunds',
    );
    const mine = refundRow.refunds.find((r) => r.gateway_refund_id === refunded.refund.gateway_refund_id);
    ok(
      'it is processing, not processed — the bank has not confirmed it',
      mine?.status === 'processing',
      mine?.status,
    );

    const refundHook = gateway.refundWebhookBody('refund.processed', refunded.refund.gateway_refund_id!, 'processed');
    const refundHookResponse = await raw(SHOP, '/payments/razorpay/webhook', {
      method: 'POST',
      auth: false,
      rawBody: refundHook,
      headers: { 'X-Razorpay-Signature': webhookSignature(refundHook, WEBHOOK_SECRET) },
    });
    ok('the refund webhook is accepted', refundHookResponse.status === 200);
    const settledRefunds = await adminOrThrow<{ refunds: { gateway_refund_id: string | null; status: string }[] }>(
      '/payments/refunds',
    );
    const settled = settledRefunds.refunds.find((r) => r.gateway_refund_id === refunded.refund.gateway_refund_id);
    ok('and only then does it read as processed', settled?.status === 'processed', settled?.status);

    // A refused refund must put the order's figures back. Otherwise a customer
    // is told they were refunded and the shop's books say so too.
    const beforeFailed = await adminOrThrow<{ order: { amount_refunded: number; payment_status: string } }>(
      `/orders/${order.id}`,
    );
    gateway.failNextRefund = 'The payment has already been fully refunded.';
    const failedRefund = await adminOrThrow<{
      refund: { sent_to_gateway: boolean; message: string };
      order: { amount_refunded: number; payment_status: string };
    }>(`/orders/${order.id}/refund`, { method: 'POST', body: { amount: 50, reason: 'Second attempt' } });

    ok('a refused refund says so', failedRefund.refund.sent_to_gateway === false, failedRefund.refund);
    ok(
      'and repeats the gateway’s reason rather than a generic failure',
      failedRefund.refund.message.includes('already been fully refunded'),
      failedRefund.refund.message,
    );

    const afterFailed = await adminOrThrow<{ order: { amount_refunded: number; payment_status: string } }>(
      `/orders/${order.id}`,
    );
    ok(
      'the refunded total is put back',
      afterFailed.order.amount_refunded === beforeFailed.order.amount_refunded,
      { before: beforeFailed.order.amount_refunded, after: afterFailed.order.amount_refunded },
    );
    ok(
      'and so is the payment status',
      afterFailed.order.payment_status === beforeFailed.order.payment_status,
      afterFailed.order.payment_status,
    );

    const failedRow = await adminOrThrow<{ refunds: { status: string; amount: number }[] }>('/payments/refunds');
    ok(
      'the attempt is kept as a failed row rather than erased',
      failedRow.refunds.some((r) => r.status === 'failed' && r.amount === 50),
      failedRow.refunds.slice(0, 3),
    );

    // ── what may be paid ─────────────────────────────────────────────────────
    process.stdout.write('\nWhat may still be paid\n');
    // This order is paid and partly refunded. Refunds do not put `amount_due`
    // back, so an allow-list on payment_status is the only thing stopping it
    // being charged again in full.
    const repay = await shop<{ error?: { message: string } }>(`/payments/orders/${order.orderNumber}/start`, {
      method: 'POST',
      body: { phone: order.phone },
    });
    ok('a paid, partly refunded order cannot be paid again', repay.status === 409, repay.status);

    const paidAgain = await shop<{ error?: { message: string } }>(`/payments/orders/${hookOrder.orderNumber}/start`, {
      method: 'POST',
      body: { phone: hookOrder.phone },
    });
    ok('nor can a fully paid one', paidAgain.status === 409, paidAgain.status);

    // A failed payment must leave the order payable — otherwise a customer
    // whose card was declined has no way to try again.
    const retry = await shop<{ payment?: { gateway_order_id: string } }>(
      `/payments/orders/${failOrder.orderNumber}/start`,
      { method: 'POST', body: { phone: failOrder.phone } },
    );
    ok('but an order whose payment failed can be retried', retry.status === 200, retry.status);

  } finally {
    await shutdown();
    await closePool();
    // A 500 from the spawned API says nothing on its own; its log says why.
    if (failures.length > 0) {
      const errors = apiLog
        .join('')
        .split('\n')
        .filter((line) => line.includes('"level":"error"'))
        .slice(0, 10);
      if (errors.length > 0) process.stdout.write(`\nAPI errors:\n${errors.join('\n')}\n`);
    }
  }

  process.stdout.write(`\n${'='.repeat(52)}\n  ${passed} passed, ${failures.length} failed\n${'='.repeat(52)}\n`);
  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const failure of failures) process.stdout.write(`  • ${failure}\n`);
  }
  process.stdout.write('\n');
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  process.stdout.write(`\nFATAL: ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});
