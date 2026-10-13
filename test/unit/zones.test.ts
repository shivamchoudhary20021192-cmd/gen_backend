import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalisePostal, zoneFor, type ZoneArea } from '../../src/modules/shipping/shippingQuote';

const area = (zone_id: number, country_code: string, region_code: string | null, postal_prefix: string | null): ZoneArea => ({
  zone_id,
  zone_name: `zone ${zone_id}`,
  country_code,
  region_code,
  postal_prefix,
});

describe('which shipping zone an address is in', () => {
  const areas = [
    area(1, 'US', 'AK', null),
    area(1, 'US', 'HI', null),
    area(2, 'US', null, '941'),
    area(3, 'US', 'CA', '9410'),
    area(4, 'GB', null, 'PA21'),
    area(5, 'GB', null, 'HS'),
    area(6, 'CA', null, null),
    area(7, 'CA', 'NU', null),
  ];
  const us = (region: string | null, postalCode: string | null) => ({ country: 'US', region, postalCode });
  const gb = (postalCode: string) => ({ country: 'GB', region: null, postalCode });

  it('by state', () => {
    assert.equal(zoneFor(areas, us('ak', '99501'))?.zone_id, 1);
  });

  it('a postcode prefix beats a state, a longer prefix a shorter, and state + prefix the prefix alone', () => {
    assert.equal(zoneFor(areas, us('CA', '94105'))?.zone_id, 3);
    assert.equal(zoneFor(areas, us('CA', '94123'))?.zone_id, 2);
    // The state-qualified prefix needs the state.
    assert.equal(zoneFor(areas, us(null, '94105'))?.zone_id, 2);
  });

  it('keeps the space that makes UK postcodes unambiguous', () => {
    assert.equal(zoneFor(areas, gb('pa21 1ab'))?.zone_id, 4);
    // District PA2, not PA21, although "PA21AB" would start with "PA21".
    assert.equal(zoneFor(areas, gb('PA2 1AB')), null);
    assert.equal(zoneFor(areas, gb('HS1  2AB'))?.zone_id, 5);
  });

  it('abroad, a whole country is a place, and its provinces can differ', () => {
    assert.equal(zoneFor(areas, { country: 'CA', region: 'ON', postalCode: 'M5V 2T6' })?.zone_id, 6);
    assert.equal(zoneFor(areas, { country: 'ca', region: 'NU', postalCode: 'X0A 0H0' })?.zone_id, 7);
    // A US state code is not matched in another country.
    assert.equal(zoneFor(areas, { country: 'MX', region: 'CA', postalCode: '94105' }), null);
  });

  it('is in no zone when nothing covers it', () => {
    assert.equal(zoneFor(areas, us('NY', '10001')), null);
    assert.equal(zoneFor(areas, us(null, null)), null);
    assert.equal(zoneFor([], us('AK', '99501')), null);
  });

  it('normalises postcodes without losing the space', () => {
    assert.equal(normalisePostal('  sw1a   1aa '), 'SW1A 1AA');
    assert.equal(normalisePostal(''), null);
    assert.equal(normalisePostal(null), null);
  });
});
