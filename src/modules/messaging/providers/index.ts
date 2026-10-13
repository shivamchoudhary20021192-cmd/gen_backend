import { logger } from '../../../core/logger';
import { connectionsRepository } from '../../../platform/integrations/connections.repository';
import { connectionsService } from '../../../platform/integrations/connections.service';
import { providerManifest } from '../../../platform/integrations/registry';
import type { IntegrationCategory } from '../../../platform/integrations/types';
import { LoggingProvider } from './LoggingProvider';
import { SimulatorProvider } from './SimulatorProvider';
import type { MessageChannel, MessageProvider, OutboundMessage, OutboundSender, SendResult } from '../MessageProvider';

export { LoggingProvider } from './LoggingProvider';
export { SimulatorProvider } from './SimulatorProvider';
export * from '../MessageProvider';

/**
 * Picks the adapter that will carry a message.
 *
 * Two ways to choose, in order:
 *
 *   1. the sender row — `messaging_senders.provider`. This is the real one: a
 *      shop may have a transactional gateway and a promotional gateway on the
 *      same channel, and the identity the message is sent from is what decides.
 *
 *   2. the environment — `MESSAGING_SMS_PROVIDER` and friends. The fallback for
 *      code paths that send an event message without naming a sender.
 *
 * Adding a real provider is one file here and one row in Senders. Nothing above
 * this function knows which adapter it got, which is the reason the interface is
 * this narrow in the first place.
 *
 * An unknown name does not throw. It falls back to the recorder and says so
 * loudly: a shop that believes it is messaging customers and is not should be
 * obvious in the log, not silent.
 */
export interface ProviderContext {
  /** `messaging_senders.provider`, when the message has a sender. */
  provider?: string | null;
  /** The template's category, which is what WhatsApp prices on. */
  category?: string;
  /** From settings, so the simulator's numbers are the shop's numbers. */
  deliveryRate?: number;
}

export function providerFor(channel: MessageChannel, context: ProviderContext = {}): MessageProvider {
  const configured = (
    context.provider ??
    process.env[`MESSAGING_${channel.toUpperCase()}_PROVIDER`] ??
    'simulator'
  )
    .trim()
    .toLowerCase();

  switch (configured) {
    case 'simulator':
      return new SimulatorProvider({
        deliveryRate: context.deliveryRate ?? 94,
        category: context.category,
      });

    case 'logging':
    case '':
      return new LoggingProvider();

    default:
      logger.warn('messaging.unknown_provider', {
        channel,
        configured,
        message: 'Falling back to the recorder. Nothing is being sent on this channel.',
      });
      return new LoggingProvider();
  }
}

/** Whether a channel can actually deliver, as opposed to only pretending to. */
export function channelCanDeliver(channel: MessageChannel, provider?: string | null): boolean {
  const name = providerFor(channel, { provider }).name;
  return name !== 'logging' && name !== 'simulator';
}

const BUILT_IN = new Set(['simulator', 'logging', '']);

/**
 * A provider that is named but cannot be used — not connected, or switched
 * off. It refuses every send with a message that says what to fix, rather
 * than quietly recording messages that never leave the building.
 */
class UnavailableProvider implements MessageProvider {
  readonly channels: MessageChannel[];
  constructor(
    readonly name: string,
    channel: MessageChannel,
    private readonly reason: string,
  ) {
    this.channels = [channel];
  }
  async send(_message: OutboundMessage): Promise<SendResult> {
    return { providerMessageId: null, status: 'failed', providerStatus: 'not_connected', error: this.reason, cost: null };
  }
}

/** The integration category a channel's default connection lives in. */
function categoryFor(channel: MessageChannel): IntegrationCategory | null {
  return channel === 'sms' || channel === 'whatsapp' || channel === 'email' ? channel : null;
}

/**
 * Picks the adapter that will carry a message, including the shop's connected
 * integrations (Twilio, SendGrid, Postmark, WhatsApp Cloud…).
 *
 *   1. The sender row names a provider: that provider's active connection in
 *      this shop. Built-in names (simulator, logging) need no connection.
 *   2. No sender provider: the shop's default connection for the channel's
 *      category, or any active connection whose provider carries the channel
 *      (Twilio carries WhatsApp as well as SMS).
 *   3. Nothing connected: the environment fallback, then the simulator —
 *      exactly the behaviour before integrations existed.
 */
export async function resolveMessageProvider(
  channel: MessageChannel,
  context: ProviderContext = {},
): Promise<MessageProvider> {
  const named = (context.provider ?? '').trim().toLowerCase();

  if (named && !BUILT_IN.has(named)) {
    const connected = await connectionsService.resolveProvider(named);
    if (connected?.manifest.messaging && (connected.manifest.channels ?? []).includes(channel)) {
      return connected.manifest.messaging(connected.context, channel);
    }
    const manifest = providerManifest(named);
    return new UnavailableProvider(
      named,
      channel,
      manifest
        ? `${manifest.name} is not connected for this store. Connect it in Settings → Integrations.`
        : `The sender uses "${named}", which is not a provider this platform supports.`,
    );
  }

  if (!named) {
    const category = categoryFor(channel);
    if (category) {
      const byDefault = await connectionsService.resolveDefault(category);
      if (byDefault?.manifest.messaging && (byDefault.manifest.channels ?? []).includes(channel)) {
        return byDefault.manifest.messaging(byDefault.context, channel);
      }
      // A multi-channel provider connected under another category.
      for (const row of await connectionsRepository.list()) {
        if (row.status !== 'active') continue;
        const manifest = providerManifest(row.provider);
        if (manifest?.messaging && (manifest.channels ?? []).includes(channel)) {
          return manifest.messaging(await connectionsService.context(row), channel);
        }
      }
    }
  }

  return providerFor(channel, context);
}

/** Whether a channel will really deliver in this shop, integrations included. */
export async function channelDelivers(channel: MessageChannel, provider?: string | null): Promise<boolean> {
  const resolved = await resolveMessageProvider(channel, { provider: provider ?? null });
  return !(resolved instanceof UnavailableProvider) && resolved.name !== 'logging' && resolved.name !== 'simulator';
}

/** A sender row as the identity a provider sends from. */
export function outboundSender(
  sender: {
    from_email: string | null;
    from_name: string | null;
    reply_to: string | null;
    sms_header: string | null;
    phone_number_id: string | null;
    display_phone: string | null;
  } | null,
): OutboundSender | null {
  if (!sender) return null;
  return {
    fromEmail: sender.from_email,
    fromName: sender.from_name,
    replyTo: sender.reply_to,
    smsHeader: sender.sms_header,
    phoneNumberId: sender.phone_number_id,
    displayPhone: sender.display_phone,
  };
}
