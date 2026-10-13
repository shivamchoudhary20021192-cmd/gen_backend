import { defineJob } from '../jobs/registry';
import { billingEngine } from './billingEngine';

/**
 * The billing cycle, run by the scheduler every quarter of an hour: opens the
 * periods that ended (trial ends included), retries charges that are due and
 * freezes stores past their grace period. Idempotent — a period is billed once
 * however many workers run it.
 */
defineJob({
  type: 'billing.tick',
  shopScoped: false,
  maxAttempts: 3,
  timeoutMs: 10 * 60_000,
  handler: async () => {
    await billingEngine.tick();
  },
});
