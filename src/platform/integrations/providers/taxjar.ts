import { roundMoney } from '../../money/currency';
import { TaxCalculationError, type NamedTax, type TaxCalculation, type TaxCalculator, type TaxRequestLine, type TaxTransaction } from '../../tax/TaxCalculator';
import { commonErrorMessage, providerFetch, ProviderHttpError } from '../http';
import type { ConnectionContext, ProviderManifest } from '../types';

/**
 * TaxJar: US and Canadian sales tax by address, down to city and special
 * district rates, from the merchant's own TaxJar account.
 *
 * Nexus — where the merchant collects — is configured in TaxJar itself; an
 * address outside it comes back with nothing to collect. Exempt products are
 * sent with TaxJar's general exempt category.
 */

interface TaxJarCredentials {
  api_token: string;
}

type Json = Record<string, unknown>;

const LIVE = 'https://api.taxjar.com/v2';
const SANDBOX = 'https://api.sandbox.taxjar.com/v2';
/** TaxJar's product tax code for "other exempt". */
const EXEMPT_CODE = '99999';

function base(context: ConnectionContext<TaxJarCredentials>): string {
  return context.mode === 'test' ? SANDBOX : LIVE;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorMessage(body: unknown): string | null {
  const record = body as Json | null;
  if (record && typeof record.detail === 'string') return record.detail;
  return commonErrorMessage(body);
}

class TaxJarCalculator implements TaxCalculator {
  readonly name = 'taxjar';

  constructor(private readonly context: ConnectionContext<TaxJarCredentials>) {}

  /**
   * Sales and refunds for TaxJar's filing reports (`/transactions/orders`,
   * `/transactions/refunds`). A refund carries negative amounts and points at
   * the sale it refunds. TaxJar refuses a transaction id it already has;
   * that is success here, because it is what a retried event looks like.
   */
  private async transaction(path: 'orders' | 'refunds', transaction: TaxTransaction): Promise<void> {
    try {
      await providerFetch({
        provider: 'taxjar',
        method: 'POST',
        url: `${base(this.context)}/transactions/${path}`,
        headers: { Authorization: `Bearer ${this.context.credentials.api_token}` },
        json: {
          transaction_id: transaction.transactionId,
          ...(transaction.referenceId ? { transaction_reference_id: transaction.referenceId } : {}),
          transaction_date: transaction.date.toISOString(),
          from_country: transaction.from.country,
          from_zip: transaction.from.postalCode ?? undefined,
          from_state: transaction.from.region ?? undefined,
          from_city: transaction.from.city ?? undefined,
          from_street: transaction.from.line1 ?? undefined,
          to_country: transaction.to.country,
          to_zip: transaction.to.postalCode ?? undefined,
          to_state: transaction.to.region ?? undefined,
          to_city: transaction.to.city ?? undefined,
          to_street: transaction.to.line1 ?? undefined,
          amount: transaction.amount,
          shipping: transaction.shipping,
          sales_tax: transaction.salesTax,
          line_items: transaction.lines.map((line) => ({
            id: line.id,
            quantity: line.quantity,
            description: line.description.slice(0, 255),
            unit_price: line.unitPrice,
            discount: line.discount,
            sales_tax: line.salesTax,
          })),
        },
        timeoutMs: 10_000,
        errorMessage,
      });
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 422 && /already exists/i.test(error.message)) return;
      if (error instanceof ProviderHttpError) throw new TaxCalculationError(`TaxJar: ${error.message}`);
      throw error;
    }
  }

  recordSale(transaction: TaxTransaction): Promise<void> {
    return this.transaction('orders', transaction);
  }

  recordRefund(transaction: TaxTransaction): Promise<void> {
    return this.transaction('refunds', transaction);
  }

  async calculate(input: Parameters<TaxCalculator['calculate']>[0]): Promise<TaxCalculation> {
    const round = (value: number) => roundMoney(value, input.currency);
    const lineItems = input.lines.map((line: TaxRequestLine) => ({
      id: line.id,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      discount: line.discount,
      product_tax_code: line.exempt ? EXEMPT_CODE : (line.productTaxCode ?? undefined),
    }));

    let data: Json;
    try {
      ({ data } = await providerFetch<Json>({
        provider: 'taxjar',
        method: 'POST',
        url: `${base(this.context)}/taxes`,
        headers: { Authorization: `Bearer ${this.context.credentials.api_token}` },
        json: {
          from_country: input.from.country,
          from_zip: input.from.postalCode ?? undefined,
          from_state: input.from.region ?? undefined,
          from_city: input.from.city ?? undefined,
          from_street: input.from.line1 ?? undefined,
          to_country: input.to.country,
          to_zip: input.to.postalCode ?? undefined,
          to_state: input.to.region ?? undefined,
          to_city: input.to.city ?? undefined,
          to_street: input.to.line1 ?? undefined,
          shipping: input.shipping,
          line_items: lineItems,
        },
        timeoutMs: 8_000,
        errorMessage,
      }));
    } catch (error) {
      if (error instanceof ProviderHttpError) throw new TaxCalculationError(`TaxJar: ${error.message}`);
      throw error;
    }

    const tax = (data.tax ?? {}) as Json;
    const breakdown = (tax.breakdown ?? {}) as Json;
    const byId = new Map<string, Json>(
      ((breakdown.line_items as Json[] | undefined) ?? []).map((line) => [String(line.id), line]),
    );
    const lines = input.lines.map((line) => {
      const found = byId.get(line.id);
      return {
        id: line.id,
        taxable: round(num(found?.taxable_amount ?? line.unitPrice * line.quantity - line.discount)),
        tax: round(num(found?.tax_collectable)),
        rate: round(num(found?.combined_tax_rate) * 100 * 1000) / 1000,
      };
    });
    const shippingTax = round(num((breakdown.shipping as Json | undefined)?.tax_collectable));

    const jurisdictions = (tax.jurisdictions ?? {}) as Json;
    const named: NamedTax[] = [];
    const add = (label: string | null, rate: unknown, amount: unknown) => {
      const value = round(num(amount));
      if (value > 0 && label) named.push({ name: label, rate: Math.round(num(rate) * 100_000) / 1000, amount: value });
    };
    if (input.to.country === 'CA') {
      add('GST', breakdown.gst_tax_rate, breakdown.gst);
      add('PST', breakdown.pst_tax_rate, breakdown.pst);
      add('QST', breakdown.qst_tax_rate, breakdown.qst);
    } else {
      add(jurisdictions.state ? `${jurisdictions.state} state tax` : 'State tax', breakdown.state_tax_rate, breakdown.state_tax_collectable);
      add(jurisdictions.county ? `${String(jurisdictions.county)} county tax` : 'County tax', breakdown.county_tax_rate, breakdown.county_tax_collectable);
      add(jurisdictions.city ? `${String(jurisdictions.city)} city tax` : 'City tax', breakdown.city_tax_rate, breakdown.city_tax_collectable);
      add('Special district tax', breakdown.special_tax_rate ?? breakdown.special_district_tax_rate, breakdown.special_district_tax_collectable);
    }
    // Jurisdiction amounts are rounded one by one and can miss the total by a
    // cent or two; the largest takes the difference so the lines add up. A
    // response with no usable breakdown still has a total, never dropped.
    const total = round(num(tax.amount_to_collect));
    const difference = round(total - named.reduce((sum, line) => sum + line.amount, 0));
    if (named.length > 0 && Math.abs(difference) <= 0.02 * named.length) {
      const largest = named.reduce((best, line) => (line.amount > best.amount ? line : best));
      largest.amount = round(largest.amount + difference);
    } else if (total > 0 && difference !== 0) {
      named.splice(0, named.length, { name: 'Sales tax', rate: Math.round(num(tax.rate) * 100_000) / 1000, amount: total });
    }
    return { lines, shippingTax, taxLines: named };
  }
}

export const taxjarProvider: ProviderManifest<TaxJarCredentials> = {
  key: 'taxjar',
  name: 'TaxJar',
  category: 'tax',
  description: 'Sales tax by address for the US and Canada — state, county, city and special districts — from your TaxJar account.',
  docsUrl: 'https://developers.taxjar.com/api/reference/',
  countries: ['US', 'CA'],
  credentialFields: [
    { key: 'api_token', label: 'API token', secret: true, required: true, pattern: /^[A-Za-z0-9]{20,64}$/, help: 'TaxJar → Account → SmartCalcs API.' },
  ],
  configFields: [
    {
      key: 'environment',
      label: 'Environment',
      type: 'select',
      options: [
        { value: 'live', label: 'Live' },
        { value: 'sandbox', label: 'Sandbox' },
      ],
      default: 'live',
    },
  ],
  hint: (credentials) => `…${credentials.api_token.slice(-4)}`,
  async verify(context) {
    const mode = context.config.environment === 'sandbox' ? 'test' : 'live';
    try {
      await providerFetch({
        provider: 'taxjar',
        url: `${mode === 'test' ? SANDBOX : LIVE}/categories`,
        headers: { Authorization: `Bearer ${context.credentials.api_token}` },
        timeoutMs: 8_000,
        errorMessage,
      });
      return { ok: true, mode, accountLabel: `TaxJar (${mode === 'test' ? 'sandbox' : 'live'})` };
    } catch (error) {
      if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 403)) {
        return { ok: false, message: 'TaxJar did not accept that API token.' };
      }
      throw error;
    }
  },
  tax: (context) => new TaxJarCalculator(context),
};
