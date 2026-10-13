import { screenshotFile } from '../themes/screenshots';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../core/ApiError';
import { asyncHandler } from '../../core/asyncHandler';
import { passwordSchema } from '../../modules/auth/auth.schemas';
import { authenticate, authenticateIdentity } from '../../middleware/authenticate';
import { rateLimit } from '../../middleware/rateLimit';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission, requireStaff } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { SUPPORTED_REGION_COUNTRIES } from './blueprints/regions';
import { VERTICAL_KEYS } from './blueprints/verticals';
import { shopsService } from './shops.service';
import { billingService } from '../billing/billing.service';
import { brandService, SOCIAL_PLATFORMS } from './brand';
import { signupService } from './signup.service';
import { themesService } from '../themes/themes.service';

function actor(req: Request) {
  return { id: req.admin?.id ?? req.identity?.id ?? null, label: req.admin?.email ?? req.identity?.email ?? null };
}

function meta(req: Request) {
  return { ip: clientIp(req), userAgent: req.header('User-Agent') ?? null, requestId: req.requestId };
}

const shopBody = z.object({
  name: z.string().trim().min(2).max(160),
  handle: z.string().trim().toLowerCase().max(60).nullish(),
  vertical: z.enum(VERTICAL_KEYS as [string, ...string[]]).optional(),
  country_code: z.string().trim().regex(/^[A-Za-z]{2}$/, 'Use a two-letter country code, such as IN or US.'),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).nullish(),
  timezone: z.string().trim().max(64).nullish(),
  locale: z.string().trim().max(10).nullish(),
  email: z.string().trim().toLowerCase().email().max(190).nullish(),
  phone: z.string().trim().max(20).nullish(),
  plan: z.string().trim().max(40).nullish(),
  // Onboarding: the theme and style chosen, and what the merchant told us about themselves.
  theme: z.string().trim().max(60).nullish(),
  theme_style: z.string().trim().max(60).nullish(),
  stage: z.enum(['starting', 'online', 'in_person', 'switching']).nullish(),
  channels: z.array(z.enum(['online_store', 'social', 'marketplaces', 'in_person', 'not_sure'])).max(5).nullish(),
});

type ShopBody = z.infer<typeof shopBody>;

function toCreateInput(body: ShopBody) {
  return {
    name: body.name,
    handle: body.handle ?? null,
    vertical: body.vertical ?? null,
    countryCode: body.country_code,
    currency: body.currency?.toUpperCase() ?? null,
    timezone: body.timezone ?? null,
    locale: body.locale ?? null,
    email: body.email ?? null,
    phone: body.phone ?? null,
    plan: body.plan ?? null,
    theme: body.theme ?? null,
    themeStyle: body.theme_style ?? null,
    onboarding: body.stage || body.channels ? { stage: body.stage ?? null, channels: body.channels ?? [] } : null,
  };
}

// ── Admin API: the current shop ──────────────────────────────────────────────

export const shopAdminRoutes = Router();
shopAdminRoutes.use(authenticate, requireStaff);

shopAdminRoutes.get(
  '/',
  requirePermission('shop.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await shopsService.current());
  }),
);

shopAdminRoutes.patch(
  '/',
  requirePermission('shop.manage'),
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(160).optional(),
      email: z.string().trim().toLowerCase().email().max(190).nullish(),
      phone: z.string().trim().max(20).nullish(),
      timezone: z.string().trim().max(64).optional(),
      locale: z.string().trim().max(10).optional(),
      weight_unit: z.enum(['g', 'kg', 'lb', 'oz']).optional(),
      currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
      country_code: z.string().trim().regex(/^[A-Za-z]{2}$/).optional(),
      storefront_password: z.object({ enabled: z.boolean(), password: z.string().min(4).max(100).nullish() }).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await shopsService.update(req.body, actor(req)));
  }),
);

/** Settings → Brand: logo, slogan, a line about the store, social profiles. */
shopAdminRoutes.get(
  '/brand',
  requirePermission('shop.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await brandService.get());
  }),
);

shopAdminRoutes.put(
  '/brand',
  requirePermission('shop.manage'),
  validate({
    body: z.object({
      slogan: z.string().trim().max(160).nullish(),
      short_description: z.string().trim().max(500).nullish(),
      logo_media_id: z.coerce.number().int().positive().nullish(),
      square_logo_media_id: z.coerce.number().int().positive().nullish(),
      social_links: z
        .array(
          z.object({
            platform: z.enum(SOCIAL_PLATFORMS),
            url: z.string().trim().url('Enter the full address, starting https://').max(300).refine((value) => value.startsWith('https://'), 'Use an https address.'),
          }),
        )
        .max(12)
        .optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await brandService.update(req.body, actor(req)));
  }),
);

shopAdminRoutes.get(
  '/setup',
  requirePermission('shop.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await shopsService.current().then((current) => current.setup));
  }),
);

shopAdminRoutes.post(
  '/setup/:task',
  requirePermission('shop.manage'),
  validate({
    params: z.object({ task: z.string().trim().min(2).max(60) }),
    body: z.object({ status: z.enum(['done', 'skipped', 'pending']) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await shopsService.setTask(String(req.params.task), req.body.status));
  }),
);

shopAdminRoutes.post(
  '/transfer-ownership',
  validate({ body: z.object({ admin_user_id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await shopsService.transferOwnership(req.body.admin_user_id, actor(req)));
  }),
);

shopAdminRoutes.post(
  '/pause',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await shopsService.setPaused(true, actor(req)));
  }),
);

shopAdminRoutes.post(
  '/unpause',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await shopsService.setPaused(false, actor(req)));
  }),
);

shopAdminRoutes.post(
  '/close',
  validate({ body: z.object({ reason: z.string().trim().min(3).max(255), confirm_handle: z.string().trim() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    // Typing the handle is the "are you sure" that cannot be clicked through.
    if (req.body.confirm_handle !== req.shop?.handle) {
      throw ApiError.validation({ confirm_handle: ['Type the store address exactly to confirm.'] });
    }
    res.json(await shopsService.close(req.body.reason, actor(req)));
  }),
);

// ── Admin API: billing ───────────────────────────────────────────────────────

export const billingRoutes = Router();
billingRoutes.use(authenticate, requireStaff);

billingRoutes.get(
  '/plans',
  requirePermission('billing.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await shopsService.plans());
  }),
);

billingRoutes.get(
  '/subscription',
  requirePermission('billing.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await shopsService.subscription());
  }),
);

billingRoutes.post(
  '/subscription',
  requirePermission('billing.manage'),
  validate({ body: z.object({ plan: z.string().trim().min(2).max(40) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await shopsService.changePlan(req.body.plan, actor(req)));
  }),
);

/** The card on file, what is owed, and credits waiting for the next bill. */
billingRoutes.get(
  '/',
  requirePermission('billing.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await billingService.overview());
  }),
);

/** Who the bills are made out to: legal name, tax ID (GSTIN), state, billing email. */
billingRoutes.patch(
  '/details',
  requirePermission('billing.manage'),
  validate({
    body: z.object({
      legal_name: z.string().trim().max(160).nullish(),
      tax_id: z.string().trim().max(40).nullish(),
      tax_region: z.string().trim().max(10).nullish(),
      billing_email: z.string().trim().email().max(191).nullish().or(z.literal('')),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await billingService.updateTaxDetails(req.body, actor(req)));
  }),
);

billingRoutes.get(
  '/invoices',
  requirePermission('billing.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await billingService.invoices());
  }),
);

const invoiceId = z.object({ id: z.coerce.number().int().positive() });

billingRoutes.get(
  '/invoices/:id',
  requirePermission('billing.view'),
  validate({ params: invoiceId }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await billingService.invoice(Number(req.params.id)));
  }),
);

/** A card charge is a real-money call; a burst of them is a bug or abuse. */
const payLimit = rateLimit({ bucket: 'billing.pay', max: 10, windowSeconds: 600 });

billingRoutes.post(
  '/invoices/:id/pay',
  payLimit,
  requirePermission('billing.manage'),
  validate({ params: invoiceId }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await billingService.pay(Number(req.params.id), actor(req)));
  }),
);

billingRoutes.post(
  '/invoices/:id/confirm',
  payLimit,
  requirePermission('billing.manage'),
  validate({ params: invoiceId }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await billingService.confirm(Number(req.params.id)));
  }),
);

billingRoutes.post(
  '/payment-method',
  payLimit,
  requirePermission('billing.manage'),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await billingService.startPaymentMethod(actor(req)));
  }),
);

billingRoutes.post(
  '/payment-method/confirm',
  payLimit,
  requirePermission('billing.manage'),
  validate({ body: z.object({ reference: z.string().trim().min(3).max(120) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await billingService.confirmPaymentMethod(req.body.reference, actor(req)));
  }),
);

// ── Admin API: a signed-in person opening another store ─────────────────────

export const identityShopsRoutes = Router();

identityShopsRoutes.post(
  '/',
  authenticateIdentity,
  rateLimit({ bucket: 'shops.create', max: 5, windowSeconds: 3600 }),
  validate({ body: shopBody }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.identity) throw ApiError.unauthenticated();
    res.status(201).json(await signupService.createAdditionalShop(req.identity.id, toCreateInput(req.body)));
  }),
);

// ── Platform API: public signup ──────────────────────────────────────────────

export const signupRoutes = Router();

/** The theme store's screenshots (public: the signup flow shows them before there is an account). */
signupRoutes.get('/theme-store/screenshots/:handle/:file', (req: Request, res: Response) => {
  const file = screenshotFile(String(req.params.handle), String(req.params.file));
  if (!file) {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
  res.sendFile(file);
});

signupRoutes.get(
  '/signup/options',
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ ...shopsService.verticals(), countries: SUPPORTED_REGION_COUNTRIES, themes: await themesService.publicCatalog() });
  }),
);

signupRoutes.get(
  '/signup/handles/:handle',
  rateLimit({ bucket: 'signup.handles', max: 60, windowSeconds: 60 }),
  validate({ params: z.object({ handle: z.string().trim().min(1).max(60) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await signupService.handleAvailability(String(req.params.handle)));
  }),
);

signupRoutes.get(
  '/signup/suggest-handle',
  rateLimit({ bucket: 'signup.handles', max: 60, windowSeconds: 60 }),
  validate({ query: z.object({ name: z.string().trim().min(2).max(160) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await signupService.suggestHandle(String(req.query.name)));
  }),
);

signupRoutes.post(
  '/signup',
  // Opening a store is expensive (provisioning) and a target for abuse.
  rateLimit({ bucket: 'signup', max: 5, windowSeconds: 3600, blockSeconds: 3600 }),
  validate({
    body: z.object({
      email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(191),
      password: passwordSchema,
      first_name: z.string().trim().min(1).max(80),
      last_name: z.string().trim().max(80).nullish(),
      phone: z.string().trim().max(20).nullish(),
      shop: shopBody,
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { email: string; password: string; first_name: string; last_name?: string | null; phone?: string | null; shop: ShopBody };
    res.status(201).json(await signupService.signup({ ...body, shop: toCreateInput(body.shop) }, meta(req)));
  }),
);
