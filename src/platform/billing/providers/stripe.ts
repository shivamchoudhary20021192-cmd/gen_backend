import { commonErrorMessage, providerFetch, ProviderHttpError } from '../../integrations/http';
import { BillingProviderError, type BillingCustomer, type BillingProvider, type ChargeResult } from './types';

/**
 * Stripe as the platform's own processor — the platform's account, not a
 * shop's connection. A card is saved with a SetupIntent (collected in the
 * admin by Stripe.js, so card numbers never touch this API) and charged with
 * off-session PaymentIntents. A bank that insists on 3-D Secure turns the
 * charge into `requires_action`, which the merchant completes from Billing.
 */

type Json = Record<string, unknown>;
type Form = Record<string, string | number | boolean | null | undefined>;

const API = 'https://api.stripe.com/v1';

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function fromIntent(intent: Json): ChargeResult {
  const id = String(intent.id);
  switch (intent.status) {
    case 'succeeded':
      return { status: 'succeeded', providerPaymentId: id };
    case 'requires_action':
    case 'requires_confirmation':
      return {
        status: 'requires_action',
        providerPaymentId: id,
        clientSecret: str(intent.client_secret),
        error: 'Your bank asked you to confirm this payment. Pay it from Billing to complete it.',
      };
    case 'processing':
      return { status: 'pending', providerPaymentId: null };
    default: {
      const lastError = intent.last_payment_error as Json | undefined;
      return { status: 'failed', providerPaymentId: id, error: str(lastError?.message) ?? 'The payment did not go through.' };
    }
  }
}

export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe';

  constructor(
    private readonly secretKey: string,
    readonly publishableKey: string,
  ) {}

  private async call<T = Json>(path: string, form?: Form, idempotencyKey?: string): Promise<T> {
    const { data } = await providerFetch<T>({
      provider: 'stripe_billing',
      method: form ? 'POST' : 'GET',
      url: `${API}${path}`,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      form,
      timeoutMs: 20_000,
      errorMessage: commonErrorMessage,
    });
    return data;
  }

  private async customerId(customer: BillingCustomer): Promise<string> {
    if (customer.providerCustomerId) return customer.providerCustomerId;
    const created = await this.call<Json>(
      '/customers',
      { name: customer.shopName, email: customer.email ?? undefined, 'metadata[shop_id]': customer.shopId },
      `shop-${customer.shopId}-customer`,
    );
    return String(created.id);
  }

  async setupPaymentMethod(customer: BillingCustomer) {
    const customerId = await this.customerId(customer);
    const intent = await this.call<Json>('/setup_intents', {
      customer: customerId,
      usage: 'off_session',
      'payment_method_types[]': 'card',
      'metadata[shop_id]': customer.shopId,
    });
    return {
      kind: 'client_secret' as const,
      clientSecret: String(intent.client_secret),
      publishableKey: this.publishableKey,
      reference: String(intent.id),
      providerCustomerId: customerId,
    };
  }

  async confirmPaymentMethod(customer: BillingCustomer, reference: string) {
    if (!customer.providerCustomerId) throw new BillingProviderError('Start adding a card before confirming it.');
    const intent = await this.call<Json>(`/setup_intents/${encodeURIComponent(reference)}?expand[]=payment_method`);
    // A SetupIntent id is not a secret; it must belong to this shop's customer.
    if (intent.customer !== customer.providerCustomerId) throw new BillingProviderError('That card setup belongs to another account.', 403);
    if (intent.status !== 'succeeded') throw new BillingProviderError('The card has not been confirmed yet.');
    const method = intent.payment_method as Json;
    const card = (method?.card ?? {}) as Json;
    await this.call(`/customers/${encodeURIComponent(customer.providerCustomerId)}`, {
      'invoice_settings[default_payment_method]': String(method.id),
    });
    const brand = str(card.brand) ?? 'Card';
    return {
      reference: String(method.id),
      label: `${brand.charAt(0).toUpperCase()}${brand.slice(1)} •••• ${str(card.last4) ?? '????'}`,
      expires: card.exp_year && card.exp_month ? `${card.exp_year}-${String(card.exp_month).padStart(2, '0')}` : null,
      providerCustomerId: customer.providerCustomerId,
    };
  }

  async charge(input: {
    customer: BillingCustomer;
    paymentMethodRef: string;
    amountMinor: number;
    currency: string;
    description: string;
    idempotencyKey: string;
    invoiceId?: number;
  }): Promise<ChargeResult> {
    try {
      const intent = await this.call<Json>(
        '/payment_intents',
        {
          amount: input.amountMinor,
          currency: input.currency.toLowerCase(),
          customer: input.customer.providerCustomerId ?? undefined,
          payment_method: input.paymentMethodRef,
          off_session: true,
          confirm: true,
          description: input.description,
          'metadata[shop_id]': input.customer.shopId,
          'metadata[invoice_id]': input.invoiceId,
        },
        input.idempotencyKey,
      );
      return fromIntent(intent);
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 402) {
        // A card error carries the PaymentIntent it failed on.
        const body = (error.body ?? {}) as Json;
        const failure = (body.error ?? {}) as Json;
        const intent = failure.payment_intent as Json | undefined;
        if (failure.code === 'authentication_required' && intent) return fromIntent({ ...intent, status: 'requires_action' });
        return { status: 'failed', providerPaymentId: intent ? String(intent.id) : null, error: str(failure.message) ?? 'Your card was declined.' };
      }
      throw error;
    }
  }

  async chargeStatus(providerPaymentId: string): Promise<ChargeResult> {
    return fromIntent(await this.call<Json>(`/payment_intents/${encodeURIComponent(providerPaymentId)}`));
  }
}
