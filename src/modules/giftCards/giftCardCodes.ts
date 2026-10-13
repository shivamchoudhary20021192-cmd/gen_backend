import { createHash, randomBytes, randomInt } from 'node:crypto';

/**
 * Gift card codes: what they look like, and how they are found without being
 * stored.
 *
 * A generated code is 16 characters from an alphabet with nothing to misread
 * (no 0/O, 1/I/L): 31 symbols, so about 79 random bits — unguessable, even
 * before the storefront's rate limits. Shown in groups of four (ABCD EFGH JKLM NPQR);
 * typed any way (lower case, spaces, dashes). Merchants may choose their own
 * (8–20 letters and digits), as on Shopify.
 *
 * The database keeps a SHA-256 of the shop and the normalised code to find a
 * card at checkout, the vault's sealed copy for the customer's gift card page,
 * and the last four characters for staff — never the code itself.
 */

/** Letters and digits nobody misreads: no I, L, O, 0 or 1. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const GENERATED_LENGTH = 16;

export function generateCode(): string {
  let code = '';
  for (let index = 0; index < GENERATED_LENGTH; index += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** What a shopper typed, as stored: upper case, letters and digits only. */
export function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidCode(normalised: string): boolean {
  return /^[A-Z0-9]{8,20}$/.test(normalised);
}

/** ABCD EFGH JKLM NPQR — how a code is printed and emailed. */
export function formatCode(normalised: string): string {
  return normalised.replace(/(.{4})(?=.)/g, '$1 ');
}

export function lastCharacters(normalised: string): string {
  return normalised.slice(-4);
}

/** •••• •••• •••• NPQR — how staff and receipts show a card. */
export function maskedCode(last: string): string {
  return `•••• •••• •••• ${last}`;
}

/** The lookup key: the shop is part of it, so the same code in two shops never collides. */
export function codeHash(shopId: number, normalised: string): string {
  return createHash('sha256').update(`gift_card:${shopId}:${normalised}`).digest('hex');
}

/** The customer's page address: random, unrelated to the code. */
export function lookupToken(): string {
  return randomBytes(16).toString('hex');
}
