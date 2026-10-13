import { ApiError } from '../../core/ApiError';
import { auditService } from '../../shared/audit.service';
import { shopsRepository } from '../shops/shops.repository';
import { shopId, tenancy } from '../tenancy/context';
import { billingEngine, type CollectResult } from './billingEngine';
import { billingRepository, type InvoiceLineRow, type InvoiceRow } from './billing.repository';
import { billingProvider } from './providers';
import { BillingProviderError } from './providers/types';
import { platformTaxConfig } from './platformTax';

/**
 * What a shop's admin sees and does under Billing: its bills, the card they
 * are charged to, and paying one now. The engine does the charging; this is
 * the shop-scoped face of it.
 */

interface Actor {
  id: number | null;
  label: string | null;
}

function presentInvoice(row: InvoiceRow, lines?: InvoiceLineRow[]) {
  return {
    id: row.id,
    number: row.invoice_number,
    kind: row.kind,
    status: row.status,
    currency: row.currency,
    subtotal: Number(row.subtotal ?? row.total),
    tax_total: Number(row.tax_total ?? 0),
    tax_note: row.tax_note ?? null,
    customer_tax_id: row.customer_tax_id ?? null,
    total: Number(row.total),
    period_start: row.period_start,
    period_end: row.period_end,
    issued_at: row.issued_at,
    paid_at: row.paid_at,
    attempts: row.attempt_count,
    next_attempt_at: row.next_attempt_at,
    last_error: row.last_error,
    ...(lines
      ? {
          lines: lines.map((line) => ({
            kind: line.kind,
            description: line.description,
            amount: Number(line.amount),
            period_start: line.period_start,
            period_end: line.period_end,
          })),
        }
      : {}),
  };
}

function presentCollect(result: CollectResult) {
  return {
    invoice: presentInvoice(result.invoice),
    outcome: result.outcome,
    // Only for a charge the bank wants confirmed: the admin hands this to the
    // processor's browser SDK, then calls /confirm.
    client_secret: result.clientSecret,
  };
}

async function ownInvoice(id: number): Promise<InvoiceRow> {
  const invoice = await billingRepository.invoice(id);
  if (!invoice || invoice.shop_id !== shopId()) throw ApiError.notFound('Invoice');
  return invoice;
}

async function customer() {
  const shop = tenancy.current();
  const account = await billingRepository.account(shop.id);
  const owner = await shopsRepository.byId(shop.id);
  return {
    account,
    customer: {
      shopId: shop.id,
      shopName: shop.name,
      email: account?.billing_email ?? owner?.email ?? null,
      providerCustomerId: account?.provider === billingProvider().name ? account.provider_customer_id : null,
    },
  };
}

function wrapProviderError(error: unknown): never {
  if (error instanceof BillingProviderError) {
    throw error.status === 403 ? ApiError.forbidden(error.message) : ApiError.validation({ reference: [error.message] }, error.message);
  }
  throw error;
}

export const billingService = {
  async overview() {
    const shop = tenancy.current();
    const [account, unpaid, pending] = await Promise.all([
      billingRepository.account(shop.id),
      billingRepository.unpaidForShop(shop.id),
      billingRepository.pendingLines(shop.id),
    ]);
    const usable = account && account.provider === billingProvider().name && account.payment_method_ref;
    return {
      provider: billingProvider().name,
      // For confirming a charge the bank wants the cardholder to approve.
      publishable_key: billingProvider().publishableKey ?? null,
      payment_method: usable ? { label: account.payment_method_label, expires: account.payment_method_expires } : null,
      outstanding: unpaid.map((invoice) => presentInvoice(invoice)),
      // Credits and charges waiting for the next bill.
      pending_lines: pending.map((line) => ({ kind: line.kind, description: line.description, amount: Number(line.amount), currency: line.currency })),
      frozen: shop.status === 'frozen',
      // Who the bills are made out to, for the platform's tax (see platformTax.ts).
      tax_details: {
        legal_name: account?.legal_name ?? null,
        tax_id: account?.tax_id ?? null,
        tax_region: account?.tax_region ?? null,
        billing_email: account?.billing_email ?? null,
      },
      platform_tax: (() => {
        const config = platformTaxConfig();
        return config.country ? { country: config.country, name: config.name, rate: config.rate, tax_id: config.taxId } : null;
      })(),
    };
  },

  /** The legal name, tax ID and state the store's bills are made out to. Applies from the next bill. */
  async updateTaxDetails(input: { legal_name?: string | null; tax_id?: string | null; tax_region?: string | null; billing_email?: string | null }, actor: Actor) {
    const shop = tenancy.current();
    const taxId = input.tax_id?.trim().toUpperCase() || null;
    // An Indian GSTIN: 2-digit state code, PAN, entity number, Z, check character.
    if (taxId && shop.countryCode === 'IN' && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(taxId)) {
      throw ApiError.validation({ tax_id: ['That is not a valid GSTIN (15 characters, like 29ABCDE1234F1Z5).'] });
    }
    const account = await billingRepository.account(shop.id);
    await billingRepository.upsertAccount(shop.id, account?.provider ?? billingProvider().name, {
      ...(input.legal_name !== undefined ? { legal_name: input.legal_name?.trim() || null } : {}),
      ...(input.tax_id !== undefined ? { tax_id: taxId } : {}),
      ...(input.tax_region !== undefined ? { tax_region: input.tax_region?.trim().toUpperCase() || null } : {}),
      ...(input.billing_email !== undefined ? { billing_email: input.billing_email?.trim() || null } : {}),
    });
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'billing.tax_details_updated', entityType: 'billing_account', entityId: shop.id, summary: 'Changed the billing details', changes: input as Record<string, unknown> });
    return this.overview();
  },

  async invoices() {
    const rows = await billingRepository.invoicesForShop(shopId());
    return { invoices: rows.map((row) => presentInvoice(row)) };
  },

  async invoice(id: number) {
    const invoice = await ownInvoice(id);
    return { invoice: presentInvoice(invoice, await billingRepository.lines(invoice.id)) };
  },

  /** "Pay now": charges the card on file for one bill, whatever the retry schedule says. */
  async pay(id: number, actor: Actor) {
    const invoice = await ownInvoice(id);
    const result = await billingEngine.collect(invoice.id);
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'billing.invoice_paid_manually', entityType: 'platform_invoice', entityId: invoice.id, summary: `Paid ${invoice.invoice_number}: ${result.outcome}` });
    return presentCollect(result);
  },

  /** After the cardholder confirmed a charge with their bank (3-D Secure). */
  async confirm(id: number) {
    const invoice = await ownInvoice(id);
    if (!invoice.provider_payment_id || invoice.status === 'paid') return presentCollect({ invoice, outcome: invoice.status === 'paid' ? 'already_settled' : 'pending', clientSecret: null });
    const status = await billingProvider().chargeStatus(invoice.provider_payment_id);
    return presentCollect(await billingEngine.applyResult(invoice.id, status, new Date()));
  },

  /** Starts adding a card: what the admin needs to collect it. */
  async startPaymentMethod(actor: Actor) {
    const provider = billingProvider();
    const { customer: who } = await customer();
    let setup;
    try {
      setup = await provider.setupPaymentMethod(who);
    } catch (error) {
      wrapProviderError(error);
    }
    if (setup.kind !== 'none') {
      await billingRepository.upsertAccount(shopId(), provider.name, {
        provider_customer_id: setup.providerCustomerId,
        pending_setup_ref: setup.reference,
        billing_email: who.email,
      });
    }
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'billing.payment_method_started', entityType: 'shop', entityId: shopId(), summary: 'Started adding a payment method' });
    return {
      provider: provider.name,
      ...(setup.kind === 'client_secret'
        ? { client_secret: setup.clientSecret, publishable_key: setup.publishableKey }
        : setup.kind === 'test_tokens'
          ? { test_tokens: setup.tokens }
          : { message: setup.message }),
    };
  },

  /**
   * Saves the confirmed card, then retries every unpaid bill with it — the
   * moment a merchant fixes their card is the moment they expect the store
   * to come back.
   */
  async confirmPaymentMethod(reference: string, actor: Actor) {
    const provider = billingProvider();
    const { customer: who } = await customer();
    let method;
    try {
      method = await provider.confirmPaymentMethod(who, reference);
    } catch (error) {
      wrapProviderError(error);
    }
    await billingRepository.upsertAccount(shopId(), provider.name, {
      provider_customer_id: method.providerCustomerId,
      payment_method_ref: method.reference,
      payment_method_label: method.label,
      payment_method_expires: method.expires,
      pending_setup_ref: null,
    });
    // A store invoiced by hand moves onto card billing when it adds a card.
    const subscription = await shopsRepository.liveSubscription(shopId());
    if (subscription && subscription.provider === 'manual') {
      await shopsRepository.updateSubscription(subscription.id, { provider: provider.name });
    }
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'billing.payment_method_updated', entityType: 'shop', entityId: shopId(), summary: `Payment method: ${method.label}` });

    const retried = [];
    for (const invoice of await billingRepository.unpaidForShop(shopId())) {
      retried.push(presentCollect(await billingEngine.collect(invoice.id)));
    }
    return { payment_method: { label: method.label, expires: method.expires }, retried };
  },
};
