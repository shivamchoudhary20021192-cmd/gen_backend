import crypto from 'node:crypto';

/**
 * Webhook signatures, the way Shopify signs them: base64 HMAC-SHA256 of the
 * exact body bytes, keyed with the app's client secret (or the subscription's
 * own secret for ones staff created). Receivers verify before trusting a byte.
 *
 * The receiving side, in any language:
 *
 *   expected = base64(hmac_sha256(secret, raw_body))
 *   valid    = constant_time_equals(expected, header["X-Veylog-Hmac-Sha256"])
 */
export function signWebhook(body: string | Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('base64');
}

export function verifyWebhookSignature(body: string | Buffer, secret: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(signWebhook(body, secret));
  const presented = Buffer.from(header.trim());
  return expected.length === presented.length && crypto.timingSafeEqual(expected, presented);
}

/** A fresh per-subscription signing secret, for subscriptions staff create. */
export function newSigningSecret(): string {
  return `whsec_${crypto.randomBytes(24).toString('hex')}`;
}
