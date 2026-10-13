import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '../../core/logger';
import { metrics } from '../observability/metrics';
import { billingEngine } from './billingEngine';
import { billingRepository } from './billing.repository';

/**
 * What the platform's Stripe account tells us about bills — the payments
 * that finish away from the platform's own requests: a 3-D Secure check
 * completed in another tab, a bank payment that settles later, a charge that
 * fails after it looked pending. Without these a bill paid that way stayed
 * open until someone pressed "Pay" again.
 *
 *   POST /platform/api/v1/billing/webhooks/stripe
 *
 * Each event is verified (Stripe-Signature against
 * PLATFORM_STRIPE_WEBHOOK_SECRET, five minutes' tolerance), recorded, and
 * handled once — Stripe retries until it gets a 2xx, and a retry of an event
 * already handled is answered without doing anything.
 */

const TOLERANCE_SECONDS = 300;

/** Stripe's scheme: `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` (several v1 while a secret rolls). */
export function verifyStripeSignature(rawBody: Buffer | string, header: string | undefined, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((part) => part.trim().split('=') as [string, string]);
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - timestamp) > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody).digest();
  return signatures.some((signature) => {
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

type Outcome = { invoiceId: number | null; outcome: string; error?: string | null };

async function invoiceFor(intent: Record<string, unknown>) {
  const fromMetadata = Number((intent.metadata as Record<string, unknown> | undefined)?.invoice_id);
  if (Number.isInteger(fromMetadata) && fromMetadata > 0) {
    const invoice = await billingRepository.invoice(fromMetadata);
    if (invoice) return invoice;
  }
  return typeof intent.id === 'string' ? billingRepository.invoiceByProviderPayment(intent.id) : null;
}

async function handle(event: StripeEvent): Promise<Outcome> {
  const object = event.data?.object ?? {};
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const invoice = await invoiceFor(object);
      if (!invoice) return { invoiceId: null, outcome: 'unmatched' };
      const result = await billingEngine.applyResult(invoice.id, { status: 'succeeded', providerPaymentId: String(object.id) }, new Date());
      return { invoiceId: invoice.id, outcome: result.outcome };
    }
    case 'payment_intent.payment_failed': {
      const invoice = await invoiceFor(object);
      if (!invoice) return { invoiceId: null, outcome: 'unmatched' };
      if (invoice.status === 'paid' || invoice.status === 'void') return { invoiceId: invoice.id, outcome: 'already_settled' };
      // The platform's own charge request already recorded this failure: not a second attempt.
      if (invoice.status === 'failed' && invoice.provider_payment_id === object.id) return { invoiceId: invoice.id, outcome: 'already_recorded' };
      const failure = (object.last_payment_error ?? {}) as Record<string, unknown>;
      const message = typeof failure.message === 'string' && failure.message ? failure.message : 'The payment did not go through.';
      const result = await billingEngine.applyResult(invoice.id, { status: 'failed', providerPaymentId: String(object.id), error: message }, new Date());
      return { invoiceId: invoice.id, outcome: result.outcome, error: message };
    }
    case 'charge.dispute.created': {
      metrics.counter('platform_billing_disputes_total').inc();
      logger.warn('billing.dispute_opened', { charge: object.charge ?? object.id, amount: object.amount, reason: object.reason });
      return { invoiceId: null, outcome: 'noted' };
    }
    default:
      return { invoiceId: null, outcome: 'ignored' };
  }
}

export const billingWebhooks = {
  async stripe(rawBody: Buffer | undefined, signature: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
    const secret = process.env.PLATFORM_STRIPE_WEBHOOK_SECRET ?? '';
    if (!secret) return { status: 503, body: { error: 'Billing webhooks are not configured.' } };
    if (!rawBody || !verifyStripeSignature(rawBody, signature, secret)) {
      metrics.counter('platform_billing_webhooks_total', { outcome: 'bad_signature' }).inc();
      return { status: 400, body: { error: 'Invalid signature.' } };
    }
    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as StripeEvent;
    } catch {
      return { status: 400, body: { error: 'Invalid payload.' } };
    }
    if (!event?.id || !event.type) return { status: 400, body: { error: 'Invalid event.' } };
    if (!(await billingRepository.recordEvent('stripe', event.id, event.type))) {
      return { status: 200, body: { received: true, duplicate: true } };
    }
    try {
      const outcome = await handle(event);
      await billingRepository.finishEvent('stripe', event.id, outcome);
      metrics.counter('platform_billing_webhooks_total', { outcome: outcome.outcome }).inc();
      return { status: 200, body: { received: true, outcome: outcome.outcome } };
    } catch (error) {
      // Let Stripe retry: the event is forgotten so the retry is handled afresh.
      await billingRepository.forgetEvent('stripe', event.id).catch(() => undefined);
      logger.error('billing.webhook_failed', { event: event.id, type: event.type, error: error instanceof Error ? error.message : String(error) });
      return { status: 500, body: { error: 'Could not process the event.' } };
    }
  },
};
