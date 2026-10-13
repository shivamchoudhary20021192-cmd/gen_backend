import { randomUUID } from 'node:crypto';
import { logger } from '../../../core/logger';
import { smsInfo } from '../messageContent';
import type { MessageChannel, MessageProvider, OutboundMessage, SendResult } from '../MessageProvider';

/**
 * A provider that behaves like a provider without being one.
 *
 * The shop has no WhatsApp Business account, no DLT registration and no mail
 * relay yet, and will not have them for weeks. Everything above this line —
 * consent, quiet hours, audience resolution, batching, throttling, per-recipient
 * status, campaign counters, cost — has to be built and testable before then, so
 * this stands in and answers the way a real one does:
 *
 *   - it returns a provider message id, so the log has something to join on
 *   - it reports *delivered* for most sends, *sent* for some and *failed* for a
 *     few, at the rate configured in settings, so a campaign's numbers look like
 *     a campaign's numbers instead of a column of 100%
 *   - it prices the message the way Indian providers do, per SMS segment and per
 *     WhatsApp conversation category, so the cost column means something
 *
 * It is not a lie about sending: `providerStatus` says `simulated` on every row,
 * the delivery log shows the provider as "simulator", and the Senders screen
 * says in words that nothing is leaving the building. The moment a real adapter
 * is written, it replaces this one file and nothing above it changes.
 */

/** Rough Indian list prices, so an estimate is the right order of magnitude. */
const PRICING = {
  sms: { perSegment: 0.16 },
  whatsapp: { marketing: 0.73, utility: 0.115, authentication: 0.115, transactional: 0.115 },
  email: { each: 0.02 },
  push: { each: 0 },
} as const;

export interface SimulatorOptions {
  /** Percentage of sends that report delivered. The rest are sent or failed. */
  deliveryRate: number;
  /** Message category, for WhatsApp pricing. */
  category?: string;
}

export class SimulatorProvider implements MessageProvider {
  readonly name = 'simulator';
  readonly channels: MessageChannel[] = ['whatsapp', 'sms', 'email', 'push'];

  constructor(private readonly options: SimulatorOptions = { deliveryRate: 94 }) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const roll = Math.random() * 100;
    const deliveryRate = Math.min(100, Math.max(0, this.options.deliveryRate));

    // The remainder after the delivered share is split: most of it is a message
    // that has left but not been confirmed, a small slice is a hard failure.
    // A real provider's numbers look like this; 100% delivered does not.
    const failureShare = Math.min(4, (100 - deliveryRate) / 2);

    let status: SendResult['status'] = 'delivered';
    let error: string | null = null;

    if (roll >= deliveryRate + failureShare) {
      status = 'sent';
    } else if (roll >= deliveryRate) {
      status = 'failed';
      error = failureFor(message.channel);
    }

    logger.debug('messaging.simulated', {
      channel: message.channel,
      status,
      template: message.providerTemplateId,
    });

    return {
      providerMessageId: `sim_${randomUUID()}`,
      status,
      providerStatus: 'simulated',
      error,
      cost: status === 'failed' ? 0 : priceOf(message, this.options.category),
    };
  }
}

/** The refusals real providers actually return, so the log reads like a log. */
function failureFor(channel: MessageChannel): string {
  const reasons: Record<string, string[]> = {
    sms: ['Handset unreachable', 'Number on the DND registry', 'Operator rejected: header mismatch'],
    whatsapp: ['Recipient has no WhatsApp account', 'Message undeliverable (24h window closed)'],
    email: ['Mailbox full', 'Recipient address does not exist', 'Rejected by receiving server'],
    push: ['Device token expired'],
  };
  const list = reasons[channel] ?? ['Undeliverable'];
  return `${list[Math.floor(Math.random() * list.length)]} (simulated)`;
}

function priceOf(message: OutboundMessage, category = 'marketing'): number {
  switch (message.channel) {
    case 'sms':
      return Number((smsInfo(message.body).segments * PRICING.sms.perSegment).toFixed(4));
    case 'whatsapp': {
      const table = PRICING.whatsapp as Record<string, number>;
      return table[category] ?? table.marketing;
    }
    case 'email':
      return PRICING.email.each;
    default:
      return 0;
  }
}
