import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../auth/auth.schemas';
import { customersService } from './customers.service';

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'blocked', 'deleted']).optional(),
  cod_blocked: z.coerce.boolean().optional(),
  marketing: z.enum(['email', 'sms', 'whatsapp']).optional(),
  has_orders: z.coerce.boolean().optional(),
  sort: z.string().max(60).optional(),
});

const updateCustomerSchema = z.object({
  customer: z
    .object({
      email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(191).nullish(),
      first_name: z.string().trim().max(80).nullish(),
      last_name: z.string().trim().max(80).nullish(),
      gender: z.enum(['female', 'male', 'other', 'undisclosed']).nullish(),
      date_of_birth: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.')
        .nullish(),
      skin_type_id: z.coerce.number().int().positive().nullish(),
      primary_concern_id: z.coerce.number().int().positive().nullish(),
      preferred_language: z.string().trim().max(10).nullish(),
      accepts_email_marketing: z.boolean().optional(),
      accepts_sms_marketing: z.boolean().optional(),
      accepts_whatsapp_marketing: z.boolean().optional(),
      // Set after repeated RTOs; the checkout reads it to hide cash on delivery.
      cod_blocked: z.boolean().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, 'Provide at least one field to update.'),
});

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const customersRoutes = Router();
customersRoutes.use(authenticate);

customersRoutes.get(
  '/',
  requirePermission('customers.view'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await customersService.list(req.query as Record<string, unknown>));
  }),
);

customersRoutes.get(
  '/:id',
  requirePermission('customers.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await customersService.get(id));
  }),
);

customersRoutes.patch(
  '/:id',
  requirePermission('customers.update'),
  validate({ params: idParamSchema, body: updateCustomerSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = (req.body as { customer: Record<string, unknown> }).customer;
    res.status(200).json(await customersService.update(id, body, req.admin!, meta(req)));
  }),
);

/**
 * Blocking is an action, not a field.
 *
 * It revokes sessions as a side effect, so it cannot be a PATCH on `status`
 * without that side effect becoming invisible in the audit trail.
 */
customersRoutes.post(
  '/:id/block',
  requirePermission('customers.update'),
  validate({
    params: idParamSchema,
    body: z.object({ reason: z.string().trim().max(255).nullish() }).default({}),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const { reason } = (req.body ?? {}) as { reason?: string | null };
    res.status(200).json(await customersService.setStatus(id, 'blocked', reason ?? null, req.admin!, meta(req)));
  }),
);

customersRoutes.post(
  '/:id/unblock',
  requirePermission('customers.update'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await customersService.setStatus(id, 'active', null, req.admin!, meta(req)));
  }),
);

customersRoutes.get(
  '/:id/notes',
  requirePermission('customers.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const detail = await customersService.get(id);
    res.status(200).json({ notes: detail.customer.notes });
  }),
);

customersRoutes.post(
  '/:id/notes',
  requirePermission('customers.update'),
  validate({
    params: idParamSchema,
    body: z.object({
      note: z.string().trim().min(1, 'Write something.').max(5000),
      is_pinned: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const { note, is_pinned } = req.body as { note: string; is_pinned: boolean };
    res.status(201).json(await customersService.addNote(id, note, is_pinned, req.admin!));
  }),
);

customersRoutes.delete(
  '/:id/notes/:noteId',
  requirePermission('customers.update'),
  validate({
    params: z.object({
      id: z.coerce.number().int().positive(),
      noteId: z.coerce.number().int().positive(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id, noteId } = req.params as unknown as { id: number; noteId: number };
    res.status(200).json(await customersService.removeNote(id, noteId));
  }),
);

customersRoutes.delete(
  '/:id',
  requirePermission('customers.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    await customersService.remove(id, req.admin!, meta(req));
    res.status(204).send();
  }),
);
