import { z } from 'zod';
import { tenancy } from '../tenancy/context';

/**
 * Phone numbers in the shop's own country.
 *
 * The storefront stores a customer's phone as the national number (what they
 * type) and the calling code separately (`customers.country_code`). The
 * single-shop code accepted only an Indian mobile, `^[6-9]\d{9}$`; these rules
 * keep that exact check for India and apply the right shape elsewhere, falling
 * back to "six to fourteen digits" for countries without a specific rule.
 *
 * Input is forgiving — spaces, dashes, brackets and a leading +<calling code>
 * are stripped — and the value handed on is the bare national number.
 */

interface CountryPhone {
  callingCode: string;
  national: RegExp;
  example: string;
}

const COUNTRIES: Record<string, CountryPhone> = {
  IN: { callingCode: '91', national: /^[6-9]\d{9}$/, example: '98765 43210' },
  US: { callingCode: '1', national: /^[2-9]\d{2}[2-9]\d{6}$/, example: '(415) 555-0132' },
  CA: { callingCode: '1', national: /^[2-9]\d{2}[2-9]\d{6}$/, example: '(416) 555-0132' },
  GB: { callingCode: '44', national: /^0?7\d{9}$|^0?[1-3]\d{8,9}$/, example: '07700 900123' },
  AU: { callingCode: '61', national: /^0?[2-478]\d{8}$/, example: '0412 345 678' },
  NZ: { callingCode: '64', national: /^0?[2-9]\d{7,9}$/, example: '021 123 4567' },
  AE: { callingCode: '971', national: /^0?5\d{8}$/, example: '050 123 4567' },
  SG: { callingCode: '65', national: /^[689]\d{7}$/, example: '8123 4567' },
  DE: { callingCode: '49', national: /^0?1[5-7]\d{8,9}$|^0?[2-9]\d{6,10}$/, example: '0151 23456789' },
  FR: { callingCode: '33', national: /^0?[1-9]\d{8}$/, example: '06 12 34 56 78' },
};

const FALLBACK = /^\d{6,14}$/;

export function callingCodeFor(countryCode: string | null | undefined): string | null {
  return COUNTRIES[(countryCode ?? '').toUpperCase()]?.callingCode ?? null;
}

/** "+91 98765-43210" → "9876543210" for an Indian shop. */
export function normaliseNationalPhone(raw: string, countryCode: string | null | undefined): string {
  let digits = raw.trim().replace(/[\s\-().]/g, '');
  const calling = callingCodeFor(countryCode);
  if (digits.startsWith('+')) {
    digits = digits.slice(1);
    if (calling && digits.startsWith(calling)) digits = digits.slice(calling.length);
  } else if (digits.startsWith('00') && calling && digits.startsWith(`00${calling}`)) {
    digits = digits.slice(2 + calling.length);
  }
  return digits;
}

export function isValidNationalPhone(national: string, countryCode: string | null | undefined): boolean {
  const rule = COUNTRIES[(countryCode ?? '').toUpperCase()];
  return (rule?.national ?? FALLBACK).test(national);
}

/** A zod phone field validated and normalised for the current shop's country. */
export function shopPhone(message?: string) {
  return z
    .string()
    .trim()
    .max(24)
    .transform((value) => normaliseNationalPhone(value, tenancy.currentOrNull()?.countryCode ?? 'IN'))
    .superRefine((value, ctx) => {
      const country = tenancy.currentOrNull()?.countryCode ?? 'IN';
      if (!isValidNationalPhone(value, country)) {
        const example = COUNTRIES[country]?.example;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: message ?? `Enter a valid mobile number${example ? `, such as ${example}` : ''}.`,
        });
      }
    });
}

/** E.164 without the plus, for messaging providers: 919876543210. */
export function toE164Digits(national: string, countryCode: string | null | undefined): string {
  const calling = callingCodeFor(countryCode) ?? '';
  const trimmed = national.replace(/^0+/, '');
  return `${calling}${trimmed}`;
}
