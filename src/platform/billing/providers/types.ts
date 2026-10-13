/**
 * How the platform takes money from its merchants.
 *
 * Deliberately smaller than a shop's `PaymentGateway`: the platform only ever
 * keeps a card on file and charges it off-session for a bill. A provider does
 * not know what a plan or an invoice is — the billing engine decides what to
 * charge and when, which is what makes transaction fees, prorations and
 * dunning the same on every provider.
 */

export interface BillingCustomer {
  shopId: number;
  shopName: string;
  email: string | null;
  providerCustomerId: string | null;
}

export type PaymentMethodSetup =
  /** The admin collects the card with the provider's own browser SDK. */
  | { kind: 'client_secret'; clientSecret: string; publishableKey: string; reference: string; providerCustomerId: string }
  /** Development: tokens that stand for a working and a declining card. */
  | { kind: 'test_tokens'; tokens: { token: string; description: string }[]; reference: string; providerCustomerId: string | null }
  /** Nothing to collect: bills are settled outside the platform (bank transfer). */
  | { kind: 'none'; message: string };

export interface ConfirmedPaymentMethod {
  reference: string;
  label: string;
  expires: string | null;
  providerCustomerId: string | null;
}

export type ChargeResult =
  | { status: 'succeeded'; providerPaymentId: string }
  | { status: 'failed'; providerPaymentId: string | null; error: string }
  /** The bank wants the cardholder to confirm (3-D Secure); pay from Billing. */
  | { status: 'requires_action'; providerPaymentId: string; clientSecret: string | null; error: string }
  /** Settled outside the platform; the bill stays open until marked paid. */
  | { status: 'pending'; providerPaymentId: null };

export interface BillingProvider {
  readonly name: string;
  /** Public key for the provider's browser SDK, when the admin needs one (3-D Secure). */
  readonly publishableKey?: string;
  setupPaymentMethod(customer: BillingCustomer): Promise<PaymentMethodSetup>;
  confirmPaymentMethod(customer: BillingCustomer, reference: string): Promise<ConfirmedPaymentMethod>;
  charge(input: {
    customer: BillingCustomer;
    paymentMethodRef: string;
    amountMinor: number;
    currency: string;
    description: string;
    idempotencyKey: string;
    /** The bill being paid: lets the processor's events find it again. */
    invoiceId?: number;
  }): Promise<ChargeResult>;
  /** Re-reads a charge that needed the cardholder, after they confirmed it. */
  chargeStatus(providerPaymentId: string): Promise<ChargeResult>;
}

export class BillingProviderError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = 'BillingProviderError';
  }
}
