import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../auth/auth.schemas';
import { categoriesService } from './categories.service';

const createCategorySchema = z.object({
  category: z.object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().trim().max(140).optional(),
    parent_id: z.coerce.number().int().positive().nullish(),
    short_description: z.string().trim().max(500).nullish(),
    description: z.string().max(20000).nullish(),
    banner_media_id: z.coerce.number().int().positive().nullish(),
    thumbnail_media_id: z.coerce.number().int().positive().nullish(),
    sort_order: z.coerce.number().int().min(0).max(9999).optional(),
    is_active: z.boolean().optional(),
    show_in_menu: z.boolean().optional(),
  }),
});

const updateCategorySchema = z.object({
  category: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      slug: z.string().trim().max(140).optional(),
      parent_id: z.coerce.number().int().positive().nullish(),
      short_description: z.string().trim().max(500).nullish(),
      description: z.string().max(20000).nullish(),
      banner_media_id: z.coerce.number().int().positive().nullish(),
      thumbnail_media_id: z.coerce.number().int().positive().nullish(),
      sort_order: z.coerce.number().int().min(0).max(9999).optional(),
      is_active: z.boolean().optional(),
      show_in_menu: z.boolean().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update.'),
});

const reorderSchema = z.object({
  items: z
    .array(z.object({ id: z.coerce.number().int().positive(), sort_order: z.coerce.number().int().min(0) }))
    .min(1)
    .max(200),
});

const listQuerySchema = z.object({
  tree: z.coerce.boolean().optional(),
  include_inactive: z.coerce.boolean().optional(),
});

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const categoriesRoutes = Router();
categoriesRoutes.use(authenticate);

categoriesRoutes.get(
  '/',
  requirePermission('products.view'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as { tree?: boolean; include_inactive?: boolean };
    res.status(200).json(await categoriesService.list({ tree: q.tree, includeInactive: q.include_inactive }));
  }),
);

categoriesRoutes.post(
  '/',
  requirePermission('products.create'),
  validate({ body: createCategorySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body as { category: Parameters<typeof categoriesService.create>[0] }).category;
    res.status(201).json({ category: await categoriesService.create(body, req.admin!, meta(req)) });
  }),
);

categoriesRoutes.post(
  '/reorder',
  requirePermission('products.update'),
  validate({ body: reorderSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items } = req.body as { items: { id: number; sort_order: number }[] };
    await categoriesService.reorder(items);
    res.status(200).json({ message: 'Order updated.' });
  }),
);

categoriesRoutes.get(
  '/:id',
  requirePermission('products.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json({ category: await categoriesService.get(id) });
  }),
);

categoriesRoutes.patch(
  '/:id',
  requirePermission('products.update'),
  validate({ params: idParamSchema, body: updateCategorySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = (req.body as { category: Record<string, unknown> }).category;
    res.status(200).json({ category: await categoriesService.update(id, body, req.admin!, meta(req)) });
  }),
);

categoriesRoutes.delete(
  '/:id',
  requirePermission('products.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    await categoriesService.remove(id, req.admin!, meta(req));
    res.status(204).send();
  }),
);
