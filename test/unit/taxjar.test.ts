import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { taxjarProvider } from '../../src/platform/integrations/providers/taxjar';
import type { ConnectionContext } from '../../src/platform/integrations/types';

/**
 * The TaxJar adapter against a canned response in TaxJar's documented shape,
 * with `fetch` stubbed: what is sent, and how the answer becomes per-line
 * tax, delivery tax and named jurisdiction lines.
 */

const context: ConnectionContext<{ api_token: string }> = {
  shopId: 1,
  connectionId: 1,
  publicId: 'conn',
  provider: 'taxjar',
  name: 'TaxJar',
  mode: 'test',
  credentials: { api_token: 'abcdefghijklmnopqrstuvwxyz123456' },
  config: {},
  inboundUrl: 'https://example.test/in',
};

const originalFetch = globalThis.fetch;
let sent: { url: string; body: Record<string, unknown>; auth: string | null } | null = null;

function answer(payload: unknown, status = 200): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    sent = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')), auth: new Headers(init?.headers).get('authorization') };
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  sent = null;
});

const address = { country: 'US', region: 'CA', postalCode: '90002', city: 'Los Angeles', line1: '1335 E 103rd St' };

describe('TaxJar adapter', () => {
  it('sends the basket, and reads per-line, delivery and jurisdiction tax', async () => {
    answer({
      tax: {
        amount_to_collect: 1.35,
        rate: 0.09,
        jurisdictions: { country: 'US', state: 'CA', county: 'LOS ANGELES', city: 'LOS ANGELES' },
        breakdown: {
          state_tax_rate: 0.0625,
          state_tax_collectable: 0.94,
          county_tax_rate: 0.0025,
          county_tax_collectable: 0.04,
          city_tax_rate: 0,
          city_tax_collectable: 0,
          special_tax_rate: 0.025,
          special_district_tax_collectable: 0.38,
          shipping: { tax_collectable: 0 },
          line_items: [
            { id: 'a', taxable_amount: 15, tax_collectable: 1.35, combined_tax_rate: 0.09 },
            { id: 'b', taxable_amount: 0, tax_collectable: 0, combined_tax_rate: 0 },
          ],
        },
      },
    });

    const calculator = taxjarProvider.tax!(context);
    const result = await calculator.calculate({
      from: { country: 'US', region: 'CA', postalCode: '92093', city: 'La Jolla', line1: '9500 Gilman Drive' },
      to: address,
      currency: 'USD',
      lines: [
        { id: 'a', quantity: 1, unitPrice: 15, discount: 0, exempt: false, productTaxCode: null },
        { id: 'b', quantity: 2, unitPrice: 5, discount: 1, exempt: true, productTaxCode: null },
      ],
      shipping: 1.5,
    });

    assert.equal(sent!.url, 'https://api.sandbox.taxjar.com/v2/taxes');
    assert.equal(sent!.auth, 'Bearer abcdefghijklmnopqrstuvwxyz123456');
    assert.equal(sent!.body.to_zip, '90002');
    assert.equal(sent!.body.shipping, 1.5);
    const items = sent!.body.line_items as Record<string, unknown>[];
    assert.equal(items[1].product_tax_code, '99999', 'an exempt line is sent as exempt');
    assert.equal(items[1].discount, 1);

    assert.deepEqual(result.lines, [
      { id: 'a', taxable: 15, tax: 1.35, rate: 9 },
      { id: 'b', taxable: 0, tax: 0, rate: 0 },
    ]);
    assert.equal(result.shippingTax, 0);
    // 0.94 + 0.04 + 0.38 is 1.36; the largest line absorbs TaxJar's rounding.
    assert.deepEqual(result.taxLines, [
      { name: 'CA state tax', rate: 6.25, amount: 0.93 },
      { name: 'LOS ANGELES county tax', rate: 0.25, amount: 0.04 },
      { name: 'Special district tax', rate: 2.5, amount: 0.38 },
    ]);
    assert.equal(Math.round(result.taxLines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100, 1.35);
  });

  it('turns a refusal into a calculation error the tax service can fall back from', async () => {
    answer({ error: 'Bad Request', detail: 'to_zip 00000 is not used within to_state CA', status: 400 }, 400);
    await assert.rejects(
      taxjarProvider.tax!(context).calculate({ from: address, to: { ...address, postalCode: '00000' }, currency: 'USD', lines: [], shipping: 0 }),
      (error: Error) => error.name === 'TaxCalculationError' && /not used within/.test(error.message),
    );
  });

  it('reports a sale, and treats "already exists" as done', async () => {
    const transaction = {
      transactionId: 'VEY0000131',
      date: new Date('2026-09-24T10:00:00Z'),
      from: address,
      to: { ...address, postalCode: '94105' },
      amount: 100,
      shipping: 7.99,
      salesTax: 7.25,
      lines: [{ id: '11', quantity: 1, description: 'USB-C Cable', unitPrice: 100, discount: 0, salesTax: 7.25 }],
    };
    answer({ order: { transaction_id: 'VEY0000131' } }, 201);
    await taxjarProvider.tax!(context).recordSale!(transaction);
    assert.equal(sent!.url, 'https://api.sandbox.taxjar.com/v2/transactions/orders');
    assert.equal(sent!.body.transaction_id, 'VEY0000131');
    assert.equal(sent!.body.sales_tax, 7.25);
    assert.equal((sent!.body.line_items as Record<string, unknown>[])[0].description, 'USB-C Cable');

    answer({ error: 'Unprocessable Entity', detail: 'Provider tranx already exists.', status: 422 }, 422);
    await taxjarProvider.tax!(context).recordSale!(transaction);

    answer({ error: 'Unprocessable Entity', detail: 'to_zip is required', status: 422 }, 422);
    await assert.rejects(taxjarProvider.tax!(context).recordSale!(transaction), /to_zip is required/);
  });

  it('reports a refund against its sale, with negative amounts', async () => {
    answer({ refund: { transaction_id: 'VEY0000131-refund-55' } }, 201);
    await taxjarProvider.tax!(context).recordRefund!({
      transactionId: 'VEY0000131-refund-55',
      referenceId: 'VEY0000131',
      date: new Date('2026-09-25T10:00:00Z'),
      from: address,
      to: address,
      amount: -50,
      shipping: 0,
      salesTax: -3.63,
      lines: [],
    });
    assert.equal(sent!.url, 'https://api.sandbox.taxjar.com/v2/transactions/refunds');
    assert.equal(sent!.body.transaction_reference_id, 'VEY0000131');
    assert.equal(sent!.body.amount, -50);
    assert.equal(sent!.body.sales_tax, -3.63);
  });
});
