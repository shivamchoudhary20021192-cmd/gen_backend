import crypto from 'node:crypto';

/**
 * Razorpay's two signatures, as pure functions.
 *
 * Nothing here touches the database, the network or the clock, which is the
 * point: signature verification is the single control standing between "a
 * browser said this was paid" and "this order is paid", so it has to be
 * testable against known vectors rather than only in an end-to-end run against
 * a sandbox nobody can reach from CI.
 *
 * Both comparisons are timing-safe. The window is small and the attacker would
 * need a great many samples, but a constant-time compare costs nothing and an
 * early-exit `===` on a MAC is the kind of thing that gets found in an audit.
 */

function hmacHex(payload: string | Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function timingSafeHexEqual(a: string, b: string): boolean {
  // Lengths differ only when the other side is malformed; comparing buffers of
  // different length throws, so this is checked first and leaks only the length.
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The signature Razorpay Checkout hands back to the browser after a payment.
 *
 * `HMAC_SHA256(razorpay_order_id + "|" + razorpay_payment_id, key_secret)`.
 * Signed with the **key secret**, not the webhook secret — they are different
 * secrets and mixing them up produces a verification that always fails.
 */
export function checkoutSignature(razorpayOrderId: string, razorpayPaymentId: string, keySecret: string): string {
  return hmacHex(`${razorpayOrderId}|${razorpayPaymentId}`, keySecret);
}

export function verifyCheckoutSignature(
  input: { razorpayOrderId: string; razorpayPaymentId: string; signature: string },
  keySecret: string,
): boolean {
  if (!keySecret || !input.signature) return false;
  return timingSafeHexEqual(
    checkoutSignature(input.razorpayOrderId, input.razorpayPaymentId, keySecret),
    input.signature.trim(),
  );
}

/**
 * The signature on the `X-Razorpay-Signature` header of a webhook.
 *
 * `HMAC_SHA256(raw_request_body, webhook_secret)` — over the **exact bytes**
 * that arrived. Re-serialising the parsed JSON changes key order, whitespace
 * and number formatting, so a webhook verified against `JSON.stringify(req.body)`
 * fails intermittently and in ways that look like Razorpay's fault.
 */
export function webhookSignature(rawBody: Buffer | string, webhookSecret: string): string {
  return hmacHex(rawBody, webhookSecret);
}

export function verifyWebhookSignature(
  rawBody: Buffer | string | undefined,
  header: string | undefined,
  webhookSecret: string,
): boolean {
  if (!webhookSecret || !header || rawBody === undefined) return false;
  return timingSafeHexEqual(webhookSignature(rawBody, webhookSecret), header.trim());
}

/**
 * Rupees to paise, as an integer.
 *
 * Razorpay works entirely in the minor unit and rejects a fractional one. The
 * rounding matters: `12.1 * 100` is `1209.9999999999998` in IEEE 754, and
 * truncating that bills the customer a paisa short of the order, which then
 * fails the amount check on the way back in.
 */
export function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function fromPaise(paise: number): number {
  return Math.round(paise) / 100;
}
