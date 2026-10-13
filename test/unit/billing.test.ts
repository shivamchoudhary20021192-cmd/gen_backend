import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addInterval, nextAttemptAt, pastGrace, transactionFee, unusedCredit } from '../../src/platform/billing/billingMath';

const at = (iso: string) => new Date(iso);

describe('billing periods', () => {
  it('runs to the same day next month', () => {
    assert.equal(addInterval(at('2026-03-15T10:00:00Z'), 'month').toISOString(), '2026-04-15T10:00:00.000Z');
    assert.equal(addInterval(at('2026-12-15T10:00:00Z'), 'month').toISOString(), '2027-01-15T10:00:00.000Z');
  });

  it('clamps the 31st to the end of a shorter month instead of spilling over', () => {
    assert.equal(addInterval(at('2026-01-31T00:00:00Z'), 'month').toISOString(), '2026-02-28T00:00:00.000Z');
    assert.equal(addInterval(at('2028-01-31T00:00:00Z'), 'month').toISOString(), '2028-02-29T00:00:00.000Z');
    // …and returns to the anchor day when the month allows it.
    assert.equal(addInterval(at('2026-02-28T00:00:00Z'), 'month', 31).toISOString(), '2026-03-31T00:00:00.000Z');
  });

  it('runs a year to the same date, 29 February becoming the 28th', () => {
    assert.equal(addInterval(at('2028-02-29T00:00:00Z'), 'year').toISOString(), '2029-02-28T00:00:00.000Z');
  });
});

describe('proration', () => {
  const start = at('2026-04-01T00:00:00Z');
  const end = at('2026-05-01T00:00:00Z');

  it('credits the unused part of the period', () => {
    assert.equal(unusedCredit(3000, start, end, at('2026-04-16T00:00:00Z'), 'INR'), 1500);
  });

  it('credits nothing at the end and everything at the start', () => {
    assert.equal(unusedCredit(3000, start, end, end, 'INR'), 0);
    assert.equal(unusedCredit(3000, start, end, start, 'INR'), 3000);
    assert.equal(unusedCredit(3000, start, end, at('2026-06-01T00:00:00Z'), 'INR'), 0);
  });

  it('rounds to the currency, including one without minor units', () => {
    assert.equal(unusedCredit(19, start, end, at('2026-04-11T00:00:00Z'), 'USD'), 12.67);
    assert.equal(unusedCredit(1999, start, end, at('2026-04-11T00:00:00Z'), 'JPY'), 1333);
  });
});

describe('transaction fees', () => {
  it('is basis points of sales, rounded to the currency', () => {
    assert.equal(transactionFee(123_456.78, 200, 'INR'), 2469.14);
    assert.equal(transactionFee(1000, 50, 'USD'), 5);
    assert.equal(transactionFee(0, 200, 'INR'), 0);
    assert.equal(transactionFee(1000, 0, 'INR'), 0);
  });
});

describe('dunning', () => {
  const failedAt = at('2026-04-01T00:00:00Z');

  it('retries after 1, 3 and 5 days, then stops', () => {
    assert.equal(nextAttemptAt(1, failedAt)?.toISOString(), '2026-04-02T00:00:00.000Z');
    assert.equal(nextAttemptAt(2, failedAt)?.toISOString(), '2026-04-04T00:00:00.000Z');
    assert.equal(nextAttemptAt(3, failedAt)?.toISOString(), '2026-04-06T00:00:00.000Z');
    assert.equal(nextAttemptAt(4, failedAt), null);
  });

  it('freezes only once the grace period has fully passed', () => {
    assert.equal(pastGrace(failedAt, at('2026-04-07T23:59:59Z'), 7), false);
    assert.equal(pastGrace(failedAt, at('2026-04-08T00:00:00Z'), 7), true);
    assert.equal(pastGrace(null, at('2027-01-01T00:00:00Z'), 7), false);
  });
});
