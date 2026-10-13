/**
 * The contract a tax service (TaxJar, Avalara…) implements to compute
 * destination-based tax for a basket.
 *
 * Only regimes whose rate depends on where the parcel goes use it — US sales
 * tax, Canadian GST/HST/PST. The service answers per line, for delivery, and
 * with the named taxes that make up the total, so the order and its receipt
 * can say "California state tax 6%, Los Angeles County 0.25%…".
 */

export interface TaxAddress {
  country: string;
  region: string | null;
  postalCode: string | null;
  city: string | null;
  line1: string | null;
}

export interface TaxRequestLine {
  id: string;
  quantity: number;
  unitPrice: number;
  /** Discount on the whole line, not per unit. */
  discount: number;
  exempt: boolean;
  /** The service's own product category, when a tax class names one. */
  productTaxCode: string | null;
}

export interface NamedTax {
  name: string;
  /** Percent. */
  rate: number;
  amount: number;
}

export interface TaxCalculation {
  /** In request order. `rate` is a percent. */
  lines: { id: string; taxable: number; tax: number; rate: number }[];
  shippingTax: number;
  taxLines: NamedTax[];
}

/** A completed sale (or, with negative amounts, a refund) for the service's filing reports. */
export interface TaxTransaction {
  transactionId: string;
  /** For a refund: the sale it refunds. */
  referenceId?: string;
  date: Date;
  from: TaxAddress;
  to: TaxAddress;
  /** Goods after discounts, before tax. Negative for a refund. */
  amount: number;
  shipping: number;
  salesTax: number;
  lines: { id: string; quantity: number; description: string; unitPrice: number; discount: number; salesTax: number }[];
}

export interface TaxCalculator {
  readonly name: string;
  calculate(input: { from: TaxAddress; to: TaxAddress; currency: string; lines: TaxRequestLine[]; shipping: number }): Promise<TaxCalculation>;
  /**
   * Records a completed sale or refund. Services that file returns need them;
   * one that is told twice about the same id answers as if once.
   */
  recordSale?(transaction: TaxTransaction): Promise<void>;
  recordRefund?(transaction: TaxTransaction): Promise<void>;
}

export class TaxCalculationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxCalculationError';
  }
}
