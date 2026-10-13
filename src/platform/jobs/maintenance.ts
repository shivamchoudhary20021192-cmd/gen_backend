import { logger } from '../../core/logger';
import { controlPlane, execute, query, type RowDataPacket } from '../../db/pool';
import { podRouter } from '../../db/pods';
import { appsRepository } from '../apps/apps.repository';
import { tenancy } from '../tenancy/context';
import { jobQueue } from './queue';
import { defineJob } from './registry';

/**
 * Housekeeping that keeps the platform's own tables from growing forever.
 *
 * Every table purged here is append-heavy and only ever read recently: the job
 * table (a row per tick and per delivery), the event outbox (a row per domain
 * change), webhook delivery logs, and expired OAuth codes. Each statement is
 * bounded with LIMIT and walks an index on its time column, so a purge never
 * holds a long lock; a backlog clears over successive runs instead of at once.
 */

const RETENTION = {
  eventsDays: 30,
  webhookDeliveriesDays: 30,
};

async function purgeTenantTable(sql: string, label: string): Promise<number> {
  let total = 0;
  for (const podId of podRouter.configuredPods()) {
    const pool = podRouter.poolFor(podId);
    const result = await tenancy.unscoped(`maintenance: purge ${label}`, () => execute(sql, [], pool));
    total += result.affectedRows;
  }
  return total;
}

/**
 * Inbound provider webhooks are stored and then processed by a job. If the
 * enqueue failed after the store (the control plane was briefly unreachable),
 * the event would sit in 'received' for ever; this puts it back on the queue.
 */
async function requeueStrandedInbound(): Promise<number> {
  let total = 0;
  for (const podId of podRouter.configuredPods()) {
    const pool = podRouter.poolFor(podId);
    const stranded = await tenancy.unscoped('maintenance: find stranded inbound webhooks', () =>
      query<RowDataPacket & { id: number; shop_id: number }>(
        `SELECT id, shop_id FROM integration_webhook_events
          WHERE status = 'received' AND received_at < DATE_SUB(NOW(3), INTERVAL 2 MINUTE)
          ORDER BY id
          LIMIT 500`,
        [],
        pool,
      ),
    );
    for (const event of stranded) {
      const added = await jobQueue.enqueue(
        'integrations.process_inbound',
        { event_id: Number(event.id) },
        {
          shopId: Number(event.shop_id),
          queue: 'integrations',
          maxAttempts: 12,
          uniqueKey: `inbound:${event.shop_id}:${event.id}`,
        },
      );
      if (added) total += 1;
    }
  }
  return total;
}

defineJob({
  type: 'platform.maintenance',
  queue: 'default',
  shopScoped: false,
  maxAttempts: 1,
  timeoutMs: 120_000,
  async handler() {
    const jobs = await jobQueue.purgeFinished();
    const codes = await appsRepository.purgeExpiredCodes();
    const events = await purgeTenantTable(
      `DELETE FROM events
        WHERE dispatched_at IS NOT NULL AND dispatched_at < DATE_SUB(NOW(3), INTERVAL ${RETENTION.eventsDays} DAY)
        LIMIT 5000`,
      'events',
    );
    const deliveries = await purgeTenantTable(
      `DELETE FROM webhook_deliveries
        WHERE created_at < DATE_SUB(NOW(3), INTERVAL ${RETENTION.webhookDeliveriesDays} DAY)
        LIMIT 5000`,
      'webhook deliveries',
    );
    const requeued = await requeueStrandedInbound();
    // A bucket idle for an hour has long drained to empty: forgetting it
    // changes nothing but the table's size.
    const buckets = (
      await execute('DELETE FROM api_rate_buckets WHERE updated_ms < ? LIMIT 5000', [Date.now() - 3_600_000], controlPlane)
    ).affectedRows;
    if (jobs + codes + events + deliveries + requeued + buckets > 0) {
      logger.info('platform.maintenance', {
        jobs,
        oauth_codes: codes,
        events,
        webhook_deliveries: deliveries,
        inbound_requeued: requeued,
        api_buckets: buckets,
      });
    }
  },
});
