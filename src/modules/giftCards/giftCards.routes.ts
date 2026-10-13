import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { idempotency } from '../../middleware/idempotency';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { giftCardsService } from './giftCards.service';

/**
 * Admin API: /gift-cards — Products → Gift cards.
 *
 *   GET    /                    ?q=&status=enabled|disabled|expired|used&customer_id=&page=&limit=
 *   POST   /                    issue { value, currency?, code?, expires_on?, customer_id?, note?, recipient?, notify? }
 *                               → the full code, the only time staff see it
 *   GET    /:id                 the card and its balance history
 *   PATCH  /:id                 { expires_on?, note?, customer_id? }
 *   POST   /:id/disable | /:id/enable
 *   POST   /:id/adjust          { amount (signed), note }
 *   POST   /:id/resend          send it to its recipient or customer again
 */
export const giftCardsRoutes = Router();
giftCardsRoutes.use(authenticate);

const canView = requirePermission('gift_cards.view');
const canManage = requirePermission('gift_cards.manage');
const idParam = z.object({ id: z.coerce.number().int().positive() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

function actor(req: Request) {
  return { id: req.admin?.id ?? null, label: req.admin?.email ?? null };
}

giftCardsRoutes.get(
  '/',
  canView,
  validate({
    query: z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum(['enabled', 'disabled', 'expired', 'used']).optional(),
      customer_id: z.coerce.number().int().positive().optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await giftCardsService.list(req.query as never));
  }),
);

giftCardsRoutes.post(
  '/',
  canManage,
  idempotency,
  rateLimit({ bucket: 'gift_cards.issue', max: 60, windowSeconds: 600 }),
  validate({
    body: z.object({
      value: z.number().positive(),
      currency: z.string().trim().length(3).toUpperCase().optional(),
      code: z.string().trim().max(40).nullish(),
      expires_on: date.nullish(),
      customer_id: z.number().int().positive().nullish(),
      note: z.string().trim().max(500).nullish(),
      recipient: z
        .object({
          name: z.string().trim().max(120).nullish(),
          email: z.string().trim().email().max(191).nullish(),
          phone: z.string().trim().min(6).max(24).nullish(),
          message: z.string().trim().max(500).nullish(),
        })
        .nullish(),
      notify: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await giftCardsService.issue(req.body, actor(req)));
  }),
);

giftCardsRoutes.get(
  '/:id',
  canView,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await giftCardsService.get(Number(req.params.id)));
  }),
);

giftCardsRoutes.patch(
  '/:id',
  canManage,
  validate({ params: idParam, body: z.object({ expires_on: date.nullish(), note: z.string().trim().max(500).nullish(), customer_id: z.number().int().positive().nullish() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await giftCardsService.update(Number(req.params.id), req.body, actor(req)));
  }),
);

giftCardsRoutes.post(
  '/:id/disable',
  canManage,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await giftCardsService.setEnabled(Number(req.params.id), false, actor(req)));
  }),
);

giftCardsRoutes.post(
  '/:id/enable',
  canManage,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await giftCardsService.setEnabled(Number(req.params.id), true, actor(req)));
  }),
);

giftCardsRoutes.post(
  '/:id/adjust',
  canManage,
  idempotency,
  validate({ params: idParam, body: z.object({ amount: z.number().refine((value) => value !== 0, 'Enter an amount.'), note: z.string().trim().min(1).max(500) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await giftCardsService.adjust(Number(req.params.id), req.body, actor(req)));
  }),
);

giftCardsRoutes.post(
  '/:id/resend',
  canManage,
  rateLimit({ bucket: 'gift_cards.resend', max: 10, windowSeconds: 600 }),
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await giftCardsService.resend(Number(req.params.id), actor(req)));
  }),
);
