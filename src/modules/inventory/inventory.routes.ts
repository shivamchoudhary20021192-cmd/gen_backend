import { Router } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { inventoryController } from './inventory.controller';
import {
  adjustSchema,
  bulkAdjustSchema,
  createLocationSchema,
  listStockQuerySchema,
  locationIdParamSchema,
  movementsQuerySchema,
  setStockSchema,
  updateLocationSchema,
  variantIdParamSchema,
} from './inventory.schemas';

export const inventoryRoutes = Router();
inventoryRoutes.use(authenticate);

// ── summary & global views ─────────────────────────────────────────────────
// Registered before /:variantId so the literal paths are not swallowed.

inventoryRoutes.get(
  '/',
  requirePermission('inventory.view'),
  validate({ query: listStockQuerySchema }),
  asyncHandler(inventoryController.list),
);

inventoryRoutes.get(
  '/summary',
  requirePermission('inventory.view'),
  validate({ query: listStockQuerySchema }),
  asyncHandler(inventoryController.summary),
);

inventoryRoutes.get(
  '/movements',
  requirePermission('inventory.view'),
  validate({ query: movementsQuerySchema }),
  asyncHandler(inventoryController.movements),
);

// ── bulk ────────────────────────────────────────────────────────────────────

inventoryRoutes.post(
  '/bulk-adjust',
  requirePermission('inventory.adjust'),
  validate({ body: bulkAdjustSchema }),
  asyncHandler(inventoryController.bulkAdjust),
);

// ── locations ──────────────────────────────────────────────────────────────

inventoryRoutes.get(
  '/locations',
  requirePermission('inventory.view'),
  asyncHandler(inventoryController.listLocations),
);

inventoryRoutes.post(
  '/locations',
  requirePermission('inventory.adjust'),
  validate({ body: createLocationSchema }),
  asyncHandler(inventoryController.createLocation),
);

inventoryRoutes.get(
  '/locations/:id',
  requirePermission('inventory.view'),
  validate({ params: locationIdParamSchema }),
  asyncHandler(inventoryController.getLocation),
);

inventoryRoutes.patch(
  '/locations/:id',
  requirePermission('inventory.adjust'),
  validate({ params: locationIdParamSchema, body: updateLocationSchema }),
  asyncHandler(inventoryController.updateLocation),
);

// ── single variant ─────────────────────────────────────────────────────────

inventoryRoutes.get(
  '/:variantId',
  requirePermission('inventory.view'),
  validate({ params: variantIdParamSchema }),
  asyncHandler(inventoryController.get),
);

inventoryRoutes.post(
  '/:variantId/adjust',
  requirePermission('inventory.adjust'),
  validate({ params: variantIdParamSchema, body: adjustSchema }),
  asyncHandler(inventoryController.adjust),
);

inventoryRoutes.post(
  '/:variantId/set',
  requirePermission('inventory.adjust'),
  validate({ params: variantIdParamSchema, body: setStockSchema }),
  asyncHandler(inventoryController.setStock),
);
