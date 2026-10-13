import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { quietHours, quietHoursApplies } from './compliance';
import { CHANNEL_LIMITS, render, smsInfo } from './messageContent';
import { messagingRepository } from './messaging.repository';
import { messagingService } from './messaging.service';
import { messagingSettings } from './messagingSettings';
import { outboundSender, resolveMessageProvider } from './providers';
import { shopId } from '../../platform/tenancy/context';
import { callingCodeFor } from '../../platform/geo/phone';
import { tenancy } from '../../platform/tenancy/context';

/**
 * Messaging one person, by hand, from their page in the admin.
 *
 * The bulk path and this one share every rule, but they do not share the
 * question they are answering. A campaign asks "who should hear this"; this asks
 * "can I reply to *this* customer, right now, and how". So the useful thing this
 * returns is not a form — it is the state of the three channels for one person:
 * which have an address, which have consent, which are inside a window, and what
 * may be sent on each.
 *
 * ── free text, and where it is not allowed ──────────────────────────────────
 *
 * WhatsApp allows free-form replies only inside 24 hours of the customer's own
 * last message; outside that window, business-initiated contact must use a
 * template Meta has approved. Indian SMS is stricter still: with DLT enforced,
 * every commercial message must map to a registered template, so there is no
 * free-form SMS at all. Email has neither constraint.
 *
 * Rather than let someone type a message and have it refused by a gateway
 * minutes later, the composer says which of the three it is before they start.
 */

const CONSENT_PURPOSE: Record<string, string> = {
  email: 'marketing_email',
  sms: 'marketing_sms',
  whatsapp: 'marketing_whatsapp',
};

interface CustomerRow extends RowDataPacket {
  id: number;
  public_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  country_code: string | null;
  status: string;
  accepts_email_marketing: number;
  accepts_sms_marketing: number;
  accepts_whatsapp_marketing: number;
  orders_count: number;
  total_spent: string;
  last_order_at: Date | null;
}

async function customer(customerId: number, exec: Executor): Promise<CustomerRow> {
  const row = await queryOne<CustomerRow>(
    `SELECT id, public_id, first_name, last_name, email, phone, country_code, status,
            accepts_email_marketing, accepts_sms_marketing, accepts_whatsapp_marketing,
            orders_count, total_spent, last_order_at
       FROM customers WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1`,
    [shopId(), customerId],
    exec,
  );
  if (!row) throw ApiError.notFound('Customer');
  return row;
}

function addressFor(row: CustomerRow, channel: string): string | null {
  if (channel === 'email') return row.email && row.email.trim() !== '' ? row.email : null;
  if (!row.phone || row.phone.trim() === '') return null;
  const fallback = callingCodeFor(tenancy.current().countryCode) ?? '91';
  return `${(row.country_code || fallback).replace('+', '')}${row.phone}`;
}

/**
 * Whether WhatsApp's 24-hour service window is open.
 *
 * It opens when the customer messages the business. Nothing writes inbound
 * messages yet — that needs a provider webhook — so this is `false` for everyone
 * today and becomes true on its own the day one is connected, because it reads
 * `direction = 'inbound'` rather than a flag somebody has to remember to set.
 */
async function serviceWindowOpen(customerId: number, exec: Executor): Promise<boolean> {
  const row = await queryOne<RowDataPacket & { last_inbound: Date | null }>(
    `SELECT MAX(queued_at) AS last_inbound FROM notification_logs
      WHERE shop_id = ? AND customer_id = ? AND channel = 'whatsapp' AND direction = 'inbound'`,
    [shopId(), customerId],
    exec,
  );
  if (!row?.last_inbound) return false;
  return Date.now() - new Date(row.last_inbound).getTime() < 24 * 3_600_000;
}

export const directService = {
  /** What can be sent to this person, on each channel, and why not. */
  async context(customerId: number, exec: Executor = pool) {
    const row = await customer(customerId, exec);
    const settings = await messagingSettings(exec);
    const windowOpen = await serviceWindowOpen(row.id, exec);
    const promotional = quietHours(settings);

    const consents = await query<RowDataPacket & { purpose: string; status: string; created_at: Date }>(
      `SELECT c1.purpose, c1.status, c1.created_at
         FROM customer_consents c1
         JOIN (SELECT purpose, MAX(id) AS id FROM customer_consents
                WHERE shop_id = ? AND customer_id = ? GROUP BY purpose) latest
           ON latest.id = c1.id`,
      [shopId(), customerId],
      exec,
    );
    const consentByPurpose = new Map(consents.map((consent) => [consent.purpose, consent]));

    const lastMessages = await query<RowDataPacket & { channel: string; last_at: Date }>(
      `SELECT channel, MAX(queued_at) AS last_at FROM notification_logs
        WHERE shop_id = ? AND customer_id = ? GROUP BY channel`,
      [shopId(), customerId],
      exec,
    );
    const lastByChannel = new Map(lastMessages.map((message) => [message.channel, message.last_at]));

    const templates = await query<RowDataPacket & { id: number; name: string; channel: string; category: string; event_key: string }>(
      `SELECT id, name, channel, category, event_key
         FROM notification_templates
        WHERE shop_id = ? AND is_active = 1 AND deleted_at IS NULL AND category <> 'authentication'
        ORDER BY channel, category, name`,
      [shopId()],
      exec,
    );

    const channels = (['whatsapp', 'sms', 'email'] as const).map((channel) => {
      const address = addressFor(row, channel);
      const consent = consentByPurpose.get(CONSENT_PURPOSE[channel]);
      const optedIn =
        channel === 'email'
          ? row.accepts_email_marketing === 1
          : channel === 'sms'
            ? row.accepts_sms_marketing === 1
            : row.accepts_whatsapp_marketing === 1;

      const reasons: string[] = [];
      if (!address) reasons.push(channel === 'email' ? 'No email address on file.' : 'No phone number on file.');

      let freeText = true;
      let freeTextReason: string | null = null;
      if (channel === 'whatsapp' && !windowOpen) {
        freeText = false;
        freeTextReason =
          'WhatsApp allows a free-form reply only within 24 hours of the customer’s own last message. Use an approved template.';
      }
      if (channel === 'sms' && settings.enforceDlt) {
        freeText = false;
        freeTextReason = 'Every commercial SMS in India must map to a template registered on DLT, so free text is not possible.';
      }

      return {
        channel,
        address,
        can_send: reasons.length === 0,
        reasons,
        opted_in_to_marketing: optedIn && consent?.status !== 'withdrawn',
        consent_status: consent?.status ?? 'never',
        consent_at: consent?.created_at ?? null,
        last_messaged_at: lastByChannel.get(channel) ?? null,
        free_text: freeText,
        free_text_reason: freeTextReason,
        templates: templates
          .filter((template) => template.channel === channel)
          .map((template) => ({
            id: template.id,
            name: template.name,
            category: template.category,
            event_key: template.event_key,
          })),
        limits: CHANNEL_LIMITS[channel],
      };
    });

    return {
      customer: {
        id: row.id,
        name: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Customer',
        first_name: row.first_name,
        email: row.email,
        phone: row.phone,
        status: row.status,
        orders_count: row.orders_count,
        total_spent: Number(row.total_spent),
        last_order_at: row.last_order_at,
      },
      channels,
      promotional_window: promotional,
      service_window_open: windowOpen,
    };
  },

  /**
   * Sends it.
   *
   * A template send goes through `messagingService.send`, which is the same door
   * a campaign and an order confirmation use — so consent, the promotional
   * window and the template's compliance state all apply, and the only thing
   * skipped is the frequency cap, because a person deliberately messaging one
   * customer is not the thing that cap exists to prevent.
   *
   * A free-text send cannot go through that door — there is no template row to
   * render — so it repeats the checks here rather than skipping them, and is
   * refused on the channels where free text is not allowed at all.
   */
  async send(
    input: {
      customerId: number;
      channel: 'email' | 'sms' | 'whatsapp';
      templateId?: number | null;
      subject?: string | null;
      body?: string | null;
      variables?: Record<string, string>;
      purpose?: 'service' | 'marketing';
    },
    adminId: number,
    exec: Executor = pool,
  ) {
    const row = await customer(input.customerId, exec);
    const settings = await messagingSettings(exec);
    const to = addressFor(row, input.channel);
    if (!to) {
      throw ApiError.badRequest(
        input.channel === 'email' ? 'This customer has no email address.' : 'This customer has no phone number.',
      );
    }

    const baseVariables: Record<string, string> = {
      first_name: row.first_name ?? 'there',
      last_name: row.last_name ?? '',
      full_name: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'there',
      email: row.email ?? '',
      phone: row.phone ?? '',
      ...(input.variables ?? {}),
    };

    // ── the template path ───────────────────────────────────────────────────
    if (input.templateId) {
      const outcome = await messagingService.send(
        {
          templateId: input.templateId,
          channel: input.channel,
          to,
          variables: baseVariables,
          customerId: row.id,
          sentByAdminId: adminId,
          ignoreFrequencyCap: true,
        },
        exec,
      );

      if (!outcome.sent) {
        throw ApiError.conflict(outcome.detail, 'INVALID_OPERATION', { reason: outcome.reason });
      }
      logger.info('messaging.direct_sent', { customer_id: row.id, channel: input.channel, admin_id: adminId });
      return { sent: true, log_id: outcome.logId, delivered: outcome.delivered };
    }

    // ── the free-text path ──────────────────────────────────────────────────
    const body = (input.body ?? '').trim();
    if (body === '') throw ApiError.badRequest('There is no message to send.');

    if (input.channel === 'sms' && settings.enforceDlt) {
      throw ApiError.conflict(
        'Free-text SMS cannot be sent in India: the wording has to be registered on DLT first. Choose a template.',
        'INVALID_OPERATION',
      );
    }
    if (input.channel === 'whatsapp' && !(await serviceWindowOpen(row.id, exec))) {
      throw ApiError.conflict(
        'WhatsApp allows a free-form message only within 24 hours of the customer’s own last message. Choose an approved template.',
        'INVALID_OPERATION',
      );
    }

    const marketing = input.purpose === 'marketing';
    if (marketing) {
      const consent = await messagingRepository.marketingAllowed(row.id, input.channel, exec);
      if (!consent.allowed) {
        throw ApiError.conflict(
          'This customer has not opted in to marketing on this channel.',
          'INVALID_OPERATION',
        );
      }
      if (quietHoursApplies(input.channel, 'marketing')) {
        const window = quietHours(settings);
        if (!window.inside) throw ApiError.conflict(window.message, 'INVALID_OPERATION');
      }
    }

    const limits = CHANNEL_LIMITS[input.channel];
    if (body.length > limits.body) {
      throw ApiError.badRequest(`This channel allows ${limits.body} characters and the message is ${body.length}.`);
    }

    const sender = await messagingRepository.defaultSender(input.channel, exec);
    const rendered = render(body, baseVariables);
    const provider = await resolveMessageProvider(input.channel, {
      provider: sender?.provider ?? null,
      category: marketing ? 'marketing' : 'utility',
      deliveryRate: settings.simulatorDeliveryRate,
    });

    const result = await provider.send({
      channel: input.channel,
      to,
      body: rendered,
      subject: input.subject ? render(input.subject, baseVariables) : null,
      providerTemplateId: null,
      variables: baseVariables,
      sender: outboundSender(sender),
    });

    const logId = await messagingRepository.logMessage(
      {
        templateId: null,
        eventKey: 'direct.message',
        channel: input.channel,
        recipient: to,
        customerId: row.id,
        orderId: null,
        senderId: sender?.id ?? null,
        sentByAdminId: adminId,
        provider: provider.name,
        providerMessageId: result.providerMessageId,
        status: result.status,
        error: result.error,
        cost: result.cost,
        payload: { body: rendered, subject: input.subject ?? null, variables: baseVariables, direct: true },
      },
      exec,
    );

    if (result.status === 'failed') {
      throw ApiError.upstream(result.error ?? 'The provider refused the message.', { log_id: logId });
    }

    logger.info('messaging.direct_sent', { customer_id: row.id, channel: input.channel, admin_id: adminId, free_text: true });
    return { sent: true, log_id: logId, delivered: result.status === 'delivered' };
  },

  /** What a free-text message will cost and how it will be encoded, while typing. */
  inspect(channel: string, body: string) {
    const limits = CHANNEL_LIMITS[channel as keyof typeof CHANNEL_LIMITS] ?? CHANNEL_LIMITS.sms;
    return {
      length: body.length,
      limit: limits.body,
      sms: channel === 'sms' ? smsInfo(body) : null,
    };
  },
};
