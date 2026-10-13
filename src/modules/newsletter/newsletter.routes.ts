import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { rateLimit } from '../../middleware/rateLimit';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { marketContext } from '../../platform/markets/markets';
import { newsletterService } from './newsletter.service';

function meta(req: Request) {
  return { ip: clientIp(req), userAgent: req.header('User-Agent')?.slice(0, 255) ?? null };
}

// ── Storefront API: /api/v1/newsletter ───────────────────────────────────────

export const newsletterStorefrontRoutes = Router();

newsletterStorefrontRoutes.post(
  '/newsletter/subscribe',
  // A sign-up form is a favourite target for list-bombing; a person signs up once.
  rateLimit({ bucket: 'shop.newsletter', max: 5, windowSeconds: 600, blockSeconds: 600 }),
  validate({
    body: z.object({
      email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(191),
      source: z.enum(['footer', 'popup', 'account']).default('footer'),
      // The sentence the shopper saw beside the box, kept as evidence of what they agreed to.
      wording: z.string().trim().max(300).nullish(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { email: string; source: 'footer' | 'popup' | 'account'; wording?: string | null };
    const market = marketContext.current();
    res.json(await newsletterService.subscribe({ email: body.email, source: body.source, wording: body.wording ?? null, countryCode: market.country }, meta(req)));
  }),
);

newsletterStorefrontRoutes.post(
  '/newsletter/unsubscribe',
  rateLimit({ bucket: 'shop.newsletter_leave', max: 20, windowSeconds: 600 }),
  validate({ body: z.object({ token: z.string().trim().min(20).max(64) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await newsletterService.unsubscribeByToken((req.body as { token: string }).token, meta(req)));
  }),
);

// ── Admin API: /admin/api/:version/newsletter ───────────────────────────────

export const newsletterAdminRoutes = Router();
newsletterAdminRoutes.use(authenticate);

newsletterAdminRoutes.get(
  '/subscribers',
  requirePermission('customers.view'),
  validate({
    query: z.object({
      status: z.enum(['subscribed', 'unsubscribed']).optional(),
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(200).default(50),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { status?: 'subscribed' | 'unsubscribed'; q?: string; page: number; limit: number };
    res.json(await newsletterService.list({ status: q.status, q: q.q, page: Number(q.page), limit: Number(q.limit) }));
  }),
);

newsletterAdminRoutes.get(
  '/subscribers/export',
  requirePermission('customers.export'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="subscribers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(await newsletterService.exportCsv());
  }),
);

newsletterAdminRoutes.post(
  '/subscribers/:id/unsubscribe',
  requirePermission('customers.update'),
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await newsletterService.unsubscribeById(Number(req.params.id), { id: req.admin?.id ?? null, label: req.admin?.email ?? null }, meta(req)));
  }),
);
