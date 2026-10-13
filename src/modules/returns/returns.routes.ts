import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { idempotency } from '../../middleware/idempotency';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../auth/auth.schemas';
import { returnsService } from './returns.service';

const RETURN_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'pickup_scheduled',
  'picked_up',
  'received',
  'inspected',
  'refunded',
  'closed',
] as const;

const RETURN_REASONS = [
  'damaged',
  'wrong_item',
  'missing_item',
  'not_as_described',
  'adverse_reaction',
  'changed_mind',
  'late_delivery',
  'expired_product',
  'other',
] as const;

const CONDITIONS = ['unopened', 'opened', 'damaged', 'used', 'unknown'] as const;

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.enum(RETURN_STATUSES).optional(),
  reason: z.enum(RETURN_REASONS).optional(),
  order_id: z.coerce.number().int().positive().optional(),
  customer_id: z.coerce.number().int().positive().optional(),
  open: z.coerce.boolean().optional(),
  sort: z.string().max(40).optional(),
});

const createSchema = z.object({
  order_id: z.coerce.number().int().positive(),
  reason: z.enum(RETURN_REASONS),
  reason_detail: z.string().trim().max(2000).nullish(),
  refund_method: z.enum(['original', 'store_credit', 'bank_transfer', 'none']).default('original'),
  items: z
    .array(
      z.object({
        order_item_id: z.coerce.number().int().positive(),
        quantity: z.coerce.number().int().positive().max(999),
      }),
    )
    .min(1, 'Choose at least one item to return.')
    .max(200),
});

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const returnsRoutes = Router();
returnsRoutes.use(authenticate);

returnsRoutes.get(
  '/',
  requirePermission('orders.view'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await returnsService.list(req.query as Record<string, unknown>));
  }),
);

returnsRoutes.get(
  '/counts',
  requirePermission('orders.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await returnsService.statusCounts());
  }),
);

/**
 * What of an order could still come back.
 *
 * The return form calls this before it offers anything, so it cannot present a
 * quantity that `POST /returns` would then refuse.
 */
returnsRoutes.get(
  '/returnable/:orderId',
  requirePermission('orders.view'),
  validate({ params: z.object({ orderId: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { orderId } = req.params as unknown as { orderId: number };
    res.status(200).json(await returnsService.returnableFor(orderId));
  }),
);

returnsRoutes.get(
  '/:id',
  requirePermission('orders.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await returnsService.get(id));
  }),
);

returnsRoutes.post(
  '/',
  requirePermission('orders.update'),
  idempotency,
  validate({ body: createSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await returnsService.create(req.body, req.admin!, meta(req)));
  }),
);

returnsRoutes.post(
  '/:id/status',
  requirePermission('orders.update'),
  validate({
    params: idParamSchema,
    body: z.object({
      status: z.enum(RETURN_STATUSES),
      note: z.string().trim().max(2000).nullish(),
      reason: z.string().trim().max(500).nullish(),
      approved_amount: z.coerce.number().nonnegative().max(10_000_000).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = req.body as { status: string };
    res.status(200).json(await returnsService.changeStatus(id, body.status, req.body, req.admin!, meta(req)));
  }),
);

returnsRoutes.post(
  '/:id/schedule-pickup',
  requirePermission('orders.fulfil'),
  idempotency,
  validate({
    params: idParamSchema,
    body: z.object({ carrier_id: z.coerce.number().int().positive().nullish() }).default({}),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const { carrier_id } = (req.body ?? {}) as { carrier_id?: number | null };
    res.status(200).json(await returnsService.schedulePickup(id, carrier_id ?? null, req.admin!, meta(req)));
  }),
);

returnsRoutes.post(
  '/:id/inspect',
  requirePermission('orders.update'),
  validate({
    params: idParamSchema,
    body: z.object({
      note: z.string().trim().max(2000).nullish(),
      items: z
        .array(
          z.object({
            id: z.coerce.number().int().positive(),
            condition: z.enum(CONDITIONS),
            restock: z.boolean().default(false),
            condition_note: z.string().trim().max(500).nullish(),
          }),
        )
        .min(1)
        .max(200),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await returnsService.inspect(id, req.body, req.admin!, meta(req)));
  }),
);

/** Idempotent-keyed: a replayed refund must not pay the customer twice. */
returnsRoutes.post(
  '/:id/refund',
  requirePermission('orders.refund'),
  idempotency,
  validate({
    params: idParamSchema,
    body: z
      .object({
        amount: z.coerce.number().positive().max(10_000_000).optional(),
        note: z.string().trim().max(2000).nullish(),
      })
      .default({}),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await returnsService.refund(id, req.body ?? {}, req.admin!, meta(req)));
  }),
);
