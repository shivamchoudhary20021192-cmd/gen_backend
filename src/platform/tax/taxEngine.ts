import { roundMoney } from '../money/currency';

/**
 * Tax on a basket, for whichever regime the shop is under.
 *
 * Every line carries its own rate and whether its price already includes tax
 * (from the product's tax class, or the shop's default class). From there:
 *
 *   inclusive  — the tax is inside the price and extracted from it; the total
 *                the shopper pays does not change (India, the UK, the EU,
 *                Australia).
 *   exclusive  — the tax is added on top at checkout (the US, Canada).
 *
 * `in_gst` additionally splits each line's tax the way an Indian invoice must:
 * CGST + SGST when the goods stay in the seller's state, IGST when they cross
 * a state line. The place of supply is the delivery state; the origin is the
 * shop's dispatch state. When either is unknown the intra-state split is used,
 * which is what the single-shop code always did.
 *
 * Rounding is per line, to the currency's own precision, because invoices are
 * per line and must add up exactly.
 */

export interface TaxableLine {
  /** The line's price after discounts, quantity included. */
  amount: number;
  /** Percent, e.g. 18. */
  rate: number;
  inclusive: boolean;
}

export interface TaxedLine {
  taxable: number;
  tax: number;
  rate: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface TaxResult {
  lines: TaxedLine[];
  taxable: number;
  tax: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** Tax that is added on top of prices (exclusive lines only). */
  addedToTotal: number;
  /** Delivery region, recorded on the order for engines that need it. */
  placeOfSupply: string | null;
  interstate: boolean;
}

export interface TaxContext {
  engine: string;
  currency: string;
  /** The shop's dispatch region (state code). */
  origin?: string | null;
  /** The delivery region (state code). */
  destination?: string | null;
}

export function computeTax(lines: TaxableLine[], context: TaxContext): TaxResult {
  const round = (value: number) => roundMoney(value, context.currency);
  const origin = context.origin?.trim().toUpperCase() || null;
  const destination = context.destination?.trim().toUpperCase() || null;
  const splitsGst = context.engine === 'in_gst';
  const interstate = splitsGst && origin !== null && destination !== null && origin !== destination;

  const taxed = lines.map((line): TaxedLine => {
    const rate = Math.max(0, line.rate);
    const amount = round(line.amount);
    const taxable = line.inclusive ? round(amount / (1 + rate / 100)) : amount;
    const tax = line.inclusive ? round(amount - taxable) : round((amount * rate) / 100);

    if (!splitsGst) return { taxable, tax, rate, cgst: 0, sgst: 0, igst: 0 };
    if (interstate) return { taxable, tax, rate, cgst: 0, sgst: 0, igst: tax };
    const cgst = round(tax / 2);
    return { taxable, tax, rate, cgst, sgst: round(tax - cgst), igst: 0 };
  });

  const sum = (pick: (line: TaxedLine) => number) => round(taxed.reduce((total, line) => total + pick(line), 0));
  const addedToTotal = round(
    taxed.reduce((total, line, index) => total + (lines[index].inclusive ? 0 : line.tax), 0),
  );

  return {
    lines: taxed,
    taxable: sum((line) => line.taxable),
    tax: sum((line) => line.tax),
    cgst: sum((line) => line.cgst),
    sgst: sum((line) => line.sgst),
    igst: sum((line) => line.igst),
    addedToTotal,
    placeOfSupply: destination,
    interstate,
  };
}
