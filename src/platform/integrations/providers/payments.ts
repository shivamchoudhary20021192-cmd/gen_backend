import crypto from 'node:crypto';
import { PaypalGateway, fromPaypalCapture } from '../../../modules/payments/gateway/PaypalGateway';
import { RazorpayGateway, fromRazorpayEntity } from '../../../modules/payments/gateway/RazorpayGateway';
import { StripeGateway, fromPaymentIntent } from '../../../modules/payments/gateway/StripeGateway';
import { basicAuth, commonErrorMessage, providerFetch } from '../http';
import { InboundSignatureError, type ConnectionContext, type InboundEvent, type ProviderManifest } from '../types';

/**
 * Payment gateways as integrations.
 *
 * Each manifest maps a merchant's keys to the gateway class the payments
 * module already speaks to, and translates the gateway's webhooks into the
 * platform's payment events: payment.captured, payment.authorized,
 * payment.failed, refund.processed/failed/pending. The payments module
 * subscribes to those once for every gateway.
 */

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Idempotency keys are namespaced by shop and connection so two shops never collide at the gateway. */
function scope(context: ConnectionContext<unknown>): string {
  return `veylog:${context.shopId}:${context.publicId.slice(0, 8)}`;
}

// ── Razorpay ─────────────────────────────────────────────────────────────────

interface RazorpayCredentials {
  key_id: string;
  key_secret: string;
  webhook_secret?: string;
}

export const razorpayProvider: ProviderManifest<RazorpayCredentials> = {
  key: 'razorpay',
  name: 'Razorpay',
  category: 'payments',
  description: 'UPI, cards, netbanking and wallets in India.',
  docsUrl: 'https://razorpay.com/docs/api/',
  countries: ['IN'],
  credentialFields: [
    { key: 'key_id', label: 'Key ID', secret: false, required: true, placeholder: 'rzp_live_…', pattern: /^rzp_(live|test)_[A-Za-z0-9]{8,}$/ },
    { key: 'key_secret', label: 'Key secret', secret: true, required: true },
    { key: 'webhook_secret', label: 'Webhook secret', secret: true, required: false, help: 'Set on the webhook in the Razorpay dashboard. Required for payment confirmations by webhook.' },
  ],
  detectMode: (credentials) => (credentials.key_id.startsWith('rzp_test_') ? 'test' : 'live'),
  hint: (credentials) => credentials.key_id,

  async verify(context) {
    await providerFetch({
      provider: 'razorpay',
      url: 'https://api.razorpay.com/v1/payments?count=1',
      headers: { Authorization: basicAuth(context.credentials.key_id, context.credentials.key_secret) },
      errorMessage: commonErrorMessage,
    });
    return { ok: true, mode: context.credentials.key_id.startsWith('rzp_test_') ? 'test' : 'live' };
  },

  payments: (context) =>
    new RazorpayGateway(context.credentials.key_id, context.credentials.key_secret, context.credentials.key_id.startsWith('rzp_test_')),

  inbound: {
    verify(request, context): InboundEvent[] {
      const secret = context.credentials.webhook_secret;
      const header = request.headers['x-razorpay-signature'] ?? '';
      if (!secret || !header) throw new InboundSignatureError('A webhook secret is required.');
      const expected = crypto.createHmac('sha256', secret).update(request.rawBody).digest('hex');
      if (!safeEqual(header.trim(), expected)) throw new InboundSignatureError();

      const body = JSON.parse(request.rawBody.toString('utf8')) as {
        event?: string;
        payload?: { payment?: { entity?: Record<string, unknown> }; refund?: { entity?: Record<string, unknown> } };
      };
      const event = String(body.event ?? '');
      const deliveryId = request.headers['x-razorpay-event-id'];
      const payment = body.payload?.payment?.entity;
      const refund = body.payload?.refund?.entity;

      if (payment && ['payment.captured', 'payment.authorized', 'payment.failed'].includes(event)) {
        return [
          {
            externalId: deliveryId ?? `${event}:${String(payment.id)}`,
            type: event,
            providerType: event,
            data: { gateway: 'razorpay', payment: fromRazorpayEntity(payment) },
          },
        ];
      }
      if (refund && ['refund.processed', 'refund.failed', 'refund.created'].includes(event)) {
        const acquirer = refund.acquirer_data as Record<string, unknown> | undefined;
        return [
          {
            externalId: deliveryId ?? `${event}:${String(refund.id)}`,
            type: event === 'refund.created' ? 'refund.pending' : event,
            providerType: event,
            data: { gateway: 'razorpay', refund_id: String(refund.id), arn: (acquirer?.arn as string | undefined) ?? null, raw: refund },
          },
        ];
      }
      return [{ externalId: deliveryId ?? `${event}:${crypto.createHash('sha256').update(request.rawBody).digest('hex')}`, type: `razorpay.${event}`, providerType: event, data: {} }];
    },
  },
};

// ── Stripe ───────────────────────────────────────────────────────────────────

interface StripeCredentials {
  secret_key: string;
  publishable_key: string;
  webhook_secret?: string;
}

/** Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]. HMAC-SHA256 over "<t>.<raw body>". Exported for tests. */
export function verifyStripeSignature(rawBody: Buffer, header: string, secret: string, toleranceSeconds = 300, now = Date.now()): boolean {
  const parts = header.split(',').map((part) => part.trim().split('='));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return signatures.some((signature) => safeEqual(signature, expected));
}

export const stripeProvider: ProviderManifest<StripeCredentials> = {
  key: 'stripe',
  name: 'Stripe',
  category: 'payments',
  description: 'Cards, wallets and local payment methods in 45+ countries.',
  docsUrl: 'https://docs.stripe.com/payments/payment-intents',
  countries: ['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'SG', 'AE', 'DE', 'FR', 'NL', 'ES', 'IT', 'SE', 'JP', 'MX', 'BR'],
  credentialFields: [
    { key: 'secret_key', label: 'Secret key', secret: true, required: true, placeholder: 'sk_live_…', pattern: /^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/ },
    { key: 'publishable_key', label: 'Publishable key', secret: false, required: true, placeholder: 'pk_live_…', pattern: /^pk_(live|test)_[A-Za-z0-9]{10,}$/ },
    { key: 'webhook_secret', label: 'Webhook signing secret', secret: true, required: false, placeholder: 'whsec_…', pattern: /^whsec_[A-Za-z0-9]{10,}$/ },
  ],
  detectMode: (credentials) => (credentials.secret_key.includes('_test_') ? 'test' : 'live'),
  hint: (credentials) => `${credentials.publishable_key.slice(0, 8)}…${credentials.publishable_key.slice(-4)}`,

  async verify(context) {
    const { secret_key: secret, publishable_key: publishable } = context.credentials;
    if (secret.includes('_test_') !== publishable.includes('_test_')) {
      return { ok: false, message: 'The secret and publishable keys are from different modes (test vs live).' };
    }
    const { data } = await providerFetch<Record<string, unknown>>({
      provider: 'stripe',
      url: 'https://api.stripe.com/v1/balance',
      headers: { Authorization: `Bearer ${secret}` },
      errorMessage: commonErrorMessage,
    });
    return { ok: true, mode: data.livemode === true ? 'live' : 'test' };
  },

  payments: (context) =>
    new StripeGateway(context.credentials.secret_key, context.credentials.publishable_key, scope(context)),

  inbound: {
    verify(request, context): InboundEvent[] {
      const secret = context.credentials.webhook_secret;
      const header = request.headers['stripe-signature'] ?? '';
      if (!secret || !header) throw new InboundSignatureError('A webhook signing secret is required.');
      if (!verifyStripeSignature(request.rawBody, header, secret)) throw new InboundSignatureError();

      const event = JSON.parse(request.rawBody.toString('utf8')) as { id: string; type: string; data?: { object?: Record<string, unknown> } };
      const object = event.data?.object ?? {};
      const byType: Record<string, string> = {
        'payment_intent.succeeded': 'payment.captured',
        'payment_intent.amount_capturable_updated': 'payment.authorized',
        'payment_intent.payment_failed': 'payment.failed',
      };
      if (byType[event.type]) {
        return [{ externalId: event.id, type: byType[event.type], providerType: event.type, data: { gateway: 'stripe', payment: fromPaymentIntent(object) } }];
      }
      if (event.type === 'refund.updated' || event.type === 'refund.created' || event.type === 'refund.failed') {
        const status = String(object.status ?? '');
        return [
          {
            externalId: event.id,
            type: status === 'succeeded' ? 'refund.processed' : status === 'failed' || status === 'canceled' ? 'refund.failed' : 'refund.pending',
            providerType: event.type,
            data: { gateway: 'stripe', refund_id: String(object.id), arn: null, raw: { id: object.id, status } },
          },
        ];
      }
      return [{ externalId: event.id, type: `stripe.${event.type}`, providerType: event.type, data: {} }];
    },
  },
};

// ── PayPal ───────────────────────────────────────────────────────────────────

interface PaypalCredentials {
  client_id: string;
  client_secret: string;
  webhook_id?: string;
}

function paypalGateway(context: ConnectionContext<PaypalCredentials>): PaypalGateway {
  return new PaypalGateway(
    context.credentials.client_id,
    context.credentials.client_secret,
    String(context.config.environment ?? 'sandbox') === 'live',
    scope(context),
  );
}

export const paypalProvider: ProviderManifest<PaypalCredentials> = {
  key: 'paypal',
  name: 'PayPal',
  category: 'payments',
  description: 'PayPal wallet, Pay Later and cards through PayPal Checkout.',
  docsUrl: 'https://developer.paypal.com/docs/checkout/',
  countries: '*',
  credentialFields: [
    { key: 'client_id', label: 'Client ID', secret: false, required: true },
    { key: 'client_secret', label: 'Client secret', secret: true, required: true },
    { key: 'webhook_id', label: 'Webhook ID', secret: false, required: false, help: 'From the webhook you create in the PayPal developer dashboard. Required for confirmations by webhook.' },
  ],
  configFields: [
    {
      key: 'environment',
      label: 'Environment',
      type: 'select',
      required: true,
      default: 'sandbox',
      options: [
        { value: 'sandbox', label: 'Sandbox (testing)' },
        { value: 'live', label: 'Live' },
      ],
    },
  ],
  hint: (credentials) => `${credentials.client_id.slice(0, 6)}…${credentials.client_id.slice(-4)}`,

  async verify(context) {
    try {
      await paypalGateway(context).verifyCredentials();
    } catch (error) {
      const status = (error as { status?: number }).status ?? 0;
      if (status >= 400 && status < 500) return { ok: false, message: 'PayPal did not accept this client id and secret.' };
      throw error;
    }
    return { ok: true, mode: String(context.config.environment ?? 'sandbox') === 'live' ? 'live' : 'test' };
  },

  payments: (context) => paypalGateway(context),

  inbound: {
    async verify(request, context): Promise<InboundEvent[]> {
      const webhookId = context.credentials.webhook_id;
      if (!webhookId) throw new InboundSignatureError('A webhook id is required.');
      const event = JSON.parse(request.rawBody.toString('utf8')) as { id: string; event_type: string; resource?: Record<string, unknown> };
      const h = request.headers;
      // PayPal verifies its own signature: we hand back exactly what arrived.
      const result = await paypalGateway(context).request<{ verification_status?: string }>(
        '/v1/notifications/verify-webhook-signature',
        {
          json: {
            auth_algo: h['paypal-auth-algo'],
            cert_url: h['paypal-cert-url'],
            transmission_id: h['paypal-transmission-id'],
            transmission_sig: h['paypal-transmission-sig'],
            transmission_time: h['paypal-transmission-time'],
            webhook_id: webhookId,
            webhook_event: event,
          },
        },
      );
      if (result.verification_status !== 'SUCCESS') throw new InboundSignatureError();

      const resource = event.resource ?? {};
      const byType: Record<string, string> = {
        'PAYMENT.CAPTURE.COMPLETED': 'payment.captured',
        'PAYMENT.CAPTURE.PENDING': 'payment.authorized',
        'PAYMENT.CAPTURE.DENIED': 'payment.failed',
        'PAYMENT.CAPTURE.DECLINED': 'payment.failed',
      };
      if (byType[event.event_type]) {
        return [{ externalId: event.id, type: byType[event.event_type], providerType: event.event_type, data: { gateway: 'paypal', payment: fromPaypalCapture(resource) } }];
      }
      if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED' || event.event_type === 'PAYMENT.REFUND.COMPLETED' || event.event_type === 'PAYMENT.REFUND.FAILED') {
        const status = String(resource.status ?? '');
        return [
          {
            externalId: event.id,
            type: status === 'COMPLETED' ? 'refund.processed' : status === 'FAILED' || status === 'CANCELLED' ? 'refund.failed' : 'refund.pending',
            providerType: event.event_type,
            data: { gateway: 'paypal', refund_id: String(resource.id), arn: null, raw: { id: resource.id, status } },
          },
        ];
      }
      return [{ externalId: event.id, type: `paypal.${event.event_type}`, providerType: event.event_type, data: {} }];
    },
  },
};
