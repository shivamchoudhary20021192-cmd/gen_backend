import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../core/asyncHandler';
import { authenticate } from '../../../middleware/authenticate';
import { requirePermission } from '../../../middleware/requirePermission';
import { validate } from '../../../middleware/validate';
import { commentsService } from './comments.service';

/**
 * Admin API: /content/comments — Content → Comments.
 *
 *   GET   /        ?status=pending|published|spam|removed&q=&page=
 *   POST  /:id/moderate   { status: published | pending | spam | removed }
 */
export const commentsRouter = Router();
commentsRouter.use(authenticate);

commentsRouter.get(
  '/',
  requirePermission('cms.view'),
  validate({
    query: z.object({
      status: z.enum(['pending', 'published', 'spam', 'removed']).optional(),
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await commentsService.list(req.query as never));
  }),
);

commentsRouter.post(
  '/:id/moderate',
  requirePermission('cms.publish'),
  validate({ params: z.object({ id: z.coerce.number().int().positive() }), body: z.object({ status: z.enum(['pending', 'published', 'spam', 'removed']) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await commentsService.moderate(Number(req.params.id), req.body.status, { id: req.admin?.id ?? null, label: req.admin?.email ?? null }));
  }),
);
