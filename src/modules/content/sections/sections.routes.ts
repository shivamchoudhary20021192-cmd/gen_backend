import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../../core/asyncHandler';
import { authenticate, type AuthRequest } from '../../../middleware/authenticate';
import { requirePermission } from '../../../middleware/requirePermission';
import { validate } from '../../../middleware/validate';
import {
  assignmentUpdateSchema,
  attachSchema,
  blockBodySchema,
  blockParamSchema,
  blockUpdateSchema,
  hotspotsSchema,
  ownerAssignmentParamSchema,
  ownerParamSchema,
  reorderSchema,
  sectionBodySchema,
  sectionIdParamSchema,
  sectionListQuerySchema,
  sectionUpdateSchema,
} from './sections.schemas';
import { sectionsService } from './sections.service';
import type { BlockInput, HotspotInput, SectionInput } from './sections.types';

/**
 * The section library, and what is attached to a product.
 *
 * Two routers because they are two different things to a person: "the packaging
 * story we wrote" lives in a library, and "what is on this product" lives on
 * the product. Behind the content permissions — the same people who write
 * banners write these.
 */

export const sectionsRouter = Router();
sectionsRouter.use(authenticate);

// ── the library ─────────────────────────────────────────────────────────────
sectionsRouter.get(
  '/',
  requirePermission('cms.view'),
  validate({ query: sectionListQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(
      await sectionsService.list({
        sectionKey: typeof req.query.kind === 'string' ? req.query.kind : undefined,
        search: typeof req.query.q === 'string' ? req.query.q : undefined,
      }),
    );
  }),
);

sectionsRouter.get(
  '/:id',
  requirePermission('cms.view'),
  validate({ params: sectionIdParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await sectionsService.get(Number(req.params.id)));
  }),
);

sectionsRouter.post(
  '/',
  requirePermission('cms.edit'),
  validate({ body: sectionBodySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(201).json(await sectionsService.create(req.body as SectionInput, req.admin));
  }),
);

sectionsRouter.patch(
  '/:id',
  requirePermission('cms.edit'),
  validate({ params: sectionIdParamSchema, body: sectionUpdateSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res
      .status(200)
      .json(await sectionsService.update(Number(req.params.id), req.body as SectionInput, req.admin));
  }),
);

sectionsRouter.delete(
  '/:id',
  requirePermission('cms.delete'),
  validate({ params: sectionIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(await sectionsService.remove(Number(req.params.id), req.admin));
  }),
);

// ── blocks ──────────────────────────────────────────────────────────────────
sectionsRouter.post(
  '/:id/blocks',
  requirePermission('cms.edit'),
  validate({ params: sectionIdParamSchema, body: blockBodySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res
      .status(201)
      .json(await sectionsService.addBlock(Number(req.params.id), req.body as BlockInput, req.admin));
  }),
);

sectionsRouter.patch(
  '/:id/blocks/:blockId',
  requirePermission('cms.edit'),
  validate({ params: blockParamSchema, body: blockUpdateSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(
      await sectionsService.updateBlock(
        Number(req.params.id),
        Number(req.params.blockId),
        req.body as BlockInput,
        req.admin,
      ),
    );
  }),
);

sectionsRouter.delete(
  '/:id/blocks/:blockId',
  requirePermission('cms.edit'),
  validate({ params: blockParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res
      .status(200)
      .json(
        await sectionsService.removeBlock(
          Number(req.params.id),
          Number(req.params.blockId),
          req.admin,
        ),
      );
  }),
);

sectionsRouter.put(
  '/:id/blocks/order',
  requirePermission('cms.edit'),
  validate({ params: sectionIdParamSchema, body: reorderSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res
      .status(200)
      .json(
        await sectionsService.reorderBlocks(
          Number(req.params.id),
          (req.body as { ids: number[] }).ids,
          req.admin,
        ),
      );
  }),
);

// ── hotspots ────────────────────────────────────────────────────────────────
// Replaced wholesale rather than patched one at a time: the editor is a picture
// people drag dots around on, and "save what is on the image now" is the only
// operation that matches what they are doing.
sectionsRouter.put(
  '/:id/blocks/:blockId/hotspots',
  requirePermission('cms.edit'),
  validate({ params: blockParamSchema, body: hotspotsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(
      await sectionsService.setHotspots(
        Number(req.params.id),
        Number(req.params.blockId),
        (req.body as { hotspots: HotspotInput[] }).hotspots,
        req.admin,
      ),
    );
  }),
);

// ── what is attached to a product ───────────────────────────────────────────
export const productSectionsRouter = Router({ mergeParams: true });
productSectionsRouter.use(authenticate);

productSectionsRouter.get(
  '/',
  requirePermission('cms.view'),
  validate({ params: ownerParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await sectionsService.listFor('product', Number(req.params.productId)));
  }),
);

productSectionsRouter.post(
  '/',
  requirePermission('cms.edit'),
  validate({ params: ownerParamSchema, body: attachSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(201).json(
      await sectionsService.attach(
        'product',
        Number(req.params.productId),
        (req.body as { section_id: number }).section_id,
        req.admin,
      ),
    );
  }),
);

productSectionsRouter.patch(
  '/:assignmentId',
  requirePermission('cms.edit'),
  validate({ params: ownerAssignmentParamSchema, body: assignmentUpdateSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(
      await sectionsService.updateAssignment(
        'product',
        Number(req.params.productId),
        Number(req.params.assignmentId),
        req.body as { is_enabled?: boolean },
        req.admin,
      ),
    );
  }),
);

productSectionsRouter.delete(
  '/:assignmentId',
  requirePermission('cms.edit'),
  validate({ params: ownerAssignmentParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(
      await sectionsService.detach(
        'product',
        Number(req.params.productId),
        Number(req.params.assignmentId),
        req.admin,
      ),
    );
  }),
);

productSectionsRouter.put(
  '/order',
  requirePermission('cms.edit'),
  validate({ params: ownerParamSchema, body: reorderSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(200).json(
      await sectionsService.reorder(
        'product',
        Number(req.params.productId),
        (req.body as { ids: number[] }).ids,
        req.admin,
      ),
    );
  }),
);
