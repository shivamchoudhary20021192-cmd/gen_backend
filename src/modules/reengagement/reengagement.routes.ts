import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate, type AuthRequest } from '../../middleware/authenticate';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { reengagementService } from './reengagement.service';

/**
 * The admin side of re-engagement: who wanted something and did not buy it, and
 * a way to message the ones who agreed to be messaged.
 */
export const reengagementRoutes = Router();
reengagementRoutes.use(authenticate);

const audienceQuery = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  interest: z.enum(['saved', 'cart']).optional(),
  contactable: z.enum(['true', 'false']).optional(),
  in_stock: z.enum(['true', 'false']).optional(),
  within_days: z.coerce.number().int().positive().max(365).optional(),
});

reengagementRoutes.get(
  '/audience',
  requirePermission('customers.view'),
  validate({ query: audienceQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await reengagementService.list(req.query as Record<string, unknown>));
  }),
);

/**
 * Sends the nudge.
 *
 * Behind `customers.manage` rather than `customers.view`: this spends money and
 * puts a message on a stranger's phone, which is not a read.
 *
 * `dry_run` defaults to **true**. Someone exploring this endpoint should find
 * out how many people it would message, not discover afterwards that it did.
 */
reengagementRoutes.post(
  '/send',
  requirePermission('customers.manage'),
  validate({
    query: audienceQuery,
    body: z.object({
      dry_run: z.boolean().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    }),
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as { dry_run?: boolean; limit?: number };
    await reengagementService.assertTemplateReady();

    res.status(200).json(
      await reengagementService.send(
        {
          queryParams: req.query as Record<string, unknown>,
          limit: body.limit ?? 50,
          dryRun: body.dry_run !== false,
        },
        req.admin,
        {
          ip: clientIp(req),
          userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
          requestId: req.requestId,
        },
      ),
    );
  }),
);
