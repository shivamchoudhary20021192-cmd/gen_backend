import { Router } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { paymentsController } from './payments.controller';
import {
  idParamSchema,
  transactionsQuerySchema,
  updatePaymentSettingsSchema,
} from './payments.schemas';

export const paymentsRoutes = Router();
paymentsRoutes.use(authenticate);

// ── Settings ───────────────────────────────────────────────────────────────

paymentsRoutes.get(
  '/settings',
  requirePermission('settings.view'),
  asyncHandler(paymentsController.getSettings),
);

paymentsRoutes.patch(
  '/settings',
  requirePermission('settings.manage'),
  validate({ body: updatePaymentSettingsSchema }),
  asyncHandler(paymentsController.updateSettings),
);

// ── Transactions ───────────────────────────────────────────────────────────

paymentsRoutes.get(
  '/transactions',
  requirePermission('settings.view'),
  validate({ query: transactionsQuerySchema }),
  asyncHandler(paymentsController.listTransactions),
);

paymentsRoutes.get(
  '/transactions/:id',
  requirePermission('settings.view'),
  validate({ params: idParamSchema }),
  asyncHandler(paymentsController.getTransaction),
);

// ── Refunds ────────────────────────────────────────────────────────────────

paymentsRoutes.get(
  '/refunds',
  requirePermission('settings.view'),
  asyncHandler(paymentsController.listRefunds),
);

// ── Webhooks ───────────────────────────────────────────────────────────────

paymentsRoutes.get(
  '/webhooks',
  requirePermission('settings.view'),
  asyncHandler(paymentsController.listWebhooks),
);
