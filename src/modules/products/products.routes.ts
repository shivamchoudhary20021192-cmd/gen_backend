import { Router } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { idempotency } from '../../middleware/idempotency';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { productsController } from './products.controller';
import {
  attachImagesSchema,
  shadeImagesParamSchema,
  shadeImagesSchema,
  bulkActionSchema,
  createProductSchema,
  createVariantSchema,
  imageParamSchema,
  listProductsQuerySchema,
  productIdParamSchema,
  reorderImagesSchema,
  updateProductSchema,
  updateVariantSchema,
  variantParamSchema,
} from './products.schemas';

export const productsRoutes = Router();
productsRoutes.use(authenticate);

// ── collection ───────────────────────────────────────────────────────────────
productsRoutes.get(
  '/',
  requirePermission('products.view'),
  validate({ query: listProductsQuerySchema }),
  asyncHandler(productsController.list),
);

productsRoutes.post(
  '/',
  requirePermission('products.create'),
  idempotency,
  validate({ body: createProductSchema }),
  asyncHandler(productsController.create),
);

// Registered before /:id so "bulk" is not swallowed by the id param.
productsRoutes.post(
  '/bulk',
  requirePermission('products.update'),
  validate({ body: bulkActionSchema }),
  asyncHandler(productsController.bulk),
);

// ── single resource ──────────────────────────────────────────────────────────
productsRoutes.get(
  '/:id',
  requirePermission('products.view'),
  validate({ params: productIdParamSchema }),
  asyncHandler(productsController.get),
);

productsRoutes.patch(
  '/:id',
  requirePermission('products.update'),
  validate({ params: productIdParamSchema, body: updateProductSchema }),
  asyncHandler(productsController.update),
);

productsRoutes.delete(
  '/:id',
  requirePermission('products.delete'),
  validate({ params: productIdParamSchema }),
  asyncHandler(productsController.remove),
);

// ── state transitions (POST, not PATCH — they are actions, not edits) ────────
productsRoutes.post(
  '/:id/publish',
  requirePermission('products.publish'),
  validate({ params: productIdParamSchema }),
  asyncHandler(productsController.publish),
);

productsRoutes.post(
  '/:id/unpublish',
  requirePermission('products.publish'),
  validate({ params: productIdParamSchema }),
  asyncHandler(productsController.unpublish),
);

productsRoutes.post(
  '/:id/archive',
  requirePermission('products.publish'),
  validate({ params: productIdParamSchema }),
  asyncHandler(productsController.archive),
);

productsRoutes.post(
  '/:id/duplicate',
  requirePermission('products.create'),
  idempotency,
  validate({ params: productIdParamSchema }),
  asyncHandler(productsController.duplicate),
);

// ── variants ─────────────────────────────────────────────────────────────────
productsRoutes.get(
  '/:id/variants',
  requirePermission('products.view'),
  validate({ params: productIdParamSchema }),
  asyncHandler(productsController.listVariants),
);

productsRoutes.post(
  '/:id/variants',
  requirePermission('products.update'),
  validate({ params: productIdParamSchema, body: createVariantSchema }),
  asyncHandler(productsController.addVariant),
);

productsRoutes.patch(
  '/:id/variants/:variantId',
  requirePermission('products.update'),
  validate({ params: variantParamSchema, body: updateVariantSchema }),
  asyncHandler(productsController.updateVariant),
);

productsRoutes.delete(
  '/:id/variants/:variantId',
  requirePermission('products.update'),
  validate({ params: variantParamSchema }),
  asyncHandler(productsController.removeVariant),
);

// ── images ───────────────────────────────────────────────────────────────────
productsRoutes.post(
  '/:id/images',
  requirePermission('products.update'),
  validate({ params: productIdParamSchema, body: attachImagesSchema }),
  asyncHandler(productsController.attachImages),
);

productsRoutes.patch(
  '/:id/images/reorder',
  requirePermission('products.update'),
  validate({ params: productIdParamSchema, body: reorderImagesSchema }),
  asyncHandler(productsController.reorderImages),
);

productsRoutes.put(
  '/:id/shades/:optionValueId/images',
  requirePermission('products.update'),
  validate({ params: shadeImagesParamSchema, body: shadeImagesSchema }),
  asyncHandler(productsController.setShadeImages),
);

productsRoutes.delete(
  '/:id/images/:mediaId',
  requirePermission('products.update'),
  validate({ params: imageParamSchema }),
  asyncHandler(productsController.detachImage),
);
