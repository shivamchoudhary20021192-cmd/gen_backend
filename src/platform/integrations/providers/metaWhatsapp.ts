import crypto from 'node:crypto';
import type { MessageChannel, MessageProvider, OutboundMessage, SendResult } from '../../../modules/messaging/MessageProvider';
import { providerFetch, ProviderHttpError } from '../http';
import { InboundSignatureError, type ConnectionContext, type InboundEvent, type ProviderManifest } from '../types';

/**
 * WhatsApp Business through Meta's Cloud API, without a middleman.
 *
 * Business-initiated messages must be approved templates (`providerTemplateId`
 * is the template name); free text is only allowed inside the 24-hour window a
 * customer opens by messaging the shop, which the inbound `message.inbound`
 * events record. Webhooks are signed with the Meta app secret
 * (X-Hub-Signature-256), and the subscription handshake echoes hub.challenge
 * when the verify token matches.
 */

interface MetaCredentials {
  access_token: string;
  app_secret: string;
  verify_token: string;
}

const GRAPH = 'https://graph.facebook.com';

function version(context: ConnectionContext<MetaCredentials>): string {
  const configured = String(context.config.api_version ?? 'v21.0');
  return /^v\d{2}\.\d$/.test(configured) ? configured : 'v21.0';
}

function errorMessage(body: unknown): string | null {
  const error = (body as { error?: { message?: string; error_user_msg?: string; code?: number } } | null)?.error;
  if (!error) return null;
  return error.error_user_msg ?? error.message ?? `Meta error ${error.code ?? ''}`.trim();
}

function mapStatus(status: string): string {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    default:
      return 'queued';
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class MetaWhatsappProvider implements MessageProvider {
  readonly name = 'meta_whatsapp';
  readonly channels: MessageChannel[] = ['whatsapp'];

  constructor(private readonly context: ConnectionContext<MetaCredentials>) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    const phoneNumberId = message.sender?.phoneNumberId ?? String(this.context.config.phone_number_id ?? '');
    if (!phoneNumberId) {
      return { providerMessageId: null, status: 'failed', providerStatus: 'no_sender', error: 'No WhatsApp phone number id is set.', cost: null };
    }
    const to = message.to.replace(/^\+/, '');
    const body = message.providerTemplateId
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: message.providerTemplateId,
            language: { code: String(this.context.config.template_language ?? 'en') },
            components: Object.keys(message.variables).length
              ? [
                  {
                    type: 'body',
                    parameters: Object.values(message.variables).map((text) => ({ type: 'text', text })),
                  },
                ]
              : [],
          },
        }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: message.body, preview_url: true } };

    try {
      const { data } = await providerFetch<{ messages?: { id: string }[] }>({
        provider: 'meta_whatsapp',
        url: `${GRAPH}/${version(this.context)}/${encodeURIComponent(phoneNumberId)}/messages`,
        headers: { Authorization: `Bearer ${this.context.credentials.access_token}` },
        json: body,
        errorMessage,
      });
      return {
        providerMessageId: data.messages?.[0]?.id ?? null,
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

export const metaWhatsappProvider: ProviderManifest<MetaCredentials> = {
  key: 'meta_whatsapp',
  name: 'WhatsApp Cloud API (Meta)',
  category: 'whatsapp',
  channels: ['whatsapp'],
  description: 'Send WhatsApp templates and replies directly through Meta, with read receipts.',
  docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  countries: '*',
  credentialFields: [
    { key: 'access_token', label: 'Permanent access token', secret: true, required: true, help: 'A System User token with whatsapp_business_messaging.' },
    { key: 'app_secret', label: 'App secret', secret: true, required: true, help: 'Used to verify webhook signatures.' },
    { key: 'verify_token', label: 'Webhook verify token', secret: true, required: true, help: 'Any long random string; enter the same in Meta’s webhook setup.' },
  ],
  configFields: [
    { key: 'phone_number_id', label: 'Phone number ID', type: 'string', required: true },
    { key: 'waba_id', label: 'WhatsApp Business Account ID', type: 'string' },
    { key: 'template_language', label: 'Template language', type: 'string', default: 'en' },
    { key: 'api_version', label: 'Graph API version', type: 'string', default: 'v21.0' },
  ],
  hint: (credentials) => `EAA…${credentials.access_token.slice(-4)}`,

  async verify(context) {
    const phoneNumberId = String(context.config.phone_number_id ?? '');
    const { data } = await providerFetch<Record<string, unknown>>({
      provider: 'meta_whatsapp',
      url: `${GRAPH}/${version(context)}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`,
      headers: { Authorization: `Bearer ${context.credentials.access_token}` },
      errorMessage,
    });
    return {
      ok: true,
      accountLabel: [data.verified_name, data.display_phone_number].filter(Boolean).join(' '),
      mode: 'live',
    };
  },

  messaging: (context) => new MetaWhatsappProvider(context),

  inbound: {
    handshake(query, context) {
      if (query['hub.mode'] !== 'subscribe') return null;
      const token = query['hub.verify_token'] ?? '';
      if (!token || !safeEqual(token, context.credentials.verify_token)) return null;
      return query['hub.challenge'] ?? null;
    },

    verify(request, context): InboundEvent[] {
      const header = request.headers['x-hub-signature-256'] ?? '';
      const expected = `sha256=${crypto.createHmac('sha256', context.credentials.app_secret).update(request.rawBody).digest('hex')}`;
      if (!header || !safeEqual(header, expected)) throw new InboundSignatureError();

      const payload = JSON.parse(request.rawBody.toString('utf8')) as {
        entry?: { changes?: { value?: Record<string, unknown> }[] }[];
      };
      const events: InboundEvent[] = [];
      for (const entry of payload.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};
          for (const status of (value.statuses as Record<string, unknown>[] | undefined) ?? []) {
            const errors = status.errors as { code?: number; title?: string }[] | undefined;
            events.push({
              externalId: `${String(status.id)}:${String(status.status)}`,
              type: 'message.status',
              providerType: `status.${String(status.status)}`,
              data: {
                provider_message_id: String(status.id),
                status: mapStatus(String(status.status)),
                error_code: errors?.[0] ? `${errors[0].code ?? ''} ${errors[0].title ?? ''}`.trim() : null,
                channel: 'whatsapp',
              },
            });
          }
          for (const message of (value.messages as Record<string, unknown>[] | undefined) ?? []) {
            events.push({
              externalId: `${String(message.id)}:inbound`,
              type: 'message.inbound',
              providerType: `message.${String(message.type)}`,
              data: {
                provider_message_id: String(message.id),
                from: String(message.from ?? ''),
                channel: 'whatsapp',
                body: (message.text as { body?: string } | undefined)?.body ?? null,
              },
            });
          }
        }
      }
      return events;
    },
  },
};
