import crypto from 'node:crypto';
import type { MessageChannel, MessageProvider, OutboundMessage, SendResult } from '../../../modules/messaging/MessageProvider';
import { basicAuth, commonErrorMessage, providerFetch, ProviderHttpError } from '../http';
import { InboundSignatureError, type ConnectionContext, type InboundEvent, type ProviderManifest } from '../types';

/**
 * Twilio: SMS and WhatsApp through one account.
 *
 * Sends through the Messages API with a status callback pointing at this
 * connection's inbound URL, so delivery receipts come back signed and land on
 * the right shop's log. WhatsApp templates are Twilio Content templates
 * (HX… ids) filled positionally, which is how Twilio's Content API numbers
 * variables ({{1}}, {{2}}…).
 */

interface TwilioCredentials {
  account_sid: string;
  auth_token: string;
}

const API = 'https://api.twilio.com/2010-04-01';

function errorMessage(body: unknown): string | null {
  const record = body as Record<string, unknown> | null;
  if (record && typeof record.message === 'string') {
    return record.code ? `${record.message} (Twilio ${record.code})` : record.message;
  }
  return commonErrorMessage(body);
}

/** Twilio's delivery vocabulary onto ours. */
export function mapTwilioStatus(status: string): SendResult['status'] | 'read' {
  switch (status) {
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
    case 'undelivered':
    case 'canceled':
      return 'failed';
    case 'sent':
      return 'sent';
    default:
      return 'queued';
  }
}

/**
 * X-Twilio-Signature: base64(HMAC-SHA1(auth token, url + each POST param
 * name and value, sorted by name)). Exported for tests.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class TwilioMessageProvider implements MessageProvider {
  readonly name = 'twilio';
  readonly channels: MessageChannel[];

  constructor(
    private readonly context: ConnectionContext<TwilioCredentials>,
    private readonly channel: MessageChannel,
  ) {
    this.channels = [channel];
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const { credentials, config } = this.context;
    const whatsapp = message.channel === 'whatsapp';
    const to = `${whatsapp ? 'whatsapp:' : ''}+${message.to.replace(/^\+/, '')}`;

    const from = whatsapp
      ? String(config.whatsapp_from ?? message.sender?.displayPhone ?? '')
      : String(message.sender?.smsHeader ?? config.sms_from ?? '');
    const messagingService = whatsapp ? null : (config.messaging_service_sid as string | undefined) ?? null;

    const form: Record<string, string | null> = {
      To: to,
      StatusCallback: this.context.inboundUrl,
    };
    if (messagingService) form.MessagingServiceSid = messagingService;
    else if (from) form.From = whatsapp ? `whatsapp:+${from.replace(/^(whatsapp:)?\+?/, '')}` : from;
    else {
      return {
        providerMessageId: null,
        status: 'failed',
        providerStatus: 'no_sender',
        error: `No ${whatsapp ? 'WhatsApp number' : 'sending number or Messaging Service'} is set on the Twilio connection.`,
        cost: null,
      };
    }

    if (whatsapp && message.providerTemplateId?.startsWith('HX')) {
      form.ContentSid = message.providerTemplateId;
      const values = Object.values(message.variables);
      form.ContentVariables = JSON.stringify(Object.fromEntries(values.map((value, index) => [String(index + 1), value])));
    } else {
      form.Body = message.body;
    }

    try {
      const { data } = await providerFetch<Record<string, unknown>>({
        provider: 'twilio',
        url: `${API}/Accounts/${encodeURIComponent(credentials.account_sid)}/Messages.json`,
        headers: { Authorization: basicAuth(credentials.account_sid, credentials.auth_token) },
        form,
        errorMessage,
      });
      const status = mapTwilioStatus(String(data.status ?? 'queued'));
      return {
        providerMessageId: typeof data.sid === 'string' ? data.sid : null,
        status: status === 'read' ? 'delivered' : status,
        providerStatus: String(data.status ?? ''),
        error: null,
        cost: data.price ? Math.abs(Number(data.price)) : null,
      };
    } catch (error) {
      if (error instanceof ProviderHttpError && !error.retryable) {
        return { providerMessageId: null, status: 'failed', providerStatus: 'rejected', error: error.message, cost: null };
      }
      throw error;
    }
  }
}

export const twilioProvider: ProviderManifest<TwilioCredentials> = {
  key: 'twilio',
  name: 'Twilio',
  category: 'sms',
  channels: ['sms', 'whatsapp'],
  description: 'SMS and WhatsApp in 180+ countries, with delivery receipts.',
  docsUrl: 'https://www.twilio.com/docs/messaging',
  countries: '*',
  credentialFields: [
    { key: 'account_sid', label: 'Account SID', secret: false, required: true, placeholder: 'AC…', pattern: /^AC[0-9a-fA-F]{32}$/ },
    { key: 'auth_token', label: 'Auth token', secret: true, required: true, pattern: /^[0-9a-fA-F]{32}$/ },
  ],
  configFields: [
    { key: 'messaging_service_sid', label: 'Messaging Service SID', type: 'string', help: 'MG… — preferred over a single sending number.' },
    { key: 'sms_from', label: 'SMS sending number or sender ID', type: 'string', help: 'E.164, e.g. +14155550123, or an alphanumeric sender ID.' },
    { key: 'whatsapp_from', label: 'WhatsApp sender number', type: 'string', help: 'The WhatsApp-enabled number, E.164.' },
  ],
  hint: (credentials) => `${credentials.account_sid.slice(0, 6)}…${credentials.account_sid.slice(-4)}`,

  async verify(context) {
    const { data } = await providerFetch<Record<string, unknown>>({
      provider: 'twilio',
      url: `${API}/Accounts/${encodeURIComponent(context.credentials.account_sid)}.json`,
      headers: { Authorization: basicAuth(context.credentials.account_sid, context.credentials.auth_token) },
      errorMessage,
    });
    if (data.status && data.status !== 'active') {
      return { ok: false, message: `The Twilio account is ${String(data.status)}.` };
    }
    return {
      ok: true,
      accountLabel: typeof data.friendly_name === 'string' ? data.friendly_name : null,
      mode: data.type === 'Trial' ? 'test' : 'live',
    };
  },

  messaging: (context, channel) => new TwilioMessageProvider(context, channel),

  inbound: {
    verify(request, context): InboundEvent[] {
      const params = Object.fromEntries(new URLSearchParams(request.rawBody.toString('utf8')));
      const signature = request.headers['x-twilio-signature'] ?? '';
      const expected = twilioSignature(context.credentials.auth_token, request.url, params);
      if (!signature || !safeEqual(signature, expected)) throw new InboundSignatureError();

      if (params.MessageSid && params.MessageStatus) {
        return [
          {
            externalId: `${params.MessageSid}:${params.MessageStatus}`,
            type: 'message.status',
            providerType: `message.${params.MessageStatus}`,
            data: {
              provider_message_id: params.MessageSid,
              status: mapTwilioStatus(params.MessageStatus),
              error_code: params.ErrorCode ?? null,
              channel: (params.To ?? '').startsWith('whatsapp:') ? 'whatsapp' : 'sms',
            },
          },
        ];
      }
      if (params.MessageSid && params.Body !== undefined) {
        return [
          {
            externalId: `${params.MessageSid}:inbound`,
            type: 'message.inbound',
            providerType: 'message.received',
            data: {
              provider_message_id: params.MessageSid,
              from: (params.From ?? '').replace(/^whatsapp:/, '').replace(/^\+/, ''),
              channel: (params.From ?? '').startsWith('whatsapp:') ? 'whatsapp' : 'sms',
              body: params.Body,
            },
          },
        ];
      }
      return [];
    },
    // An empty TwiML response: acknowledged, and no automatic reply.
    acknowledge: { contentType: 'text/xml', body: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>' },
  },
};
