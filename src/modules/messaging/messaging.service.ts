import { isLockConflict, retryOnLockConflict } from '../../db/retry';
import { logger } from '../../core/logger';
import { pool, type Executor } from '../../db/pool';
import { blockers, checkTemplate, quietHours, quietHoursApplies } from './compliance';
import { render as renderContent } from './messageContent';
import { messagingRepository, type SenderRow, type TemplateRow } from './messaging.repository';
import { messagingSettings } from './messagingSettings';
import { maskRecipient } from './providers/LoggingProvider';
import { outboundSender, resolveMessageProvider, type MessageChannel } from './providers';

/**
 * Sending a message to a customer, and the rules about when that is allowed.
 *
 * One function does all of it, because the rule that matters — **nothing
 * non-transactional goes to anyone who has not opted in** — is only a rule if
 * there is no second way to send a message that skips it.
 *
 * The distinction is `notification_templates.is_transactional`:
 *
 *   - transactional (an OTP, an order confirmation, a delivery update) is about
 *     something the customer asked for, and needs no marketing consent
 *   - everything else (you saved this, it is back in stock, you left this in
 *     your bag) is marketing, and is refused without a granted consent on file
 *
 * That is not a nicety. WhatsApp's own policy requires opt-in for
 * business-initiated marketing and rates a number down for sending without it
 * until it stops delivering; India's DPDP Act 2023 requires consent for
 * processing personal data for marketing. A shop that ignores this does not get
 * a warning, it gets a dead WhatsApp number.
 */

/** The consent purpose each channel's marketing needs. */
const MARKETING_PURPOSE: Record<string, string> = {
  whatsapp: 'marketing_whatsapp',
  sms: 'marketing_sms',
  email: 'marketing_email',
};

/**
 * How long to leave someone alone between marketing messages on a channel.
 *
 * Kept as a constant for the callers that predate the settings table; the live
 * value is `messaging.frequency_cap_hours` and this is only its default.
 */
export const MARKETING_QUIET_HOURS = 72;

export type SendOutcome =
  | { sent: true; logId: number; providerMessageId: string | null; delivered: boolean; cost: number }
  | { sent: false; reason: SkipReason; detail: string };

export type SkipReason =
  | 'no_template'
  | 'no_recipient'
  | 'no_consent'
  | 'too_soon'
  | 'quiet_hours'
  | 'blocked'
  | 'provider_failed';

export interface SendInput {
  /** Either an event key… */
  eventKey?: string;
  /** …or a specific template, which is how a campaign sends. */
  templateId?: number;
  channel: MessageChannel;
  /** E.164 without the plus for WhatsApp/SMS, or an email address. */
  to: string | null;
  variables: Record<string, string>;
  customerId?: number | null;
  orderId?: number | null;
  campaignId?: number | null;
  /** Set when a person sent this by hand, so the log can say who. */
  sentByAdminId?: number | null;
  /** Skips the frequency cap. For a send the customer just asked for. */
  ignoreFrequencyCap?: boolean;
}

/** `{{name}}` → the value. Unknown placeholders are left visible, not blanked. */
export const render = renderContent;

export const messagingService = {
  /**
   * Sends one message, or explains why it did not.
   *
   * Never throws for an ordinary refusal — "this person has not opted in" is an
   * expected outcome when sweeping an audience, not an error, and a thrown
   * exception there would abort the rest of the batch.
   */
  async send(input: SendInput, exec: Executor = pool): Promise<SendOutcome> {
    const settings = await messagingSettings(exec);

    const template: TemplateRow | null = input.templateId
      ? await messagingRepository.findTemplateById(input.templateId, exec)
      : input.eventKey
        ? await messagingRepository.findTemplate(input.eventKey, input.channel, exec)
        : null;

    if (!template || template.is_active !== 1) {
      return {
        sent: false,
        reason: 'no_template',
        detail: input.templateId
          ? 'That template no longer exists, or has been switched off.'
          : `No active ${input.channel} template for "${input.eventKey}".`,
      };
    }

    const recipient = (input.to ?? '').trim();
    if (!recipient) {
      return { sent: false, reason: 'no_recipient', detail: 'No address to send to.' };
    }

    const sender: SenderRow | null = template.sender_id
      ? await messagingRepository.findSender(template.sender_id, exec)
      : await messagingRepository.defaultSender(template.channel, exec);

    // The template's own compliance state, checked here as well as in the
    // editor. The editor is advice; this is the gate. A template that lost its
    // DLT id after it was written must not keep sending because it passed once.
    const failed = blockers(checkTemplate(template, sender, settings));
    if (failed.length > 0) {
      return {
        sent: false,
        reason: 'blocked',
        detail: failed.map((violation) => violation.message).join(' '),
      };
    }

    // The category, not the legacy flag, decides what the rules are. Utility and
    // authentication messages are about something the customer asked for;
    // marketing is not, and is the only one that needs consent.
    const marketing = template.category === 'marketing';
    const transactional = !marketing;

    // TRAI's promotional window. Checked at the moment of sending rather than
    // when the campaign was built, because a campaign built at 20:55 and still
    // running at 21:05 has to stop at 21:00.
    if (quietHoursApplies(template.channel, template.category)) {
      const window = quietHours(settings);
      if (!window.inside) {
        return { sent: false, reason: 'quiet_hours', detail: window.message };
      }
    }

    if (!transactional) {
      // No customer means no consent record can exist, so there is nobody who
      // could have opted in. Refused rather than sent to an anonymous number.
      if (!input.customerId || !MARKETING_PURPOSE[input.channel]) {
        return {
          sent: false,
          reason: 'no_consent',
          detail: 'Marketing messages need a customer with a recorded opt-in.',
        };
      }

      const consent = await messagingRepository.marketingAllowed(
        input.customerId,
        input.channel as 'whatsapp' | 'sms' | 'email',
        exec,
      );
      if (!consent.allowed) {
        return {
          sent: false,
          reason: 'no_consent',
          detail:
            consent.reason === 'withdrawn'
              ? 'This customer has withdrawn consent for these messages.'
              : 'This customer has never opted in to these messages.',
        };
      }

      if (!input.ignoreFrequencyCap) {
        const last = await messagingRepository.lastMarketingMessageAt(input.customerId, input.channel, exec);
        if (last && Date.now() - new Date(last).getTime() < settings.frequencyCapHours * 3_600_000) {
          return {
            sent: false,
            reason: 'too_soon',
            detail: `Already messaged within the last ${settings.frequencyCapHours} hours.`,
          };
        }
      }
    }

    const body = render(template.body, input.variables);
    const subject = template.subject ? render(template.subject, input.variables) : null;
    const provider = await resolveMessageProvider(input.channel, {
      provider: sender?.provider ?? null,
      category: template.category,
      deliveryRate: settings.simulatorDeliveryRate,
    });

    const result = await provider.send({
      channel: input.channel,
      to: recipient,
      body,
      subject,
      providerTemplateId: template.provider_template_id,
      variables: input.variables,
      sender: outboundSender(sender),
    });

    // The message has left by now, so its log row is what stops it being sent
    // twice (the once-per-order check reads it) and what the delivery receipt
    // will attach to. A deadlock with a concurrent send must not lose it.
    const logId = await retryOnLockConflict(exec, () => messagingRepository.logMessage(
      {
        templateId: template.id,
        eventKey: input.eventKey ?? template.event_key,
        channel: input.channel,
        recipient,
        customerId: input.customerId ?? null,
        orderId: input.orderId ?? null,
        campaignId: input.campaignId ?? null,
        senderId: sender?.id ?? null,
        sentByAdminId: input.sentByAdminId ?? null,
        provider: provider.name,
        providerMessageId: result.providerMessageId,
        status: result.status,
        error: result.error,
        cost: result.cost,
        // The rendered body is kept so an OTP can be read back in development
        // and so a support question about "what did we actually send" has an
        // answer. It is the shop's own outbox, not customer data beyond what
        // was already sent to them.
        payload: { body, subject, variables: input.variables, provider_status: result.providerStatus },
      },
      exec,
    ));

    // A usage counter on a row every send touches: the hottest row in the
    // outbox, and not worth failing a message that was already delivered.
    try {
      await retryOnLockConflict(exec, () => messagingRepository.touchTemplateUsage(template.id, exec));
    } catch (error) {
      if (!isLockConflict(error)) throw error;
      logger.warn('messaging.template_usage_skipped', { template_id: template.id });
    }

    if (result.status === 'failed') {
      logger.warn('messaging.failed', {
        event: input.eventKey ?? template.event_key,
        channel: input.channel,
        to: maskRecipient(recipient),
        error: result.error,
      });
      return { sent: false, reason: 'provider_failed', detail: result.error ?? 'The provider refused it.' };
    }

    return {
      sent: true,
      logId,
      providerMessageId: result.providerMessageId,
      delivered: result.status === 'delivered',
      cost: result.cost ?? 0,
    };
  },

  /** Records an opt-in or an opt-out, and keeps the customer flag in step. */
  async setMarketingConsent(
    input: {
      customerId: number;
      subjectIdentifier: string;
      channel: 'whatsapp' | 'sms' | 'email';
      granted: boolean;
      source: string;
      ip: string | null;
      userAgent: string | null;
      evidence?: unknown;
    },
    exec: Executor = pool,
  ): Promise<void> {
    const purpose = MARKETING_PURPOSE[input.channel];
    await messagingRepository.recordConsent(
      {
        customerId: input.customerId,
        subjectIdentifier: input.subjectIdentifier,
        purpose,
        status: input.granted ? 'granted' : 'withdrawn',
        // Bumped whenever the wording people agree to changes, so an old consent
        // can be told apart from one given against the current notice.
        noticeVersion: process.env.PRIVACY_NOTICE_VERSION ?? '2026-09',
        source: input.source,
        ip: input.ip,
        userAgent: input.userAgent,
        evidence: input.evidence ?? null,
      },
      exec,
    );

    const column =
      input.channel === 'whatsapp'
        ? 'accepts_whatsapp_marketing'
        : input.channel === 'sms'
          ? 'accepts_sms_marketing'
          : 'accepts_email_marketing';
    await messagingRepository.setMarketingFlag(input.customerId, column, input.granted, exec);

    logger.info('messaging.consent_recorded', {
      customer_id: input.customerId,
      channel: input.channel,
      granted: input.granted,
      source: input.source,
    });
  },

  async hasMarketingConsent(customerId: number, channel: 'whatsapp' | 'sms' | 'email'): Promise<boolean> {
    const consent = await messagingRepository.latestConsent(customerId, MARKETING_PURPOSE[channel]);
    return consent?.status === 'granted';
  },
};

export { MARKETING_PURPOSE };
