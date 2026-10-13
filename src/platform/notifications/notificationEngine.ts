import { execute, query, type RowDataPacket } from '../../db/pool';
import { logger } from '../../core/logger';
import { messagingService } from '../../modules/messaging/messaging.service';
import { toE164Digits } from '../geo/phone';
import { ShopScopedCache } from '../cache/shopCache';
import { metrics } from '../observability/metrics';
import { shopId, tenancy } from '../tenancy/context';
import { NOTIFICATIONS, notificationDefinition, type NotificationChannel } from './catalog';
import { staffNotifier } from './staffNotifier';

/**
 * Turns "this happened" into the messages a shop has chosen to send.
 *
 *   domain event → subscriber (knows the order, the customer, the words to
 *   fill in) → notificationEngine.notifyCustomer (knows the shop's channel
 *   preferences) → messagingService.send (knows consent, quiet hours,
 *   templates and which provider carries each channel).
 *
 * Every layer can decline without failing the others: a channel switched off
 * is skipped, a channel with no template is skipped, a provider refusal is
 * logged against that channel only.
 */

interface PreferenceRow extends RowDataPacket {
  event_key: string;
  audience: 'customer' | 'staff';
  channel: NotificationChannel;
  is_enabled: number;
  recipients: unknown;
}

const preferencesCache = new ShopScopedCache<PreferenceRow[]>(60_000);

async function preferences(): Promise<PreferenceRow[]> {
  return preferencesCache.get('all', () =>
    query<PreferenceRow>(
      'SELECT event_key, audience, channel, is_enabled, recipients FROM notification_preferences WHERE shop_id = ?',
      [shopId()],
    ),
  );
}

export interface Recipient {
  customerId: number | null;
  email: string | null;
  /** The national number as stored. */
  phone: string | null;
  /** "+91", "91" or empty: the stored calling code, if any. */
  countryCode: string | null;
}

function addressFor(channel: NotificationChannel, recipient: Recipient): string | null {
  if (channel === 'email') return recipient.email?.trim() || null;
  const phone = recipient.phone?.replace(/\D/g, '');
  if (!phone) return null;
  const calling = (recipient.countryCode ?? '').replace(/\D/g, '');
  return calling ? `${calling}${phone.replace(/^0+/, '')}` : toE164Digits(phone, tenancy.current().countryCode);
}

export const notificationEngine = {
  /** Whether a notification is on for a channel in this shop. */
  async enabled(key: string, channel: NotificationChannel, audience: 'customer' | 'staff' = 'customer'): Promise<boolean> {
    const definition = notificationDefinition(key);
    if (!definition || !definition.channels.includes(channel)) return false;
    const row = (await preferences()).find((pref) => pref.event_key === key && pref.channel === channel && pref.audience === audience);
    return row ? row.is_enabled === 1 : definition.defaultOn.includes(channel);
  },

  /**
   * Sends one notification to a customer on every channel the shop has on.
   * Never throws for a channel refusal; returns what happened per channel.
   */
  async notifyCustomer(input: {
    key: string;
    recipient: Recipient;
    orderId?: number | null;
    variables: Record<string, string>;
    /**
     * Send at most once per order and channel. Event delivery is at least
     * once, so a retried job must not confirm the same order twice; set this
     * for notifications an order has only one of (confirmed, delivered).
     */
    oncePerOrder?: boolean;
  }): Promise<Record<string, string>> {
    const definition = notificationDefinition(input.key);
    if (!definition) return {};
    const shop = tenancy.current();
    const variables = { shop_name: shop.name, ...input.variables };
    const outcome: Record<string, string> = {};

    for (const channel of definition.channels) {
      if (!(await this.enabled(input.key, channel))) {
        outcome[channel] = 'off';
        continue;
      }
      const to = addressFor(channel, input.recipient);
      if (!to) {
        outcome[channel] = 'no_address';
        continue;
      }
      if (input.oncePerOrder && input.orderId) {
        const already = await query<RowDataPacket & { id: number }>(
          `SELECT id FROM notification_logs
            WHERE shop_id = ? AND order_id = ? AND event_key = ? AND channel = ? AND status NOT IN ('failed','bounced')
            LIMIT 1`,
          [shopId(), input.orderId, input.key, channel],
        );
        if (already.length > 0) {
          outcome[channel] = 'already_sent';
          continue;
        }
      }
      try {
        const result = await messagingService.send({
          eventKey: input.key,
          channel,
          to,
          variables,
          customerId: input.recipient.customerId,
          orderId: input.orderId ?? null,
          // A transactional message the customer is waiting for is never held
          // back by the marketing frequency cap.
          ignoreFrequencyCap: true,
        });
        outcome[channel] = result.sent ? 'sent' : result.reason;
        metrics.counter('notifications_total', { key: input.key, channel, outcome: result.sent ? 'sent' : result.reason }).inc();
      } catch (error) {
        outcome[channel] = 'error';
        logger.error('notifications.send_failed', { key: input.key, channel, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return outcome;
  },

  /** The admin bell, and optionally email to the listed staff addresses. */
  async notifyStaff(input: {
    key: string;
    title: string;
    body?: string;
    linkUrl?: string;
    entityType?: string;
    entityId?: number;
    variables?: Record<string, string>;
  }): Promise<void> {
    await staffNotifier.notify({
      type: input.key,
      title: input.title,
      body: input.body,
      linkUrl: input.linkUrl,
      entityType: input.entityType,
      entityId: input.entityId,
    });

    if (!(await this.enabled(input.key, 'email', 'staff'))) return;
    const row = (await preferences()).find((pref) => pref.event_key === input.key && pref.channel === 'email' && pref.audience === 'staff');
    const recipients = (typeof row?.recipients === 'string' ? JSON.parse(row.recipients) : row?.recipients) as string[] | null;
    for (const email of recipients ?? []) {
      await messagingService
        .send({
          eventKey: input.key,
          channel: 'email',
          to: email,
          variables: { shop_name: tenancy.current().name, title: input.title, body: input.body ?? '', ...(input.variables ?? {}) },
          ignoreFrequencyCap: true,
        })
        .catch((error) => logger.warn('notifications.staff_email_failed', { key: input.key, error: String(error) }));
    }
  },

  // ── preferences ────────────────────────────────────────────────────────────

  async listPreferences() {
    const rows = await preferences();
    return {
      notifications: await Promise.all(
        NOTIFICATIONS.map(async (definition) => ({
          key: definition.key,
          audience: definition.audience,
          group: definition.group,
          label: definition.label,
          description: definition.description,
          channels: await Promise.all(
            definition.channels.map(async (channel) => ({
              channel,
              enabled: await this.enabled(definition.key, channel, definition.audience),
              recipients:
                definition.audience === 'staff'
                  ? (() => {
                      const row = rows.find((pref) => pref.event_key === definition.key && pref.channel === channel && pref.audience === 'staff');
                      return (typeof row?.recipients === 'string' ? JSON.parse(row.recipients) : row?.recipients) ?? [];
                    })()
                  : undefined,
            })),
          ),
        })),
      ),
    };
  },

  async setPreference(
    input: { key: string; channel: NotificationChannel; enabled: boolean; recipients?: string[] },
    adminId: number | null,
  ) {
    const definition = notificationDefinition(input.key);
    if (!definition || !definition.channels.includes(input.channel)) {
      throw new Error(`${input.key} cannot be sent by ${input.channel}.`);
    }
    await execute(
      `INSERT INTO notification_preferences (shop_id, event_key, audience, channel, is_enabled, recipients, updated_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), recipients = VALUES(recipients),
                               updated_by_admin_id = VALUES(updated_by_admin_id)`,
      [
        shopId(),
        input.key,
        definition.audience,
        input.channel,
        input.enabled ? 1 : 0,
        input.recipients ? JSON.stringify(input.recipients) : null,
        adminId,
      ],
    );
    preferencesCache.clear();
    return this.listPreferences();
  },
};
