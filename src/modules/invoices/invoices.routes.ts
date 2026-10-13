import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { idempotency } from '../../middleware/idempotency';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { idParamSchema } from '../auth/auth.schemas';
import { invoicesService } from './invoices.service';

const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(250).optional(),
  q: z.string().trim().max(120).optional(),
  status: z.enum(['draft', 'issued', 'cancelled']).optional(),
  type: z.enum(['tax_invoice', 'credit_note']).optional(),
  order_id: z.coerce.number().int().positive().optional(),
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

export const invoicesRoutes = Router();
invoicesRoutes.use(authenticate);

invoicesRoutes.get(
  '/',
  requirePermission('orders.view'),
  validate({ query: listQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await invoicesService.list(req.query as Record<string, unknown>));
  }),
);

invoicesRoutes.get(
  '/:id',
  requirePermission('orders.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await invoicesService.get(id));
  }),
);

/**
 * Issues the tax invoice for an order.
 *
 * Idempotency-keyed *and* idempotent by design: an invoice number is permanent
 * and consecutive, so a second call returns the existing invoice rather than
 * minting a second one for the same sale. A duplicate here is a compliance
 * problem, not just a duplicate row.
 */
invoicesRoutes.post(
  '/orders/:orderId/issue',
  requirePermission('orders.update'),
  idempotency,
  validate({ params: z.object({ orderId: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { orderId } = req.params as unknown as { orderId: number };
    const result = await invoicesService.issueForOrder(orderId, req.admin!, meta(req));
    res.status(result.already_existed ? 200 : 201).json(result);
  }),
);

invoicesRoutes.post(
  '/:id/credit-note',
  requirePermission('orders.refund'),
  idempotency,
  validate({
    params: idParamSchema,
    body: z.object({
      amount: z.coerce.number().positive().max(10_000_000),
      reason: z.string().trim().min(3, 'Give a reason — it prints on the credit note.').max(255),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(201).json(await invoicesService.issueCreditNote(id, req.body, req.admin!, meta(req)));
  }),
);
