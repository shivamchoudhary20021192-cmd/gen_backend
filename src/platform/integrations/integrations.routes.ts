import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission, requireStaff } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { connectionsService } from './connections.service';

/**
 * Settings → Integrations.
 *
 * Staff only: an installed app can do a great deal through the Admin API, but
 * it can never read, replace or remove the shop's payment or messaging
 * credentials. Reading needs integrations.view; anything that changes where
 * money or messages go needs integrations.manage.
 */
export const integrationsRoutes = Router();
integrationsRoutes.use(authenticate, requireStaff);

const canView = requirePermission('integrations.view');
const canManage = requirePermission('integrations.manage');

const idParam = z.object({ id: z.string().uuid() });
const credentials = z.record(z.string().max(60), z.string().max(4000));
const config = z.record(z.string().max(60), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]));

const connectBody = z.object({
  provider: z.string().trim().min(2).max(40),
  name: z.string().trim().max(120).optional(),
  credentials,
  config: config.optional(),
  make_default: z.boolean().optional(),
});

const updateBody = z.object({
  name: z.string().trim().max(120).optional(),
  credentials: credentials.optional(),
  config: config.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

function actor(req: Request) {
  return { id: req.admin?.id ?? null, label: req.admin?.email ?? null };
}

integrationsRoutes.get(
  '/catalog',
  canView,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(connectionsService.catalog());
  }),
);

integrationsRoutes.get(
  '/',
  canView,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await connectionsService.list());
  }),
);

integrationsRoutes.post(
  '/',
  canManage,
  validate({ body: connectBody }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await connectionsService.connect(req.body, actor(req)));
  }),
);

integrationsRoutes.get(
  '/:id',
  canView,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await connectionsService.get(String(req.params.id)));
  }),
);

integrationsRoutes.patch(
  '/:id',
  canManage,
  validate({ params: idParam, body: updateBody }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await connectionsService.update(String(req.params.id), req.body, actor(req)));
  }),
);

integrationsRoutes.post(
  '/:id/test',
  canManage,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await connectionsService.test(String(req.params.id)));
  }),
);

integrationsRoutes.post(
  '/:id/default',
  canManage,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await connectionsService.setDefault(String(req.params.id), actor(req)));
  }),
);

integrationsRoutes.delete(
  '/:id',
  canManage,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await connectionsService.disconnect(String(req.params.id), actor(req)));
  }),
);
