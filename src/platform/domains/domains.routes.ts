import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission, requireStaff } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { domainsService } from './domains.service';

/**
 * Admin API: /domains — Settings → Domains.
 *
 *   GET    /                         the store's domains, purchased domains, the edge
 *   GET    /:id                      one domain with its DNS checklist and history
 *   POST   /                         connect { hostname, include_sibling }
 *   POST   /:id/verify               check now
 *   POST   /:id/primary              make primary (everything else redirects to it)
 *   PATCH  /:id                      { redirect_to_primary, market_id, locale }
 *   DELETE /:id
 *   POST   /transfer                 { hostname } → the TXT record that moves it here
 *   POST   /transfer/complete        { hostname }
 *   GET    /search?q=                domains to buy, with prices
 *   POST   /buy                      { domain, years, privacy, contact }
 *   PATCH  /registrations/:id        { auto_renew }
 *   POST   /registrations/:id/transfer-code
 */
export const domainsRoutes = Router();
domainsRoutes.use(authenticate, requireStaff);

const canView = requirePermission('shop.view');
const canManage = requirePermission('domains.manage');
const idParam = z.object({ id: z.coerce.number().int().positive() });
const hostname = z.string().trim().min(4).max(253);

function actor(req: Request) {
  return { id: req.admin?.id ?? null, label: req.admin?.email ?? null };
}

domainsRoutes.get(
  '/',
  canView,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await domainsService.list());
  }),
);

domainsRoutes.get(
  '/search',
  canManage,
  rateLimit({ bucket: 'domains.search', max: 30, windowSeconds: 60 }),
  validate({ query: z.object({ q: z.string().trim().min(1).max(63) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await domainsService.search(String(req.query.q)));
  }),
);

domainsRoutes.get(
  '/:id',
  canView,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await domainsService.get(Number(req.params.id)));
  }),
);

domainsRoutes.post(
  '/',
  canManage,
  rateLimit({ bucket: 'domains.connect', max: 20, windowSeconds: 600 }),
  validate({ body: z.object({ hostname, include_sibling: z.boolean().optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await domainsService.connect(req.body, actor(req)));
  }),
);

domainsRoutes.post(
  '/transfer',
  canManage,
  validate({ body: z.object({ hostname }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await domainsService.transferInstructions(req.body.hostname));
  }),
);

domainsRoutes.post(
  '/transfer/complete',
  canManage,
  rateLimit({ bucket: 'domains.verify', max: 20, windowSeconds: 60 }),
  validate({ body: z.object({ hostname }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await domainsService.completeTransfer(req.body.hostname, actor(req)));
  }),
);

/** Who a domain is registered to (the registrant), for buying and transferring in. */
const contact = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(191),
    phone: z.string().trim().min(6).max(24),
    address1: z.string().trim().min(1).max(255),
    city: z.string().trim().min(1).max(80),
    state: z.string().trim().min(1).max(80),
    zip: z.string().trim().min(1).max(16),
    country: z.string().trim().length(2),
    organization: z.string().trim().max(120).nullish(),
  })
  .nullish();

domainsRoutes.post(
  '/buy',
  canManage,
  rateLimit({ bucket: 'domains.buy', max: 5, windowSeconds: 600 }),
  validate({
    body: z.object({
      domain: hostname,
      years: z.number().int().min(1).max(10).optional(),
      privacy: z.boolean().optional(),
      contact,
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await domainsService.buy(req.body, actor(req)));
  }),
);

domainsRoutes.patch(
  '/registrations/:id',
  canManage,
  validate({ params: idParam, body: z.object({ auto_renew: z.boolean() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await domainsService.setAutoRenew(Number(req.params.id), req.body.auto_renew, actor(req)));
  }),
);

domainsRoutes.post(
  '/registrations/:id/transfer-code',
  canManage,
  rateLimit({ bucket: 'domains.transfer_code', max: 5, windowSeconds: 600 }),
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await domainsService.transferOutCode(Number(req.params.id), actor(req)));
  }),
);

/** Transferring a connected domain's registration here: the quote, then the request with the code. */
domainsRoutes.get(
  '/:id/transfer',
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await domainsService.transferQuote(Number(req.params.id)));
  }),
);

domainsRoutes.post(
  '/:id/transfer',
  canManage,
  rateLimit({ bucket: 'domains.transfer_in', max: 5, windowSeconds: 600 }),
  validate({ params: idParam, body: z.object({ auth_code: z.string().trim().min(1).max(64), privacy: z.boolean().optional(), contact }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(202).json(await domainsService.transferIn(Number(req.params.id), req.body, actor(req)));
  }),
);

domainsRoutes.post(
  '/:id/verify',
  canManage,
  rateLimit({ bucket: 'domains.verify', max: 20, windowSeconds: 60 }),
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await domainsService.verifyNow(Number(req.params.id)));
  }),
);

domainsRoutes.post(
  '/:id/primary',
  canManage,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await domainsService.makePrimary(Number(req.params.id), actor(req)));
  }),
);

domainsRoutes.patch(
  '/:id',
  canManage,
  validate({
    params: idParam,
    body: z.object({
      redirect_to_primary: z.boolean().optional(),
      market_id: z.number().int().positive().nullable().optional(),
      locale: z.string().trim().toLowerCase().regex(/^[a-z]{2}(-[a-z]{2})?$/).nullable().optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await domainsService.update(Number(req.params.id), req.body, actor(req)));
  }),
);

domainsRoutes.delete(
  '/:id',
  canManage,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await domainsService.remove(Number(req.params.id), actor(req)));
  }),
);
