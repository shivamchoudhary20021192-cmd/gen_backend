import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { query, queryOne, type RowDataPacket } from '../../db/pool';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { shopId, tenancy } from '../../platform/tenancy/context';

/**
 * Reading the audit trail. Writing it is auditService's job, from inside the
 * transaction that made each change; this only lists it — for a store's own
 * staff (Settings → Audit log) and, across every store, for operators.
 */

interface AuditRow extends RowDataPacket {
  id: number;
  shop_id: number | null;
  actor_type: string;
  actor_id: number | null;
  actor_label: string | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  summary: string | null;
  changes: unknown;
  context: unknown;
  ip_text: string | null;
  user_agent: string | null;
  created_at: Date;
  shop_handle?: string | null;
  shop_name?: string | null;
}

const filters = z.object({
  q: z.string().trim().max(120).optional(),
  // "product" matches every product.* action; "product.updated" matches exactly.
  action: z.string().trim().max(80).optional(),
  entity_type: z.string().trim().max(60).optional(),
  entity_id: z.coerce.number().int().positive().optional(),
  actor_id: z.coerce.number().int().positive().optional(),
  actor_type: z.enum(['admin', 'customer', 'system', 'webhook', 'job']).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
type Filters = z.infer<typeof filters>;

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function present(row: AuditRow) {
  return {
    id: Number(row.id),
    shop: row.shop_id ? { id: Number(row.shop_id), handle: row.shop_handle ?? null, name: row.shop_name ?? null } : null,
    actor: { type: row.actor_type, id: row.actor_id, label: row.actor_label },
    action: row.action,
    entity: row.entity_type ? { type: row.entity_type, id: row.entity_id } : null,
    summary: row.summary,
    changes: parse(row.changes),
    context: parse(row.context),
    ip: row.ip_text,
    user_agent: row.user_agent,
    created_at: row.created_at,
  };
}

/** The WHERE for the filters every view shares. */
function filterSql(input: Filters, where: string[], params: unknown[]): void {
  if (input.q) {
    where.push('(a.summary LIKE ? OR a.actor_label LIKE ?)');
    params.push(`%${input.q}%`, `%${input.q}%`);
  }
  if (input.action) {
    if (input.action.includes('.')) {
      where.push('a.action = ?');
      params.push(input.action);
    } else {
      where.push('a.action LIKE ?');
      params.push(`${input.action}.%`);
    }
  }
  if (input.entity_type) {
    where.push('a.entity_type = ?');
    params.push(input.entity_type);
  }
  if (input.entity_id) {
    where.push('a.entity_id = ?');
    params.push(input.entity_id);
  }
  if (input.actor_type) {
    where.push('a.actor_type = ?');
    params.push(input.actor_type);
  }
  if (input.actor_id) {
    where.push('a.actor_id = ?');
    params.push(input.actor_id);
  }
  if (input.since) {
    where.push('a.created_at >= ?');
    params.push(new Date(input.since));
  }
  if (input.until) {
    where.push('a.created_at < ?');
    params.push(new Date(input.until));
  }
}

async function page(where: string[], params: unknown[], input: Filters, withShop: boolean) {
  const rows = await query<AuditRow>(
    `SELECT a.*, INET6_NTOA(a.ip) AS ip_text${withShop ? ', s.handle AS shop_handle, s.name AS shop_name' : ''}
       FROM audit_logs a ${withShop ? 'LEFT JOIN shops s ON s.id = a.shop_id' : ''}
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?`,
    [...params, input.limit, (input.page - 1) * input.limit],
  );
  // "Is there more" rather than a COUNT(*): the log grows without bound and
  // counting it on every page view is the query that eventually hurts.
  const more = await queryOne<RowDataPacket & { id: number }>(
    `SELECT a.id FROM audit_logs a WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC, a.id DESC LIMIT 1 OFFSET ?`,
    [...params, input.page * input.limit],
  );
  return { entries: rows.map(present), pagination: { page: input.page, limit: input.limit, has_next: Boolean(more), has_prev: input.page > 1 } };
}

// ── Admin API: /admin/api/:version/audit ─────────────────────────────────────

export const auditRoutes = Router();
auditRoutes.use(authenticate);

auditRoutes.get(
  '/',
  requirePermission('audit.view'),
  validate({ query: filters }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = req.query as unknown as Filters;
    // This store's own trail, plus what the platform's operators did to it
    // (a plan move, a freeze): those are recorded outside any store, against it.
    const where = ["(a.shop_id = ? OR (a.shop_id IS NULL AND a.entity_type = 'shop' AND a.entity_id = ? AND a.action LIKE 'platform.%'))"];
    const params: unknown[] = [shopId(), shopId()];
    filterSql(input, where, params);
    res.json(await page(where, params, input, false));
  }),
);

/** The kinds of action this store's log holds, for the filter. */
auditRoutes.get(
  '/actions',
  requirePermission('audit.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await query<RowDataPacket & { area: string; total: number }>(
      `SELECT SUBSTRING_INDEX(action, '.', 1) AS area, COUNT(*) AS total
         FROM audit_logs WHERE shop_id = ? GROUP BY area ORDER BY total DESC LIMIT 50`,
      [shopId()],
    );
    res.json({ areas: rows.map((row) => ({ area: row.area, total: Number(row.total) })) });
  }),
);

// ── Platform API: /platform/api/v1/audit (operators, every store) ───────────

export const platformAuditRoutes = Router();

platformAuditRoutes.get(
  '/audit',
  validate({
    query: filters.extend({
      shop_id: z.coerce.number().int().positive().optional(),
      // Only what happened outside any store: sign-ins, plan edits, rates.
      platform_only: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = req.query as unknown as Filters & { shop_id?: number; platform_only?: 'true' | 'false' };
    const where: string[] = ['1 = 1'];
    const params: unknown[] = [];
    if (input.shop_id) {
      where.push("(a.shop_id = ? OR (a.shop_id IS NULL AND a.entity_type = 'shop' AND a.entity_id = ?))");
      params.push(Number(input.shop_id), Number(input.shop_id));
    }
    if (input.platform_only === 'true') where.push('a.shop_id IS NULL');
    filterSql(input, where, params);
    res.json(await tenancy.unscoped('operators reading the audit trail across stores', () => page(where, params, input, true)));
  }),
);
