import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickQuote, within, withMarkup } from '../../src/modules/shipping/carrierRates';
import { DummyProvider, type RateQuote } from '../../src/modules/shipping/courier';

const quote = (mode: RateQuote['mode'], amount: number, service = `${mode} ${amount}`): RateQuote => ({
  mode,
  service,
  amount,
  currency: 'INR',
  etaMinDays: 2,
  etaMaxDays: 4,
});

describe('carrier-calculated rates: which service a method charges', () => {
  const offered = [quote('surface', 90), quote('surface', 70), quote('air', 120), quote('express', 150), quote('air', 110)];

  it('standard: the cheapest surface service', () => {
    assert.equal(pickQuote(offered, 'standard')?.amount, 70);
  });

  it('express: the cheapest express or air service, never surface', () => {
    assert.equal(pickQuote(offered, 'express')?.amount, 110);
    assert.equal(pickQuote([quote('surface', 50)], 'express'), null);
  });

  it('standard on a carrier that only flies: its cheapest service', () => {
    assert.equal(pickQuote([quote('air', 130), quote('express', 160)], 'standard')?.amount, 130);
  });

  it('nothing offered: nothing picked, so the fallback applies', () => {
    assert.equal(pickQuote([], 'standard'), null);
    assert.equal(pickQuote([], 'express'), null);
  });
});

describe('carrier-calculated rates: markup', () => {
  // Unrounded on purpose: the quote rounds to the shop's currency.
  const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);

  it('percentage first, then the fixed amount', () => {
    near(withMarkup(100, { carrier_markup_percent: '10.00', carrier_markup_amount: '5.00' }), 115);
    near(withMarkup(250, { carrier_markup_percent: '0.00', carrier_markup_amount: '20.00' }), 270);
  });

  it('none, or junk, leaves the carrier price alone', () => {
    assert.equal(withMarkup(80, { carrier_markup_percent: '0.00', carrier_markup_amount: '0.00' }), 80);
    assert.equal(withMarkup(80, { carrier_markup_percent: null, carrier_markup_amount: 'abc' }), 80);
  });
});

describe('carrier-calculated rates: a courier that does not answer in time', () => {
  const later = <T>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it('an answer in time is used', async () => {
    assert.deepEqual(await within(later([1], 5), 200), [1]);
  });

  it('a late answer is not waited for: null, and the fallback applies', async () => {
    const started = Date.now();
    assert.equal(await within(later([1], 500), 20), null);
    assert.ok(Date.now() - started < 300);
  });

  it('a failure is null, not an error', async () => {
    assert.equal(await within(Promise.reject(new Error('courier down')), 200), null);
  });
});

describe('the stand-in courier quotes what it would charge to book', () => {
  const courier = new DummyProvider('delhivery');
  const input = (postalCode: string, weightGrams: number) => ({
    origin: { postalCode: '173212', country: 'IN' },
    destination: { postalCode, country: 'IN', region: null },
    weightGrams,
    declaredValue: 1200,
    cod: false,
  });

  it('three services, priced in 500 g slabs, in rupees', async () => {
    const quotes = await courier.quoteRates(input('560001', 1200));
    assert.deepEqual(
      quotes.map((q) => [q.mode, q.amount, q.currency]),
      [
        ['surface', 79 + 2 * 30, 'INR'],
        ['air', 119 + 2 * 30, 'INR'],
        ['express', 149 + 2 * 30, 'INR'],
      ],
    );
  });

  it('the same price createShipment charges', async () => {
    const [surface] = await courier.quoteRates(input('560001', 1200));
    const booked = await courier.createShipment({
      reference: 'r',
      orderNumber: 'VEY-1',
      mode: 'surface',
      codAmount: 0,
      declaredValue: 1200,
      pickup: { name: 'Store', phone: null, email: null, line1: 'x', line2: null, landmark: null, city: 'Solan', state: 'HP', pincode: '173212', country: 'IN' },
      delivery: { name: 'Ana', phone: null, email: null, line1: 'y', line2: null, landmark: null, city: 'Bengaluru', state: 'KA', pincode: '560001', country: 'IN' },
      parcel: { weightGrams: 1200, lengthMm: null, widthMm: null, heightMm: null },
      items: [],
    });
    assert.equal(booked.shippingCharge, surface.amount);
  });

  it('metro destinations are quoted faster', async () => {
    const [metro] = await courier.quoteRates(input('560001', 500));
    const [elsewhere] = await courier.quoteRates(input('176215', 500));
    assert.ok((metro.etaMaxDays ?? 0) < (elsewhere.etaMaxDays ?? 0));
  });

  it('serves nothing it could not book', async () => {
    assert.deepEqual(await courier.quoteRates(input('12', 500)), []);
    assert.deepEqual(await courier.quoteRates(input('560001', 0)), []);
  });
});
