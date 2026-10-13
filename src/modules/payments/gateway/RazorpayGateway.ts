import { logger } from '../../../core/logger';
import { verifyCheckoutSignature } from './signatures';
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

const DEFAULT_BASE_URL = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 20_000;

interface RazorpayErrorBody {
  error?: { code?: string; description?: string; reason?: string; step?: string; source?: string };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The live Razorpay adapter.
 *
 * Deliberately hand-rolled over `fetch` rather than pulling in the `razorpay`
 * npm package: the four calls used here are plain authenticated REST, and the
 * package would add a dependency whose own transitive tree sits in the path of
 * every payment.
 *
 * Two things this class will not do. It never logs the key secret or a full
 * response body, because a payment log is the first thing copied into a support
 * ticket. And it never decides that a payment succeeded — it reports what the
 * gateway said, and the service layer decides, after checking the amount.
 */
export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay';
  readonly publicKey: string;

  private readonly auth: string;
  private readonly baseUrl: string;
  private readonly keySecret: string;

  constructor(
    keyId: string,
    keySecret: string,
    private readonly testMode = keyId.startsWith('rzp_test_'),
    baseUrl = process.env.RAZORPAY_API_BASE ?? DEFAULT_BASE_URL,
  ) {
    this.publicKey = keyId;
    this.keySecret = keySecret;
    this.auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async call<T>(path: string, init: { method: string; body?: unknown } ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Basic ${this.auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
    } catch (caught) {
      const aborted = caught instanceof Error && caught.name === 'AbortError';
      logger.error('razorpay.unreachable', { path, method: init.method, aborted });
      throw new GatewayError(
        aborted
          ? 'The payment gateway did not respond in time.'
          : 'The payment gateway could not be reached.',
        503,
        aborted ? 'GATEWAY_TIMEOUT' : 'GATEWAY_UNREACHABLE',
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const body = parsed as RazorpayErrorBody | null;
      const code = body?.error?.code ?? null;
      const description = body?.error?.description ?? 'The payment gateway refused the request.';
      // The path and the gateway's own code, never the body: a Razorpay error
      // body can echo the customer's contact details back.
      logger.error('razorpay.refused', { path, method: init.method, status: response.status, code });
      throw new GatewayError(description, response.status, code);
    }

    return parsed as T;
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new GatewayError('A gateway order needs a whole number of minor units above zero.', 400, 'BAD_AMOUNT');
    }

    const body = await this.call<Record<string, unknown>>('/orders', {
      method: 'POST',
      body: {
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.receipt,
        // Razorpay captures automatically when the payment is authorised. The
        // alternative — authorise now, capture later — leaves money on hold
        // that expires silently if nobody captures it in five days.
        payment_capture: 1,
        notes: input.notes ?? {},
      },
    });

    return {
      id: String(body.id),
      amount: num(body.amount),
      currency: String(body.currency ?? input.currency),
      status: String(body.status ?? 'created'),
      receipt: str(body.receipt),
    };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const body = await this.call<Record<string, unknown>>(`/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
    });
    return presentPayment(body);
  }

  async capturePayment(paymentId: string, amountMinor: number, currency: string): Promise<GatewayPayment> {
    const body = await this.call<Record<string, unknown>>(
      `/payments/${encodeURIComponent(paymentId)}/capture`,
      { method: 'POST', body: { amount: amountMinor, currency } },
    );
    return presentPayment(body);
  }

  async createRefund(input: CreateRefundInput): Promise<GatewayRefund> {
    const body = await this.call<Record<string, unknown>>(
      `/payments/${encodeURIComponent(input.paymentId)}/refund`,
      {
        method: 'POST',
        body: {
          amount: input.amountMinor,
          speed: 'normal',
          // Razorpay treats `notes.idempotency` as data, not as a dedupe key,
          // so the real protection against a double refund is the unique index
          // on `refunds.gateway_refund_id` plus the row we write before calling.
          // This is here so a duplicate is identifiable in their dashboard.
          notes: { ...(input.notes ?? {}), idempotency_key: input.idempotencyKey },
        },
      },
    );

    return {
      id: String(body.id),
      payment_id: String(body.payment_id ?? input.paymentId),
      amount: num(body.amount),
      status: String(body.status ?? 'pending'),
      speed: str(body.speed_processed) ?? str(body.speed_requested),
      arn: str(body.acquirer_data && (body.acquirer_data as Record<string, unknown>).arn),
      raw: body,
    };
  }

  /** Razorpay Checkout is opened with the key id and the gateway order id. */
  checkoutPayload(order: GatewayOrder): Record<string, unknown> {
    return {
      provider: this.name,
      key_id: this.publicKey,
      gateway_order_id: order.id,
      amount_minor: order.amount,
      currency: order.currency,
      test_mode: this.testMode,
    };
  }

  /**
   * Checkout hands the browser `razorpay_order_id`, `razorpay_payment_id` and
   * an HMAC of the pair under our key secret. The signature proves the ids came
   * from Razorpay; the fetch that follows proves the money moved.
   */
  async confirmClientPayment(input: ClientConfirmation, gatewayOrderId: string): Promise<GatewayPayment> {
    const orderId = input.razorpay_order_id ?? '';
    const paymentId = input.razorpay_payment_id ?? '';
    const signature = input.razorpay_signature ?? '';
    if (orderId !== gatewayOrderId) {
      throw new GatewayError('That payment belongs to a different order.', 400, 'ORDER_MISMATCH');
    }
    const valid = verifyCheckoutSignature(
      { razorpayOrderId: orderId, razorpayPaymentId: paymentId, signature },
      this.keySecret,
    );
    if (!valid) throw new GatewayError('That payment could not be verified.', 400, 'SIGNATURE_INVALID');
    const payment = await this.fetchPayment(paymentId);
    if (payment.order_id && payment.order_id !== gatewayOrderId) {
      throw new GatewayError('That payment belongs to a different order.', 400, 'ORDER_MISMATCH');
    }
    return payment;
  }
}

function presentPayment(body: Record<string, unknown>): GatewayPayment {
  const card = (body.card ?? null) as Record<string, unknown> | null;
  const acquirer = (body.acquirer_data ?? null) as Record<string, unknown> | null;

  return {
    id: String(body.id),
    order_id: str(body.order_id),
    amount: num(body.amount),
    currency: String(body.currency ?? 'INR'),
    status: String(body.status ?? 'created'),
    method: str(body.method),
    captured: body.captured === true,
    email: str(body.email),
    contact: str(body.contact),
    fee: num(body.fee),
    tax: num(body.tax),
    card_network: str(card?.network),
    // The last four digits the gateway returns for display. Everything else
    // about the card stays on Razorpay's side and never reaches this server.
    card_last4: str(card?.last4),
    card_issuer: str(card?.issuer),
    upi_vpa: str(body.vpa) ?? str((body.upi as Record<string, unknown> | null)?.vpa),
    bank: str(body.bank),
    wallet: str(body.wallet),
    international: body.international === true,
    error_code: str(body.error_code),
    error_description: str(body.error_description),
    error_source: str(body.error_source),
    error_step: str(body.error_step),
    error_reason: str(body.error_reason),
    raw: { ...body, card: card ? { network: card.network, last4: card.last4, issuer: card.issuer } : null },
  };
}

export { presentPayment };

/**
 * A Razorpay payment entity (API response or webhook) in the gateway-neutral
 * shape. The webhook is attacker-reachable input, so this tolerates missing and
 * wrongly-typed fields rather than assuming a well-formed body.
 */
export function fromRazorpayEntity(entity: Record<string, unknown>): GatewayPayment {
  const card = (entity.card ?? null) as Record<string, unknown> | null;
  const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

  return {
    id: String(entity.id ?? ''),
    order_id: str(entity.order_id),
    amount: num(entity.amount),
    currency: String(entity.currency ?? 'INR'),
    status: String(entity.status ?? 'created'),
    method: str(entity.method),
    captured: entity.captured === true,
    email: str(entity.email),
    contact: str(entity.contact),
    fee: num(entity.fee),
    tax: num(entity.tax),
    card_network: str(card?.network),
    card_last4: str(card?.last4),
    card_issuer: str(card?.issuer),
    upi_vpa: str(entity.vpa),
    bank: str(entity.bank),
    wallet: str(entity.wallet),
    international: entity.international === true,
    error_code: str(entity.error_code),
    error_description: str(entity.error_description),
    error_source: str(entity.error_source),
    error_step: str(entity.error_step),
    error_reason: str(entity.error_reason),
    raw: { ...entity, card: card ? { network: card.network, last4: card.last4, issuer: card.issuer } : null },
  };
}

