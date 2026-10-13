import { Router } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { idempotency } from '../../middleware/idempotency';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { catalogController as c } from './catalog.controller';
import {
  adoptSchema,
  bulkSchema,
  classicQuerySchema,
  definitionBodySchema,
  definitionsQuerySchema,
  duplicateSchema,
  entriesQuerySchema,
  entryBodySchema,
  entryParamSchema,
  idParamSchema,
  listQuerySchema,
  metaobjectDefinitionBodySchema,
  pinnedSchema,
  productBodySchema,
  referencesParamSchema,
  referencesQuerySchema,
  suggestionsQuerySchema,
  taxonomyQuerySchema,
  typeParamSchema,
  variantsPatchSchema,
} from './catalog.schemas';

/**
 * Products (new) — /api/v1/catalog. The classic /products API is untouched;
 * a product moved here is read-only there (CATALOG_MANAGED).
 */
export const catalogRoutes = Router();
catalogRoutes.use(authenticate);

// ── lookups the editor needs ─────────────────────────────────────────────────
catalogRoutes.get('/field-types', requirePermission('products.view'), asyncHandler(c.fieldTypes));
catalogRoutes.get('/taxonomy', requirePermission('products.view'), validate({ query: taxonomyQuerySchema }), asyncHandler(c.taxonomy));
catalogRoutes.get('/suggestions', requirePermission('products.view'), validate({ query: suggestionsQuerySchema }), asyncHandler(c.suggestions));
catalogRoutes.get(
  '/references/:kind',
  requirePermission('products.view'),
  validate({ params: referencesParamSchema, query: referencesQuerySchema }),
  asyncHandler(c.references),
);

// ── products ─────────────────────────────────────────────────────────────────
catalogRoutes.get('/products', requirePermission('products.view'), validate({ query: listQuerySchema }), asyncHandler(c.list));
catalogRoutes.get('/products/new', requirePermission('products.create'), asyncHandler(c.blank));
catalogRoutes.post('/products', requirePermission('products.create'), idempotency, validate({ body: productBodySchema }), asyncHandler(c.create));
// Before /products/:id so "bulk" is not read as an id.
catalogRoutes.post('/products/bulk', requirePermission('products.update'), validate({ body: bulkSchema }), asyncHandler(c.bulk));
catalogRoutes.get('/products/:id', requirePermission('products.view'), validate({ params: idParamSchema }), asyncHandler(c.get));
catalogRoutes.patch('/products/:id', requirePermission('products.update'), validate({ params: idParamSchema, body: productBodySchema }), asyncHandler(c.update));
catalogRoutes.delete('/products/:id', requirePermission('products.delete'), validate({ params: idParamSchema }), asyncHandler(c.remove));
catalogRoutes.post(
  '/products/:id/duplicate',
  requirePermission('products.create'),
  idempotency,
  validate({ params: idParamSchema, body: duplicateSchema }),
  asyncHandler(c.duplicate),
);
catalogRoutes.patch(
  '/products/:id/variants',
  requirePermission('products.update'),
  validate({ params: idParamSchema, body: variantsPatchSchema }),
  asyncHandler(c.updateVariants),
);

// ── classic products → Products (new) ────────────────────────────────────────
catalogRoutes.get('/classic', requirePermission('products.update'), validate({ query: classicQuerySchema }), asyncHandler(c.classic));
catalogRoutes.post('/classic/adopt', requirePermission('products.update'), validate({ body: adoptSchema }), asyncHandler(c.adopt));

// ── custom fields (metafield definitions) ────────────────────────────────────
catalogRoutes.get('/definitions', requirePermission('products.view'), validate({ query: definitionsQuerySchema }), asyncHandler(c.definitions));
catalogRoutes.post('/definitions', requirePermission('custom_data.manage'), validate({ body: definitionBodySchema }), asyncHandler(c.createDefinition));
catalogRoutes.put('/definitions/pinned', requirePermission('custom_data.manage'), validate({ body: pinnedSchema }), asyncHandler(c.setPinned));
catalogRoutes.get('/definitions/:id', requirePermission('products.view'), validate({ params: idParamSchema }), asyncHandler(c.definition));
catalogRoutes.patch(
  '/definitions/:id',
  requirePermission('custom_data.manage'),
  validate({ params: idParamSchema, body: definitionBodySchema }),
  asyncHandler(c.updateDefinition),
);
catalogRoutes.delete('/definitions/:id', requirePermission('custom_data.manage'), validate({ params: idParamSchema }), asyncHandler(c.removeDefinition));

// ── metaobject types and their entries ───────────────────────────────────────
catalogRoutes.get('/metaobject-definitions', requirePermission('products.view'), asyncHandler(c.metaobjectDefinitions));
catalogRoutes.post(
  '/metaobject-definitions',
  requirePermission('custom_data.manage'),
  validate({ body: metaobjectDefinitionBodySchema }),
  asyncHandler(c.createMetaobjectDefinition),
);
catalogRoutes.get('/metaobject-definitions/:id', requirePermission('products.view'), validate({ params: idParamSchema }), asyncHandler(c.metaobjectDefinition));
catalogRoutes.patch(
  '/metaobject-definitions/:id',
  requirePermission('custom_data.manage'),
  validate({ params: idParamSchema, body: metaobjectDefinitionBodySchema }),
  asyncHandler(c.updateMetaobjectDefinition),
);
catalogRoutes.delete(
  '/metaobject-definitions/:id',
  requirePermission('custom_data.manage'),
  validate({ params: idParamSchema }),
  asyncHandler(c.removeMetaobjectDefinition),
);

catalogRoutes.get('/metaobjects/:type', requirePermission('products.view'), validate({ params: typeParamSchema, query: entriesQuerySchema }), asyncHandler(c.entries));
catalogRoutes.post('/metaobjects/:type', requirePermission('metaobjects.manage'), validate({ params: typeParamSchema, body: entryBodySchema }), asyncHandler(c.createEntry));
catalogRoutes.get('/metaobjects/:type/:id', requirePermission('products.view'), validate({ params: entryParamSchema }), asyncHandler(c.entry));
catalogRoutes.patch(
  '/metaobjects/:type/:id',
  requirePermission('metaobjects.manage'),
  validate({ params: entryParamSchema, body: entryBodySchema }),
  asyncHandler(c.updateEntry),
);
catalogRoutes.delete('/metaobjects/:type/:id', requirePermission('metaobjects.manage'), validate({ params: entryParamSchema }), asyncHandler(c.removeEntry));
