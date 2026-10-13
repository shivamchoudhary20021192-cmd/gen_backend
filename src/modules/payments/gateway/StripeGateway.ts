import { commonErrorMessage, providerFetch, ProviderHttpError } from '../../../platform/integrations/http';
import {
  GatewayError,
  type ClientConfirmation,
  type CreateOrderInput,
  type CreateRefundInput,
  type GatewayOrder,
  type GatewayPayment,
  type GatewayRefund,
  type PaymentGateway,
} from './PaymentGateway';

/**
 * Stripe, through PaymentIntents.
 *
 * The "gateway order" is a PaymentIntent: created server-side with the exact
 * amount, confirmed in the browser by Stripe's Payment Element with the
 * intent's client secret, and read back server-side before anything is
 * believed. Card data never touches this server.
 *
 * Stripe accepts `Idempotency-Key` on every write, so a retried create or
 * refund is the same object rather than a second one.
 */

const API = 'https://api.stripe.com/v1';

type Json = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A PaymentIntent (optionally with latest_charge expanded) in the gateway-neutral shape. */
export function fromPaymentIntent(intent: Json): GatewayPayment {
  const charge = (typeof intent.latest_charge === 'object' ? intent.latest_charge : null) as Json | null;
  const details = (charge?.payment_method_details ?? null) as Json | null;
  const card = (details?.card ?? null) as Json | null;
  const billing = (charge?.billing_details ?? null) as Json | null;
  const lastError = (intent.last_payment_error ?? null) as Json | null;
  const status = String(intent.status ?? '');

  const mapped =
    status === 'succeeded'
      ? 'captured'
      : status === 'requires_capture'
        ? 'authorized'
        : status === 'canceled' || (status === 'requires_payment_method' && lastError)
          ? 'failed'
          : 'created';

  return {
    id: String(intent.id ?? ''),
    // The intent is both the order and the payment in Stripe's model.
    order_id: str(intent.id),
    amount: status === 'succeeded' ? num(intent.amount_received) || num(intent.amount) : num(intent.amount),
    currency: String(intent.currency ?? '').toUpperCase(),
    status: mapped,
    method: str(details?.type) ?? (Array.isArray(intent.payment_method_types) ? str(intent.payment_method_types[0]) : null),
    captured: status === 'succeeded',
    email: str(billing?.email) ?? str(intent.receipt_email),
    contact: str(billing?.phone),
    fee: 0,
    tax: 0,
    card_network: str(card?.brand),
    card_last4: str(card?.last4),
    card_issuer: null,
    upi_vpa: null,
    bank: null,
    wallet: str((card?.wallet as Json | null)?.type),
    international: false,
    error_code: str(lastError?.decline_code) ?? str(lastError?.code),
    error_description: str(lastError?.message),
    error_source: str(lastError?.type),
    error_step: null,
    error_reason: str(lastError?.decline_code),
    raw: {
      id: intent.id,
      status: intent.status,
      amount: intent.amount,
      amount_received: intent.amount_received,
      currency: intent.currency,
      latest_charge: charge ? { id: charge.id, card: card ? { brand: card.brand, last4: card.last4, country: card.country } : null } : intent.latest_charge,
    },
  };
}

export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe';

  constructor(
    private readonly secretKey: string,
    readonly publicKey: string,
    private readonly idempotencyScope: string,
  ) {}

  private async call<T = Json>(path: string, init: { method?: 'GET' | 'POST'; form?: Json; idempotencyKey?: string } = {}): Promise<T> {
    try {
      const { data } = await providerFetch<T>({
        provider: 'stripe',
        method: init.method ?? (init.form ? 'POST' : 'GET'),
        url: `${API}${path}`,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
        },
        form: init.form as Record<string, string | number | boolean | null | undefined> | undefined,
        timeoutMs: 20_000,
        errorMessage: commonErrorMessage,
      });
      return data;
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        const code = ((error.body as Json | null)?.error as Json | undefined)?.code;
        throw new GatewayError(error.message, error.status || 503, typeof code === 'string' ? code : null);
      }
      throw error;
    }
  }

  private toOrder(intent: Json, receipt: string | null): GatewayOrder {
    return {
      id: String(intent.id),
      amount: num(intent.amount),
      currency: String(intent.currency ?? '').toUpperCase(),
      status: String(intent.status ?? 'requires_payment_method'),
      receipt: receipt ?? str((intent.metadata as Json | undefined)?.order_number),
      clientSecret: str(intent.client_secret),
    };
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new GatewayError('A payment needs a whole number of minor units above zero.', 400, 'BAD_AMOUNT');
    }
    const form: Json = {
      amount: input.amountMinor,
      currency: input.currency.toLowerCase(),
      'automatic_payment_methods[enabled]': true,
      description: `Order ${input.receipt}`,
      'metadata[order_number]': input.receipt,
    };
    for (const [key, value] of Object.entries(input.notes ?? {})) form[`metadata[${key}]`] = value;
    const intent = await this.call<Json>('/payment_intents', {
      form,
      idempotencyKey: `${this.idempotencyScope}:pi:${input.receipt}:${input.notes?.attempt ?? '1'}:${input.amountMinor}`,
    });
    return this.toOrder(intent, input.receipt);
  }

  async resumeOrder(gatewayOrderId: string): Promise<GatewayOrder> {
    const intent = await this.call<Json>(`/payment_intents/${encodeURIComponent(gatewayOrderId)}`);
    return this.toOrder(intent, null);
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const intent = await this.call<Json>(`/payment_intents/${encodeURIComponent(paymentId)}?expand[]=latest_charge`);
    return fromPaymentIntent(intent);
  }

  async capturePayment(paymentId: string, amountMinor: number): Promise<GatewayPayment> {
    const intent = await this.call<Json>(`/payment_intents/${encodeURIComponent(paymentId)}/capture`, {
      form: { amount_to_capture: amountMinor, 'expand[]': 'latest_charge' },
      idempotencyKey: `${this.idempotencyScope}:capture:${paymentId}:${amountMinor}`,
    });
    return fromPaymentIntent(intent);
  }

  async createRefund(input: CreateRefundInput): Promise<GatewayRefund> {
    const form: Json = { payment_intent: input.paymentId, amount: input.amountMinor };
    for (const [key, value] of Object.entries(input.notes ?? {})) form[`metadata[${key}]`] = value;
    const refund = await this.call<Json>('/refunds', { form, idempotencyKey: `${this.idempotencyScope}:${input.idempotencyKey}` });
    const status = String(refund.status ?? 'pending');
    return {
      id: String(refund.id),
      payment_id: input.paymentId,
      amount: num(refund.amount),
      status: status === 'succeeded' ? 'processed' : status === 'failed' || status === 'canceled' ? 'failed' : 'pending',
      speed: null,
      arn: str((refund.destination_details as Json | undefined)?.card && ((refund.destination_details as Json).card as Json).reference),
      raw: { id: refund.id, status: refund.status, amount: refund.amount, currency: refund.currency },
    };
  }

  checkoutPayload(order: GatewayOrder): Record<string, unknown> {
    return {
      provider: this.name,
      publishable_key: this.publicKey,
      payment_intent: order.id,
      client_secret: order.clientSecret ?? null,
      amount_minor: order.amount,
      currency: order.currency,
    };
  }

  async confirmClientPayment(input: ClientConfirmation, gatewayOrderId: string): Promise<GatewayPayment> {
    const intentId = input.payment_intent ?? input.gateway_order_id ?? '';
    if (intentId !== gatewayOrderId) {
      throw new GatewayError('That payment belongs to a different order.', 400, 'ORDER_MISMATCH');
    }
    // Nothing the browser sent is believed beyond the id: the intent is read
    // back from Stripe with our secret key.
    return this.fetchPayment(intentId);
  }
}
