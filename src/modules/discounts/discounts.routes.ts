import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { idempotency } from '../../middleware/idempotency';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../auth/auth.schemas';
import { discountsService } from './discounts.service';
import {
  createDiscountSchema,
  listDiscountsQuerySchema,
  setProductDiscountsSchema,
  setProductsSchema,
  updateDiscountSchema,
} from './discounts.schemas';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const discountsRoutes = Router();
discountsRoutes.use(authenticate);

discountsRoutes.get(
  '/',
  requirePermission('coupons.view'),
  validate({ query: listDiscountsQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await discountsService.list(req.query as Record<string, unknown>));
  }),
);

discountsRoutes.post(
  '/',
  requirePermission('coupons.manage'),
  idempotency,
  validate({ body: createDiscountSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body as { discount: Record<string, unknown> }).discount;
    res.status(201).json({ discount: await discountsService.create(body, req.admin!, meta(req)) });
  }),
);

/**
 * Lightweight feed for the product-form dropdown: active discounts only.
 * Registered before `/:id` so "options" is never parsed as an id.
 */
discountsRoutes.get(
  '/options',
  requirePermission('products.view', 'coupons.view'),
  validate({ query: z.object({ q: z.string().trim().max(120).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await discountsService.list({
      limit: 100,
      state: 'active',
      q: (req.query as { q?: string }).q,
      sort: 'code:asc',
    });
    res.status(200).json({ discounts: result.discounts });
  }),
);

discountsRoutes.get(
  '/:id',
  requirePermission('coupons.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json({ discount: await discountsService.get(id) });
  }),
);

discountsRoutes.patch(
  '/:id',
  requirePermission('coupons.manage'),
  validate({ params: idParamSchema, body: updateDiscountSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = (req.body as { discount: Record<string, unknown> }).discount;
    res.status(200).json({ discount: await discountsService.update(id, body, req.admin!, meta(req)) });
  }),
);

discountsRoutes.delete(
  '/:id',
  requirePermission('coupons.manage'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    await discountsService.remove(id, req.admin!, meta(req));
    res.status(204).send();
  }),
);

/** The Shopify direction: a discount owns its product list. */
discountsRoutes.put(
  '/:id/products',
  requirePermission('coupons.manage'),
  validate({ params: idParamSchema, body: setProductsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const { product_ids } = req.body as { product_ids: number[] };
    res.status(200).json({ discount: await discountsService.setProducts(id, product_ids, req.admin!, meta(req)) });
  }),
);

/**
 * The product-form direction. Mounted under /products in app.ts, AFTER the
 * products router, so `/products/:id/discounts` resolves here while everything
 * else stays in the products module. Both directions write the same
 * `coupon_products` rows — there is one source of truth, two doors into it.
 */
export const productDiscountsRoutes = Router();
productDiscountsRoutes.use(authenticate);

productDiscountsRoutes.get(
  '/:id/discounts',
  requirePermission('products.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await discountsService.forProduct(id));
  }),
);

productDiscountsRoutes.put(
  '/:id/discounts',
  requirePermission('coupons.manage', 'products.update'),
  validate({ params: idParamSchema, body: setProductDiscountsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const { discount_ids } = req.body as { discount_ids: number[] };
    res.status(200).json(await discountsService.setProductDiscounts(id, discount_ids, req.admin!, meta(req)));
  }),
);

