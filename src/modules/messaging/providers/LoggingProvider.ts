import { randomUUID } from 'node:crypto';
import { logger } from '../../../core/logger';
import type { MessageChannel, MessageProvider, OutboundMessage, SendResult } from '../MessageProvider';

/**
 * The stand-in, used until a real provider is connected.
 *
 * It does not send anything. It records what *would* have been sent, which is
 * the honest behaviour for a shop with no WhatsApp Business account yet — and
 * it means the whole pipeline (consent gate, template rendering, audience
 * selection, delivery log) is exercised and testable before any provider exists.
 *
 * Two deliberate choices.
 *
 * It reports `sent`, not `delivered`. Nothing has been delivered, and a log full
 * of green ticks for messages that never left the building is worse than no log.
 *
 * It writes the rendered body to the application log at debug level and returns
 * it on the result, so the OTP flow can be driven end to end in development
 * without the code ever travelling over HTTP in a response.
 */
export class LoggingProvider implements MessageProvider {
  readonly name = 'logging';
  readonly channels: MessageChannel[] = ['whatsapp', 'sms', 'email', 'push'];

  async send(message: OutboundMessage): Promise<SendResult> {
    logger.info('messaging.not_sent', {
      channel: message.channel,
      // Masked: a log line is the commonest place a phone number leaks into a
      // screenshot or a support ticket.
      to: maskRecipient(message.to),
      template: message.providerTemplateId,
      reason: 'no provider configured — message recorded, not sent',
    });

    return {
      providerMessageId: `local_${randomUUID()}`,
      status: 'sent',
      providerStatus: 'recorded_not_sent',
      error: null,
      cost: 0,
    };
  }
}

export function maskRecipient(value: string): string {
  if (value.includes('@')) {
    const [name, domain] = value.split('@');
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return value.length <= 4 ? '****' : `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
}
