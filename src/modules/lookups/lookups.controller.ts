import type { Request, Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { LookupsService } from './lookups.service';

// ============================================================================
// PUBLIC ENDPOINTS (No authentication required for reading)
// ============================================================================

/**
 * GET /api/v1/lookups/categories
 * Get all lookup categories
 */
export const getCategories = asyncHandler(async (req: Request, res: Response) => {
  const categories = await LookupsService.getCategories();

  res.json({
    success: true,
    categories,
  });
});

/**
 * GET /api/v1/lookups/:categoryCode
 * Get lookup values for a specific category
 */
export const getValuesByCategory = asyncHandler(async (req: Request, res: Response) => {
  const { categoryCode } = req.params;

  const values = await LookupsService.getValuesByCategory(categoryCode);

  res.json({
    success: true,
    category: categoryCode,
    values,
  });
});

/**
 * GET /api/v1/lookups
 * Get all lookup values grouped by category
 * Query params:
 *   ?categories=benefits,skin_types,skin_concerns  (optional: filter specific categories)
 */
export const getAllValues = asyncHandler(async (req: Request, res: Response) => {
  const categoriesParam = req.query.categories as string | undefined;

  let lookups;

  if (categoriesParam) {
    // Fetch specific categories
    const categoryCodes = categoriesParam.split(',').map((c) => c.trim());
    lookups = await LookupsService.getMultipleCategoriesWithValues(categoryCodes);
  } else {
    // Fetch all
    lookups = await LookupsService.getAllValuesGrouped();
  }

  res.json({
    success: true,
    lookups,
  });
});

/**
 * GET /api/v1/lookups/search
 * Search lookup values
 * Query params:
 *   ?q=hydrating
 *   ?category=benefits
 */
export const searchValues = asyncHandler(async (req: Request, res: Response) => {
  const query = (req.query.q as string) || '';
  const categoryCode = req.query.category as string | undefined;

  if (!query || query.trim().length < 2) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Search query must be at least 2 characters',
      },
    });
    return;
  }

  const results = await LookupsService.searchValues(query, categoryCode);

  res.json({
    success: true,
    query,
    results,
  });
});

// ============================================================================
// ADMIN ENDPOINTS (Require authentication + permissions)
// ============================================================================

/**
 * POST /admin/api/v1/lookups/categories
 * Create a new lookup category
 */
export const createCategory = asyncHandler(async (req: Request, res: Response) => {
  const { code, name, description, allow_custom, sort_order } = req.body;

  const id = await LookupsService.createCategory({
    code,
    name,
    description,
    allow_custom,
    sort_order,
  });

  res.status(201).json({
    success: true,
    category_id: id,
    message: 'Lookup category created',
  });
});

/**
 * PUT /admin/api/v1/lookups/categories/:id
 * Update a lookup category
 */
export const updateCategory = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name, description, allow_custom, is_active, sort_order } = req.body;

  await LookupsService.updateCategory(id, {
    name,
    description,
    allow_custom,
    is_active,
    sort_order,
  });

  res.json({
    success: true,
    message: 'Lookup category updated',
  });
});

/**
 * POST /admin/api/v1/lookups/values
 * Create a new lookup value
 */
export const createValue = asyncHandler(async (req: Request, res: Response) => {
  const { category_id, code, label, description, icon, color, metadata, sort_order } = req.body;

  const id = await LookupsService.createValue({
    category_id,
    code,
    label,
    description,
    icon,
    color,
    metadata,
    sort_order,
  });

  res.status(201).json({
    success: true,
    value_id: id,
    message: 'Lookup value created',
  });
});

/**
 * PUT /admin/api/v1/lookups/values/:id
 * Update a lookup value
 */
export const updateValue = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { label, description, icon, color, metadata, is_active, sort_order } = req.body;

  await LookupsService.updateValue(id, {
    label,
    description,
    icon,
    color,
    metadata,
    is_active,
    sort_order,
  });

  res.json({
    success: true,
    message: 'Lookup value updated',
  });
});

/**
 * DELETE /admin/api/v1/lookups/values/:id
 * Delete (soft delete) a lookup value
 */
export const deleteValue = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  await LookupsService.deleteValue(id);

  res.json({
    success: true,
    message: 'Lookup value deleted',
  });
});

/**
 * POST /admin/api/v1/lookups/categories/:categoryId/reorder
 * Reorder lookup values within a category
 * Body: { ordered_ids: [3, 1, 2, 5, 4] }
 */
export const reorderValues = asyncHandler(async (req: Request, res: Response) => {
  const categoryId = Number(req.params.categoryId);
  const { ordered_ids } = req.body;

  if (!Array.isArray(ordered_ids)) {
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'ordered_ids must be an array',
      },
    });
    return;
  }

  await LookupsService.reorderValues(categoryId, ordered_ids);

  res.json({
    success: true,
    message: 'Lookup values reordered',
  });
});
