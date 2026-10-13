import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../auth/auth.schemas';
import { collectionsService } from './collections.service';
import { RULE_FIELDS } from './ruleCompiler';

const ruleSchema = z.object({
  field: z.enum(RULE_FIELDS as [string, ...string[]]),
  operator: z.enum([
    'equals',
    'not_equals',
    'contains',
    'not_contains',
    'starts_with',
    'ends_with',
    'greater_than',
    'less_than',
  ]),
  value: z.string().max(255).nullable(),
});

const createCollectionSchema = z.object({
  collection: z.object({
    title: z.string().trim().min(1).max(160),
    slug: z.string().trim().max(140).optional(),
    subtitle: z.string().trim().max(255).nullish(),
    description: z.string().max(20000).nullish(),
    meta_title: z.string().trim().max(191).nullish(),
    meta_description: z.string().trim().max(320).nullish(),
    collection_type: z.enum(['manual', 'automatic']).default('manual'),
    match_condition: z.enum(['all', 'any']).default('all'),
    sort_type: z
      .enum(['manual', 'best_selling', 'newest', 'price_asc', 'price_desc', 'title_asc', 'rating_desc'])
      .default('manual'),
    image_media_id: z.coerce.number().int().positive().nullish(),
    banner_media_id: z.coerce.number().int().positive().nullish(),
    is_active: z.boolean().optional(),
    show_in_menu: z.boolean().optional(),
    rules: z.array(ruleSchema).max(20).optional(),
    product_ids: z.array(z.coerce.number().int().positive()).max(500).optional(),
  }),
});

const updateCollectionSchema = z.object({
  collection: z
    .object({
      title: z.string().trim().min(1).max(160).optional(),
      slug: z.string().trim().max(140).optional(),
      subtitle: z.string().trim().max(255).nullish(),
      description: z.string().max(20000).nullish(),
      meta_title: z.string().trim().max(191).nullish(),
      meta_description: z.string().trim().max(320).nullish(),
      match_condition: z.enum(['all', 'any']).optional(),
      sort_type: z
        .enum(['manual', 'best_selling', 'newest', 'price_asc', 'price_desc', 'title_asc', 'rating_desc'])
        .optional(),
      image_media_id: z.coerce.number().int().positive().nullish(),
      banner_media_id: z.coerce.number().int().positive().nullish(),
      is_active: z.boolean().optional(),
      show_in_menu: z.boolean().optional(),
      sort_order: z.coerce.number().int().min(0).optional(),
      rules: z.array(ruleSchema).max(20).optional(),
      // The Online Store template: null for the default, or an alternate ("sale" → collection.sale.json).
      template_suffix: z.string().trim().regex(/^[a-z0-9_-]{1,60}$/i, 'Use letters, numbers, dashes and underscores.').nullish(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update.'),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  type: z.enum(['manual', 'automatic']).optional(),
  active: z.coerce.boolean().optional(),
  sort: z.string().max(60).optional(),
});

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const collectionsRoutes = Router();
collectionsRoutes.use(authenticate);

collectionsRoutes.get(
  '/',
  requirePermission('products.view'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await collectionsService.list(req.query as Record<string, unknown>));
  }),
);

collectionsRoutes.post(
  '/',
  requirePermission('products.create'),
  validate({ body: createCollectionSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body as { collection: Parameters<typeof collectionsService.create>[0] }).collection;
    res.status(201).json({ collection: await collectionsService.create(body, req.admin!, meta(req)) });
  }),
);

collectionsRoutes.get(
  '/:id',
  requirePermission('products.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json({ collection: await collectionsService.get(id) });
  }),
);

collectionsRoutes.patch(
  '/:id',
  requirePermission('products.update'),
  validate({ params: idParamSchema, body: updateCollectionSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = (req.body as { collection: Record<string, unknown> }).collection;
    res.status(200).json({ collection: await collectionsService.update(id, body, req.admin!, meta(req)) });
  }),
);

collectionsRoutes.delete(
  '/:id',
  requirePermission('products.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    await collectionsService.remove(id, req.admin!, meta(req));
    res.status(204).send();
  }),
);

collectionsRoutes.post(
  '/:id/recalculate',
  requirePermission('products.update'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await collectionsService.recalculate(id));
  }),
);

collectionsRoutes.post(
  '/:id/products',
  requirePermission('products.update'),
  validate({
    params: idParamSchema,
    body: z.object({
      product_id: z.coerce.number().int().positive(),
      position: z.coerce.number().int().min(0).default(0),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const { product_id, position } = req.body as { product_id: number; position: number };
    await collectionsService.addProduct(id, product_id, position);
    res.status(200).json({ collection: await collectionsService.get(id) });
  }),
);

collectionsRoutes.put(
  '/:id/products',
  requirePermission('products.update'),
  validate({
    params: idParamSchema,
    body: z.object({
      product_ids: z.array(z.coerce.number().int().positive()).max(500),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const { product_ids } = req.body as { product_ids: number[] };
    await collectionsService.setProducts(id, product_ids);
    res.status(200).json({ collection: await collectionsService.get(id) });
  }),
);

collectionsRoutes.delete(
  '/:id/products/:productId',
  requirePermission('products.update'),
  validate({
    params: z.object({
      id: z.coerce.number().int().positive(),
      productId: z.coerce.number().int().positive(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id, productId } = req.params as unknown as { id: number; productId: number };
    await collectionsService.removeProduct(id, productId);
    res.status(204).send();
  }),
);

collectionsRoutes.post(
  '/:id/reorder',
  requirePermission('products.update'),
  validate({
    params: idParamSchema,
    body: z.object({ product_ids: z.array(z.coerce.number().int().positive()).min(1).max(500) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const { product_ids } = req.body as { product_ids: number[] };
    await collectionsService.reorder(id, product_ids);
    res.status(200).json({ message: 'Order updated.' });
  }),
);

/**
 * Product-side collections, mounted at /products.
 *
 * Same shape as the discounts module: the relationship is owned by the
 * collection, but Shopify lets you reach it from the product page too, and so
 * does this. Kept in a second router so the products module does not grow a
 * dependency on collections.
 */
export const productCollectionsRoutes = Router();
productCollectionsRoutes.use(authenticate);

productCollectionsRoutes.get(
  '/:id/collections',
  requirePermission('products.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await collectionsService.forProduct(id));
  }),
);

productCollectionsRoutes.put(
  '/:id/collections',
  requirePermission('products.update'),
  validate({
    params: idParamSchema,
    body: z.object({ collection_ids: z.array(z.coerce.number().int().positive()).max(100) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const { collection_ids } = req.body as { collection_ids: number[] };
    res.status(200).json(await collectionsService.setProductCollections(id, collection_ids));
  }),
);
