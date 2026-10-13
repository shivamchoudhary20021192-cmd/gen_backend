import { logger } from '../../core/logger';
import { metrics } from '../observability/metrics';
import { defineJob } from '../jobs/registry';
import { advanceTransfers, check, renewDue } from './domains.service';
import { domainsRepository } from './domains.repository';

/**
 * The domain sweep: every minute, each worker claims a batch of domains that
 * are due and checks them, a few at a time.
 *
 * It scales by adding workers — claims are leased, so two never check the
 * same domain — and by the schedule, which spreads checks out (a live domain
 * is looked at every ~6 hours, jittered). At a million domains that is
 * roughly 50 checks a second across the fleet, each a handful of DNS
 * queries; the DoH resolvers and the edge API are the limits to watch, not
 * the database.
 */

const BATCH = Number(process.env.DOMAIN_SWEEP_BATCH ?? 200);
const CONCURRENCY = Number(process.env.DOMAIN_SWEEP_CONCURRENCY ?? 10);

async function inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  });
  await Promise.all(runners);
}

async function sweep(): Promise<void> {
  const due = await domainsRepository.claimDue(BATCH);
  if (!due.length) return;
  let failed = 0;
  await inParallel(due, CONCURRENCY, async (domain) => {
    try {
      await check(domain);
    } catch (error) {
      failed += 1;
      logger.warn('domains.check_failed', { hostname: domain.hostname, error: error instanceof Error ? error.message : String(error) });
      // Try again in ten minutes rather than waiting out the lease.
      await domainsRepository.update(domain.id, { next_check_at: new Date(Date.now() + 10 * 60_000), check_lease: null }).catch(() => undefined);
    }
  });
  metrics.counter('domain_checks_total', { outcome: 'checked' }).inc(due.length - failed);
  if (failed) metrics.counter('domain_checks_total', { outcome: 'failed' }).inc(failed);
  logger.info('domains.sweep', { checked: due.length, failed });
}

defineJob({
  type: 'domains.sweep',
  queue: 'default',
  shopScoped: false,
  maxAttempts: 1,
  timeoutMs: 170_000,
  handler: sweep,
});

defineJob({
  type: 'domains.renewals',
  queue: 'default',
  shopScoped: false,
  maxAttempts: 1,
  timeoutMs: 600_000,
  async handler() {
    const result = await renewDue();
    if (result.renewed || result.failed) logger.info('domains.renewals', result);
  },
});

/** Transfers in: each is asked about every ten minutes until the registries finish (up to a week). */
defineJob({
  type: 'domains.transfers',
  queue: 'default',
  shopScoped: false,
  maxAttempts: 1,
  timeoutMs: 600_000,
  async handler() {
    const result = await advanceTransfers();
    if (result.completed || result.failed || result.pending) logger.info('domains.transfers', result);
  },
});

/** The job the previous domain checker was scheduled as: already-queued runs do the new sweep. */
defineJob({
  type: 'shops.verify_pending_domains',
  queue: 'default',
  shopScoped: false,
  maxAttempts: 1,
  timeoutMs: 170_000,
  handler: sweep,
});
