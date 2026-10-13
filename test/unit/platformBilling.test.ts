import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { platformTax, platformTaxConfig } from '../../src/platform/billing/platformTax';
import { verifyStripeSignature } from '../../src/platform/billing/billingWebhooks';

// Pure checks only: nothing here reaches a database.

describe('tax on the platform’s bills', () => {
  const india = platformTaxConfig({ PLATFORM_TAX_COUNTRY: 'IN', PLATFORM_TAX_REGION: 'KA', PLATFORM_TAX_RATE: '18', PLATFORM_TAX_ID: '29ABCDE1234F1Z5' } as NodeJS.ProcessEnv);

  it('charges nothing until the platform says where it is registered', () => {
    const none = platformTaxConfig({} as NodeJS.ProcessEnv);
    assert.deepEqual(platformTax(none, { country: 'IN', region: 'KA', taxId: null }, 1000, 'INR'), { lines: [], note: null });
    assert.equal(india.name, 'GST');
  });

  it('splits GST into CGST and SGST within the platform’s state', () => {
    const tax = platformTax(india, { country: 'IN', region: 'KA', taxId: '29AAAAA0000A1Z5' }, 1999, 'INR');
    assert.deepEqual(tax.lines, [
      { name: 'CGST 9%', rate: 9, amount: 179.91 },
      { name: 'SGST 9%', rate: 9, amount: 179.91 },
    ]);
    assert.match(tax.note ?? '', /29AAAAA0000A1Z5/);
  });

  it('charges IGST to another state, or when the state is not known', () => {
    assert.deepEqual(platformTax(india, { country: 'IN', region: 'MH', taxId: null }, 1000, 'INR').lines, [{ name: 'IGST 18%', rate: 18, amount: 180 }]);
    assert.deepEqual(platformTax(india, { country: 'IN', region: null, taxId: null }, 1000, 'INR').lines, [{ name: 'IGST 18%', rate: 18, amount: 180 }]);
  });

  it('adds nothing to an export of services, and says so', () => {
    const tax = platformTax(india, { country: 'US', region: 'CA', taxId: null }, 49, 'USD');
    assert.deepEqual(tax.lines, []);
    assert.match(tax.note ?? '', /Export of services/);
  });

  it('uses one named rate elsewhere', () => {
    const uk = platformTaxConfig({ PLATFORM_TAX_COUNTRY: 'GB', PLATFORM_TAX_RATE: '20' } as NodeJS.ProcessEnv);
    assert.deepEqual(platformTax(uk, { country: 'GB', region: null, taxId: null }, 100, 'GBP').lines, [{ name: 'VAT 20%', rate: 20, amount: 20 }]);
  });
});

describe('Stripe webhook signatures', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
  const now = 1_790_000_000_000;
  const sign = (t: number, payload = body, key = secret) => createHmac('sha256', key).update(`${t}.${payload}`).digest('hex');

  it('accepts a fresh event signed with the secret', () => {
    const t = Math.floor(now / 1000);
    assert.equal(verifyStripeSignature(body, `t=${t},v1=${sign(t)}`, secret, now), true);
    assert.equal(verifyStripeSignature(Buffer.from(body), `t=${t},v1=deadbeef,v1=${sign(t)}`, secret, now), true, 'any v1 while a secret rolls');
  });

  it('refuses a changed body, another secret, an old event, or no signature', () => {
    const t = Math.floor(now / 1000);
    assert.equal(verifyStripeSignature(`${body} `, `t=${t},v1=${sign(t)}`, secret, now), false);
    assert.equal(verifyStripeSignature(body, `t=${t},v1=${sign(t, body, 'whsec_other')}`, secret, now), false);
    assert.equal(verifyStripeSignature(body, `t=${t - 600},v1=${sign(t - 600)}`, secret, now), false);
    assert.equal(verifyStripeSignature(body, undefined, secret, now), false);
  });
});
