import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { clientIp } from '../../middleware/requestContext';
import { validate } from '../../middleware/validate';
import { storefrontService } from './storefront.service';
import { cartsService } from '../carts/carts.service';
import { reviewsService } from '../reviews/reviews.service';
import {
  eligibilityQuerySchema,
  productSlugParamSchema,
  publicListQuerySchema,
  submitReviewSchema,
} from '../reviews/reviews.schemas';
import { isValidPostalCode, normalisePostalCode, postalCodeLabel, regionCode, shopCountry } from '../../platform/geo/postalCodes';
import { isValidNationalPhone, normaliseNationalPhone, shopPhone } from '../../platform/geo/phone';

/**
 * The public storefront API.
 *
 * Unauthenticated by design — anyone can browse and build a bag without an
 * account, which is how a first-time visitor actually behaves. That makes rate
 * limiting the only thing standing between this and a scraper, so the write
 * paths are limited per IP and checkout is idempotency-keyed.
 */

const cartTokenSchema = z.object({ token: z.string().uuid('That bag link is not valid.') });

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(48).optional(),
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(140).optional(),
  collection: z.string().trim().max(140).optional(),
  concern: z.string().trim().max(140).optional(),
  skin_type: z.string().trim().max(140).optional(),
  min_price: z.coerce.number().min(0).optional(),
  max_price: z.coerce.number().min(0).optional(),
  in_stock: z.coerce.boolean().optional(),
  sort: z.enum(['featured', 'newest', 'oldest', 'price_asc', 'price_desc', 'rating', 'name', 'name_desc', 'best_selling']).optional(),
});

const shippingMethodSchema = z.enum(['standard', 'express', 'pickup']);

const checkoutSchema = z.object({
  payment_method: z.enum(['cod', 'online']),
  // The delivery option the shopper picked from the bag's `delivery.options`;
  // omitted, the standard option (or the only one offered) is used.
  shipping_method: shippingMethodSchema.nullish(),
  // A code typed on the checkout page without going through the bag first.
  discount_code: z.string().trim().min(1).max(60).nullish(),
  contact: z.object({
    first_name: z.string().trim().min(1, 'Tell us your name.').max(80),
    last_name: z.string().trim().max(80).nullish(),
    // Checked for the delivery country below: an Indian mobile is ten digits
    // starting 6–9, a US one is ten digits, a UK one starts 07…
    phone: z.string().trim().min(4).max(24),
    email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(191).nullish(),
  }),
  shipping_address: z.object({
    line1: z.string().trim().min(4, 'Add a house or flat number and street.').max(255),
    line2: z.string().trim().max(255).nullish(),
    landmark: z.string().trim().max(120).nullish(),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().min(2).max(80),
    state_code: regionCode().nullish(),
    // Omitted: the store's own country (or the bag's, if it was set).
    country: z.string().trim().length(2).transform((value) => value.toUpperCase()).nullish(),
    pincode: z.string().trim().max(16),
  }),
  customer_note: z.string().trim().max(500).nullish(),
  // "Email me with news and offers": needs an email to mean anything.
  accepts_marketing: z.boolean().optional(),
})
  // Phone and postcode are only meaningful for a country; the address says which.
  .superRefine((body, ctx) => {
    const country = body.shipping_address.country ?? shopCountry();
    if (!isValidPostalCode(body.shipping_address.pincode, country)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shipping_address', 'pincode'], message: `Enter a valid ${postalCodeLabel(country)}.` });
    }
    if (!isValidNationalPhone(normaliseNationalPhone(body.contact.phone, country), country)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contact', 'phone'], message: 'Enter a valid mobile number for the delivery country.' });
    }
  })
  .transform((body) => {
    const country = body.shipping_address.country ?? null;
    const phoneCountry = country ?? shopCountry();
    return {
      ...body,
      contact: { ...body.contact, phone: normaliseNationalPhone(body.contact.phone, phoneCountry) },
      shipping_address: { ...body.shipping_address, country, pincode: normalisePostalCode(body.shipping_address.pincode) },
    };
  });

/** Generous enough for real browsing, tight enough to make scraping tedious. */
const browseLimit = rateLimit({ bucket: 'shop.browse', max: 300, windowSeconds: 60 });
const writeLimit = rateLimit({ bucket: 'shop.cart', max: 60, windowSeconds: 60 });
const checkoutLimit = rateLimit({ bucket: 'shop.checkout', max: 10, windowSeconds: 300, blockSeconds: 300 });
/** Codes (discounts and gift cards) tried on a bag: generous for typos, hopeless for guessing. */
const codeLimit = rateLimit({ bucket: 'shop.code', max: 20, windowSeconds: 600, blockSeconds: 900 });
/** A review is a one-per-purchase act; a burst from one address is abuse. */
const reviewLimit = rateLimit({ bucket: 'shop.review', max: 5, windowSeconds: 600, blockSeconds: 600 });
/**
 * Order numbers run in sequence, so this lookup is guessable by design and the
 * phone number is what stops it. At the browse allowance a script could walk
 * every order number against one known phone in a few minutes; at this one it
 * cannot. A shopper checking on a parcel never comes close to the ceiling.
 */
const trackLimit = rateLimit({ bucket: 'shop.track', max: 20, windowSeconds: 300, blockSeconds: 900 });

export const storefrontRoutes = Router();

// ── catalogue ────────────────────────────────────────────────────────────────
storefrontRoutes.get(
  '/navigation',
  browseLimit,
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await storefrontService.navigation());
  }),
);

storefrontRoutes.get(
  '/products',
  browseLimit,
  validate({ query: listQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await storefrontService.listProducts(req.query as Record<string, unknown>));
  }),
);

storefrontRoutes.get(
  '/products/:slug',
  browseLimit,
  validate({ params: z.object({ slug: z.string().trim().min(1).max(191) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    res.status(200).json(await storefrontService.getProduct(slug));
  }),
);

// ── cart ─────────────────────────────────────────────────────────────────────
storefrontRoutes.post(
  '/cart',
  writeLimit,
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(201).json(await storefrontService.createCart());
  }),
);

storefrontRoutes.get(
  '/cart/:token',
  browseLimit,
  validate({
    params: cartTokenSchema,
    // Totals for a choice not yet made: the delivery option or payment method
    // being hovered over on the checkout page.
    query: z.object({
      shipping_method: shippingMethodSchema.optional(),
      payment_method: z.enum(['cod', 'online']).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    const { shipping_method, payment_method } = req.query as { shipping_method?: 'standard' | 'express' | 'pickup'; payment_method?: 'cod' | 'online' };
    res.status(200).json(await storefrontService.getCart(token, { shippingMethod: shipping_method, paymentMethod: payment_method }));
  }),
);

/** Applies a discount code — or a gift card — to the bag. Unknown codes are a 422 with the reason. */
storefrontRoutes.post(
  '/cart/:token/discount',
  writeLimit,
  codeLimit,
  validate({ params: cartTokenSchema, body: z.object({ code: z.string().trim().min(1, 'Enter a code.').max(60) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    res.status(200).json(await storefrontService.applyDiscountCode(token, (req.body as { code: string }).code));
  }),
);

storefrontRoutes.delete(
  '/cart/:token/discount',
  writeLimit,
  validate({ params: cartTokenSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    res.status(200).json(await storefrontService.removeDiscountCode(token));
  }),
);

/** Takes a gift card back off the bag. */
storefrontRoutes.delete(
  '/cart/:token/gift-cards/:giftCardId',
  writeLimit,
  validate({ params: cartTokenSchema.extend({ giftCardId: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token, giftCardId } = req.params as unknown as { token: string; giftCardId: number };
    res.status(200).json(await storefrontService.removeGiftCard(token, Number(giftCardId)));
  }),
);

/** The shopper's country: the bag is priced in its market's currency from now on. */
storefrontRoutes.put(
  '/cart/:token/market',
  writeLimit,
  validate({ params: cartTokenSchema, body: z.object({ country: z.string().trim().length(2, 'Use a two-letter country code.') }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    res.status(200).json(await storefrontService.setMarket(token, (req.body as { country: string }).country.toUpperCase()));
  }),
);

/** Where the bag is going, so delivery options, prices, COD and tax are the real ones. */
storefrontRoutes.put(
  '/cart/:token/delivery',
  writeLimit,
  validate({
    params: cartTokenSchema,
    body: z.object({
      // Checked against the bag's country, which may not be the store's.
      pincode: z.string().trim().max(16).nullable(),
      // Name or code ("California" or "CA"): decides the tax where it follows the address.
      state: z.string().trim().min(2).max(80).nullish(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    const { pincode, state } = req.body as { pincode: string | null; state?: string | null };
    res.status(200).json(await storefrontService.setDelivery(token, pincode, state ?? null));
  }),
);

storefrontRoutes.post(
  '/cart/:token/items',
  writeLimit,
  validate({
    params: cartTokenSchema,
    body: z.object({
      variant_id: z.coerce.number().int().positive(),
      quantity: z.coerce.number().int().positive().max(20).default(1),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    const { variant_id, quantity } = req.body as { variant_id: number; quantity: number };
    res.status(200).json(await storefrontService.addItem(token, variant_id, quantity));
  }),
);

storefrontRoutes.patch(
  '/cart/:token/items/:itemId',
  writeLimit,
  validate({
    params: z.object({
      token: z.string().uuid(),
      itemId: z.coerce.number().int().positive(),
    }),
    // Zero is allowed and means "remove", so the stepper's minus button has one
    // code path all the way down to one.
    body: z.object({ quantity: z.coerce.number().int().min(0).max(20) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token, itemId } = req.params as unknown as { token: string; itemId: number };
    const { quantity } = req.body as { quantity: number };
    res.status(200).json(await storefrontService.updateItem(token, itemId, quantity));
  }),
);

storefrontRoutes.delete(
  '/cart/:token/items/:itemId',
  writeLimit,
  validate({
    params: z.object({ token: z.string().uuid(), itemId: z.coerce.number().int().positive() }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token, itemId } = req.params as unknown as { token: string; itemId: number };
    res.status(200).json(await storefrontService.removeItem(token, itemId));
  }),
);

// ── checkout ─────────────────────────────────────────────────────────────────
storefrontRoutes.post(
  '/cart/:token/checkout',
  checkoutLimit,
  idempotency,
  validate({ params: cartTokenSchema, body: checkoutSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    res.status(201).json(
      await storefrontService.checkout(token, req.body, {
        ip: clientIp(req),
        userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
      }),
    );
  }),
);

storefrontRoutes.get(
  '/orders/:orderNumber',
  trackLimit,
  validate({
    params: z.object({ orderNumber: z.string().trim().max(20) }),
    // The order number alone is guessable, so the phone on the order is the
    // second factor for looking one up without an account.
    query: z.object({ phone: shopPhone() }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { orderNumber } = req.params as { orderNumber: string };
    const { phone } = req.query as unknown as { phone: string };
    res.status(200).json(await storefrontService.trackOrder(orderNumber, phone));
  }),
);

/**
 * Redeems a cart-recovery link.
 *
 * Public and rate-limited, and it deliberately returns nothing but the cart
 * token: whoever holds the link gets the bag back, which is the point, and
 * learns nothing about the person it belonged to. Guessing a UUID at the browse
 * rate limit is not a realistic attack, and the prize is a shopping cart.
 */
storefrontRoutes.get(
  '/cart/recover/:token',
  browseLimit,
  validate({ params: z.object({ token: z.string().uuid() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params as { token: string };
    res.status(200).json(await cartsService.redeemRecoveryToken(token));
  }),
);

// ── reviews ─────────────────────────────────────────────────────────────────
// Reading is browsing; writing is a claim about a purchase, so it is limited
// like a cart write and checked against a real delivered order before it is
// accepted. Nothing written here is visible until a moderator approves it.

storefrontRoutes.get(
  '/products/:slug/reviews',
  browseLimit,
  validate({ params: productSlugParamSchema, query: publicListQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    res.status(200).json(await reviewsService.publicList(slug, req.query as Record<string, unknown>));
  }),
);

/**
 * "May I review this?" — asked before the form is shown.
 *
 * Deliberately not a silent yes/no: the answer distinguishes an order we cannot
 * find from one that has not arrived yet from one already reviewed, because
 * those send the shopper to three different places.
 */
storefrontRoutes.get(
  '/products/:slug/reviews/eligibility',
  writeLimit,
  validate({ params: productSlugParamSchema, query: eligibilityQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    const { order_number, phone } = req.query as unknown as { order_number: string; phone: string };
    res.status(200).json(await reviewsService.checkEligibility(slug, order_number, phone));
  }),
);

storefrontRoutes.post(
  '/products/:slug/reviews',
  reviewLimit,
  idempotency,
  validate({ params: productSlugParamSchema, body: submitReviewSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    res.status(201).json(await reviewsService.submit(slug, req.body, { ip: clientIp(req) }));
  }),
);
