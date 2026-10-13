import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { clientIp } from '../../middleware/requestContext';
import { idParamSchema } from '../auth/auth.schemas';
import { createRoleSchema, updateRoleSchema } from '../admin-users/adminUsers.schemas';
import { rolesService } from './roles.service';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const rolesRoutes = Router();
rolesRoutes.use(authenticate);

rolesRoutes.get(
  '/',
  requirePermission('admins.view', 'roles.manage'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await rolesService.list());
  }),
);

rolesRoutes.post(
  '/',
  requirePermission('roles.manage'),
  validate({ body: createRoleSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body as { role: Parameters<typeof rolesService.create>[0] }).role;
    res.status(201).json(await rolesService.create(body, req.admin!, meta(req)));
  }),
);

rolesRoutes.get(
  '/:id',
  requirePermission('admins.view', 'roles.manage'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await rolesService.get(id));
  }),
);

rolesRoutes.patch(
  '/:id',
  requirePermission('roles.manage'),
  validate({ params: idParamSchema, body: updateRoleSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = (req.body as { role: Parameters<typeof rolesService.update>[1] }).role;
    res.status(200).json(await rolesService.update(id, body, req.admin!, meta(req)));
  }),
);

rolesRoutes.delete(
  '/:id',
  requirePermission('roles.manage'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    await rolesService.remove(id, req.admin!, meta(req));
    res.status(204).send();
  }),
);

/** Separate router so it can mount at /permissions rather than /roles/permissions. */
export const permissionsRoutes = Router();
permissionsRoutes.use(authenticate);
permissionsRoutes.get(
  '/',
  requirePermission('admins.view', 'roles.manage'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await rolesService.listPermissions());
  }),
);
