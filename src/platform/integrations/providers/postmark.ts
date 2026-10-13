import crypto from 'node:crypto';
import type { MessageChannel, MessageProvider, OutboundMessage, SendResult } from '../../../modules/messaging/MessageProvider';
import { providerFetch, ProviderHttpError } from '../http';
import { InboundSignatureError, type ConnectionContext, type InboundEvent, type ProviderManifest } from '../types';

/**
 * Postmark: fast transactional email.
 *
 * Postmark webhooks are not signed; they are authenticated with HTTP Basic
 * credentials the merchant sets on the webhook in Postmark. Those credentials
 * are generated here, per connection, and must match exactly.
 */

interface PostmarkCredentials {
  server_token: string;
  webhook_username?: string;
  webhook_password?: string;
}

const API = 'https://api.postmarkapp.com';

function errorMessage(body: unknown): string | null {
  const record = body as Record<string, unknown> | null;
  return record && typeof record.Message === 'string' ? record.Message : null;
}

class PostmarkEmailProvider implements MessageProvider {
  readonly name = 'postmark';
  readonly channels: MessageChannel[] = ['email'];

  constructor(private readonly context: ConnectionContext<PostmarkCredentials>) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const { config } = this.context;
    const fromEmail = message.sender?.fromEmail ?? (config.from_email as string | undefined);
    if (!fromEmail) {
      return { providerMessageId: null, status: 'failed', providerStatus: 'no_sender', error: 'No From address is set for email.', cost: null };
    }
    const fromName = message.sender?.fromName ?? (config.from_name as string | undefined);
    const html = /<[a-z][\s\S]*>/i.test(message.body);
    try {
      const { data } = await providerFetch<Record<string, unknown>>({
        provider: 'postmark',
        url: `${API}/email`,
        headers: { 'X-Postmark-Server-Token': this.context.credentials.server_token },
        json: {
          From: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
          To: message.to,
          Subject: message.subject ?? '',
          ...(html ? { HtmlBody: message.body } : { TextBody: message.body }),
          ReplyTo: message.sender?.replyTo ?? (config.reply_to as string | undefined) ?? undefined,
          MessageStream: (config.message_stream as string | undefined) ?? 'outbound',
          Metadata: message.reference ? { reference: message.reference } : undefined,
        },
        errorMessage,
      });
      return {
        providerMessageId: typeof data.MessageID === 'string' ? data.MessageID : null,
        status: 'sent',
        providerStatus: 'accepted',
        error: null,
        cost: null,
      };
    } catch (error) {
      if (error instanceof ProviderHttpError && !error.retryable) {
        return { providerMessageId: null, status: 'failed', providerStatus: 'rejected', error: error.message, cost: null };
      }
      throw error;
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export const postmarkProvider: ProviderManifest<PostmarkCredentials> = {
  key: 'postmark',
  name: 'Postmark',
  category: 'email',
  channels: ['email'],
  description: 'Transactional email with fast, reliable delivery.',
  docsUrl: 'https://postmarkapp.com/developer',
  countries: '*',
  credentialFields: [
    { key: 'server_token', label: 'Server API token', secret: true, required: true, pattern: /^[0-9a-f-]{36}$/i },
    { key: 'webhook_username', label: 'Webhook username', secret: false, required: false, help: 'Set the same on the Postmark webhook (Basic auth).' },
    { key: 'webhook_password', label: 'Webhook password', secret: true, required: false },
  ],
  configFields: [
    { key: 'from_email', label: 'Default From address', type: 'string', required: true, help: 'A confirmed sender signature in Postmark.' },
    { key: 'from_name', label: 'Default From name', type: 'string' },
    { key: 'reply_to', label: 'Reply-To address', type: 'string' },
    { key: 'message_stream', label: 'Message stream', type: 'string', default: 'outbound' },
  ],
  hint: (credentials) => `••••${credentials.server_token.slice(-4)}`,

  async verify(context) {
    const { data } = await providerFetch<Record<string, unknown>>({
      provider: 'postmark',
      url: `${API}/server`,
      headers: { 'X-Postmark-Server-Token': context.credentials.server_token },
      errorMessage,
    });
    return { ok: true, accountLabel: typeof data.Name === 'string' ? data.Name : null, mode: 'live' };
  },

  messaging: (context) => new PostmarkEmailProvider(context),

  inbound: {
    verify(request, context): InboundEvent[] {
      const { webhook_username: user, webhook_password: password } = context.credentials;
      const header = request.headers.authorization ?? '';
      if (!user || !password || !header.startsWith('Basic ')) throw new InboundSignatureError('Webhook credentials are required.');
      const expected = Buffer.from(`${user}:${password}`, 'utf8').toString('base64');
      if (!safeEqual(header.slice(6).trim(), expected)) throw new InboundSignatureError();

      const event = JSON.parse(request.rawBody.toString('utf8')) as Record<string, unknown>;
      const recordType = String(event.RecordType ?? '');
      const messageId = typeof event.MessageID === 'string' ? event.MessageID : null;
      if (!messageId) return [];
      const status =
        recordType === 'Delivery' ? 'delivered' : recordType === 'Open' ? 'read' : recordType === 'Bounce' || recordType === 'SpamComplaint' ? 'failed' : null;
      if (!status) return [];
      return [
        {
          externalId: `${messageId}:${recordType}:${String(event.ID ?? event.DeliveredAt ?? event.BouncedAt ?? '')}`,
          type: 'message.status',
          providerType: recordType,
          data: {
            provider_message_id: messageId,
            status,
            error_code: typeof event.Type === 'string' ? event.Type : null,
            channel: 'email',
          },
        },
      ];
    },
  },
};
