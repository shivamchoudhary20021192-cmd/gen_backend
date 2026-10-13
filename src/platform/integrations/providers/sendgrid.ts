import crypto from 'node:crypto';
import type { MessageChannel, MessageProvider, OutboundMessage, SendResult } from '../../../modules/messaging/MessageProvider';
import { commonErrorMessage, providerFetch, ProviderHttpError } from '../http';
import { InboundSignatureError, type ConnectionContext, type InboundEvent, type ProviderManifest } from '../types';

/**
 * SendGrid (Twilio SendGrid): transactional and marketing email.
 *
 * The Event Webhook reports delivered/bounced/dropped per message. It is
 * signed with ECDSA; the merchant pastes the verification key SendGrid shows
 * when signing is enabled. Without a key, webhooks are refused rather than
 * believed — an unsigned "delivered" is not evidence of anything.
 */

interface SendgridCredentials {
  api_key: string;
  webhook_verification_key?: string;
}

const API = 'https://api.sendgrid.com/v3';

function toHtml(body: string): string {
  // Templates are stored as text or simple HTML; plain text is wrapped so line
  // breaks survive in every client.
  if (/<[a-z][\s\S]*>/i.test(body)) return body;
  const escaped = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.5">${escaped.replace(/\n/g, '<br>')}</div>`;
}

function mapEvent(event: string): string {
  switch (event) {
    case 'delivered':
      return 'delivered';
    case 'open':
      return 'read';
    case 'bounce':
    case 'dropped':
    case 'blocked':
      return 'failed';
    case 'deferred':
    case 'processed':
      return 'queued';
    default:
      return event;
  }
}

class SendgridEmailProvider implements MessageProvider {
  readonly name = 'sendgrid';
  readonly channels: MessageChannel[] = ['email'];

  constructor(private readonly context: ConnectionContext<SendgridCredentials>) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const { config } = this.context;
    const fromEmail = message.sender?.fromEmail ?? (config.from_email as string | undefined) ?? '';
    if (!fromEmail) {
      return { providerMessageId: null, status: 'failed', providerStatus: 'no_sender', error: 'No From address is set for email.', cost: null };
    }
    const fromName = message.sender?.fromName ?? (config.from_name as string | undefined) ?? undefined;
    const replyTo = message.sender?.replyTo ?? (config.reply_to as string | undefined) ?? undefined;

    try {
      const { headers } = await providerFetch({
        provider: 'sendgrid',
        url: `${API}/mail/send`,
        headers: { Authorization: `Bearer ${this.context.credentials.api_key}` },
        json: {
          personalizations: [
            {
              to: [{ email: message.to }],
              ...(message.reference ? { custom_args: { reference: message.reference } } : {}),
            },
          ],
          from: { email: fromEmail, ...(fromName ? { name: fromName } : {}) },
          ...(replyTo ? { reply_to: { email: replyTo } } : {}),
          subject: message.subject ?? '',
          content: [
            { type: 'text/plain', value: message.body.replace(/<[^>]+>/g, '') },
            { type: 'text/html', value: toHtml(message.body) },
          ],
        },
        errorMessage: commonErrorMessage,
      });
      return {
        providerMessageId: headers.get('x-message-id'),
        status: 'queued',
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

function publicKeyFrom(value: string): crypto.KeyObject {
  const trimmed = value.trim();
  if (trimmed.includes('BEGIN PUBLIC KEY')) return crypto.createPublicKey(trimmed);
  return crypto.createPublicKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'spki' });
}

export const sendgridProvider: ProviderManifest<SendgridCredentials> = {
  key: 'sendgrid',
  name: 'SendGrid',
  category: 'email',
  channels: ['email'],
  description: 'Email delivery with bounce and delivery tracking.',
  docsUrl: 'https://docs.sendgrid.com/for-developers/sending-email/api-getting-started',
  countries: '*',
  credentialFields: [
    { key: 'api_key', label: 'API key', secret: true, required: true, placeholder: 'SG.…', pattern: /^SG\.[\w-]{10,}\.[\w-]{10,}$/ },
    {
      key: 'webhook_verification_key',
      label: 'Event webhook verification key',
      secret: false,
      required: false,
      help: 'From Mail Settings → Signed Event Webhook. Needed for delivery tracking.',
    },
  ],
  configFields: [
    { key: 'from_email', label: 'Default From address', type: 'string', required: true, help: 'A verified sender in SendGrid.' },
    { key: 'from_name', label: 'Default From name', type: 'string' },
    { key: 'reply_to', label: 'Reply-To address', type: 'string' },
  ],
  hint: (credentials) => `SG.…${credentials.api_key.slice(-4)}`,

  async verify(context) {
    const { data } = await providerFetch<{ scopes?: string[] }>({
      provider: 'sendgrid',
      url: `${API}/scopes`,
      headers: { Authorization: `Bearer ${context.credentials.api_key}` },
      errorMessage: commonErrorMessage,
    });
    if (!data.scopes?.includes('mail.send')) {
      return { ok: false, message: 'This API key cannot send mail. Give it the "Mail Send" permission.' };
    }
    if (context.credentials.webhook_verification_key) {
      try {
        publicKeyFrom(context.credentials.webhook_verification_key);
      } catch {
        return { ok: false, message: 'The event webhook verification key is not a valid public key.' };
      }
    }
    return { ok: true, mode: 'live' };
  },

  messaging: (context) => new SendgridEmailProvider(context),

  inbound: {
    verify(request, context): InboundEvent[] {
      const key = context.credentials.webhook_verification_key;
      const signature = request.headers['x-twilio-email-event-webhook-signature'];
      const timestamp = request.headers['x-twilio-email-event-webhook-timestamp'];
      if (!key || !signature || !timestamp) throw new InboundSignatureError('Signed event webhooks are required.');

      const valid = crypto.verify(
        'sha256',
        Buffer.concat([Buffer.from(timestamp, 'utf8'), request.rawBody]),
        publicKeyFrom(key),
        Buffer.from(signature, 'base64'),
      );
      if (!valid) throw new InboundSignatureError();

      const events = JSON.parse(request.rawBody.toString('utf8')) as Record<string, unknown>[];
      if (!Array.isArray(events)) return [];
      return events
        .filter((event) => typeof event.sg_message_id === 'string' && typeof event.event === 'string')
        .map((event) => ({
          externalId: String(event.sg_event_id ?? `${event.sg_message_id}:${event.event}`),
          type: 'message.status',
          providerType: String(event.event),
          data: {
            // sg_message_id is "<X-Message-Id>.<filter suffix>"; we stored the prefix.
            provider_message_id: String(event.sg_message_id).split('.')[0],
            status: mapEvent(String(event.event)),
            error_code: typeof event.reason === 'string' ? event.reason.slice(0, 120) : null,
            channel: 'email',
          },
        }));
    },
  },
};
