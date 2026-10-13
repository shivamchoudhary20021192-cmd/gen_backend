import { logger } from '../../core/logger';
import type { Executor } from '../../db/pool';
import { tenancy } from '../tenancy/context';
import { eventBus } from './eventBus';
import { resourceSnapshot } from './resourceSnapshots';

/**
 * Domain events, derived from the audit trail.
 *
 * Every change staff make to a shop's resources is already written to
 * audit_logs, inside the transaction that made it. Mapping those audit actions
 * onto webhook topics means every audited change also emits its event, in the
 * same transaction — so there is no second list of "places that must remember
 * to publish", and no code path that changes a product without apps hearing
 * about it. Changes that are not audited (a shopper checking out) publish
 * their events explicitly.
 */

interface Mapped {
  topic: string;
  resourceType: string;
}

function topicsFor(action: string, entityType: string | null | undefined): Mapped[] {
  const [resource, verb] = action.split('.', 2) as [string, string | undefined];
  if (!verb) return [];

  switch (resource) {
    case 'product':
      if (verb.startsWith('bulk_')) return [];
      if (verb === 'created' || verb === 'duplicated') return [{ topic: 'products/create', resourceType: 'product' }];
      if (verb === 'deleted') return [{ topic: 'products/delete', resourceType: 'product' }];
      return [{ topic: 'products/update', resourceType: 'product' }];
    case 'collection':
      if (verb === 'created') return [{ topic: 'collections/create', resourceType: 'collection' }];
      if (verb === 'deleted') return [{ topic: 'collections/delete', resourceType: 'collection' }];
      return [{ topic: 'collections/update', resourceType: 'collection' }];
    case 'customer':
      if (verb === 'deleted') return [{ topic: 'customers/delete', resourceType: 'customer' }];
      return [{ topic: 'customers/update', resourceType: 'customer' }];
    case 'discount':
      if (verb === 'created') return [{ topic: 'discounts/create', resourceType: 'coupon' }];
      if (verb === 'deleted') return [{ topic: 'discounts/delete', resourceType: 'coupon' }];
      return [{ topic: 'discounts/update', resourceType: 'coupon' }];
    case 'inventory':
      return entityType === 'product_variant' ? [{ topic: 'inventory_levels/update', resourceType: 'product_variant' }] : [];
    case 'order':
      if (verb === 'cancelled') return [{ topic: 'orders/cancelled', resourceType: 'order' }, { topic: 'orders/updated', resourceType: 'order' }];
      if (verb === 'refunded') return [{ topic: 'refunds/create', resourceType: 'order' }, { topic: 'orders/updated', resourceType: 'order' }];
      if (verb === 'shipped') return [{ topic: 'fulfillments/create', resourceType: 'order' }, { topic: 'orders/updated', resourceType: 'order' }];
      return [{ topic: 'orders/updated', resourceType: 'order' }];
    case 'shipment':
      if (verb === 'status_changed' || verb === 'cancelled') return [{ topic: 'fulfillments/update', resourceType: 'shipment' }];
      return [];
    case 'return':
      if (verb === 'created') return [{ topic: 'returns/request', resourceType: 'return_request' }];
      return [];
    default:
      return [];
  }
}

/**
 * Called by the audit service after it writes an entry. Publishes nothing for
 * entries outside a shop, or without an entity to describe.
 */
export async function publishForAudit(
  entry: { action: string; entityType?: string | null; entityId?: number | null; actorType?: string; actorId?: number | null; changes?: Record<string, unknown> | null },
  exec: Executor,
): Promise<void> {
  if (!tenancy.currentOrNull() || !entry.entityId) return;
  const mapped = topicsFor(entry.action, entry.entityType);
  if (mapped.length === 0) return;

  for (const { topic, resourceType } of mapped) {
    try {
      const snapshot = (await resourceSnapshot(resourceType, entry.entityId, exec)) ?? { id: entry.entityId };
      await eventBus.publish(topic, snapshot, {
        resourceType,
        resourceId: entry.entityId,
        actorType: entry.actorType === 'admin' || entry.actorType === undefined ? 'admin' : entry.actorType === 'customer' ? 'customer' : 'system',
        actorId: entry.actorId ?? null,
        tx: exec,
      });
      // "Every item shipped" is its own topic, derived from the order after the change.
      if (topic === 'fulfillments/create' && snapshot.fulfillment_status === 'fulfilled') {
        await eventBus.publish('orders/fulfilled', snapshot, { resourceType, resourceId: entry.entityId, actorType: 'admin', actorId: entry.actorId ?? null, tx: exec });
      }
    } catch (error) {
      // Like the audit row itself: never break the change being described,
      // but make the gap loud.
      logger.error('events.audit_publish_failed', { action: entry.action, topic, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
