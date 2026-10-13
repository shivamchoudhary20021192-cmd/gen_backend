import { roundMoney } from '../money/currency';

/**
 * The arithmetic of a platform bill, kept free of I/O so it can be tested on
 * its own: billing periods, prorations, transaction fees and the dunning
 * schedule.
 */

export type BillingInterval = 'month' | 'year';

/**
 * The end of a billing period that starts at `start`: the same day of the
 * next month (or year), clamped to the month's last day — 31 January is
 * followed by 28 or 29 February, then 31 March, never 3 March.
 */
export function addInterval(start: Date, interval: BillingInterval, anchorDay = start.getUTCDate()): Date {
  const next = new Date(start.getTime());
  const months = interval === 'year' ? 12 : 1;
  const targetMonth = next.getUTCMonth() + months;
  next.setUTCDate(1);
  next.setUTCMonth(targetMonth);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(anchorDay, lastDay));
  return next;
}

/**
 * The unused part of a period's charge when a plan changes mid-period, as a
 * credit: the fraction of the period still to run times what was charged.
 * Measured in seconds, so a change a minute into the period credits almost
 * all of it.
 */
export function unusedCredit(charged: number, periodStart: Date, periodEnd: Date, at: Date, currency: string): number {
  const total = periodEnd.getTime() - periodStart.getTime();
  if (total <= 0 || charged <= 0) return 0;
  const remaining = Math.min(total, Math.max(0, periodEnd.getTime() - at.getTime()));
  return roundMoney((charged * remaining) / total, currency);
}

/** A percentage of sales in basis points, rounded to the currency. */
export function transactionFee(sales: number, basisPoints: number, currency: string): number {
  if (sales <= 0 || basisPoints <= 0) return 0;
  return roundMoney((sales * basisPoints) / 10_000, currency);
}

/**
 * When to try a failed charge again: a day after the first failure, then
 * three days, then five. After the fourth failure nothing is retried
 * automatically; the merchant pays from Billing, or updates the card, which
 * retries at once.
 */
const RETRY_AFTER_DAYS = [1, 3, 5];

export function nextAttemptAt(attemptsSoFar: number, from: Date): Date | null {
  const days = RETRY_AFTER_DAYS[attemptsSoFar - 1];
  return days === undefined ? null : new Date(from.getTime() + days * 86_400_000);
}

/** Whether an unpaid bill has been unpaid long enough to freeze the store. */
export function pastGrace(firstFailedAt: Date | null, now: Date, graceDays: number): boolean {
  return firstFailedAt !== null && now.getTime() - firstFailedAt.getTime() >= graceDays * 86_400_000;
}
