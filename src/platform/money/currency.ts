/**
 * Currency minor units.
 *
 * Gateways work in the smallest unit of a currency: paise, cents — and for
 * yen or won, the unit itself. The single-shop code multiplied by 100
 * everywhere, which is right for INR and USD and charges a Japanese customer a
 * hundred times the price. ISO 4217 exponents for the currencies that are not
 * two-decimal; everything else is two.
 */

const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function minorUnitDigits(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** 12.1 → 1210 for INR. Rounded, because 12.1 * 100 is 1209.999… in IEEE 754. */
export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** minorUnitDigits(currency));
}

export function fromMinor(minor: number, currency: string): number {
  const digits = minorUnitDigits(currency);
  return Math.round(minor) / 10 ** digits;
}

/** 1234.5 → "1234.50", the decimal string PayPal and some others want. */
export function toDecimalString(amount: number, currency: string): string {
  return amount.toFixed(minorUnitDigits(currency));
}

/** Round to the currency's own precision. */
export function roundMoney(amount: number, currency: string): number {
  const factor = 10 ** minorUnitDigits(currency);
  return Math.round(amount * factor) / factor;
}
