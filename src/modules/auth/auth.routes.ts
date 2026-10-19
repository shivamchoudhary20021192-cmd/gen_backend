import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticateIdentity } from '../../middleware/authenticate';
import { rateLimit } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { clientIp } from '../../middleware/requestContext';
import { accountsService } from './accounts.service';
import { authController } from './auth.controller';
import {
  changePasswordSchema,
  idParamSchema,
  loginSchema,
  mfaCodeSchema,
  mfaLoginSchema,
  passwordSchema,
  refreshSchema,
} from './auth.schemas';

export const authRoutes = Router();

const switchShopSchema = z.object({
  // A shop id, handle or domain — whatever the admin's switcher has to hand.
  shop: z.union([z.string().trim().min(1).max(253), z.number().int().positive()]).transform(String),
});

/**
 * Login is limited per email AND implicitly per IP (the default identifier),
 * because limiting only by IP lets a botnet spray one account, and limiting
 * only by email lets one IP spray every account.
 */
authRoutes.post(
  '/login',
  rateLimit({
    bucket: 'admin.login',
    max: 10,
    windowSeconds: 900,
    blockSeconds: 900,
    identify: (req) => String((req.body as { email?: string })?.email ?? '').toLowerCase() || 'unknown',
  }),
  rateLimit({ bucket: 'admin.login.ip', max: 30, windowSeconds: 900 }),
  validate({ body: loginSchema }),
  asyncHandler(authController.login),
);

/**
 * The second step of sign-in for people with two-step sign-in on. The real
 * brute-force guard is the account lockout (a wrong code counts as a failed
 * login); this limit stops one IP walking many accounts' challenges at once.
 */
authRoutes.post(
  '/login/mfa',
  rateLimit({ bucket: 'admin.login_mfa.ip', max: 30, windowSeconds: 900 }),
  validate({ body: mfaLoginSchema }),
  asyncHandler(authController.completeMfaLogin),
);

authRoutes.post(
  '/refresh',
  rateLimit({ bucket: 'admin.refresh', max: 60, windowSeconds: 900 }),
  validate({ body: refreshSchema }),
  asyncHandler(authController.refresh),
);

// Everything below is about the person and their session, so it works before
// they belong to any shop — a new merchant signs in to create their first one.
authRoutes.post('/logout', authenticateIdentity, asyncHandler(authController.logout));
authRoutes.get('/me', authenticateIdentity, asyncHandler(authController.me));
authRoutes.get('/shops', authenticateIdentity, asyncHandler(authController.shops));
authRoutes.post(
  '/switch-shop',
  authenticateIdentity,
  validate({ body: switchShopSchema }),
  asyncHandler(authController.switchShop),
);

authRoutes.post(
  '/change-password',
  authenticateIdentity,
  rateLimit({ bucket: 'admin.change_password', max: 5, windowSeconds: 900, identify: (req) => String(req.identity?.id ?? 'anon') }),
  validate({ body: changePasswordSchema }),
  asyncHandler(authController.changePassword),
);

// ── two-step sign-in, from the person's security settings ────────────────────
// Each change asks for a code (and turning on or off, the password), so these
// are limited per person rather than per IP.

const mfaLimit = rateLimit({
  bucket: 'admin.mfa_settings',
  max: 10,
  windowSeconds: 900,
  identify: (req) => String(req.identity?.id ?? 'anon'),
});

authRoutes.get('/mfa', authenticateIdentity, asyncHandler(authController.mfaStatus));
authRoutes.post(
  '/mfa/setup',
  authenticateIdentity,
  mfaLimit,
  validate({ body: z.object({ password: z.string().min(1, 'Password is required.').max(128) }) }),
  asyncHandler(authController.mfaSetup),
);
authRoutes.post(
  '/mfa/enable',
  authenticateIdentity,
  mfaLimit,
  validate({ body: z.object({ code: mfaCodeSchema }) }),
  asyncHandler(authController.mfaEnable),
);
authRoutes.post(
  '/mfa/disable',
  authenticateIdentity,
  mfaLimit,
  validate({ body: z.object({ password: z.string().min(1, 'Password is required.').max(128), code: mfaCodeSchema }) }),
  asyncHandler(authController.mfaDisable),
);
authRoutes.post(
  '/mfa/recovery-codes',
  authenticateIdentity,
  mfaLimit,
  validate({ body: z.object({ code: mfaCodeSchema }) }),
  asyncHandler(authController.mfaRecoveryCodes),
);

authRoutes.get('/sessions', authenticateIdentity, asyncHandler(authController.listSessions));
authRoutes.delete(
  '/sessions/:id',
  authenticateIdentity,
  validate({ params: idParamSchema }),
  asyncHandler(authController.revokeSession),
);

// ── without a password: forgot password, accept an invitation ────────────────
// Reached from an email link, before anyone is signed in. Limited per address
// and per IP, and "forgot" answers identically whether or not the account
// exists.

const requestMeta = (req: Request) => ({ ip: clientIp(req), userAgent: req.header('User-Agent')?.slice(0, 255) ?? null });
const token = z.string().trim().min(20).max(200);

authRoutes.post(
  '/password/forgot',
  rateLimit({
    bucket: 'admin.password_forgot',
    max: 3,
    windowSeconds: 3600,
    identify: (req) => String((req.body as { email?: string })?.email ?? '').toLowerCase() || 'unknown',
  }),
  rateLimit({ bucket: 'admin.password_forgot.ip', max: 20, windowSeconds: 3600 }),
  validate({ body: z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(191) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    await accountsService.requestPasswordReset((req.body as { email: string }).email, requestMeta(req));
    res.status(202).json({ sent: true, message: 'If that address has an account, a reset link is on its way.' });
  }),
);

authRoutes.post(
  '/password/reset',
  rateLimit({ bucket: 'admin.password_reset', max: 10, windowSeconds: 900 }),
  validate({ body: z.object({ token, password: passwordSchema }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { token: value, password } = req.body as { token: string; password: string };
    await accountsService.resetPassword(value, password, requestMeta(req));
    res.json({ reset: true });
  }),
);

authRoutes.get(
  '/invitations/:token',
  rateLimit({ bucket: 'admin.invitation', max: 30, windowSeconds: 900 }),
  validate({ params: z.object({ token }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await accountsService.describeInvitation(String(req.params.token)));
  }),
);

authRoutes.post(
  '/invitations/accept',
  rateLimit({ bucket: 'admin.invitation', max: 30, windowSeconds: 900 }),
  validate({
    body: z.object({
      token,
      password: passwordSchema.nullish(),
      first_name: z.string().trim().min(1).max(80).nullish(),
      last_name: z.string().trim().max(80).nullish(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await accountsService.acceptInvitation(req.body, requestMeta(req)));
  }),
);

