import { env } from '../config/env';
import { logger } from '../core/logger';
import { controlPlane, type RowDataPacket } from '../db/pool';
import { eventDispatcher } from './events/dispatcher';
import { jobQueue } from './jobs/queue';
import { scheduler } from './jobs/scheduler';
import { Worker } from './jobs/worker';
import { metrics } from './observability/metrics';

// ── the manifest ─────────────────────────────────────────────────────────────
//
// Job types, event subscribers and inbound-webhook handlers are declared next
// to the code they belong to, at module level; importing a module registers
// them. A process that runs a worker must know every one of them — a job type
// nobody registered is dead-lettered, and an event with no registered
// subscriber is silently not acted on — so every such module is imported here,
// in one place, and both the API (embedded worker) and `src/worker.ts` load it.
import './jobs/maintenance';
import './apps/apps.service';
import './webhooks/webhooks.service';
import './integrations/providers';
import './integrations/inbound';
import './shops/provisioning';
import './domains/domains.jobs';
import './billing/billing.jobs';
import './mail/mailer';
import './tax/taxReporting';
import './markets/fx';
import '../modules/messaging/deliveryReceipts';
import '../modules/payments/onlinePayments.service';
import '../modules/shipments/shipments.service';
import '../modules/orders/orderNotifications';
import '../modules/giftCards/giftCards.subscriber';
import './privacy/privacy.jobs';
import { registerCampaignSchedule } from '../modules/messaging/campaignWorker';

/**
 * Starts and stops the background half of the platform: the job worker, the
 * scheduler that feeds it, and the event dispatcher that turns committed
 * domain events into jobs.
 *
 * The API server calls this when WORKER_EMBEDDED is on (one process does
 * everything — right for a single server); `src/worker.ts` calls it in a
 * dedicated worker process. Both paths are this function, so a worker process
 * is never subtly different from an embedded one.
 */

let worker: Worker | null = null;
let schedulesRegistered = false;

function registerSchedules(): void {
  if (schedulesRegistered) return;
  schedulesRegistered = true;
  scheduler.every('platform.maintenance', 15 * 60_000, 'platform.maintenance');
  // Custom domains: the due-list sweep every minute (it backs off per domain), renewals daily.
  scheduler.every('domains.sweep', 60_000, 'domains.sweep');
  scheduler.every('domains.renewals', 24 * 3_600_000, 'domains.renewals');
  scheduler.every('domains.transfers', 10 * 60_000, 'domains.transfers');
  scheduler.every('billing.cycle', 15 * 60_000, 'billing.tick');
  scheduler.every('markets.fx', 6 * 3_600_000, 'markets.fx_refresh');
  // Privacy: run erasures that are due, delete expired data exports, lapse unconfirmed requests.
  scheduler.every('privacy.sweep', 15 * 60_000, 'privacy.sweep');
  registerCampaignSchedule();
}

function registerQueueGauges(): void {
  metrics.onCollect(async () => {
    for (const row of await jobQueue.stats()) {
      metrics.gauge('jobs_queue_depth', { queue: row.queue, status: row.status }).set(row.count);
      if (row.oldest && row.status === 'pending') {
        metrics.gauge('jobs_oldest_pending_seconds', { queue: row.queue }).set(Math.max(0, (Date.now() - new Date(row.oldest).getTime()) / 1000));
      }
    }
    const [pending] = await controlPlane.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM jobs WHERE status = ?', ['dead']);
    metrics.gauge('jobs_dead_total').set(Number(pending[0]?.total ?? 0));
  });
}

export const platformRuntime = {
  start(): void {
    if (worker) return;
    registerSchedules();
    registerQueueGauges();
    worker = new Worker({ concurrency: env.worker.concurrency, pollIntervalMs: env.worker.pollIntervalMs });
    worker.start();
    // Exchange rates on boot too: a fresh install should not wait six hours
    // for its first rates. Once an hour at most, however often it restarts.
    void jobQueue
      .enqueue('markets.fx_refresh', {}, { shopId: null, uniqueKey: `markets.fx_refresh:boot:${new Date().toISOString().slice(0, 13)}` })
      .catch(() => undefined);
    eventDispatcher.start();
    logger.info('platform.runtime_started', {
      concurrency: env.worker.concurrency,
      schedules: scheduler.list().map((schedule) => schedule.name),
    });
  },

  async stop(): Promise<void> {
    eventDispatcher.stop();
    if (worker) await worker.stop();
    worker = null;
  },

  get running(): boolean {
    return worker !== null;
  },
};
