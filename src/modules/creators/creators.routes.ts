import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate, type AuthRequest } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import {
  creatorBodySchema,
  creatorIdParamSchema,
  creatorListQuerySchema,
  creatorUpdateSchema,
} from './creators.schemas';
import { creatorsService } from './creators.service';
import type { CreatorInput } from './creators.types';

/**
 * Admin routes for the creator library.
 *
 * Behind the content permissions rather than a new set: these are the same
 * people who write banners and articles, and inventing a permission slug that
 * no role holds is how a screen ends up reachable by nobody.
 */
export const creatorsRouter = Router();

creatorsRouter.use(authenticate);

creatorsRouter.get(
  '/',
  requirePermission('cms.view'),
  validate({ query: creatorListQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(
      await creatorsService.list({
        activeOnly: req.query.active === 'true',
        search: typeof req.query.q === 'string' ? req.query.q : undefined,
      }),
    );
  }),
);

creatorsRouter.get(
  '/:id',
  requirePermission('cms.view'),
  validate({ params: creatorIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await creatorsService.get(Number(req.params.id)));
  }),
);

creatorsRouter.post(
  '/',
  requirePermission('cms.edit'),
  validate({ body: creatorBodySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(201).json(await creatorsService.create(req.body as CreatorInput, req.admin));
  }),
);

creatorsRouter.patch(
  '/:id',
  requirePermission('cms.edit'),
  validate({ params: creatorIdParamSchema, body: creatorUpdateSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res
      .status(200)
      .json(await creatorsService.update(Number(req.params.id), req.body as CreatorInput, req.admin));
  }),
);

creatorsRouter.delete(
  '/:id',
  requirePermission('cms.delete'),
  validate({ params: creatorIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(await creatorsService.remove(Number(req.params.id), req.admin));
  }),
);
