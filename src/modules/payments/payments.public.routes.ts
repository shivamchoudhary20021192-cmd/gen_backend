import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { logger } from '../../core/logger';
import { rateLimit } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { onlinePaymentsService } from './onlinePayments.service';
import { shopPhone } from '../../platform/geo/phone';

/**
 * The public face of payments: the calls a shopper's browser makes, and the
 * legacy Razorpay webhook. Gateways connected as integrations send their
 * webhooks to /integrations/inbound/… instead.
 *
 * Nothing here is authenticated, so every route states what stands in for
 * authentication. For the two shopper routes it is the order number plus the
 * phone the order was placed with — the same pair the tracking page uses. For
 * the webhook it is the HMAC signature over the raw body, checked in the
 * service before a single field of the payload is believed.
 */
export const publicPaymentsRoutes = Router();

/** The phone the order was placed with, normalised the way checkout stored it. */
const phone = shopPhone('Enter the mobile number from the order.');

const orderNumberParam = z.object({ orderNumber: z.string().trim().min(3).max(40) });

/**
 * Tighter than browsing, looser than checkout.
 *
 * Starting a payment mints a gateway order, so a loose limit here is a way to
 * fill someone's Razorpay dashboard with junk. Reloading a payment page a few
 * times is normal and stays well inside this.
 */
const startLimit = rateLimit({ bucket: 'shop.pay', max: 15, windowSeconds: 300, blockSeconds: 600 });

/**
 * Verification is deliberately more permissive than starting one.
 *
 * A shopper whose network dropped mid-verification will retry, and blocking
 * that leaves money taken against an order that still reads unpaid. The
 * signature check is what protects this route; the limit is only there to stop
 * someone grinding signatures.
 */
const verifyLimit = rateLimit({ bucket: 'shop.pay.verify', max: 30, windowSeconds: 300, blockSeconds: 600 });

/** Is online payment even on? Cheap, read-only, no order involved. */
publicPaymentsRoutes.get(
  '/availability',
  rateLimit({ bucket: 'shop.browse', max: 300, windowSeconds: 60 }),
  asyncHandler(async (_req: Request, res: Response) => {
    const availability = await onlinePaymentsService.availability();
    res.status(200).json({
      online_enabled: availability.online_enabled,
      // Which gateway's UI the storefront should load: razorpay, stripe, paypal.
      provider: availability.provider,
      test_mode: availability.test_mode,
    });
  }),
);

publicPaymentsRoutes.post(
  '/orders/:orderNumber/start',
  startLimit,
  validate({ params: orderNumberParam, body: z.object({ phone }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { orderNumber } = req.params as { orderNumber: string };
    const { phone: contactPhone } = req.body as { phone: string };
    res.status(200).json(await onlinePaymentsService.startPayment(orderNumber, contactPhone));
  }),
);

publicPaymentsRoutes.post(
  '/orders/:orderNumber/verify',
  verifyLimit,
  validate({
    params: orderNumberParam,
    // Each gateway sends back its own fields; the adapter reads what it needs
    // and proves it. Only short opaque strings are accepted.
    body: z
      .object({
        phone,
        gateway_order_id: z.string().trim().min(4).max(120).optional(),
        // Razorpay Checkout
        razorpay_order_id: z.string().trim().min(4).max(80).optional(),
        razorpay_payment_id: z.string().trim().min(4).max(80).optional(),
        razorpay_signature: z.string().trim().min(16).max(255).optional(),
        // Stripe Payment Element
        payment_intent: z.string().trim().min(4).max(120).optional(),
        // PayPal Buttons
        paypal_order_id: z.string().trim().min(4).max(120).optional(),
      })
      .refine(
        (value) => Boolean(value.gateway_order_id ?? value.razorpay_order_id ?? value.payment_intent ?? value.paypal_order_id),
        'The payment reference is missing.',
      ),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { orderNumber } = req.params as { orderNumber: string };
    const { phone: contactPhone, ...confirmation } = req.body as Record<string, string>;
    res.status(200).json(await onlinePaymentsService.verifyCheckout(orderNumber, contactPhone, confirmation));
  }),
);

/**
 * Razorpay's webhook.
 *
 * No `validate()` and no body schema on purpose: the signature is computed over
 * the bytes exactly as they arrived, so anything that reshapes the body before
 * verification breaks it. `req.rawBody` is stashed by the JSON parser in
 * `app.ts` for this path alone.
 *
 * Answers 200 to a replay. Razorpay retries an event until it gets a 2xx, and a
 * duplicate is the expected case rather than an error.
 */
publicPaymentsRoutes.post(
  '/razorpay/webhook',
  // Generous: Razorpay bursts retries, and throttling a webhook means losing
  // payment confirmations. The signature is the control here, not the limit.
  rateLimit({ bucket: 'payments.webhook', max: 600, windowSeconds: 60 }),
  asyncHandler(async (req: Request, res: Response) => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const signature = req.header('X-Razorpay-Signature') ?? undefined;

    if (!raw) {
      // Means the body never reached the raw-capture path — a mounting mistake,
      // not a caller mistake, and it must be loud rather than a silent 401.
      logger.error('payments.webhook_raw_body_missing', { path: req.originalUrl });
    }

    const result = await onlinePaymentsService.handleLegacyRazorpayWebhook(raw, signature);
    res.status(200).json(result);
  }),
);
