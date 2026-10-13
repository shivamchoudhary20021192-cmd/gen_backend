import crypto from 'node:crypto';
import { env } from '../config/env';

/**
 * Tokens are stored only as SHA-256 hashes, peppered with a server-side secret.
 * A database dump therefore does not yield usable session or refresh tokens,
 * and rotating TOKEN_PEPPER invalidates every session at once.
 *
 * SHA-256 (not bcrypt) is correct here: these are 32–48 bytes of real entropy,
 * so there is nothing to brute-force, and the check runs on every request.
 */
export function hashToken(token: string): string {
  return crypto.createHmac('sha256', env.auth.tokenPepper).update(token).digest('hex');
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(buffer: Buffer | string): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** Timing-safe compare for opaque tokens of equal length. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
