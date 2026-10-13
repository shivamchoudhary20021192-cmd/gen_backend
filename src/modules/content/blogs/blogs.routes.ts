import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../../core/asyncHandler';
import { authenticate, type AuthRequest } from '../../../middleware/authenticate';
import { requirePermission } from '../../../middleware/requirePermission';
import { validate } from '../../../middleware/validate';
import { blogsService } from './blogs.service';
import {
  blogBodySchema,
  blogDeleteQuerySchema,
  blogIdParamSchema,
  blogUpdateSchema,
} from './blogs.schemas';
import type { BlogInput } from './blogs.types';

/**
 * Admin routes for blogs.
 *
 * Reads behind `cms.view` and writes behind `cms.edit`, matching the rest of
 * the content module. Deleting takes `cms.delete` because it can move — or,
 * without care, destroy — everything written in it.
 */
export const blogsRouter = Router();

blogsRouter.use(authenticate);

blogsRouter.get(
  '/',
  requirePermission('cms.view'),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await blogsService.list(req.query.active === 'true'));
  }),
);

blogsRouter.get(
  '/:id',
  requirePermission('cms.view'),
  validate({ params: blogIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await blogsService.get(Number(req.params.id)));
  }),
);

blogsRouter.post(
  '/',
  requirePermission('cms.edit'),
  validate({ body: blogBodySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(201).json(await blogsService.create(req.body as BlogInput, req.admin));
  }),
);

blogsRouter.patch(
  '/:id',
  requirePermission('cms.edit'),
  validate({ params: blogIdParamSchema, body: blogUpdateSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res
      .status(200)
      .json(await blogsService.update(Number(req.params.id), req.body as BlogInput, req.admin));
  }),
);

blogsRouter.delete(
  '/:id',
  requirePermission('cms.delete'),
  validate({ params: blogIdParamSchema, query: blogDeleteQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const reassignTo = req.query.reassign_to ? Number(req.query.reassign_to) : undefined;
    res.status(200).json(await blogsService.remove(Number(req.params.id), reassignTo, req.admin));
  }),
);
