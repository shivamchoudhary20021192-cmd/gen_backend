import type { Request, Response } from 'express';
import { ApiError } from '../../core/ApiError';
import { clientIp } from '../../middleware/requestContext';
import { adoption } from './adopt';
import { catalogRepository, type ListFilters } from './catalog.repository';
import { catalogService, type BulkAction, type ProductInput, type VariantInput } from './catalog.service';
import { customDataService, type DefinitionInput, type MetaobjectDefinitionInput, type MetaobjectEntryInput, type OwnerType } from './customData.service';
import { typeCatalog, type ReferenceKind } from './fieldTypes';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

const idOf = (req: Request) => (req.params as unknown as { id: number }).id;

/** The product and the custom fields its editor shows (by its type and category). */
async function withFields(product: Awaited<ReturnType<typeof catalogService.get>>) {
  const [productFields, variantFields] = await Promise.all([
    catalogService.fieldsFor('product', { product_type: product.product_type, category_code: product.category?.code ?? null }),
    catalogService.fieldsFor('variant', {}),
  ]);
  return { product, fields: { product: productFields, variant: variantFields } };
}

export const catalogController = {
  // ── products ───────────────────────────────────────────────────────────────

  async list(req: Request, res: Response): Promise<void> {
    res.status(200).json(await catalogService.list(req.query as ListFilters));
  },

  async get(req: Request, res: Response): Promise<void> {
    res.status(200).json(await withFields(await catalogService.get(idOf(req))));
  },

  async create(req: Request, res: Response): Promise<void> {
    const { product } = req.body as { product: ProductInput };
    res.status(201).json(await withFields(await catalogService.create(product, req.admin!, meta(req))));
  },

  async update(req: Request, res: Response): Promise<void> {
    const { product } = req.body as { product: ProductInput };
    res.status(200).json(await withFields(await catalogService.update(idOf(req), product, req.admin!, meta(req))));
  },

  async remove(req: Request, res: Response): Promise<void> {
    await catalogService.remove(idOf(req), req.admin!, meta(req));
    res.status(204).send();
  },

  async duplicate(req: Request, res: Response): Promise<void> {
    res.status(201).json(await withFields(await catalogService.duplicate(idOf(req), req.body as { title?: string }, req.admin!, meta(req))));
  },

  async updateVariants(req: Request, res: Response): Promise<void> {
    const { version, variants } = req.body as { version?: number; variants: (VariantInput & { id: number })[] };
    res.status(200).json(await withFields(await catalogService.updateVariants(idOf(req), variants, version, req.admin!, meta(req))));
  },

  async bulk(req: Request, res: Response): Promise<void> {
    res.status(200).json(await catalogService.bulk(req.body as { ids: number[]; action: BulkAction }, req.admin!, meta(req)));
  },

  /** An empty product for the "Add product" screen: the fields that apply before a type is chosen. */
  async blank(_req: Request, res: Response): Promise<void> {
    const [productFields, variantFields, locations] = await Promise.all([
      catalogService.fieldsFor('product', {}),
      catalogService.fieldsFor('variant', {}),
      catalogRepository.locations(),
    ]);
    res.status(200).json({
      fields: { product: productFields, variant: variantFields },
      locations: locations.map((location) => ({ id: Number(location.id), name: location.name, is_default: Number(location.is_default) === 1 })),
    });
  },

  async suggestions(req: Request, res: Response): Promise<void> {
    const { field, q } = req.query as unknown as { field: 'vendor' | 'product_type' | 'tag'; q: string };
    res.status(200).json({ values: await catalogRepository.suggestions(field, q) });
  },

  async taxonomy(req: Request, res: Response): Promise<void> {
    res.status(200).json({ categories: await catalogRepository.taxonomy(req.query as { q?: string; parent?: string }) });
  },

  async fieldTypes(_req: Request, res: Response): Promise<void> {
    res.status(200).json(typeCatalog());
  },

  async references(req: Request, res: Response): Promise<void> {
    const { kind } = req.params as { kind: ReferenceKind };
    const { q, ids, metaobject_type } = req.query as { q?: string; ids?: number[]; metaobject_type?: string };
    const items = ids?.length ? await customDataService.resolveReferences(kind, ids) : await customDataService.searchReferences(kind, q ?? '', metaobject_type ?? null);
    res.status(200).json({ items });
  },

  // ── moving classic products ────────────────────────────────────────────────

  async classic(req: Request, res: Response): Promise<void> {
    res.status(200).json(await adoption.candidates(req.query as { q?: string; limit?: number }));
  },

  async adopt(req: Request, res: Response): Promise<void> {
    const { ids } = req.body as { ids: number[] };
    res.status(200).json(await adoption.adoptMany(ids, req.admin!, meta(req)));
  },

  // ── custom fields ──────────────────────────────────────────────────────────

  async definitions(req: Request, res: Response): Promise<void> {
    const { owner_type } = req.query as { owner_type: OwnerType };
    res.status(200).json({ definitions: await customDataService.definitions(owner_type, undefined, true) });
  },

  async definition(req: Request, res: Response): Promise<void> {
    res.status(200).json({ definition: await customDataService.definition(idOf(req)) });
  },

  async createDefinition(req: Request, res: Response): Promise<void> {
    const { definition } = req.body as { definition: DefinitionInput };
    res.status(201).json({ definition: await customDataService.createDefinition(definition, req.admin!, meta(req)) });
  },

  async updateDefinition(req: Request, res: Response): Promise<void> {
    const { definition } = req.body as { definition: DefinitionInput };
    res.status(200).json({ definition: await customDataService.updateDefinition(idOf(req), definition, req.admin!, meta(req)) });
  },

  async removeDefinition(req: Request, res: Response): Promise<void> {
    await customDataService.removeDefinition(idOf(req), req.admin!, meta(req));
    res.status(204).send();
  },

  async setPinned(req: Request, res: Response): Promise<void> {
    const { owner_type, ids } = req.body as { owner_type: OwnerType; ids: number[] };
    res.status(200).json({ definitions: await customDataService.setPinned(owner_type, ids) });
  },

  // ── metaobjects ────────────────────────────────────────────────────────────

  async metaobjectDefinitions(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ definitions: await customDataService.metaobjectDefinitions() });
  },

  async metaobjectDefinition(req: Request, res: Response): Promise<void> {
    res.status(200).json({ definition: await customDataService.metaobjectDefinition(idOf(req)) });
  },

  async createMetaobjectDefinition(req: Request, res: Response): Promise<void> {
    const { definition } = req.body as { definition: MetaobjectDefinitionInput };
    res.status(201).json({ definition: await customDataService.saveMetaobjectDefinition(null, definition, req.admin!, meta(req)) });
  },

  async updateMetaobjectDefinition(req: Request, res: Response): Promise<void> {
    const { definition } = req.body as { definition: MetaobjectDefinitionInput };
    res.status(200).json({ definition: await customDataService.saveMetaobjectDefinition(idOf(req), definition, req.admin!, meta(req)) });
  },

  async removeMetaobjectDefinition(req: Request, res: Response): Promise<void> {
    await customDataService.removeMetaobjectDefinition(idOf(req), req.admin!, meta(req));
    res.status(204).send();
  },

  async entries(req: Request, res: Response): Promise<void> {
    const { type } = req.params as { type: string };
    res.status(200).json(await customDataService.entries(type, req.query as { q?: string; limit?: number; after?: string }));
  },

  async entry(req: Request, res: Response): Promise<void> {
    const { type } = req.params as { type: string };
    const [definition, entry] = await Promise.all([customDataService.metaobjectType(type), customDataService.entry(idOf(req))]);
    if (entry.definition_id !== definition.id) throw ApiError.notFound('Entry');
    res.status(200).json({ definition, entry });
  },

  async createEntry(req: Request, res: Response): Promise<void> {
    const { type } = req.params as { type: string };
    const { entry } = req.body as { entry: MetaobjectEntryInput };
    res.status(201).json({ entry: await customDataService.saveEntry(type, null, entry, req.admin!, meta(req)) });
  },

  async updateEntry(req: Request, res: Response): Promise<void> {
    const { type } = req.params as { type: string };
    const { entry } = req.body as { entry: MetaobjectEntryInput };
    res.status(200).json({ entry: await customDataService.saveEntry(type, idOf(req), entry, req.admin!, meta(req)) });
  },

  async removeEntry(req: Request, res: Response): Promise<void> {
    const { type } = req.params as { type: string };
    await customDataService.removeEntry(type, idOf(req), req.admin!, meta(req));
    res.status(204).send();
  },
};
