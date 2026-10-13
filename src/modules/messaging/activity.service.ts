import { query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

/**
 * The outbox.
 *
 * Every message the shop has sent, whatever sent it — an order confirmation, an
 * OTP, a campaign, someone clicking send on a customer's page. One table, one
 * screen, because the question people actually ask is "what did we send this
 * person", and an answer that covers only campaigns is not an answer.
 *
 * The rendered body is in `payload`. That is the shop's own record of what it
 * said, and support work is impossible without it — but it is also the one
 * place a phone number and a message body sit together, so the list does not
 * return it and the detail endpoint does.
 */

export interface LogFilters {
  channel?: string;
  status?: string;
  campaign_id?: number;
  customer_id?: number;
  template_id?: number;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

interface LogRow extends RowDataPacket {
  id: number;
  event_key: string;
  channel: string;
  recipient: string;
  status: string;
  customer_id: number | null;
  campaign_id: number | null;
  template_id: number | null;
  provider: string | null;
  provider_message_id: string | null;
  error_message: string | null;
  cost: string;
  queued_at: Date;
  sent_at: Date | null;
  delivered_at: Date | null;
  failed_at: Date | null;
  payload: unknown;
  template_name: string | null;
  campaign_name: string | null;
  customer_name: string | null;
  sent_by_name: string | null;
}

const COLUMNS = `
  l.id, l.event_key, l.channel, l.recipient, l.status, l.customer_id, l.campaign_id,
  l.template_id, l.provider, l.provider_message_id, l.error_message, l.cost,
  l.queued_at, l.sent_at, l.delivered_at, l.failed_at,
  t.name AS template_name, mc.name AS campaign_name,
  TRIM(CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))) AS customer_name,
  TRIM(CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, ''))) AS sent_by_name`;

const JOINS = `
  LEFT JOIN notification_templates t ON t.id = l.template_id AND t.shop_id = l.shop_id
  LEFT JOIN message_campaigns mc     ON mc.id = l.campaign_id AND mc.shop_id = l.shop_id
  LEFT JOIN customers c              ON c.id = l.customer_id AND c.shop_id = l.shop_id
  LEFT JOIN admin_users a            ON a.id = l.sent_by_admin_id`;

function conditionsFor(filters: LogFilters): { sql: string; params: unknown[] } {
  const conditions: string[] = ['l.shop_id = ?'];
  const params: unknown[] = [shopId()];

  const equals: [keyof LogFilters, string][] = [
    ['channel', 'l.channel'],
    ['status', 'l.status'],
    ['campaign_id', 'l.campaign_id'],
    ['customer_id', 'l.customer_id'],
    ['template_id', 'l.template_id'],
  ];
  for (const [key, column] of equals) {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
      conditions.push(`${column} = ?`);
      params.push(filters[key]);
    }
  }

  if (filters.search) {
    conditions.push('(l.recipient LIKE ? OR l.event_key LIKE ?)');
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  if (filters.from) {
    conditions.push('l.queued_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('l.queued_at <= ?');
    params.push(filters.to);
  }

  return { sql: conditions.join(' AND '), params };
}

function present(row: LogRow) {
  return {
    id: row.id,
    event_key: row.event_key,
    channel: row.channel,
    recipient: row.recipient,
    status: row.status,
    customer_id: row.customer_id,
    customer_name: row.customer_name || null,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    template_id: row.template_id,
    template_name: row.template_name,
    provider: row.provider,
    provider_message_id: row.provider_message_id,
    error_message: row.error_message,
    cost: Number(row.cost),
    queued_at: row.queued_at,
    sent_at: row.sent_at,
    delivered_at: row.delivered_at,
    failed_at: row.failed_at,
    sent_by_name: row.sent_by_name || null,
    /** True when nothing left the building — the simulator or the recorder. */
    simulated: row.provider === 'simulator' || row.provider === 'logging',
  };
}

export const activityService = {
  async list(filters: LogFilters, exec: Executor = pool) {
    const limit = Math.min(filters.limit ?? 50, 200);
    const page = Math.max(1, filters.page ?? 1);
    const where = conditionsFor(filters);

    const rows = await query<LogRow>(
      `SELECT ${COLUMNS} FROM notification_logs l ${JOINS}
        WHERE ${where.sql}
        ORDER BY l.id DESC
        LIMIT ? OFFSET ?`,
      [...where.params, limit, (page - 1) * limit],
      exec,
    );

    const totalRow = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM notification_logs l WHERE ${where.sql}`,
      where.params,
      exec,
    );
    const total = Number(totalRow?.total ?? 0);

    return {
      messages: rows.map(present),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  },

  /** One message, with what was actually said. */
  async get(id: number, exec: Executor = pool) {
    const row = await queryOne<LogRow>(
      `SELECT ${COLUMNS}, l.payload FROM notification_logs l ${JOINS} WHERE l.shop_id = ? AND l.id = ? LIMIT 1`,
      [shopId(), id],
      exec,
    );
    if (!row) return null;

    const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as
      | { body?: string; subject?: string | null; variables?: Record<string, string> }
      | null;

    return {
      ...present(row),
      body: payload?.body ?? null,
      subject: payload?.subject ?? null,
      variables: payload?.variables ?? {},
    };
  },

  /**
   * The headline numbers over a window.
   *
   * Deliberately four numbers and a breakdown rather than a chart: the question
   * this answers is "is anything broken", and a failure rate that has doubled
   * shows up in one row.
   */
  async summary(days: number, exec: Executor = pool) {
    const totals = await queryOne<RowDataPacket & Record<string, number>>(
      `SELECT COUNT(*) AS total,
              SUM(status IN ('sent','delivered','read')) AS sent,
              SUM(status IN ('delivered','read'))        AS delivered,
              SUM(status IN ('failed','bounced'))        AS failed,
              COALESCE(SUM(cost), 0)                     AS cost
         FROM notification_logs
        WHERE shop_id = ? AND queued_at >= NOW() - INTERVAL ? DAY`,
      [shopId(), days],
      exec,
    );

    const byChannel = await query<RowDataPacket & { channel: string; total: number; delivered: number; failed: number }>(
      `SELECT channel, COUNT(*) AS total,
              SUM(status IN ('delivered','read'))  AS delivered,
              SUM(status IN ('failed','bounced'))  AS failed
         FROM notification_logs
        WHERE shop_id = ? AND queued_at >= NOW() - INTERVAL ? DAY
        GROUP BY channel`,
      [shopId(), days],
      exec,
    );

    const daily = await query<RowDataPacket & { day: string; total: number; failed: number }>(
      `SELECT DATE(queued_at) AS day, COUNT(*) AS total, SUM(status IN ('failed','bounced')) AS failed
         FROM notification_logs
        WHERE shop_id = ? AND queued_at >= NOW() - INTERVAL ? DAY
        GROUP BY DATE(queued_at)
        ORDER BY day`,
      [shopId(), days],
      exec,
    );

    return {
      window_days: days,
      totals: {
        total: Number(totals?.total ?? 0),
        sent: Number(totals?.sent ?? 0),
        delivered: Number(totals?.delivered ?? 0),
        failed: Number(totals?.failed ?? 0),
        cost: Number(totals?.cost ?? 0),
      },
      by_channel: byChannel.map((row) => ({
        channel: row.channel,
        total: Number(row.total),
        delivered: Number(row.delivered),
        failed: Number(row.failed),
      })),
      daily: daily.map((row) => ({ day: row.day, total: Number(row.total), failed: Number(row.failed) })),
    };
  },

  /** Everything ever sent to one customer, newest first. */
  async forCustomer(customerId: number, limit: number, exec: Executor = pool) {
    const rows = await query<LogRow>(
      `SELECT ${COLUMNS}, l.payload FROM notification_logs l ${JOINS}
        WHERE l.shop_id = ? AND l.customer_id = ?
        ORDER BY l.id DESC
        LIMIT ?`,
      [shopId(), customerId, limit],
      exec,
    );

    return {
      messages: rows.map((row) => {
        const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as
          | { body?: string; subject?: string | null }
          | null;
        return { ...present(row), body: payload?.body ?? null, subject: payload?.subject ?? null };
      }),
    };
  },
};
