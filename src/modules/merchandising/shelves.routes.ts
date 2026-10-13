import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { shelvesService } from './shelves.service';

const linkTypes = ['none', 'url', 'page', 'category', 'collection', 'product', 'article', 'policy'] as const;
const placements = ['home', 'shop', 'category', 'collection', 'product'] as const;
const layouts = ['carousel', 'grid', 'spotlight', 'ranked'] as const;

/**
 * `source` is deliberately a plain string here rather than a z.enum.
 *
 * The list of rules lives in `shelfRules.ts` and the service checks against it,
 * so adding a rule means editing one file. A duplicated enum in this schema
 * would be a second place to forget.
 */
const shelfSchema = z.object({
  title: z.string().trim().min(1).max(120),
  eyebrow: z.string().trim().max(60).nullish(),
  subtitle: z.string().trim().max(240).nullish(),
  placement: z.enum(placements).optional(),
  scope_ref_id: z.coerce.number().int().positive().nullish(),
  layout: z.enum(layouts).optional(),
  source: z.string().trim().min(1).max(40).optional(),
  source_collection_id: z.coerce.number().int().positive().nullish(),
  window_days: z.coerce.number().int().min(1).max(1095).nullish(),
  max_products: z.coerce.number().int().min(1).max(24).optional(),
  include_sold_out: z.boolean().optional(),
  tone: z.enum(['ivory', 'cream']).optional(),
  cta_label: z.string().trim().max(40).nullish(),
  link_type: z.enum(linkTypes).optional(),
  link_url: z.string().trim().max(500).nullish(),
  link_ref_id: z.coerce.number().int().positive().nullish(),
  starts_at: z.coerce.date().nullish(),
  ends_at: z.coerce.date().nullish(),
  is_active: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).max(9999).optional(),
  pinned_product_ids: z.array(z.coerce.number().int().positive()).max(24).optional(),
});

const router = Router();

router.use(authenticate);

/**
 * Gated on the CMS permission rather than on product editing.
 *
 * A shelf decides what the shop window shows, not what anything costs — the
 * person arranging the window is not necessarily the person who may change a
 * price, and making this `products.update` would hand every merchandiser the
 * catalogue.
 */
const canRead = requirePermission('cms.view');
const canWrite = requirePermission('cms.edit');

/** The rules, layouts and placements this build knows. Drives the admin form. */
router.get('/catalogue', canRead, asyncHandler(async (_req: Request, res: Response) => {
  res.json(shelvesService.catalogue());
}));

router.put(
  '/order',
  canWrite,
  validate({ body: z.object({ ids: z.array(z.coerce.number().int().positive()).max(100) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await shelvesService.reorder((req.body as { ids: number[] }).ids));
  }),
);

router.get('/', canRead, asyncHandler(async (req: Request, res: Response) => {
  res.json(await shelvesService.list(req.query.placement as string | undefined));
}));

router.post(
  '/',
  canWrite,
  validate({ body: shelfSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await shelvesService.create(req.body as Record<string, unknown>));
  }),
);

router.get('/:id', canRead, asyncHandler(async (req: Request, res: Response) => {
  res.json(await shelvesService.byId(Number(req.params.id)));
}));

/** What this shelf's rule would choose right now, live and uncached. */
router.get('/:id/preview', canRead, asyncHandler(async (req: Request, res: Response) => {
  res.json(await shelvesService.preview(Number(req.params.id)));
}));

router.patch(
  '/:id',
  canWrite,
  validate({ body: shelfSchema.partial() }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await shelvesService.update(Number(req.params.id), req.body as Record<string, unknown>));
  }),
);

router.delete('/:id', canWrite, asyncHandler(async (req: Request, res: Response) => {
  res.json(await shelvesService.remove(Number(req.params.id)));
}));

export { router as shelvesRoutes };
