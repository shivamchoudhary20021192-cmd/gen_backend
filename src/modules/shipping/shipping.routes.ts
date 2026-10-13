import { Router } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { shippingController } from './shipping.controller';
import {
  createRateSchema,
  createZoneSchema,
  idParamSchema,
  quotePreviewSchema,
  updateZoneSchema,
  pincodeParamSchema,
  updateCarrierSchema,
  updateCodRuleSchema,
  updateRateSchema,
  upsertPincodeSchema,
} from './shipping.schemas';

export const shippingRoutes = Router();
shippingRoutes.use(authenticate);

// ── Rates ──────────────────────────────────────────────────────────────────

shippingRoutes.get(
  '/rates',
  requirePermission('settings.view'),
  asyncHandler(shippingController.listRates),
);

shippingRoutes.post(
  '/rates',
  requirePermission('settings.manage'),
  validate({ body: createRateSchema }),
  asyncHandler(shippingController.createRate),
);

shippingRoutes.patch(
  '/rates/:id',
  requirePermission('settings.manage'),
  validate({ params: idParamSchema, body: updateRateSchema }),
  asyncHandler(shippingController.updateRate),
);

shippingRoutes.delete(
  '/rates/:id',
  requirePermission('settings.manage'),
  validate({ params: idParamSchema }),
  asyncHandler(shippingController.deleteRate),
);

// ── Carriers ───────────────────────────────────────────────────────────────

shippingRoutes.get(
  '/carriers',
  requirePermission('settings.view'),
  asyncHandler(shippingController.listCarriers),
);

shippingRoutes.patch(
  '/carriers/:id',
  requirePermission('settings.manage'),
  validate({ params: idParamSchema, body: updateCarrierSchema }),
  asyncHandler(shippingController.updateCarrier),
);

// ── COD Rules ──────────────────────────────────────────────────────────────

shippingRoutes.get(
  '/cod-rules',
  requirePermission('settings.view'),
  asyncHandler(shippingController.listCodRules),
);

shippingRoutes.patch(
  '/cod-rules/:id',
  requirePermission('settings.manage'),
  validate({ params: idParamSchema, body: updateCodRuleSchema }),
  asyncHandler(shippingController.updateCodRule),
);

// ── Zones ──────────────────────────────────────────────────────────────────

shippingRoutes.get(
  '/zones',
  requirePermission('settings.view'),
  asyncHandler(shippingController.listZones),
);

shippingRoutes.post(
  '/zones',
  requirePermission('settings.manage'),
  validate({ body: createZoneSchema }),
  asyncHandler(shippingController.createZone),
);

shippingRoutes.patch(
  '/zones/:id',
  requirePermission('settings.manage'),
  validate({ params: idParamSchema, body: updateZoneSchema }),
  asyncHandler(shippingController.updateZone),
);

shippingRoutes.delete(
  '/zones/:id',
  requirePermission('settings.manage'),
  validate({ params: idParamSchema }),
  asyncHandler(shippingController.deleteZone),
);

/** What a customer at an address would be offered — for checking the rates. */
shippingRoutes.post(
  '/quote-preview',
  requirePermission('settings.view'),
  validate({ body: quotePreviewSchema }),
  asyncHandler(shippingController.previewQuote),
);

// ── Pincode Serviceability ─────────────────────────────────────────────────

shippingRoutes.get(
  '/serviceability/:pincode',
  requirePermission('settings.view'),
  validate({ params: pincodeParamSchema }),
  asyncHandler(shippingController.lookupPincode),
);

shippingRoutes.post(
  '/serviceability',
  requirePermission('settings.manage'),
  validate({ body: upsertPincodeSchema }),
  asyncHandler(shippingController.upsertPincode),
);
