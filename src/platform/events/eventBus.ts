import { randomUUID } from 'node:crypto';
import { execute, pool, type Executor } from '../../db/pool';
import { logger } from '../../core/logger';
import { shopId } from '../tenancy/context';
import { topicDefinition } from './topics';

/**
 * Publishing a domain event.
 *
 * Pass the transaction the change is being written in, and the event commits
 * or rolls back with it — the transactional outbox. The dispatcher picks it up
 * afterwards and fans it out to webhooks and internal subscribers; nothing here
 * talks to the network, so publishing can never make a checkout slow or fail
 * because a merchant's webhook endpoint is down.
 */

export interface PublishOptions {
  resourceType?: string;
  resourceId?: number;
  actorType?: 'admin' | 'customer' | 'app' | 'system';
  actorId?: number | null;
  /** Deliver to this app's subscriptions only. */
  onlyAppId?: number;
  /** The transaction to commit with. Omit only for events with no write to belong to. */
  tx?: Executor;
}

export const eventBus = {
  async publish(topic: string, payload: Record<string, unknown>, options: PublishOptions = {}): Promise<string> {
    if (!topicDefinition(topic)) {
      // A typo'd topic would be published and delivered to nobody, forever.
      throw new Error(`Unknown event topic "${topic}". Add it to src/platform/events/topics.ts.`);
    }
    const uuid = randomUUID();
    await execute(
      `INSERT INTO events
         (shop_id, event_uuid, topic, resource_type, resource_id, payload, actor_type, actor_id, only_app_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        uuid,
        topic,
        options.resourceType ?? null,
        options.resourceId ?? null,
        JSON.stringify(payload),
        options.actorType ?? null,
        options.actorId ?? null,
        options.onlyAppId ?? null,
      ],
      options.tx ?? pool,
    );
    return uuid;
  },

  /**
   * For side-effect-only call sites that must never fail the request they are
   * part of — e.g. an event added after the fact to a legacy code path that
   * has no transaction of its own. Logs and swallows.
   */
  async publishSafely(topic: string, payload: Record<string, unknown>, options: PublishOptions = {}): Promise<void> {
    try {
      await this.publish(topic, payload, options);
    } catch (error) {
      logger.error('events.publish_failed', { topic, error: error instanceof Error ? error.message : String(error) });
    }
  },
};
