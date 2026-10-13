import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../core/ApiError';
import { asyncHandler } from '../../core/asyncHandler';
import { buildMeta, parsePagination } from '../../core/pagination';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { shopId } from '../tenancy/context';

/**
 * Customers → Messages: what shoppers sent through the Online Store's
 * contact form ({% form 'contact' %}). New, read, archived — an inbox, not a
 * help desk; replying happens by email from the address they left.
 */

interface MessageRow extends RowDataPacket {
  id: number;
  name: string | null;
  email: string;
  phone: string | null;
  body: string;
  fields: unknown;
  page_path: string | null;
  status: 'new' | 'read' | 'archived';
  created_at: Date;
}

function present(row: MessageRow) {
  let fields: Record<string, unknown> = {};
  try {
    fields = typeof row.fields === 'string' ? (JSON.parse(row.fields) as Record<string, unknown>) : ((row.fields as Record<string, unknown>) ?? {});
  } catch {
    fields = {};
  }
  return { id: row.id, name: row.name, email: row.email, phone: row.phone, body: row.body, fields, page_path: row.page_path, status: row.status, created_at: row.created_at };
}

export const contactMessagesRoutes = Router();
contactMessagesRoutes.use(authenticate);

contactMessagesRoutes.get(
  '/',
  requirePermission('customers.view'),
  validate({
    query: z.object({
      status: z.enum(['new', 'read', 'archived', 'inbox']).optional(),
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const page = parsePagination(req.query as Record<string, unknown>);
    const status = typeof req.query.status === 'string' ? req.query.status : 'inbox';
    const where = ['shop_id = ?'];
    const params: unknown[] = [shopId()];
    if (status === 'inbox') where.push("status <> 'archived'");
    else {
      where.push('status = ?');
      params.push(status);
    }
    if (typeof req.query.q === 'string' && req.query.q) {
      where.push('(email LIKE ? OR name LIKE ? OR body LIKE ?)');
      const term = `%${req.query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      params.push(term, term, term);
    }
    const clause = where.join(' AND ');
    const [rows, total, counts] = await Promise.all([
      query<MessageRow>(`SELECT * FROM contact_messages WHERE ${clause} ORDER BY created_at DESC, id DESC LIMIT ${page.limit} OFFSET ${page.offset}`, params),
      queryOne<RowDataPacket & { total: number }>(`SELECT COUNT(*) AS total FROM contact_messages WHERE ${clause}`, params),
      query<RowDataPacket & { status: string; total: number }>('SELECT status, COUNT(*) AS total FROM contact_messages WHERE shop_id = ? GROUP BY status', [shopId()]),
    ]);
    res.json({
      messages: rows.map(present),
      counts: Object.fromEntries(['new', 'read', 'archived'].map((key) => [key, Number(counts.find((row) => row.status === key)?.total ?? 0)])),
      pagination: buildMeta(Number(total?.total ?? 0), page),
    });
  }),
);

contactMessagesRoutes.patch(
  '/:id',
  requirePermission('customers.update'),
  validate({ params: z.object({ id: z.coerce.number().int().positive() }), body: z.object({ status: z.enum(['new', 'read', 'archived']) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await execute('UPDATE contact_messages SET status = ? WHERE shop_id = ? AND id = ?', [req.body.status, shopId(), Number(req.params.id)]);
    if (result.affectedRows === 0) throw ApiError.notFound('Message');
    const row = await queryOne<MessageRow>('SELECT * FROM contact_messages WHERE shop_id = ? AND id = ?', [shopId(), Number(req.params.id)]);
    res.json({ message: present(row!) });
  }),
);
