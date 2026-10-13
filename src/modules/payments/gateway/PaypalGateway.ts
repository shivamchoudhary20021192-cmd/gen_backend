import { basicAuth, commonErrorMessage, providerFetch, ProviderHttpError } from '../../../platform/integrations/http';
import { fromMinor, toDecimalString, toMinor } from '../../../platform/money/currency';
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
 * PayPal Checkout (Orders v2, intent CAPTURE).
 *
 * The gateway order is a PayPal order. The buyer approves it in PayPal's
 * buttons; the browser tells us the order id; we capture it server-side —
 * which is the moment money moves, and the proof we need. The payment id we
 * store is the capture id, which is what refunds are made against.
 */

type Json = Record<string, unknown>;

const tokens = new Map<string, { token: string; expiresAt: number }>();

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function paypalError(body: unknown): string | null {
  const record = body as Json | null;
  const details = record?.details as { issue?: string; description?: string }[] | undefined;
  if (details?.[0]) return `${details[0].issue ?? ''}: ${details[0].description ?? ''}`.trim();
  return str(record?.message) ?? commonErrorMessage(body);
}

/** A PayPal capture in the gateway-neutral shape. */
export function fromPaypalCapture(capture: Json, fallbackOrderId: string | null = null): GatewayPayment {
  const amount = (capture.amount ?? {}) as Json;
  const currency = String(amount.currency_code ?? '').toUpperCase();
  const breakdown = (capture.seller_receivable_breakdown ?? {}) as Json;
  const fee = (breakdown.paypal_fee ?? {}) as Json;
  const related = ((capture.supplementary_data as Json | undefined)?.related_ids ?? {}) as Json;
  const status = String(capture.status ?? '');
  const mapped =
    status === 'COMPLETED' ? 'captured' : status === 'PENDING' ? 'authorized' : status === 'DECLINED' || status === 'FAILED' ? 'failed' : 'created';
  const statusDetails = (capture.status_details ?? {}) as Json;

  return {
    id: String(capture.id ?? ''),
    order_id: str(related.order_id) ?? fallbackOrderId,
    amount: currency ? toMinor(Number(amount.value ?? 0), currency) : 0,
    currency,
    status: mapped,
    method: 'paypal',
    captured: status === 'COMPLETED',
    email: null,
    contact: null,
    fee: currency && fee.value ? toMinor(Number(fee.value), currency) : 0,
    tax: 0,
    card_network: null,
    card_last4: null,
    card_issuer: null,
    upi_vpa: null,
    bank: null,
    wallet: 'paypal',
    international: false,
    error_code: str(statusDetails.reason),
    error_description: status === 'DECLINED' ? 'PayPal declined the payment.' : null,
    error_source: null,
    error_step: null,
    error_reason: str(statusDetails.reason),
    raw: { id: capture.id, status: capture.status, amount: capture.amount, order_id: related.order_id ?? fallbackOrderId },
  };
}

export class PaypalGateway implements PaymentGateway {
  readonly name = 'paypal';
  private readonly base: string;

  constructor(
    readonly publicKey: string,
    private readonly clientSecret: string,
    live: boolean,
    private readonly idempotencyScope: string,
  ) {
    this.base = live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }

  private async token(): Promise<string> {
    const cacheKey = `${this.base}:${this.publicKey}`;
    const cached = tokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const { data } = await providerFetch<{ access_token: string; expires_in: number }>({
      provider: 'paypal',
      url: `${this.base}/v1/oauth2/token`,
      headers: { Authorization: basicAuth(this.publicKey, this.clientSecret) },
      form: { grant_type: 'client_credentials' },
      errorMessage: paypalError,
    });
    tokens.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
    return data.access_token;
  }

  /** Proves the client id and secret belong together by exchanging them for a token. */
  async verifyCredentials(): Promise<void> {
    try {
      await this.token();
    } catch (error) {
      if (error instanceof ProviderHttpError) throw new GatewayError(error.message, error.status || 503, null);
      throw error;
    }
  }

  /** Exposed for the webhook verifier, which calls PayPal's verification API. */
  async request<T = Json>(path: string, init: { method?: 'GET' | 'POST'; json?: unknown; requestId?: string } = {}): Promise<T> {
    try {
      const { data } = await providerFetch<T>({
        provider: 'paypal',
        method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
        url: `${this.base}${path}`,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Prefer: 'return=representation',
          ...(init.requestId ? { 'PayPal-Request-Id': init.requestId } : {}),
        },
        json: init.json,
        timeoutMs: 20_000,
        errorMessage: paypalError,
      });
      return data;
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        const issue = ((error.body as Json | null)?.details as { issue?: string }[] | undefined)?.[0]?.issue ?? null;
        throw new GatewayError(error.message, error.status || 503, issue);
      }
      throw error;
    }
  }

  private toOrder(order: Json, fallback: { amountMinor: number; currency: string; receipt: string | null }): GatewayOrder {
    const links = (order.links ?? []) as { rel?: string; href?: string }[];
    const unit = ((order.purchase_units as Json[] | undefined) ?? [])[0] ?? {};
    const amount = (unit.amount ?? {}) as Json;
    const currency = String(amount.currency_code ?? fallback.currency).toUpperCase();
    return {
      id: String(order.id),
      amount: amount.value ? toMinor(Number(amount.value), currency) : fallback.amountMinor,
      currency,
      status: String(order.status ?? 'CREATED'),
      receipt: str(unit.reference_id) ?? fallback.receipt,
      approveUrl: links.find((link) => link.rel === 'approve' || link.rel === 'payer-action')?.href ?? null,
    };
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new GatewayError('A payment needs a whole number of minor units above zero.', 400, 'BAD_AMOUNT');
    }
    const value = toDecimalString(fromMinor(input.amountMinor, input.currency), input.currency);
    const order = await this.request<Json>('/v2/checkout/orders', {
      json: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: input.receipt,
            custom_id: input.receipt,
            description: `Order ${input.receipt}`,
            amount: { currency_code: input.currency.toUpperCase(), value },
          },
        ],
      },
      requestId: `${this.idempotencyScope}:order:${input.receipt}:${input.notes?.attempt ?? '1'}:${input.amountMinor}`,
    });
    return this.toOrder(order, { amountMinor: input.amountMinor, currency: input.currency, receipt: input.receipt });
  }

  async resumeOrder(gatewayOrderId: string): Promise<GatewayOrder> {
    const order = await this.request<Json>(`/v2/checkout/orders/${encodeURIComponent(gatewayOrderId)}`);
    return this.toOrder(order, { amountMinor: 0, currency: '', receipt: null });
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const capture = await this.request<Json>(`/v2/payments/captures/${encodeURIComponent(paymentId)}`);
    return fromPaypalCapture(capture);
  }

  /** CAPTURE-intent orders are captured on approval; there is nothing to capture later. */
  async capturePayment(paymentId: string): Promise<GatewayPayment> {
    return this.fetchPayment(paymentId);
  }

  async createRefund(input: CreateRefundInput): Promise<GatewayRefund> {
    const refund = await this.request<Json>(`/v2/payments/captures/${encodeURIComponent(input.paymentId)}/refund`, {
      json: {
        amount: {
          value: toDecimalString(fromMinor(input.amountMinor, input.currency), input.currency),
          currency_code: input.currency.toUpperCase(),
        },
        note_to_payer: input.notes?.order_number ? `Refund for order ${input.notes.order_number}` : undefined,
      },
      requestId: `${this.idempotencyScope}:${input.idempotencyKey}`,
    });
    const status = String(refund.status ?? 'PENDING');
    return {
      id: String(refund.id),
      payment_id: input.paymentId,
      amount: input.amountMinor,
      status: status === 'COMPLETED' ? 'processed' : status === 'FAILED' || status === 'CANCELLED' ? 'failed' : 'pending',
      speed: null,
      arn: str((refund as Json).acquirer_reference_number),
      raw: { id: refund.id, status: refund.status },
    };
  }

  checkoutPayload(order: GatewayOrder): Record<string, unknown> {
    return {
      provider: this.name,
      client_id: this.publicKey,
      paypal_order_id: order.id,
      approve_url: order.approveUrl ?? null,
      amount_minor: order.amount,
      currency: order.currency,
    };
  }

  /**
   * The buyer approved the order in PayPal; capturing it is what moves the
   * money, and the capture response is the proof. A second call (the webhook
   * got there first, or the shopper retried) finds the order already captured
   * and reads the existing capture instead.
   */
  async confirmClientPayment(input: ClientConfirmation, gatewayOrderId: string): Promise<GatewayPayment> {
    const orderId = input.paypal_order_id ?? input.gateway_order_id ?? '';
    if (orderId !== gatewayOrderId) {
      throw new GatewayError('That payment belongs to a different order.', 400, 'ORDER_MISMATCH');
    }
    let order: Json;
    try {
      order = await this.request<Json>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
        json: {},
        requestId: `${this.idempotencyScope}:capture:${orderId}`,
      });
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'ORDER_ALREADY_CAPTURED') {
        order = await this.request<Json>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
      } else if (error instanceof GatewayError && error.status === 422) {
        throw new GatewayError(error.message, 400, error.code);
      } else {
        throw error;
      }
    }
    const unit = ((order.purchase_units as Json[] | undefined) ?? [])[0] ?? {};
    const capture = (((unit.payments as Json | undefined)?.captures as Json[] | undefined) ?? [])[0];
    if (!capture) throw new GatewayError('PayPal has not captured this payment.', 400, 'NOT_CAPTURED');
    return fromPaypalCapture(capture, orderId);
  }
}
