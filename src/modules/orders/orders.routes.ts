import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { idempotency } from '../../middleware/idempotency';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../auth/auth.schemas';
import { ordersService } from './orders.service';

const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'packed',
  'shipped',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'returned',
  'rto',
] as const;

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  order_status: z.enum(ORDER_STATUSES).optional(),
  payment_status: z
    .enum([
      'pending',
      'authorized',
      'paid',
      'cod_pending',
      'cod_collected',
      'partially_refunded',
      'refunded',
      'failed',
      'cancelled',
    ])
    .optional(),
  fulfillment_status: z
    .enum(['unfulfilled', 'partially_fulfilled', 'fulfilled', 'returned', 'rto'])
    .optional(),
  payment_method: z.enum(['razorpay', 'cod', 'upi', 'card', 'netbanking', 'wallet', 'manual']).optional(),
  customer_id: z.coerce.number().int().positive().optional(),
  placed_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional(),
  placed_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').optional(),
  unfulfilled: z.coerce.boolean().optional(),
  sort: z.string().max(60).optional(),
});

/**
 * Every status change goes through one endpoint with the target in the body,
 * rather than nine verb endpoints. The transition table in the service is what
 * decides legality, so there is one place to look when a change is refused.
 */
const changeStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  note: z.string().trim().max(500).nullish(),
  notify_customer: z.boolean().default(true),
});

const shipSchema = z.object({
  carrier_id: z.coerce.number().int().positive().nullish(),
  awb_number: z.string().trim().max(60).nullish(),
  tracking_url: z.string().trim().url('Enter a valid tracking URL.').max(500).nullish(),
  shipping_mode: z.enum(['surface', 'air', 'express']).default('surface'),
  weight_grams: z.coerce.number().int().positive().max(100000).nullish(),
  // Omit to ship everything still outstanding.
  items: z
    .array(
      z.object({
        order_item_id: z.coerce.number().int().positive(),
        quantity: z.coerce.number().int().positive(),
      }),
    )
    .max(200)
    .optional(),
  note: z.string().trim().max(500).nullish(),
});

const cancelSchema = z.object({
  reason: z.string().trim().min(3, 'Give a reason — it shows on the customer’s order.').max(255),
  // Defaults to "restock if the order had taken stock", decided server-side.
  restock: z.boolean().optional(),
  note: z.string().trim().max(500).nullish(),
});

const refundSchema = z.object({
  // Omit for a full refund of whatever is still refundable.
  amount: z.coerce.number().positive().max(10_000_000).optional(),
  reason: z.string().trim().min(3, 'Give a reason.').max(255),
  internal_note: z.string().trim().max(2000).nullish(),
  restock: z.boolean().default(false),
});

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const ordersRoutes = Router();
ordersRoutes.use(authenticate);

ordersRoutes.get(
  '/',
  requirePermission('orders.view'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await ordersService.list(req.query as Record<string, unknown>));
  }),
);

/** Registered before /:id so "counts" is not read as an order id. */
ordersRoutes.get(
  '/counts',
  requirePermission('orders.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await ordersService.statusCounts());
  }),
);

ordersRoutes.get(
  '/:id',
  requirePermission('orders.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await ordersService.get(id));
  }),
);

ordersRoutes.patch(
  '/:id/note',
  requirePermission('orders.update'),
  validate({
    params: idParamSchema,
    body: z.object({ admin_note: z.string().trim().max(20000).nullish() }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const { admin_note } = req.body as { admin_note?: string | null };
    res.status(200).json(await ordersService.setAdminNote(id, admin_note ?? null, req.admin!, meta(req)));
  }),
);

ordersRoutes.post(
  '/:id/status',
  requirePermission('orders.update'),
  validate({ params: idParamSchema, body: changeStatusSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = req.body as { status: string; note?: string | null; notify_customer: boolean };
    res.status(200).json(await ordersService.changeStatus(id, body.status, body, req.admin!, meta(req)));
  }),
);

/**
 * Shipping and refunding are idempotent-keyed: a double-clicked Ship button
 * must not produce two AWBs, and a replayed refund must not pay twice.
 */
ordersRoutes.post(
  '/:id/ship',
  requirePermission('orders.fulfil'),
  idempotency,
  validate({ params: idParamSchema, body: shipSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await ordersService.ship(id, req.body, req.admin!, meta(req)));
  }),
);

ordersRoutes.post(
  '/:id/cancel',
  requirePermission('orders.cancel'),
  validate({ params: idParamSchema, body: cancelSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await ordersService.cancel(id, req.body, req.admin!, meta(req)));
  }),
);

ordersRoutes.post(
  '/:id/refund',
  requirePermission('orders.refund'),
  idempotency,
  validate({ params: idParamSchema, body: refundSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await ordersService.refund(id, req.body, req.admin!, meta(req)));
  }),
);
