import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { convertAmount, parseEcbRates, perUsdFromPerEur, presentmentPrice } from '../../src/platform/markets/fx';

describe('presentment prices', () => {
  const eur = { rate: 0.92, currency: 'EUR', adjustmentPercent: 0, rounding: 'none' as const };

  it('converts at the rate, to the currency\'s precision', () => {
    assert.equal(presentmentPrice(26.49, eur), 24.37);
  });

  it('applies the market\'s adjustment before rounding', () => {
    assert.equal(presentmentPrice(100, { ...eur, adjustmentPercent: 10 }), 101.2);
  });

  it('rounds up to .99 or to a whole unit', () => {
    assert.equal(presentmentPrice(26.49, { ...eur, rounding: 'ninety_nine' }), 24.99);
    assert.equal(presentmentPrice(26.49, { ...eur, rounding: 'whole' }), 25);
    // An exact whole price still goes to .99; a whole one stays whole.
    assert.equal(presentmentPrice(100, { ...eur, rate: 1, rounding: 'ninety_nine' }), 100.99);
    assert.equal(presentmentPrice(100, { ...eur, rate: 1, rounding: 'whole' }), 100);
  });

  it('uses whole units for currencies without minor units', () => {
    assert.equal(presentmentPrice(10, { rate: 151.37, currency: 'JPY', adjustmentPercent: 0, rounding: 'ninety_nine' }), 1514);
    assert.equal(presentmentPrice(10, { rate: 151.37, currency: 'JPY', adjustmentPercent: 0, rounding: 'none' }), 1514);
  });

  it('converts delivery and thresholds without a rounding rule', () => {
    assert.equal(convertAmount(7.99, 0.92, 'EUR'), 7.35);
  });
});

describe('ECB reference rates', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube><Cube time='2026-09-24'>
    <Cube currency='USD' rate='1.0800'/>
    <Cube currency='GBP' rate='0.8400'/>
    <Cube currency='INR' rate='90.0000'/>
  </Cube></Cube>
</gesmes:Envelope>`;

  it('reads rates per euro and rebases them on the dollar', () => {
    const perEur = parseEcbRates(xml);
    assert.equal(perEur.get('EUR'), 1);
    assert.equal(perEur.get('GBP'), 0.84);
    const perUsd = perUsdFromPerEur(perEur);
    assert.equal(perUsd.get('USD'), 1);
    assert.equal(Math.round(perUsd.get('EUR')! * 1e6) / 1e6, 0.925926);
    assert.equal(Math.round(perUsd.get('INR')! * 1e4) / 1e4, 83.3333);
  });

  it('refuses a feed without the dollar', () => {
    assert.throws(() => perUsdFromPerEur(parseEcbRates("<Cube currency='GBP' rate='0.84'/>")), /US dollar/);
  });
});
