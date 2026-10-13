import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../auth/auth.schemas';
import { cartsService } from './carts.service';

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  min_value: z.coerce.number().nonnegative().optional(),
  reachable: z.coerce.boolean().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional(),
  sort: z.string().max(40).optional(),
});

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const cartsRoutes = Router();
cartsRoutes.use(authenticate);

cartsRoutes.get(
  '/abandoned',
  requirePermission('orders.view'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await cartsService.listAbandoned(req.query as Record<string, unknown>));
  }),
);

/**
 * Marks stale carts abandoned.
 *
 * Called by the screen when it loads. There is no scheduler yet, and a queue
 * that only fills when someone looks at it beats one that never fills.
 */
cartsRoutes.post(
  '/abandoned/sweep',
  requirePermission('orders.view'),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await cartsService.sweep(req.admin!, meta(req)));
  }),
);

cartsRoutes.get(
  '/abandoned/:id',
  requirePermission('orders.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await cartsService.get(id));
  }),
);

cartsRoutes.post(
  '/abandoned/:id/recovery-link',
  requirePermission('orders.update'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await cartsService.recoveryLink(id, req.admin!, meta(req)));
  }),
);

cartsRoutes.post(
  '/abandoned/:id/contacted',
  requirePermission('orders.update'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await cartsService.markContacted(id, req.admin!, meta(req)));
  }),
);

cartsRoutes.post(
  '/abandoned/:id/dismiss',
  requirePermission('orders.update'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await cartsService.dismiss(id, req.admin!, meta(req)));
  }),
);
