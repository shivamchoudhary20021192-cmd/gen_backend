/**
 * What the application is allowed to know about a messaging provider.
 *
 * Same shape as `CourierProvider` and `PaymentGateway`, for the same reason: the
 * service layer talks to this, so adding Gupshup or the Meta Cloud API is a new
 * implementation rather than a change everywhere a message is sent.
 */

export type MessageChannel = 'whatsapp' | 'sms' | 'email' | 'push';

export interface OutboundMessage {
  channel: MessageChannel;
  /** E.164 for whatsapp and sms, an address for email. */
  to: string;
  /** The rendered body. Providers that only accept templates ignore this. */
  body: string;
  subject: string | null;
  /**
   * The provider's own template id.
   *
   * WhatsApp will not let a business start a conversation with free text: the
   * message has to be a template approved by Meta beforehand. `body` is what we
   * store and show in the log; this is what actually goes on the wire.
   */
  providerTemplateId: string | null;
  /** Ordered values for the template's placeholders. */
  variables: Record<string, string>;
  /**
   * The identity the message goes out as, from the sender row: the From
   * address and name for email, the header or number for SMS and WhatsApp.
   * Providers fall back to their connection's own defaults when absent.
   */
  sender?: OutboundSender | null;
  /** Ours, echoed back in status callbacks where the provider supports it. */
  reference?: string | null;
}

export interface OutboundSender {
  fromEmail: string | null;
  fromName: string | null;
  replyTo: string | null;
  smsHeader: string | null;
  phoneNumberId: string | null;
  displayPhone: string | null;
}

export interface SendResult {
  providerMessageId: string | null;
  /** queued | sent | delivered | failed */
  status: 'queued' | 'sent' | 'delivered' | 'failed';
  providerStatus: string | null;
  error: string | null;
  /** What the provider charged, when it says. */
  cost: number | null;
}

export interface MessageProvider {
  readonly name: string;
  readonly channels: MessageChannel[];
  send(message: OutboundMessage): Promise<SendResult>;
}

export class MessagingError extends Error {
  readonly code: string;

  constructor(message: string, code = 'MESSAGING_FAILED') {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
  }
}
