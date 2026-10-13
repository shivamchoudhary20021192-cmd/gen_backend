import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeHash, formatCode, generateCode, isValidCode, lastCharacters, lookupToken, maskedCode, normaliseCode } from '../../src/modules/giftCards/giftCardCodes';
import { allocate, dateOnly, stateOf, todayIn, unusableReason } from '../../src/modules/giftCards/giftCards.service';

// Pure helpers only: nothing here touches a database.

describe('gift card codes', () => {
  it('generates 16 unambiguous characters, different every time', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateCode()));
    assert.equal(codes.size, 200);
    for (const code of codes) {
      assert.match(code, /^[A-HJKMNP-Z2-9]{16}$/);
      assert.equal(isValidCode(code), true);
    }
  });

  it('reads what a shopper types, however they type it', () => {
    assert.equal(normaliseCode(' abcd-efgh jkmn\tpqrs '), 'ABCDEFGHJKMNPQRS');
    assert.equal(formatCode('ABCDEFGHJKMNPQRS'), 'ABCD EFGH JKMN PQRS');
    assert.equal(lastCharacters('ABCDEFGHJKMNPQRS'), 'PQRS');
    assert.equal(maskedCode('PQRS'), '•••• •••• •••• PQRS');
  });

  it('accepts merchants’ own codes of 8 to 20 letters and digits', () => {
    assert.equal(isValidCode('BIRTHDAY2026'), true);
    assert.equal(isValidCode('SHORT'), false);
    assert.equal(isValidCode('X'.repeat(21)), false);
  });

  it('hashes per shop, so the same code in two shops never collides', () => {
    assert.equal(codeHash(1, 'ABCDEFGHJKMNPQRS'), codeHash(1, 'ABCDEFGHJKMNPQRS'));
    assert.notEqual(codeHash(1, 'ABCDEFGHJKMNPQRS'), codeHash(2, 'ABCDEFGHJKMNPQRS'));
    assert.match(lookupToken(), /^[0-9a-f]{32}$/);
  });
});

describe('what a card can pay', () => {
  it('covers the total with the cards in the order they were applied', () => {
    assert.deepEqual(allocate(1000, [{ id: 1, balance: 300 }, { id: 2, balance: 5000 }], 'INR'), [
      { id: 1, amount: 300 },
      { id: 2, amount: 700 },
    ]);
    assert.deepEqual(allocate(250, [{ id: 1, balance: 300 }, { id: 2, balance: 5000 }], 'INR'), [
      { id: 1, amount: 250 },
      { id: 2, amount: 0 },
    ]);
    assert.deepEqual(allocate(0, [{ id: 1, balance: 300 }], 'INR'), [{ id: 1, amount: 0 }]);
  });

  it('rounds to the currency’s smallest unit', () => {
    const [share] = allocate(10.005, [{ id: 1, balance: 20 }], 'USD');
    assert.equal(share.amount, 10.01);
    const [yen] = allocate(1500.4, [{ id: 1, balance: 9000 }], 'JPY');
    assert.equal(yen.amount, 1500);
  });
});

describe('a card’s state', () => {
  const card = (overrides: Record<string, unknown> = {}) =>
    ({ status: 'enabled', expires_on: null, balance: '500.00', currency: 'INR', last_characters: 'PQRS', ...overrides }) as never;

  it('is active, used, expired or disabled', () => {
    assert.equal(stateOf(card(), '2026-09-29'), 'active');
    assert.equal(stateOf(card({ balance: '0.00' }), '2026-09-29'), 'used');
    assert.equal(stateOf(card({ expires_on: '2026-09-28' }), '2026-09-29'), 'expired');
    assert.equal(stateOf(card({ expires_on: '2026-09-29' }), '2026-09-29'), 'active', 'usable through its last day');
    assert.equal(stateOf(card({ status: 'disabled' }), '2026-09-29'), 'disabled');
  });

  it('says why it cannot pay, including for a basket in another currency', () => {
    assert.equal(unusableReason(card(), 'INR', '2026-09-29'), null);
    assert.match(unusableReason(card(), 'EUR', '2026-09-29') ?? '', /is in INR; this order is in EUR/);
    assert.match(unusableReason(card({ status: 'disabled' }), 'INR', '2026-09-29') ?? '', /disabled/);
    assert.match(unusableReason(card({ expires_on: new Date('2026-01-01T00:00:00Z') }), 'INR', '2026-09-29') ?? '', /expired on 2026-01-01/);
  });

  it('counts days in the shop’s timezone', () => {
    const lateEvening = new Date('2026-09-29T20:00:00Z');
    assert.equal(todayIn('Asia/Kolkata', lateEvening), '2026-09-30');
    assert.equal(todayIn('America/New_York', lateEvening), '2026-09-29');
    assert.equal(todayIn('Not/AZone', lateEvening), '2026-09-29');
    assert.equal(dateOnly(new Date('2027-03-01T00:00:00Z')), '2027-03-01');
    assert.equal(dateOnly(null), null);
  });
});
