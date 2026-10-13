import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../auth/auth.schemas';
import { shipmentsService } from './shipments.service';

const SHIPMENT_STATUSES = [
  'created',
  'label_generated',
  'pickup_scheduled',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'ndr',
  'rto_initiated',
  'rto_in_transit',
  'rto_delivered',
  'lost',
  'damaged',
  'cancelled',
] as const;

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.enum(SHIPMENT_STATUSES).optional(),
  carrier_id: z.coerce.number().int().positive().optional(),
  order_id: z.coerce.number().int().positive().optional(),
  open: z.coerce.boolean().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional(),
  sort: z.string().max(40).optional(),
});

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const shipmentsRoutes = Router();
shipmentsRoutes.use(authenticate);

shipmentsRoutes.get(
  '/',
  requirePermission('orders.view'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await shipmentsService.list(req.query as Record<string, unknown>));
  }),
);

/** Registered before /:id so these are not read as shipment ids. */
shipmentsRoutes.get(
  '/counts',
  requirePermission('orders.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await shipmentsService.statusCounts());
  }),
);

shipmentsRoutes.get(
  '/carriers',
  requirePermission('orders.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await shipmentsService.carriers());
  }),
);

shipmentsRoutes.get(
  '/:id',
  requirePermission('orders.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await shipmentsService.get(id));
  }),
);

/**
 * Asks the carrier where the parcel is and stores anything new.
 *
 * A POST rather than a GET because it writes: it appends tracking events and
 * can move the shipment's status. Making it a GET would mean a browser prefetch
 * could advance a shipment.
 */
shipmentsRoutes.post(
  '/:id/refresh-tracking',
  requirePermission('orders.fulfil'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await shipmentsService.refreshTracking(id, req.admin!, meta(req)));
  }),
);

shipmentsRoutes.post(
  '/:id/status',
  requirePermission('orders.fulfil'),
  validate({
    params: idParamSchema,
    body: z.object({
      status: z.enum(SHIPMENT_STATUSES),
      note: z.string().trim().max(500).nullish(),
      // Required by the service for NDR and RTO, where "why" is the whole point
      // of the record.
      reason: z.string().trim().max(255).nullish(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = req.body as { status: string; note?: string | null; reason?: string | null };
    res.status(200).json(await shipmentsService.changeStatus(id, body.status, body, req.admin!, meta(req)));
  }),
);

shipmentsRoutes.post(
  '/:id/cancel',
  requirePermission('orders.fulfil'),
  validate({
    params: idParamSchema,
    body: z.object({ reason: z.string().trim().min(3, 'Give a reason.').max(255) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const { reason } = req.body as { reason: string };
    res.status(200).json(await shipmentsService.cancel(id, reason, req.admin!, meta(req)));
  }),
);
