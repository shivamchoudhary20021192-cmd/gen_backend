import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { podRouter } from '../../db/pods';
import { withTransaction } from '../../db/transaction';
import { logger } from '../../core/logger';
import { jobQueue } from '../jobs/queue';
import { defineJob, PermanentJobError } from '../jobs/registry';
import { metrics } from '../observability/metrics';
import { shopDirectory } from '../shops/shopDirectory';
import { tenancy } from '../tenancy/context';
import { isComplianceTopic } from './topics';
import { subscriber, subscribersFor, type DomainEvent } from './subscribers';

/**
 * Empties the outbox.
 *
 * Takes undispatched events in id order (SKIP LOCKED, so several dispatchers
 * can share the work), turns each into jobs — one per webhook subscription,
 * one per in-process subscriber — and marks it dispatched. Enqueueing and
 * marking are not one transaction (the queue may live in another database),
 * so a crash in between re-dispatches the event; every job carries a unique
 * key derived from the event, and the second enqueue is a no-op.
 */

interface EventRow extends RowDataPacket {
  id: number;
  shop_id: number;
  event_uuid: string;
  topic: string;
  resource_type: string | null;
  resource_id: number | null;
  payload: unknown;
  actor_type: string | null;
  actor_id: number | null;
  only_app_id: number | null;
  occurred_at: Date;
}

const BATCH = 100;
let timer: NodeJS.Timeout | null = null;
let running = false;

function toDomainEvent(row: EventRow): DomainEvent {
  return {
    id: Number(row.id),
    uuid: row.event_uuid,
    shopId: Number(row.shop_id),
    topic: row.topic,
    resourceType: row.resource_type,
    resourceId: row.resource_id === null ? null : Number(row.resource_id),
    payload: (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>,
    actorType: row.actor_type,
    actorId: row.actor_id === null ? null : Number(row.actor_id),
    occurredAt: row.occurred_at,
  };
}

async function fanOut(event: EventRow): Promise<number> {
  const shop = await shopDirectory.byId(Number(event.shop_id));
  if (!shop || shop.status === 'closed') return 0;

  return tenancy.run(shop, async () => {
    let enqueued = 0;

    const params: unknown[] = [shop.id, event.topic];
    let appFilter = '';
    if (event.only_app_id !== null) {
      appFilter = 'AND app_id = ?';
      params.push(event.only_app_id);
    }
    const subscriptions = await query<RowDataPacket>(
      `SELECT id FROM webhook_subscriptions
        WHERE shop_id = ? AND topic = ? AND status = 'active' ${appFilter}`,
      params,
    );
    for (const subscription of subscriptions) {
      if (
        await jobQueue.enqueue(
          'webhooks.deliver',
          { subscription_id: Number(subscription.id), event_id: Number(event.id) },
          { shopId: shop.id, queue: 'webhooks', maxAttempts: 19, uniqueKey: `wh:${subscription.id}:${event.event_uuid}` },
        )
      ) {
        enqueued += 1;
      }
    }

    // Privacy requests go to every installed app's compliance endpoint,
    // subscribed or not — handling them is a condition of being installed.
    if (isComplianceTopic(event.topic)) {
      if (
        await jobQueue.enqueue(
          'apps.deliver_compliance',
          { event_id: Number(event.id) },
          { shopId: shop.id, queue: 'webhooks', maxAttempts: 19, uniqueKey: `compliance:${event.event_uuid}` },
        )
      ) {
        enqueued += 1;
      }
    }

    for (const target of subscribersFor(event.topic)) {
      if (
        await jobQueue.enqueue(
          'events.deliver_internal',
          { subscriber: target.name, event_id: Number(event.id) },
          { shopId: shop.id, queue: 'events', maxAttempts: 8, uniqueKey: `sub:${target.name}:${event.event_uuid}` },
        )
      ) {
        enqueued += 1;
      }
    }

    return enqueued;
  });
}

async function dispatchPod(podId: number): Promise<number> {
  const pool = podRouter.poolFor(podId);
  return tenancy.unscoped('outbox dispatch sweeps every shop on the pod', () =>
    withTransaction(async (tx) => {
      const events = await query<EventRow>(
        `SELECT * FROM events WHERE dispatched_at IS NULL ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,
        [BATCH],
        tx,
      );
      if (events.length === 0) return 0;

      const done: number[] = [];
      for (const event of events) {
        try {
          const jobs = await fanOut(event);
          done.push(Number(event.id));
          metrics.counter('events_dispatched_total', { topic: event.topic }).inc();
          if (jobs === 0) logger.debug('events.no_listeners', { topic: event.topic, event_id: event.id });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('events.fanout_failed', { event_id: event.id, topic: event.topic, error: message });
          await execute(
            'UPDATE events SET dispatch_attempts = dispatch_attempts + 1, last_error = ? WHERE id = ?',
            [message.slice(0, 500), event.id],
            tx,
          );
        }
      }
      if (done.length > 0) {
        await execute(
          'UPDATE events SET dispatched_at = NOW(3), dispatch_attempts = dispatch_attempts + 1, last_error = NULL WHERE id IN (?)',
          [done],
          tx,
        );
      }
      return events.length;
    }, pool),
  );
}

export const eventDispatcher = {
  async dispatchOnce(): Promise<number> {
    let total = 0;
    for (const podId of podRouter.configuredPods()) total += await dispatchPod(podId);
    return total;
  },

  start(idleMs = 500): void {
    if (running) return;
    running = true;
    const loop = async () => {
      if (!running) return;
      let handled = 0;
      try {
        handled = await this.dispatchOnce();
      } catch (error) {
        logger.error('events.dispatch_failed', { error: error instanceof Error ? error.message : String(error) });
      }
      if (running) {
        timer = setTimeout(() => void loop(), handled >= BATCH ? 0 : idleMs);
        timer.unref?.();
      }
    };
    void loop();
  },

  stop(): void {
    running = false;
    if (timer) clearTimeout(timer);
  },
};

/** Loads an event in the current shop. Used by every job that acts on one. */
export async function loadEvent(eventId: number): Promise<DomainEvent | null> {
  const row = await queryOne<EventRow>('SELECT * FROM events WHERE shop_id = ? AND id = ?', [
    tenancy.current().id,
    eventId,
  ]);
  return row ? toDomainEvent(row) : null;
}

defineJob<{ subscriber: string; event_id: number }>({
  type: 'events.deliver_internal',
  queue: 'events',
  shopScoped: true,
  maxAttempts: 8,
  async handler(payload) {
    const target = subscriber(payload.subscriber);
    if (!target) throw new PermanentJobError(`Subscriber ${payload.subscriber} is no longer registered.`);
    const event = await loadEvent(payload.event_id);
    if (!event) throw new PermanentJobError(`Event ${payload.event_id} no longer exists.`);
    await target.handle(event);
  },
});
