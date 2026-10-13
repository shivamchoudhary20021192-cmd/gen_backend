import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { requireStaff, requireStaffPermissionOrApp } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { webhooksService } from './webhooks.service';

const createBody = z.object({
  topic: z.string().trim().min(3).max(80),
  address: z.string().trim().max(1000),
  api_version: z.string().trim().max(10).optional(),
  include_fields: z.array(z.string().trim().min(1).max(60)).max(50).nullish(),
});

const updateBody = z.object({
  address: z.string().trim().max(1000).optional(),
  api_version: z.string().trim().max(10).optional(),
  include_fields: z.array(z.string().trim().min(1).max(60)).max(50).nullish(),
  status: z.enum(['active', 'disabled']).optional(),
});

const idParam = z.object({ id: z.string().uuid() });
const deliveriesQuery = z.object({ limit: z.coerce.number().int().positive().max(200).optional() });

/**
 * Webhook subscriptions. The same routes serve staff (the shop's own
 * subscriptions, needing webhooks.manage) and apps (only ever their own).
 */
export const webhooksRoutes = Router();
webhooksRoutes.use(authenticate, requireStaffPermissionOrApp('webhooks.manage'));

webhooksRoutes.get(
  '/topics',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ topics: webhooksService.topics(req.admin!) });
  }),
);

webhooksRoutes.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ webhooks: await webhooksService.list(req.admin!) });
  }),
);

webhooksRoutes.post(
  '/',
  validate({ body: createBody }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await webhooksService.create(req.admin!, req.body));
  }),
);

webhooksRoutes.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ webhook: await webhooksService.show(req.admin!, String(req.params.id)) });
  }),
);

webhooksRoutes.patch(
  '/:id',
  validate({ params: idParam, body: updateBody }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ webhook: await webhooksService.update(req.admin!, String(req.params.id), req.body) });
  }),
);

webhooksRoutes.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    await webhooksService.remove(req.admin!, String(req.params.id));
    res.status(204).send();
  }),
);

webhooksRoutes.get(
  '/:id/deliveries',
  validate({ params: idParam, query: deliveriesQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit } = req.query as { limit?: number };
    res.json({ deliveries: await webhooksService.deliveries(req.admin!, String(req.params.id), limit) });
  }),
);

webhooksRoutes.post(
  '/:id/test',
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ result: await webhooksService.test(req.admin!, String(req.params.id)) });
  }),
);

webhooksRoutes.get(
  '/:id/secret',
  requireStaff,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ signing_secret: await webhooksService.revealSecret(req.admin!, String(req.params.id)) });
  }),
);
