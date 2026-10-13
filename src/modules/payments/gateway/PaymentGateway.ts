/**
 * What the rest of the application is allowed to know about a payment gateway.
 *
 * Same shape as `CourierProvider` in the shipping module, and for the same
 * reason: the service layer talks to this interface, so a second gateway (or a
 * fake, in the smoke suite) is a new implementation rather than a change to
 * every call site. Nothing above this file mentions Razorpay by name.
 */

export interface GatewayOrder {
  id: string;
  /** In the currency's minor unit. */
  amount: number;
  currency: string;
  status: string;
  receipt: string | null;
  /** Stripe: the PaymentIntent client secret the browser confirms with. */
  clientSecret?: string | null;
  /** PayPal: where the buyer approves the payment. */
  approveUrl?: string | null;
}

/**
 * A payment as the gateway describes it.
 *
 * `card_last4` is the last four digits the gateway itself returns for display —
 * the only card data that is ever stored. Nothing here carries a full number,
 * an expiry or a CVV, and nothing in this codebase ever accepts one: the card
 * is entered in the gateway's own iframe and never reaches this server.
 */
export interface GatewayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  /** created | authorized | captured | refunded | failed */
  status: string;
  method: string | null;
  captured: boolean;
  email: string | null;
  contact: string | null;
  fee: number;
  tax: number;
  card_network: string | null;
  card_last4: string | null;
  card_issuer: string | null;
  upi_vpa: string | null;
  bank: string | null;
  wallet: string | null;
  international: boolean;
  error_code: string | null;
  error_description: string | null;
  error_source: string | null;
  error_step: string | null;
  error_reason: string | null;
  raw: unknown;
}

export interface GatewayRefund {
  id: string;
  payment_id: string;
  amount: number;
  /** pending | processed | failed */
  status: string;
  speed: string | null;
  arn: string | null;
  raw: unknown;
}

export interface CreateOrderInput {
  /** In the currency's minor unit (paise, cents; yen are already minor). Never a fraction. */
  amountMinor: number;
  currency: string;
  /** Our order number, so a gateway dashboard row can be traced back here. */
  receipt: string;
  notes?: Record<string, string>;
}

export interface CreateRefundInput {
  paymentId: string;
  amountMinor: number;
  currency: string;
  /** Ours, so a retried refund cannot pay twice. */
  idempotencyKey: string;
  notes?: Record<string, string>;
}

/**
 * What the browser sent back after the shopper paid. Each gateway reads its
 * own fields: Razorpay's signed triple, Stripe's PaymentIntent id, PayPal's
 * approved order id.
 */
export type ClientConfirmation = Record<string, string>;

export interface PaymentGateway {
  /** The provider key: razorpay, stripe, paypal. Stored on the payment row. */
  readonly name: string;
  /** The publishable id the browser needs. Never the secret. */
  readonly publicKey: string;

  createOrder(input: CreateOrderInput): Promise<GatewayOrder>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  capturePayment(paymentId: string, amountMinor: number, currency: string): Promise<GatewayPayment>;
  createRefund(input: CreateRefundInput): Promise<GatewayRefund>;

  /**
   * Everything the storefront needs to open this gateway's own payment UI for
   * one gateway order. Only publishable values: a key id, a client secret that
   * can confirm exactly this one payment, an approval link.
   */
  checkoutPayload(order: GatewayOrder): Record<string, unknown>;

  /**
   * Turns the browser's "I paid" into the payment as the gateway reports it.
   *
   * Must prove the claim before returning — a signature over ids only we and
   * the gateway can produce, or a server-side read of the payment — and must
   * refuse a payment that belongs to a different gateway order than
   * `gatewayOrderId`. Throws GatewayError with status 400 when the claim is
   * false; the amount is checked by the caller.
   */
  confirmClientPayment(input: ClientConfirmation, gatewayOrderId: string): Promise<GatewayPayment>;

  /**
   * Re-reads a gateway order minted earlier, for gateways whose checkout
   * payload holds something not stored here (Stripe's client secret).
   */
  resumeOrder?(gatewayOrderId: string): Promise<GatewayOrder>;
}

/** Raised when the gateway refuses or cannot be reached. */
export class GatewayError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
  }
}
