import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../../core/asyncHandler';
import { authenticate, type AuthRequest } from '../../../middleware/authenticate';
import { requirePermission } from '../../../middleware/requirePermission';
import { validate } from '../../../middleware/validate';
import { articlesService } from './articles.service';
import {
  articleBodySchema,
  articleIdParamSchema,
  articleListQuerySchema,
  articleUpdateSchema,
} from './articles.schemas';
import type { ArticleInput } from './articles.types';

/**
 * Admin routes for the Journal.
 *
 * Reads sit behind `cms.view` and writes behind `cms.edit`, which are the slugs
 * the permissions table actually seeds — the rest of this module used to ask for
 * `content.pages.view` and friends, none of which exist, so every content screen
 * was super-admin-only by accident.
 */
export const articlesRouter = Router();

articlesRouter.use(authenticate);

articlesRouter.get(
  '/categories',
  requirePermission('cms.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await articlesService.categories(false));
  }),
);

articlesRouter.get(
  '/',
  requirePermission('cms.view'),
  validate({ query: articleListQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await articlesService.list(req.query as Record<string, unknown>));
  }),
);

articlesRouter.get(
  '/:id',
  requirePermission('cms.view'),
  validate({ params: articleIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await articlesService.get(Number(req.params.id)));
  }),
);

articlesRouter.post(
  '/',
  requirePermission('cms.edit'),
  validate({ body: articleBodySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(201).json(await articlesService.create(req.body as ArticleInput, req.admin));
  }),
);

articlesRouter.patch(
  '/:id',
  requirePermission('cms.edit'),
  validate({ params: articleIdParamSchema, body: articleUpdateSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res
      .status(200)
      .json(await articlesService.update(Number(req.params.id), req.body as ArticleInput, req.admin));
  }),
);

/**
 * Publishing is its own endpoint behind its own permission.
 *
 * Someone who may draft an article is not necessarily someone who may make a
 * skincare claim public, and the review fields on the schema only mean anything
 * if this is the single door the content goes through.
 */
articlesRouter.post(
  '/:id/publish',
  requirePermission('cms.publish'),
  validate({ params: articleIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(await articlesService.publish(Number(req.params.id), req.admin));
  }),
);

articlesRouter.post(
  '/:id/unpublish',
  requirePermission('cms.publish'),
  validate({ params: articleIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(await articlesService.unpublish(Number(req.params.id), req.admin));
  }),
);

articlesRouter.post(
  '/:id/archive',
  requirePermission('cms.publish'),
  validate({ params: articleIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(await articlesService.archive(Number(req.params.id), req.admin));
  }),
);

articlesRouter.delete(
  '/:id',
  requirePermission('cms.delete'),
  validate({ params: articleIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(await articlesService.remove(Number(req.params.id), req.admin));
  }),
);
