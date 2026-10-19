import crypto from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238) over HMAC-SHA1 (RFC 4226), the
 * flavour every authenticator app speaks: Google Authenticator, 1Password,
 * Authy, Microsoft Authenticator.
 *
 * Pure functions, no I/O. Replay protection and lockout live in the auth
 * service; this file only answers "which 30-second step does this code belong
 * to, if any".
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Accepts what people paste: lower case, spaces, and `=` padding are ignored. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Secret is not valid base32.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpStep(timeMs: number): number {
  return Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS);
}

/** The code for one step. `digits` is 6 for apps; 8 exists for the RFC vectors. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function totp(secretBase32: string, timeMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretBase32), totpStep(timeMs), digits);
}

/**
 * The step a code matches, or null. One step either side is accepted, so a
 * phone whose clock is up to 30 seconds off — or a person who typed the code
 * just as it rolled over — still gets in. Every candidate is compared in
 * constant time, and all of them are checked, so timing says nothing about
 * which window (if any) matched.
 */
export function matchTotp(secretBase32: string, code: string, timeMs: number, window = 1): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(timeMs);
  let matched: number | null = null;
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    const expected = Buffer.from(hotp(secret, step));
    if (crypto.timingSafeEqual(expected, Buffer.from(digits)) && matched === null) matched = step;
  }
  return matched;
}

/**
 * The URI an authenticator app reads from a QR code. Issuer appears both as
 * the label prefix and the parameter, because older apps read only one of them.
 */
export function otpauthUrl(issuer: string, account: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes: ten of them, about 50 bits each, shown once. Grouped 5-5 so
 * they can be read over a phone; the alphabet drops 0/O/1/I/L so they can be
 * written down without ambiguity.
 */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let raw = '';
    for (let c = 0; c < 10; c += 1) raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

/** What a typed recovery code is normalised to before it is hashed. */
export function normaliseRecoveryCode(input: string): string | null {
  const clean = input.toLowerCase().replace(/[\s-]/g, '');
  if (!/^[a-z0-9]{10}$/.test(clean)) return null;
  return `${clean.slice(0, 5)}-${clean.slice(5)}`;
}
