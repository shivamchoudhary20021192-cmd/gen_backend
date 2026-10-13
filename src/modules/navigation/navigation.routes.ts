import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { clientIp } from '../../middleware/requestContext';
import { requirePlatformAdmin } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../auth/auth.schemas';
import { navigationService } from './navigation.service';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

/**
 * GET /menu-navigation
 *
 * Mounted at the API root (not under a resource) because it is not a resource —
 * it is "what can this person see". Any authenticated admin may call it; the
 * response is already scoped to them.
 */
export const menuNavigationRoutes = Router();
menuNavigationRoutes.use(authenticate);

menuNavigationRoutes.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await navigationService.forAdmin(req.admin!));
  }),
);

/**
 * Editing the menu itself is restricted to super admins. A role that could
 * rewrite the navigation could quietly surface links to screens it was never
 * meant to reach — the endpoints would still refuse, but the intent is wrong.
 */
export const menuItemsRoutes = Router();
// The admin menu is the same for every shop, so editing it is a platform
// operation: a shop owner changing it would change it for everyone.
menuItemsRoutes.use(authenticate, requirePlatformAdmin);

menuItemsRoutes.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await navigationService.listAll());
  }),
);

const updateMenuItemSchema = z.object({
  menu_item: z
    .object({
      title: z.string().trim().min(1).max(120).optional(),
      subtitle: z.string().trim().max(191).nullish(),
      icon: z.string().trim().max(60).nullish(),
      section: z.string().trim().max(60).nullish(),
      sort_order: z.coerce.number().int().min(0).max(9999).optional(),
      status: z.enum(['available', 'coming_soon', 'hidden']).optional(),
      is_active: z.boolean().optional(),
      permission_slugs: z.array(z.string().trim().max(80)).max(20).optional(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update.'),
});

menuItemsRoutes.patch(
  '/:id',
  validate({ params: idParamSchema, body: updateMenuItemSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = (req.body as { menu_item: Parameters<typeof navigationService.update>[1] }).menu_item;
    res.status(200).json(await navigationService.update(id, body, req.admin!, meta(req)));
  }),
);

menuItemsRoutes.post(
  '/reorder',
  validate({
    body: z.object({
      items: z
        .array(
          z.object({
            id: z.coerce.number().int().positive(),
            sort_order: z.coerce.number().int().min(0),
            parent_id: z.coerce.number().int().positive().nullish(),
          }),
        )
        .min(1)
        .max(200),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { items } = req.body as { items: { id: number; sort_order: number; parent_id?: number | null }[] };
    res.status(200).json(await navigationService.reorder(items));
  }),
);
