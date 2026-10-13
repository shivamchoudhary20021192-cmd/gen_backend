import { z } from 'zod';
import { tenancy } from '../tenancy/context';

/**
 * Postal codes, per country.
 *
 * The single-shop code accepted exactly `^\d{6}$` everywhere — an Indian PIN.
 * These patterns cover the countries shops are most likely to sell in; any
 * other country gets a permissive shape check (letters, digits, space, dash),
 * which is what a courier API will validate properly anyway. Where a country
 * has no postal codes at all (UAE, Hong Kong…), an empty value is accepted.
 */

const PATTERNS: Record<string, RegExp> = {
  IN: /^[1-9]\d{5}$/,
  US: /^\d{5}(-\d{4})?$/,
  CA: /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/,
  GB: /^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$/,
  AU: /^\d{4}$/,
  NZ: /^\d{4}$/,
  DE: /^\d{5}$/,
  FR: /^\d{5}$/,
  IT: /^\d{5}$/,
  ES: /^\d{5}$/,
  NL: /^\d{4}\s?[A-Za-z]{2}$/,
  BE: /^\d{4}$/,
  IE: /^[A-Za-z]\d[\dWw]\s?[A-Za-z\d]{4}$/,
  SE: /^\d{3}\s?\d{2}$/,
  PL: /^\d{2}-\d{3}$/,
  PT: /^\d{4}-\d{3}$/,
  BR: /^\d{5}-?\d{3}$/,
  MX: /^\d{5}$/,
  JP: /^\d{3}-?\d{4}$/,
  SG: /^\d{6}$/,
  MY: /^\d{5}$/,
  ID: /^\d{5}$/,
  PH: /^\d{4}$/,
  ZA: /^\d{4}$/,
  NG: /^\d{6}$/,
  KE: /^\d{5}$/,
  SA: /^\d{5}(-\d{4})?$/,
  PK: /^\d{5}$/,
  BD: /^\d{4}$/,
  LK: /^\d{5}$/,
  NP: /^\d{5}$/,
};

/** Countries whose addresses have no postal code. */
const NO_POSTAL_CODE = new Set(['AE', 'HK', 'QA', 'IE_OPTIONAL', 'BS', 'AG', 'BZ', 'FJ', 'GH', 'JM']);

const GENERIC = /^[A-Za-z0-9][A-Za-z0-9 -]{1,14}$/;

export function normalisePostalCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

export function isValidPostalCode(value: string, countryCode: string | null | undefined): boolean {
  const country = (countryCode ?? '').toUpperCase();
  const code = normalisePostalCode(value);
  if (code === '') return NO_POSTAL_CODE.has(country);
  return (PATTERNS[country] ?? GENERIC).test(code);
}

export function postalCodeLabel(countryCode: string | null | undefined): string {
  switch ((countryCode ?? '').toUpperCase()) {
    case 'IN':
      return 'PIN code';
    case 'US':
      return 'ZIP code';
    case 'GB':
    case 'CA':
    case 'AU':
      return 'Postcode';
    default:
      return 'Postal code';
  }
}

/**
 * A zod string validated against the current shop's country.
 *
 * For fields that carry no country of their own — a serviceability check, a
 * warehouse address in the shop's own country. Schemas with a `country` field
 * should validate with `isValidPostalCode(value, country)` in a refinement.
 */
export function shopPostalCode() {
  return z
    .string()
    .trim()
    .max(16)
    .transform(normalisePostalCode)
    .superRefine((value, ctx) => {
      const country = tenancy.currentOrNull()?.countryCode ?? 'IN';
      if (!isValidPostalCode(value, country)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Enter a valid ${postalCodeLabel(country)}.` });
      }
    });
}

/** The current shop's country, for fields that default to it. */
export function shopCountry(): string {
  return tenancy.currentOrNull()?.countryCode ?? 'IN';
}

/** ISO 3166-1 alpha-2, upper-cased, defaulting to the shop's own country. */
export function countryCode() {
  return z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code, such as IN or US.')
    .optional()
    .transform((value) => (value ?? shopCountry()).toUpperCase());
}

/** A subdivision code: GJ, CA, NSW, ENG. */
export function regionCode() {
  return z.string().trim().min(1).max(10).transform((value) => value.toUpperCase());
}
