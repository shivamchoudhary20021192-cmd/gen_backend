import { Router } from 'express';
import * as controller from './lookups.controller';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';

const router = Router();

// ============================================================================
// READ ROUTES (any signed-in staff member — lookup values belong to a shop)
// ============================================================================

// Get all categories
router.get('/categories', authenticate, controller.getCategories);

// Get all lookups (optionally filtered by categories)
// Examples:
//   GET /api/v1/lookups
//   GET /api/v1/lookups?categories=benefits,skin_types,skin_concerns
router.get('/', authenticate, controller.getAllValues);

// Search lookup values
// GET /api/v1/lookups/search?q=hydrating&category=benefits
router.get('/search', authenticate, controller.searchValues);

// Get values by category code
// GET /api/v1/lookups/benefits
// GET /api/v1/lookups/skin_types
router.get('/:categoryCode', authenticate, controller.getValuesByCategory);

// ============================================================================
// ADMIN ROUTES (Require authentication + permissions)
// ============================================================================

// Create new category
router.post(
  '/admin/categories',
  authenticate,
  requirePermission('lookups.create'),
  controller.createCategory,
);

// Update category
router.put(
  '/admin/categories/:id',
  authenticate,
  requirePermission('lookups.update'),
  controller.updateCategory,
);

// Create new value
router.post(
  '/admin/values',
  authenticate,
  requirePermission('lookups.create'),
  controller.createValue,
);

// Update value
router.put(
  '/admin/values/:id',
  authenticate,
  requirePermission('lookups.update'),
  controller.updateValue,
);

// Delete value
router.delete(
  '/admin/values/:id',
  authenticate,
  requirePermission('lookups.delete'),
  controller.deleteValue,
);

// Reorder values within a category
router.post(
  '/admin/categories/:categoryId/reorder',
  authenticate,
  requirePermission('lookups.update'),
  controller.reorderValues,
);

export default router;
