import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate, type AuthRequest } from '../../middleware/authenticate';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { reviewsService } from './reviews.service';
import {
  changeStatusSchema,
  listReviewsQuerySchema,
  replySchema,
  reviewIdParamSchema,
} from './reviews.schemas';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const reviewsRoutes = Router();
reviewsRoutes.use(authenticate);

reviewsRoutes.get(
  '/',
  requirePermission('reviews.view'),
  validate({ query: listReviewsQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await reviewsService.list(req.query as Record<string, unknown>));
  }),
);

reviewsRoutes.get(
  '/:id',
  requirePermission('reviews.view'),
  validate({ params: reviewIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await reviewsService.get(id));
  }),
);

reviewsRoutes.post(
  '/:id/status',
  requirePermission('reviews.moderate'),
  validate({ params: reviewIdParamSchema, body: changeStatusSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res
      .status(200)
      .json(await reviewsService.changeStatus(id, req.body, req.admin, meta(req)));
  }),
);

reviewsRoutes.post(
  '/:id/reply',
  requirePermission('reviews.moderate'),
  validate({ params: reviewIdParamSchema, body: replySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await reviewsService.reply(id, req.body, req.admin, meta(req)));
  }),
);
