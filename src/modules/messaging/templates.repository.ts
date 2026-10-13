import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import type { TemplateRow } from './messaging.repository';
import { shopId } from '../../platform/tenancy/context';

/**
 * Templates, from the admin's side.
 *
 * `messaging.repository` reads one template to send it; this reads them all to
 * list, filter and edit them. Kept apart because the send path must stay a
 * handful of indexed lookups and must never accidentally inherit a join added
 * for a screen.
 */

export interface TemplateListRow extends TemplateRow {
  sender_name: string | null;
  sent_30d: number;
  delivered_30d: number;
  failed_30d: number;
}

export interface TemplateFilters {
  channel?: string;
  category?: string;
  search?: string;
  is_active?: boolean;
  include_deleted?: boolean;
}

const LIST_COLUMNS = `
  t.*, s.name AS sender_name,
  COALESCE(stats.sent, 0)      AS sent_30d,
  COALESCE(stats.delivered, 0) AS delivered_30d,
  COALESCE(stats.failed, 0)    AS failed_30d`;

/**
 * Thirty days of outcomes per template, as a derived table rather than three
 * correlated subqueries.
 *
 * The list is the screen where someone notices that one template fails twice as
 * often as its neighbours, which is worth one aggregate scan of a log that is
 * indexed on (status, queued_at).
 */
const LIST_STATS = `
  LEFT JOIN (
    SELECT template_id,
           SUM(status IN ('sent','delivered','read')) AS sent,
           SUM(status IN ('delivered','read'))        AS delivered,
           SUM(status IN ('failed','bounced'))        AS failed
      FROM notification_logs
     WHERE shop_id = ? AND queued_at >= NOW() - INTERVAL 30 DAY
     GROUP BY template_id
  ) AS stats ON stats.template_id = t.id`;

export const templatesRepository = {
  async list(filters: TemplateFilters, exec: Executor = pool): Promise<TemplateListRow[]> {
    // The first placeholder is the one inside LIST_STATS, the second the list's own.
    const conditions: string[] = ['t.shop_id = ?'];
    const params: unknown[] = [shopId(), shopId()];

    if (!filters.include_deleted) conditions.push('t.deleted_at IS NULL');
    if (filters.channel) {
      conditions.push('t.channel = ?');
      params.push(filters.channel);
    }
    if (filters.category) {
      conditions.push('t.category = ?');
      params.push(filters.category);
    }
    if (filters.is_active !== undefined) {
      conditions.push('t.is_active = ?');
      params.push(filters.is_active ? 1 : 0);
    }
    if (filters.search) {
      conditions.push('(t.name LIKE ? OR t.event_key LIKE ? OR t.body LIKE ?)');
      const like = `%${filters.search}%`;
      params.push(like, like, like);
    }

    return query<TemplateListRow>(
      `SELECT ${LIST_COLUMNS}
         FROM notification_templates t
         LEFT JOIN messaging_senders s ON s.id = t.sender_id AND s.shop_id = t.shop_id
         ${LIST_STATS}
        WHERE ${conditions.join(' AND ')}
        ORDER BY t.category, t.channel, t.event_key`,
      params,
      exec,
    );
  },

  async byId(id: number, exec: Executor = pool): Promise<TemplateListRow | null> {
    return queryOne<TemplateListRow>(
      `SELECT ${LIST_COLUMNS}
         FROM notification_templates t
         LEFT JOIN messaging_senders s ON s.id = t.sender_id AND s.shop_id = t.shop_id
         ${LIST_STATS}
        WHERE t.shop_id = ? AND t.id = ?
        LIMIT 1`,
      [shopId(), shopId(), id],
      exec,
    );
  },

  /** The uniqueness the table enforces: one template per event, channel and locale. */
  async conflicting(
    eventKey: string,
    channel: string,
    locale: string,
    exceptId: number | null,
    exec: Executor = pool,
  ): Promise<boolean> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      `SELECT id FROM notification_templates
        WHERE shop_id = ? AND event_key = ? AND channel = ? AND locale = ? AND (? IS NULL OR id <> ?)
        LIMIT 1`,
      [shopId(), eventKey, channel, locale, exceptId, exceptId],
      exec,
    );
    return row !== null;
  },

  async create(data: Record<string, unknown>, exec: Executor = pool): Promise<number> {
    const row = { ...data, shop_id: shopId() };
    const columns = Object.keys(row);
    return insert(
      `INSERT INTO notification_templates (${columns.map((column) => `\`${column}\``).join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(row),
      exec,
    );
  },

  async update(id: number, data: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const columns = Object.keys(data);
    if (columns.length === 0) return;
    await execute(
      `UPDATE notification_templates SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE shop_id = ? AND id = ?`,
      [...Object.values(data), shopId(), id],
      exec,
    );
  },

  /**
   * Soft, and for a reason beyond the usual.
   *
   * `notification_logs.template_id` points here. A hard delete would null out
   * the template on every message ever sent from it, and "what did we send this
   * customer in April" would come back without its name.
   */
  async softDelete(id: number, exec: Executor = pool): Promise<void> {
    await execute(
      'UPDATE notification_templates SET deleted_at = NOW(), is_active = 0 WHERE shop_id = ? AND id = ?',
      [shopId(), id],
      exec,
    );
  },

  async restore(id: number, exec: Executor = pool): Promise<void> {
    await execute('UPDATE notification_templates SET deleted_at = NULL WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  /** Whether a campaign still points at this template, so deleting can say so. */
  async campaignsUsing(id: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM message_campaigns
        WHERE shop_id = ? AND template_id = ? AND deleted_at IS NULL AND status IN ('draft','scheduled','sending','paused')`,
      [shopId(), id],
      exec,
    );
    return Number(row?.total ?? 0);
  },
};
