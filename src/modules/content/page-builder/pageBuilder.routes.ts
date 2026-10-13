import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../core/asyncHandler';
import { authenticate } from '../../../middleware/authenticate';
import { requirePermission } from '../../../middleware/requirePermission';
import { validate } from '../../../middleware/validate';
import { pageBuilderService } from './pageBuilder.service';

/**
 * The page builder's admin API.
 *
 * Deliberately small. A section's *shape* comes from the catalogue endpoint and
 * its *content* is one settings blob, so there is no endpoint per section kind
 * and adding a kind needs no route at all — which is the whole reason the
 * schema lives in one file rather than in fourteen forms.
 */

const templateKey = z.object({ key: z.string().trim().min(1).max(60) });
const sectionParam = z.object({ id: z.coerce.number().int().positive() });
const blockParam = z.object({
  id: z.coerce.number().int().positive(),
  blockId: z.coerce.number().int().positive(),
});

const router = Router();
router.use(authenticate);

const canRead = requirePermission('cms.view');
const canWrite = requirePermission('cms.edit');

/** Every section kind this build can render, with its fields. */
router.get('/catalogue', canRead, asyncHandler(async (_req: Request, res: Response) => {
  res.json(pageBuilderService.catalogue());
}));

router.get('/templates', canRead, asyncHandler(async (_req: Request, res: Response) => {
  res.json(await pageBuilderService.templates());
}));

router.get(
  '/templates/:key',
  canRead,
  validate({ params: templateKey }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await pageBuilderService.forAdmin(String(req.params.key)));
  }),
);

router.post(
  '/templates/:key/sections',
  canWrite,
  validate({
    params: templateKey,
    body: z.object({
      section_key: z.string().trim().min(1).max(60),
      name: z.string().trim().max(120).optional(),
      /** Put it directly after this one. Omitted means the end of the page. */
      after_section_id: z.coerce.number().int().positive().nullish(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { section_key: string; name?: string; after_section_id?: number | null };
    res.status(201).json(await pageBuilderService.addSection(String(req.params.key), body));
  }),
);

router.put(
  '/templates/:key/order',
  canWrite,
  validate({
    params: templateKey,
    body: z.object({ section_ids: z.array(z.coerce.number().int().positive()).max(60) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { section_ids: ids } = req.body as { section_ids: number[] };
    res.json(await pageBuilderService.reorder(String(req.params.key), ids));
  }),
);

router.patch(
  '/sections/:id',
  canWrite,
  validate({
    params: sectionParam,
    body: z.object({
      name: z.string().trim().max(120).optional(),
      // Free-form on purpose: the schema decides which keys survive, and
      // repeating it here would be a second place to forget a field.
      settings: z.record(z.string(), z.unknown()).optional(),
      is_enabled: z.boolean().optional(),
      visible_from: z.coerce.date().nullish(),
      visible_until: z.coerce.date().nullish(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await pageBuilderService.updateSection(Number(req.params.id), req.body as Record<string, unknown>));
  }),
);

router.post(
  '/sections/:id/duplicate',
  canWrite,
  validate({ params: sectionParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await pageBuilderService.duplicateSection(Number(req.params.id)));
  }),
);

router.delete(
  '/sections/:id',
  canWrite,
  validate({ params: sectionParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await pageBuilderService.removeSection(Number(req.params.id)));
  }),
);

router.post(
  '/sections/:id/blocks',
  canWrite,
  validate({ params: sectionParam, body: z.object({ block_key: z.string().trim().min(1).max(60) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { block_key: blockKey } = req.body as { block_key: string };
    res.status(201).json(await pageBuilderService.addBlock(Number(req.params.id), blockKey));
  }),
);

router.patch(
  '/sections/:id/blocks/:blockId',
  canWrite,
  validate({ params: blockParam, body: z.record(z.string(), z.unknown()) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(
      await pageBuilderService.updateBlock(
        Number(req.params.id),
        Number(req.params.blockId),
        req.body as Record<string, unknown>,
      ),
    );
  }),
);

router.delete(
  '/sections/:id/blocks/:blockId',
  canWrite,
  validate({ params: blockParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await pageBuilderService.removeBlock(Number(req.params.id), Number(req.params.blockId)));
  }),
);

router.put(
  '/sections/:id/blocks/order',
  canWrite,
  validate({ params: sectionParam, body: z.object({ block_ids: z.array(z.coerce.number().int().positive()).max(60) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { block_ids: ids } = req.body as { block_ids: number[] };
    res.json(await pageBuilderService.reorderBlocks(Number(req.params.id), ids));
  }),
);

export { router as pageBuilderRoutes };
