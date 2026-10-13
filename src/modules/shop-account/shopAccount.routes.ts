import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { clientIp } from '../../middleware/requestContext';
import { requireCustomer, withCustomer } from '../../middleware/authenticateCustomer';
import { validate } from '../../middleware/validate';
import { shopAccountService } from './shopAccount.service';
import { shopAuthService } from '../shop-auth/shopAuth.service';
import { shopPhone } from '../../platform/geo/phone';

/**
 * The signed-in shopper's own routes: signing in, what they saved, what they
 * looked at, and whether they want to hear from us.
 *
 * Mounted under /api/v1/account. Everything that changes something requires a
 * customer token; the two sign-in routes are public by necessity and carry
 * their own throttles.
 */
export const shopAccountRoutes = Router();

const phone = shopPhone();

/**
 * Deliberately tight.
 *
 * Every request here can send a message to a real phone, which costs money and
 * reaches someone who may not have asked for it. The per-number and per-address
 * throttles in the service are the real control; this stops the cheap flood
 * before it reaches the database.
 */
const otpLimit = rateLimit({ bucket: 'shop.otp', max: 10, windowSeconds: 600, blockSeconds: 900 });
const verifyLimit = rateLimit({ bucket: 'shop.otp.verify', max: 30, windowSeconds: 600, blockSeconds: 900 });
const accountLimit = rateLimit({ bucket: 'shop.account', max: 120, windowSeconds: 60 });

// ── signing in ───────────────────────────────────────────────────────────────

shopAccountRoutes.post(
  '/otp',
  otpLimit,
  validate({
    body: z.object({
      phone,
      // WhatsApp is the better channel in India, but it only works if the
      // number is on WhatsApp — so SMS stays selectable.
      channel: z.enum(['sms', 'whatsapp']).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { phone: string; channel?: 'sms' | 'whatsapp' };
    res.status(200).json(
      await shopAuthService.requestOtp(
        { phone: body.phone, channel: body.channel ?? 'sms' },
        { ip: clientIp(req), userAgent: req.header('User-Agent')?.slice(0, 255) ?? null },
      ),
    );
  }),
);

shopAccountRoutes.post(
  '/otp/verify',
  verifyLimit,
  validate({
    body: z.object({
      request_id: z.string().trim().uuid(),
      code: z.string().trim().regex(/^\d{4,8}$/, 'Enter the code from the message.'),
      /** The browser's cart token, so a guest's history follows them in. */
      session_token: z.string().trim().uuid().optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { request_id: string; code: string; session_token?: string };
    res.status(200).json(
      await shopAuthService.verifyOtp(body, {
        ip: clientIp(req),
        userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
      }),
    );
  }),
);

shopAccountRoutes.post(
  '/refresh',
  accountLimit,
  validate({ body: z.object({ refresh_token: z.string().trim().min(32).max(200) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { refresh_token: token } = req.body as { refresh_token: string };
    res.status(200).json(
      await shopAuthService.refresh(token, {
        ip: clientIp(req),
        userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
      }),
    );
  }),
);

shopAccountRoutes.post(
  '/logout',
  accountLimit,
  requireCustomer,
  asyncHandler(async (req: Request, res: Response) => {
    await shopAuthService.logout(req.customer!.sessionId);
    res.status(200).json({ signed_out: true });
  }),
);

shopAccountRoutes.get(
  '/me',
  accountLimit,
  requireCustomer,
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await shopAuthService.me(req.customer!.id));
  }),
);

// ── the opt-in ───────────────────────────────────────────────────────────────

shopAccountRoutes.put(
  '/marketing/whatsapp',
  accountLimit,
  requireCustomer,
  validate({ body: z.object({ granted: z.boolean() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { granted } = req.body as { granted: boolean };
    res.status(200).json(
      await shopAuthService.setWhatsappMarketing(req.customer!.id, granted, {
        ip: clientIp(req),
        userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
        source: 'preference_center',
      }),
    );
  }),
);

// ── saved products ───────────────────────────────────────────────────────────

shopAccountRoutes.get(
  '/saved',
  accountLimit,
  requireCustomer,
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await shopAccountService.listSaved(req.customer!.id));
  }),
);

shopAccountRoutes.get(
  '/saved/ids',
  accountLimit,
  requireCustomer,
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await shopAccountService.savedIds(req.customer!.id));
  }),
);

shopAccountRoutes.put(
  '/saved/:slug',
  accountLimit,
  requireCustomer,
  validate({
    params: z.object({ slug: z.string().trim().min(1).max(200) }),
    body: z.object({ variant_id: z.number().int().positive().nullish() }).optional(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as { variant_id?: number | null };
    res.status(200).json(await shopAccountService.save(req.customer!.id, slug, body.variant_id ?? null));
  }),
);

shopAccountRoutes.delete(
  '/saved/:slug',
  accountLimit,
  requireCustomer,
  validate({ params: z.object({ slug: z.string().trim().min(1).max(200) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    res.status(200).json(await shopAccountService.unsave(req.customer!.id, slug));
  }),
);

// ── browsing ─────────────────────────────────────────────────────────────────

/**
 * Records a product view.
 *
 * `withCustomer` rather than `requireCustomer`: most views are by people who
 * have not signed in, and those are exactly the ones worth keeping — they are
 * what turns into "you looked at this" once someone does.
 *
 * Answers 202 and never fails the caller. A page must not break because
 * analytics did.
 */
shopAccountRoutes.post(
  '/views/:slug',
  rateLimit({ bucket: 'shop.view', max: 300, windowSeconds: 60 }),
  withCustomer,
  validate({
    params: z.object({ slug: z.string().trim().min(1).max(200) }),
    body: z
      .object({
        session_token: z.string().trim().uuid().nullish(),
        source: z.string().trim().max(60).optional(),
      })
      .optional(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { slug } = req.params as { slug: string };
    const body = (req.body ?? {}) as { session_token?: string | null; source?: string };
    await shopAccountService
      .recordView({
        slug,
        customerId: req.customer?.id ?? null,
        sessionToken: body.session_token ?? null,
        source: body.source ?? 'product_page',
      })
      .catch(() => undefined);
    res.status(202).json({ recorded: true });
  }),
);
