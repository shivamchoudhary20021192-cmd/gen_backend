import { tenancy } from '../tenancy/context';

/**
 * Money and dates the way the current shop writes them.
 *
 * The single-shop code wrote `₹` and `en-IN` inline, which is right for exactly
 * one shop. These read the currency, locale and timezone from the shop in
 * context so a merge field or an invoice line comes out as `$1,299.00` for a
 * US shop and `₹1,299` for an Indian one without any caller knowing which.
 *
 * Formatters are cached per (locale, currency): building an Intl formatter is
 * far more expensive than using one, and a campaign formats thousands.
 */

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(locale: string, currency: string, wholeUnits: boolean): Intl.NumberFormat {
  const key = `${locale}|${currency}|${wholeUnits ? 0 : 2}`;
  let formatter = moneyFormatters.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        ...(wholeUnits ? { maximumFractionDigits: 0, minimumFractionDigits: 0 } : {}),
      });
    } catch {
      // An unknown locale or currency code must not take a send down.
      formatter = new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' });
    }
    moneyFormatters.set(key, formatter);
  }
  return formatter;
}

function shopDefaults(): { locale: string; currency: string; timezone: string } {
  const shop = tenancy.currentOrNull();
  return {
    locale: shop?.locale || 'en',
    currency: shop?.currency || 'USD',
    timezone: shop?.timezone || 'UTC',
  };
}

/** `1299.5` → `₹1,300` (whole units) or `$1,299.50`. */
export function formatMoney(amount: unknown, options: { currency?: string; wholeUnits?: boolean } = {}): string {
  const defaults = shopDefaults();
  const value = Number(amount ?? 0);
  return moneyFormatter(defaults.locale, options.currency ?? defaults.currency, options.wholeUnits ?? false).format(
    Number.isFinite(value) ? value : 0,
  );
}

/** A short calendar date in the shop's own timezone, e.g. `12 Mar`. */
export function formatShortDate(value: Date | string | null | undefined): string {
  if (!value) return '';
  const defaults = shopDefaults();
  try {
    return new Date(value).toLocaleDateString(defaults.locale, {
      day: 'numeric',
      month: 'short',
      timeZone: defaults.timezone,
    });
  } catch {
    return new Date(value).toISOString().slice(0, 10);
  }
}
