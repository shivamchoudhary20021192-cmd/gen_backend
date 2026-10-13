import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { linkTargetsService } from './link-targets.service';

/**
 * What a link can point at, by name.
 *
 * Read-only, and behind authentication like everything else on the admin tree,
 * but with no `requirePermission` beyond that on purpose: this is a search box
 * inside forms that each carry their own permission. Someone who may edit a
 * banner must be able to find a product to point it at, and gating this
 * separately would mean a CTA field that silently returns nothing for half the
 * people allowed to use it.
 */
const router = Router();

router.use(authenticate);

/** GET /admin/api/v1/link-targets/types */
router.get(
  '/types',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ types: linkTargetsService.types() });
  }),
);

/** GET /admin/api/v1/link-targets/resolve?type=product&id=38 */
router.get(
  '/resolve',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await linkTargetsService.resolve(req.query as Record<string, unknown>));
  }),
);

/** GET /admin/api/v1/link-targets?type=product&q=serum&limit=25 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await linkTargetsService.search(req.query as Record<string, unknown>));
  }),
);

export { router as linkTargetsRoutes };
