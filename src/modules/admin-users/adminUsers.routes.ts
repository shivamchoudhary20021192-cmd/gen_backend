import { Router } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { idempotency } from '../../middleware/idempotency';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../auth/auth.schemas';
import { adminUsersController } from './adminUsers.controller';
import {
  createAdminSchema,
  listAdminsQuerySchema,
  resetPasswordSchema,
  setRolesSchema,
  updateAdminSchema,
} from './adminUsers.schemas';

export const adminUsersRoutes = Router();

// Every route below this line requires a valid session.
adminUsersRoutes.use(authenticate);

adminUsersRoutes.get(
  '/',
  requirePermission('admins.view'),
  validate({ query: listAdminsQuerySchema }),
  asyncHandler(adminUsersController.list),
);

adminUsersRoutes.post(
  '/',
  requirePermission('admins.manage'),
  idempotency,
  validate({ body: createAdminSchema }),
  asyncHandler(adminUsersController.create),
);

adminUsersRoutes.get(
  '/:id',
  requirePermission('admins.view'),
  validate({ params: idParamSchema }),
  asyncHandler(adminUsersController.get),
);

adminUsersRoutes.patch(
  '/:id',
  requirePermission('admins.manage'),
  validate({ params: idParamSchema, body: updateAdminSchema }),
  asyncHandler(adminUsersController.update),
);

adminUsersRoutes.delete(
  '/:id',
  requirePermission('admins.manage'),
  validate({ params: idParamSchema }),
  asyncHandler(adminUsersController.remove),
);

// Role assignment is a separate permission from editing a profile: changing
// who can issue refunds is a bigger deal than fixing a typo in a job title.
adminUsersRoutes.post(
  '/:id/roles',
  requirePermission('roles.manage'),
  validate({ params: idParamSchema, body: setRolesSchema }),
  asyncHandler(adminUsersController.setRoles),
);

adminUsersRoutes.post(
  '/:id/suspend',
  requirePermission('admins.manage'),
  validate({ params: idParamSchema }),
  asyncHandler(adminUsersController.suspend),
);

adminUsersRoutes.post(
  '/:id/activate',
  requirePermission('admins.manage'),
  validate({ params: idParamSchema }),
  asyncHandler(adminUsersController.activate),
);

adminUsersRoutes.post(
  '/:id/resend-invitation',
  requirePermission('admins.manage'),
  validate({ params: idParamSchema }),
  asyncHandler(adminUsersController.resendInvitation),
);

adminUsersRoutes.post(
  '/:id/reset-password',
  requirePermission('admins.manage'),
  validate({ params: idParamSchema, body: resetPasswordSchema }),
  asyncHandler(adminUsersController.resetPassword),
);

adminUsersRoutes.get(
  '/:id/permissions',
  requirePermission('admins.view'),
  validate({ params: idParamSchema }),
  asyncHandler(adminUsersController.permissions),
);
