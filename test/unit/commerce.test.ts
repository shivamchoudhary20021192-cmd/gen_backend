import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normaliseScopes, permissionsForScopes } from '../../src/platform/apps/scopes';
import { isValidNationalPhone, normaliseNationalPhone, toE164Digits } from '../../src/platform/geo/phone';
import { isValidPostalCode } from '../../src/platform/geo/postalCodes';
import { exponentialBackoff } from '../../src/platform/jobs/registry';
import { fromMinor, minorUnitDigits, toMinor } from '../../src/platform/money/currency';
import { mapShiprocketStatus } from '../../src/platform/integrations/providers/shiprocket';
import { formatMoney } from '../../src/platform/shops/format';
import { regionFor } from '../../src/platform/shops/blueprints/regions';
import { verticalFor } from '../../src/platform/shops/blueprints/verticals';
import { computeTax } from '../../src/platform/tax/taxEngine';
import { tenancy } from '../../src/platform/tenancy/context';
import { fakeShop } from '../helpers/shop';

describe('tax engine', () => {
  const lines = [
    { amount: 1180, rate: 18, inclusive: true },
    { amount: 105, rate: 5, inclusive: true },
  ];

  it('extracts inclusive GST and splits it CGST/SGST within a state', () => {
    const result = computeTax(lines, { engine: 'in_gst', currency: 'INR', origin: 'KA', destination: 'KA' });
    assert.equal(result.lines[0].taxable, 1000);
    assert.equal(result.lines[0].tax, 180);
    assert.equal(result.lines[0].cgst, 90);
    assert.equal(result.lines[0].sgst, 90);
    assert.equal(result.tax, 185);
    assert.equal(result.igst, 0);
    assert.equal(result.addedToTotal, 0);
    assert.equal(result.interstate, false);
  });

  it('uses IGST when the goods cross a state line', () => {
    const result = computeTax(lines, { engine: 'in_gst', currency: 'INR', origin: 'KA', destination: 'MH' });
    assert.equal(result.igst, 185);
    assert.equal(result.cgst + result.sgst, 0);
    assert.equal(result.placeOfSupply, 'MH');
  });

  it('adds exclusive tax on top, and does not split it outside India', () => {
    const result = computeTax([{ amount: 100, rate: 8.875, inclusive: false }], { engine: 'us_sales_tax', currency: 'USD' });
    assert.equal(result.tax, 8.88);
    assert.equal(result.addedToTotal, 8.88);
    assert.equal(result.cgst + result.sgst + result.igst, 0);
  });

  it('keeps each line exact to the currency, so an invoice adds up', () => {
    const result = computeTax([{ amount: 999, rate: 18, inclusive: true }], { engine: 'in_gst', currency: 'INR' });
    assert.equal(result.lines[0].taxable + result.lines[0].tax, 999);
    assert.equal(result.lines[0].cgst + result.lines[0].sgst, result.lines[0].tax);
  });
});

describe('currency minor units', () => {
  it('knows zero- and three-decimal currencies', () => {
    assert.equal(minorUnitDigits('JPY'), 0);
    assert.equal(minorUnitDigits('KWD'), 3);
    assert.equal(minorUnitDigits('INR'), 2);
    assert.equal(toMinor(1500, 'JPY'), 1500);
    assert.equal(toMinor(12.1, 'INR'), 1210);
    assert.equal(toMinor(1.2345, 'KWD'), 1235);
    assert.equal(fromMinor(1210, 'INR'), 12.1);
  });

  it('formats in the shop\'s own currency', () => {
    const inr = tenancy.run(fakeShop({ currency: 'INR', locale: 'en-IN' }), () => formatMoney(1299, { wholeUnits: true }));
    const usd = tenancy.run(fakeShop({ currency: 'USD', locale: 'en-US' }), () => formatMoney(1299.5));
    assert.match(inr, /₹\s?1,299/);
    assert.equal(usd, '$1,299.50');
  });
});

describe('addresses and phones', () => {
  it('validates postal codes per country', () => {
    assert.equal(isValidPostalCode('560001', 'IN'), true);
    assert.equal(isValidPostalCode('056001', 'IN'), false);
    assert.equal(isValidPostalCode('94105-1234', 'US'), true);
    assert.equal(isValidPostalCode('SW1A 1AA', 'GB'), true);
    assert.equal(isValidPostalCode('K1A 0B1', 'CA'), true);
    assert.equal(isValidPostalCode('', 'AE'), true);
    assert.equal(isValidPostalCode('12-345', 'PL'), true);
  });

  it('normalises and validates national numbers', () => {
    assert.equal(normaliseNationalPhone('+91 98765-43210', 'IN'), '9876543210');
    assert.equal(isValidNationalPhone('9876543210', 'IN'), true);
    assert.equal(isValidNationalPhone('5876543210', 'IN'), false);
    assert.equal(isValidNationalPhone('4155550132', 'US'), true);
    assert.equal(toE164Digits('07700900123', 'GB'), '447700900123');
  });
});

describe('app scopes', () => {
  it('maps scopes to permissions and rejects unknown ones', () => {
    const { scopes, unknown } = normaliseScopes('read_products,write_orders,delete_everything');
    assert.deepEqual(unknown, ['delete_everything']);
    const permissions = permissionsForScopes(scopes);
    assert.equal(permissions.has('products.view'), true);
    assert.equal(permissions.has('orders.refund'), true);
    assert.equal(permissions.has('products.delete'), false);
  });
});

describe('jobs', () => {
  it('backs off exponentially, with jitter, capped', () => {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const delay = exponentialBackoff(attempt, 1000, 60_000);
      const ceiling = Math.min(60_000, 1000 * 2 ** (attempt - 1));
      assert.ok(delay >= ceiling / 2 && delay <= ceiling, `attempt ${attempt}: ${delay}`);
    }
  });
});

describe('blueprints', () => {
  it('gives a region its own money, time and tax regime', () => {
    assert.equal(regionFor('IN').taxEngine, 'in_gst');
    assert.equal(regionFor('US').currency, 'USD');
    assert.equal(regionFor('DE').taxClasses[0].rate, 19);
    assert.equal(regionFor('FR').timezone, 'Europe/Paris');
    const elsewhere = regionFor('KE', { currency: 'KES', timezone: 'Africa/Nairobi' });
    assert.equal(elsewhere.currency, 'KES');
    assert.equal(elsewhere.taxEngine, 'manual');
  });

  it('falls back to the general blueprint for an unknown vertical', () => {
    assert.equal(verticalFor('fashion').theme, 'atelier');
    assert.equal(verticalFor('unknown-thing').key, 'general');
  });
});

describe('courier status mapping', () => {
  it('maps Shiprocket vocabulary onto ours', () => {
    assert.equal(mapShiprocketStatus('OUT FOR DELIVERY'), 'out_for_delivery');
    assert.equal(mapShiprocketStatus('Delivered'), 'delivered');
    assert.equal(mapShiprocketStatus('RTO IN TRANSIT'), 'rto_in_transit');
    assert.equal(mapShiprocketStatus('RTO DELIVERED'), 'rto_delivered');
    assert.equal(mapShiprocketStatus('PICKUP SCHEDULED'), 'pickup_scheduled');
    assert.equal(mapShiprocketStatus('UNDELIVERED'), 'ndr');
  });
});

describe('app API rate limit', () => {
  it('allows a burst up to the bucket, then refuses with a retry hint', async () => {
    const { consumeApiCall, resetApiCallLimits } = await import('../../src/platform/apps/apiCallLimit');
    resetApiCallLimits();
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => (headers[name] = value) } as never;
    // No plan: the platform's fallback bucket.
    const shop = fakeShop({ id: 9001, planId: null });
    let accepted = 0;
    let refusal: { status?: number; retryAfterSeconds?: number } | null = null;
    for (let call = 0; call < 200 && !refusal; call += 1) {
      try {
        await consumeApiCall(shop, 7, res);
        accepted += 1;
      } catch (error) {
        refusal = error as { status?: number; retryAfterSeconds?: number };
      }
    }
    assert.ok(accepted >= 10 && accepted < 200, `accepted ${accepted}`);
    assert.equal(refusal?.status, 429);
    assert.ok((refusal?.retryAfterSeconds ?? 0) >= 1);
    assert.match(headers['X-Veylog-Shop-Api-Call-Limit'], /^\d+\/\d+$/);
    // Another app in the same shop has its own bucket.
    await consumeApiCall(shop, 8, res);
  });
});
