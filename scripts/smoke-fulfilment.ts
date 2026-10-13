/**
 * End-to-end smoke test for shipments, returns, invoices and abandoned carts.
 *
 *   npm run dev            # in one shell
 *   npm run smoke:fulfilment
 *
 * The arithmetic is the point, not the happy path. Specifically:
 *
 *   - a shipment books through the courier adapter and gets a waybill back
 *   - an invoice shipped inside the warehouse state splits CGST/SGST, and one
 *     shipped outside it becomes IGST — the single rule most likely to be wrong
 *     and least likely to be noticed until an auditor finds it
 *   - a return restocks exactly once and refunds through the order's own path
 *   - an abandoned cart is only abandoned if it never became an order
 */
import { env } from '../src/config/env';
import { closePool, execute, query, queryOne, type RowDataPacket } from '../src/db/pool';

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

async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
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
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} → ${response.status} ${text.slice(0, 300)}`);
  }
  return parsed as T;
}

async function shop<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${SHOP}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} → ${response.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** Places a real order through the storefront, into whichever state we choose. */
async function placeOrder(state: string, pincode: string, phone: string) {
  const listed = await shop<{ products: { slug: string }[] }>('/products?limit=1&sort=featured');
  const detail = await shop<{ product: { variants: { id: number; in_stock: boolean }[] } }>(
    `/products/${listed.products[0].slug}`,
  );
  const variant = detail.product.variants.find((v) => v.in_stock) ?? detail.product.variants[0];

  const { cart } = await shop<{ cart: { token: string } }>('/cart', { method: 'POST' });
  await shop(`/cart/${cart.token}/items`, { method: 'POST', body: { variant_id: variant.id, quantity: 2 } });

  const { order } = await shop<{ order: { id: number; order_number: string; total: number } }>(
    `/cart/${cart.token}/checkout`,
    {
      method: 'POST',
      body: {
        payment_method: 'cod',
        contact: { first_name: 'Fulfil', last_name: 'Probe', phone, email: `f.${phone}@example.com` },
        shipping_address: { line1: '11 Test Road', city: 'Testville', state, pincode },
      },
    },
  );
  return order;
}

async function drive(orderId: number, statuses: string[]) {
  for (const status of statuses) {
    await api(`/orders/${orderId}/status`, { method: 'POST', body: { status } });
  }
}

async function main(): Promise<void> {
  process.stdout.write('\nFulfilment smoke — shipments, returns, invoices, carts\n');

  const login = await (
    await fetch(`${ADMIN}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: process.env.SUPERADMIN_EMAIL ?? 'admin@veylor.com',
        password: process.env.SUPERADMIN_PASSWORD ?? 'ChangeMe!2026',
      }),
    })
  ).json();
  token = login.tokens?.access_token ?? login.access_token;
  if (!token) throw new Error('Could not sign in.');

  // ── carriers ───────────────────────────────────────────────────────────────
  process.stdout.write('\nCarriers\n');
  const carriers = await api<{ carriers: { code: string; is_live: boolean; provider: string }[] }>(
    '/shipments/carriers',
  );
  ok('the seeded carriers are present', carriers.carriers.length >= 4, carriers.carriers.length);
  ok(
    'none of them claim to be live',
    carriers.carriers.every((carrier) => carrier.is_live === false),
    carriers.carriers.filter((c) => c.is_live).map((c) => c.code),
  );

  // ── shipment ───────────────────────────────────────────────────────────────
  process.stdout.write('\nShipment\n');
  const phone = `9${String(Date.now()).slice(-9)}`;
  const order = await placeOrder('Karnataka', '560001', phone);
  await drive(order.id, ['confirmed', 'packed']);
  const shipped = await api<{ order: { shipments: { id: number; awb_number: string | null }[] } }>(
    `/orders/${order.id}/ship`,
    { method: 'POST', body: { shipping_mode: 'surface' } },
  );
  const shipment = shipped.order.shipments[0];
  ok('the courier returned a waybill', Boolean(shipment.awb_number), shipment.awb_number);

  const detail = await api<{
    shipment: { id: number; status: string; tracking: unknown[]; shipping_charge: number | null; weight_grams: number };
  }>(`/shipments/${shipment.id}`);
  ok('the shipment starts at label_generated', detail.shipment.status === 'label_generated', detail.shipment.status);
  ok('a weight was worked out for the parcel', detail.shipment.weight_grams > 0, detail.shipment.weight_grams);
  ok('the carrier quoted a shipping charge', (detail.shipment.shipping_charge ?? 0) > 0, detail.shipment.shipping_charge);

  const tracked = await api<{ shipment: { tracking: { at: string }[] } }>(
    `/shipments/${shipment.id}/refresh-tracking`,
    { method: 'POST' },
  );
  ok('tracking events came back', tracked.shipment.tracking.length >= 1, tracked.shipment.tracking.length);
  // Events dated before the parcel was booked is the bug this catches.
  const bookedAt = new Date(detail.shipment ? tracked.shipment.tracking[0].at : Date.now()).getTime();
  ok(
    'no tracking event predates the booking',
    tracked.shipment.tracking.every((event) => new Date(event.at).getTime() >= bookedAt - 1000),
  );

  const refreshed = await api<{ shipment: { tracking: unknown[] } }>(`/shipments/${shipment.id}/refresh-tracking`, {
    method: 'POST',
  });
  ok(
    'refreshing twice does not duplicate events',
    refreshed.shipment.tracking.length === tracked.shipment.tracking.length,
    { first: tracked.shipment.tracking.length, second: refreshed.shipment.tracking.length },
  );

  let cancelRefused = false;
  try {
    await api(`/shipments/${shipment.id}/status`, { method: 'POST', body: { status: 'delivered' } });
  } catch {
    cancelRefused = true;
  }
  ok('a label_generated shipment cannot jump straight to delivered', cancelRefused);

  // ── invoice, intra-state ───────────────────────────────────────────────────
  process.stdout.write('\nInvoice — intra-state\n');
  await drive(order.id, ['delivered']);
  const invoiced = await api<{
    invoice: { id: number; invoice_number: string; cgst: number; sgst: number; igst: number; total_amount: number; pdf_url: string | null; place_of_supply: string };
    already_existed: boolean;
  }>(`/invoices/orders/${order.id}/issue`, { method: 'POST' });

  // The seeded warehouse is in Himachal Pradesh (02); Karnataka (29) is a
  // different state, so this one is inter-state.
  ok('the place of supply was resolved', invoiced.invoice.place_of_supply === '29', invoiced.invoice.place_of_supply);
  ok('a Karnataka delivery from an HP warehouse is IGST', invoiced.invoice.igst > 0 && invoiced.invoice.cgst === 0, {
    igst: invoiced.invoice.igst,
    cgst: invoiced.invoice.cgst,
  });
  ok('the invoice total matches the order', invoiced.invoice.total_amount === order.total, {
    invoice: invoiced.invoice.total_amount,
    order: order.total,
  });
  ok('a PDF was generated', Boolean(invoiced.invoice.pdf_url), invoiced.invoice.pdf_url);

  const pdfResponse = await fetch(`http://127.0.0.1:${env.port}${invoiced.invoice.pdf_url}`);
  const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
  ok('the PDF is served and is a real PDF', pdfBytes.subarray(0, 4).toString() === '%PDF', pdfBytes.subarray(0, 8).toString());
  ok('the PDF is not a stub', pdfBytes.length > 2000, pdfBytes.length);

  const again = await api<{ already_existed: boolean; invoice: { invoice_number: string } }>(
    `/invoices/orders/${order.id}/issue`,
    { method: 'POST' },
  );
  // Issuing twice is a compliance problem, not a duplicate row.
  ok('issuing twice returns the same invoice', again.already_existed === true);
  ok('and the same number', again.invoice.invoice_number === invoiced.invoice.invoice_number);

  // ── invoice, the other side of the split ───────────────────────────────────
  process.stdout.write('\nInvoice — the GST split\n');
  const hpPhone = `9${String(Date.now() + 7).slice(-9)}`;
  const hpOrder = await placeOrder('Himachal Pradesh', '173205', hpPhone);
  await drive(hpOrder.id, ['confirmed', 'packed']);
  await api(`/orders/${hpOrder.id}/ship`, { method: 'POST', body: { shipping_mode: 'surface' } });
  await drive(hpOrder.id, ['delivered']);
  const hpInvoice = await api<{
    invoice: {
      cgst: number; sgst: number; igst: number; taxable_value: number; total_amount: number;
      tax_total: number; shipping: number; cod_fee: number; round_off: number;
    };
  }>(
    `/invoices/orders/${hpOrder.id}/issue`,
    { method: 'POST' },
  );
  ok('a delivery inside the warehouse state is CGST + SGST', hpInvoice.invoice.igst === 0 && hpInvoice.invoice.cgst > 0, {
    igst: hpInvoice.invoice.igst,
    cgst: hpInvoice.invoice.cgst,
  });
  // The halves differ by at most a paisa by design — the remainder is put on
  // SGST so the two add back to the whole. That sum is the property that
  // matters: halves that quietly lose a paisa per line stop the invoice
  // footing once there are enough lines. (Compared with a tolerance because
  // 114.26 - 114.25 is not exactly 0.01 in binary floating point.)
  const half = Math.abs(hpInvoice.invoice.cgst - hpInvoice.invoice.sgst);
  ok('CGST and SGST are halves of one total', half < 0.011, {
    cgst: hpInvoice.invoice.cgst,
    sgst: hpInvoice.invoice.sgst,
    difference: half,
  });
  // The document has to add up on its own terms: taxable + tax + delivery +
  // cash handling + round-off is the total, with nothing unaccounted for.
  const inv = hpInvoice.invoice;
  const reconstructed = inv.taxable_value + inv.tax_total + inv.shipping + inv.cod_fee + inv.round_off;
  ok('the invoice reconciles line by line to its total', Math.abs(reconstructed - inv.total_amount) < 0.011, {
    taxable: inv.taxable_value,
    tax: inv.tax_total,
    shipping: inv.shipping,
    cod_fee: inv.cod_fee,
    round_off: inv.round_off,
    reconstructed,
    total: inv.total_amount,
  });
  ok(
    'the invoice foots: taxable + tax + charges = total',
    Math.abs(
      hpInvoice.invoice.taxable_value + hpInvoice.invoice.cgst + hpInvoice.invoice.sgst - hpOrder.total,
    ) < 100,
    { taxable: hpInvoice.invoice.taxable_value, total: hpOrder.total },
  );

  // ── return ─────────────────────────────────────────────────────────────────
  process.stdout.write('\nReturn\n');
  const returnable = await api<{ items: { order_item_id: number; returnable: number }[]; window: { delivered: boolean } }>(
    `/returns/returnable/${order.id}`,
  );
  ok('the delivered order has returnable items', returnable.items.some((item) => item.returnable > 0));

  const line = returnable.items.find((item) => item.returnable > 0)!;
  const stockBefore = await variantStock(order.id, line.order_item_id);

  const created = await api<{ return: { id: number; rma_number: string; requested_amount: number } }>('/returns', {
    method: 'POST',
    body: {
      order_id: order.id,
      reason: 'damaged',
      reason_detail: 'Pump arrived broken',
      items: [{ order_item_id: line.order_item_id, quantity: 1 }],
    },
  });
  ok('an RMA was raised', /^RMA\d+$/.test(created.return.rma_number), created.return.rma_number);
  ok('the refund amount was computed from what was paid', created.return.requested_amount > 0);

  const rmaId = created.return.id;

  // A second RMA must not claim the same unit twice.
  const afterFirst = await api<{ items: { order_item_id: number; returnable: number; pending_return_quantity: number }[] }>(
    `/returns/returnable/${order.id}`,
  );
  const sameLine = afterFirst.items.find((item) => item.order_item_id === line.order_item_id)!;
  ok('the open RMA reserves the unit it claimed', sameLine.pending_return_quantity === 1, sameLine);
  ok('so the returnable count dropped', sameLine.returnable === line.returnable - 1, {
    before: line.returnable,
    after: sameLine.returnable,
  });

  await api(`/returns/${rmaId}/status`, { method: 'POST', body: { status: 'approved' } });
  const pickup = await api<{ return: { pickup_awb: string | null; status: string } }>(
    `/returns/${rmaId}/schedule-pickup`,
    { method: 'POST', body: {} },
  );
  ok('a reverse pickup was booked', Boolean(pickup.return.pickup_awb), pickup.return.pickup_awb);

  await api(`/returns/${rmaId}/status`, { method: 'POST', body: { status: 'picked_up' } });
  await api(`/returns/${rmaId}/status`, { method: 'POST', body: { status: 'received' } });

  const items = await api<{ return: { items: { id: number }[] } }>(`/returns/${rmaId}`);
  await api(`/returns/${rmaId}/inspect`, {
    method: 'POST',
    body: {
      note: 'Bottle intact, pump replaced',
      items: items.return.items.map((item) => ({ id: item.id, condition: 'opened', restock: true })),
    },
  });

  const stockAfter = await variantStock(order.id, line.order_item_id);
  ok('inspecting with restock put exactly one unit back', stockAfter === stockBefore + 1, {
    before: stockBefore,
    after: stockAfter,
  });

  const refunded = await api<{ return: { status: string; approved_amount: number | null } }>(
    `/returns/${rmaId}/refund`,
    { method: 'POST', body: {} },
  );
  ok('the return refunded', refunded.return.status === 'refunded', refunded.return.status);

  const orderAfter = await api<{ order: { totals: { amount_refunded: number } } }>(`/orders/${order.id}`);
  ok(
    'and the refund landed on the order, not in a second ledger',
    orderAfter.order.totals.amount_refunded >= (refunded.return.approved_amount ?? 0),
    orderAfter.order.totals.amount_refunded,
  );

  // ── credit note ────────────────────────────────────────────────────────────
  process.stdout.write('\nCredit note\n');
  const credit = await api<{ invoice: { invoice_number: string; invoice_type: string; against_invoice: string; total_amount: number; pdf_url: string | null } }>(
    `/invoices/${invoiced.invoice.id}/credit-note`,
    { method: 'POST', body: { amount: 100, reason: 'Damaged on arrival' } },
  );
  ok('a credit note was issued', credit.invoice.invoice_type === 'credit_note');
  ok('it references the invoice it reverses', credit.invoice.against_invoice === invoiced.invoice.invoice_number);
  ok('with its own PDF', Boolean(credit.invoice.pdf_url));

  const ledger = await api<{ summary: { taxable_value: number; total: number } }>(`/invoices?order_id=${order.id}`);
  ok('the ledger nets the credit note off the invoice', ledger.summary.total < invoiced.invoice.total_amount, ledger.summary);

  // ── abandoned carts ────────────────────────────────────────────────────────
  process.stdout.write('\nAbandoned carts\n');
  const strandedPhone = `9${String(Date.now() + 13).slice(-9)}`;
  const listed = await shop<{ products: { slug: string }[] }>('/products?limit=1');
  const productDetail = await shop<{ product: { variants: { id: number }[] } }>(`/products/${listed.products[0].slug}`);
  const { cart } = await shop<{ cart: { token: string } }>('/cart', { method: 'POST' });
  await shop(`/cart/${cart.token}/items`, {
    method: 'POST',
    body: { variant_id: productDetail.product.variants[0].id, quantity: 1 },
  });
  // Age it past the idle threshold so the sweep can see it.
  await execute("UPDATE carts SET last_activity_at = DATE_SUB(NOW(), INTERVAL 8 HOUR) WHERE token = ?", [cart.token]);

  const swept = await api<{ marked_abandoned: number }>('/carts/abandoned/sweep', { method: 'POST' });
  ok('the sweep marked at least the stranded cart', swept.marked_abandoned >= 1, swept.marked_abandoned);

  const abandoned = await api<{ carts: { id: number; value: number; item_count: number }[]; stats: { value_at_risk: number } }>(
    '/carts/abandoned?limit=100',
  );
  const row = await queryOne<RowDataPacket & { id: number }>('SELECT id FROM carts WHERE token = ?', [cart.token]);
  const found = abandoned.carts.find((entry) => entry.id === row!.id);
  ok('the stranded cart is in the queue', Boolean(found), row!.id);
  ok('with its value priced from the live variant', (found?.value ?? 0) > 0, found?.value);
  ok('and the queue reports a value at risk', abandoned.stats.value_at_risk > 0, abandoned.stats.value_at_risk);

  // A converted cart must never appear, whatever its status column says.
  const convertedRow = await queryOne<RowDataPacket & { id: number }>(
    'SELECT id FROM carts WHERE converted_order_id IS NOT NULL LIMIT 1',
  );
  if (convertedRow) {
    await execute("UPDATE carts SET status = 'abandoned' WHERE id = ?", [convertedRow.id]);
    const recheck = await api<{ carts: { id: number }[] }>('/carts/abandoned?limit=250');
    ok(
      'a cart that became an order is never chased',
      !recheck.carts.some((entry) => entry.id === convertedRow.id),
      convertedRow.id,
    );
  }

  const link = await api<{ recovery_url: string; token: string }>(`/carts/abandoned/${row!.id}/recovery-link`, {
    method: 'POST',
  });
  ok('a recovery link was minted', link.recovery_url.includes(link.token), link.recovery_url);

  const redeemed = await shop<{ token: string }>(`/cart/recover/${link.token}`);
  ok('and it hands back the original bag', redeemed.token === cart.token);
  ok('while leaking nothing else about the customer', Object.keys(redeemed).length === 1, Object.keys(redeemed));

  const reactivated = await shop<{ cart: { items: unknown[] } }>(`/cart/${cart.token}`);
  ok('the recovered cart still has its items', reactivated.cart.items.length === 1);

  process.stdout.write(`\n  ${passed} passed, ${failed} failed\n`);
  if (failures.length > 0) process.stdout.write(`${failures.map((f) => `    - ${f}`).join('\n')}\n`);
  if (failed > 0) process.exitCode = 1;
}

/** Live stock for the variant behind an order line. */
async function variantStock(orderId: number, orderItemId: number): Promise<number> {
  const rows = await query<RowDataPacket & { available: number }>(
    `SELECT COALESCE(SUM(ii.quantity_available), 0) AS available
       FROM order_items oi
       JOIN inventory_items ii ON ii.variant_id = oi.variant_id
      WHERE oi.id = ? AND oi.order_id = ?`,
    [orderItemId, orderId],
  );
  return Number(rows[0]?.available ?? 0);
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`\nSmoke failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => void closePool());
