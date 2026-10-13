import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { knowsRegionsOf, regionCodeFor } from '../../src/platform/geo/regions';
import { registrationFor } from '../../src/platform/tax/taxService';

describe('region codes', () => {
  it('reads a US state or Canadian province by name or by code', () => {
    assert.equal(regionCodeFor('US', 'California'), 'CA');
    assert.equal(regionCodeFor('US', '  new   york '), 'NY');
    assert.equal(regionCodeFor('US', 'District of Columbia'), 'DC');
    assert.equal(regionCodeFor('US', 'tx'), 'TX');
    assert.equal(regionCodeFor('CA', 'Québec'), 'QC');
    assert.equal(regionCodeFor('CA', 'Newfoundland & Labrador'), 'NL');
  });

  it('does not guess', () => {
    assert.equal(regionCodeFor('US', 'Ontario'), null);
    assert.equal(regionCodeFor('US', 'ZZ'), null);
    assert.equal(regionCodeFor('US', ''), null);
    assert.equal(regionCodeFor('FR', 'Paris'), null);
    assert.equal(knowsRegionsOf('FR'), false);
    assert.equal(knowsRegionsOf('us'), true);
  });

  it('uses the GST state table for India', () => {
    assert.equal(regionCodeFor('IN', 'Karnataka'), '29');
  });
});

describe('which registration applies', () => {
  const rows = [
    { id: 1, country_code: 'CA', region_code: null, rate: 5 },
    { id: 2, country_code: 'CA', region_code: 'ON', rate: 13 },
    { id: 3, country_code: 'US', region_code: 'CA', rate: 7.25 },
  ];

  it('prefers the province over the country', () => {
    assert.equal(registrationFor(rows, 'CA', 'ON')?.id, 2);
    assert.equal(registrationFor(rows, 'ca', 'on')?.id, 2);
  });

  it('falls back to the whole country', () => {
    assert.equal(registrationFor(rows, 'CA', 'AB')?.id, 1);
    assert.equal(registrationFor(rows, 'CA', null)?.id, 1);
  });

  it('finds nothing where the store is not registered', () => {
    assert.equal(registrationFor(rows, 'US', 'OR'), null);
    assert.equal(registrationFor(rows, 'US', null), null);
    // A US state code is not a Canadian province.
    assert.equal(registrationFor(rows, 'US', 'ON'), null);
  });
});
