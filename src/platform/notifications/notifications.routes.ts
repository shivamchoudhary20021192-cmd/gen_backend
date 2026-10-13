import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../core/ApiError';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission, requireStaff } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { NOTIFICATIONS } from './catalog';
import { notificationEngine } from './notificationEngine';

/** Settings → Notifications: which automatic messages go out, on which channels. */
export const notificationPreferencesRoutes = Router();
notificationPreferencesRoutes.use(authenticate, requireStaff);

notificationPreferencesRoutes.get(
  '/',
  requirePermission('notifications.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await notificationEngine.listPreferences());
  }),
);

notificationPreferencesRoutes.put(
  '/',
  requirePermission('notifications.manage'),
  validate({
    body: z.object({
      key: z.enum(NOTIFICATIONS.map((definition) => definition.key) as [string, ...string[]]),
      channel: z.enum(['email', 'sms', 'whatsapp']),
      enabled: z.boolean(),
      recipients: z.array(z.string().trim().toLowerCase().email()).max(20).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    try {
      res.json(await notificationEngine.setPreference(req.body, req.admin?.id ?? null));
    } catch (error) {
      throw ApiError.validation({ channel: [error instanceof Error ? error.message : 'Not available.'] });
    }
  }),
);
