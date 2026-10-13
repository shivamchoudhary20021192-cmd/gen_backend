import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId, tenancy } from '../../platform/tenancy/context';

/**
 * Campaigns and the people in them.
 *
 * The recipient table is the one that matters. A campaign that stores only its
 * rules has no answer to "who did this actually go to" a week later, cannot be
 * resumed after a restart without messaging someone twice, and cannot tell a
 * customer support question from a guess. One row per person, frozen at the
 * moment the campaign starts, answers all three.
 */

export interface CampaignRow extends RowDataPacket {
  id: number;
  name: string;
  description: string | null;
  channel: string;
  template_id: number | null;
  sender_id: number | null;
  status: string;
  audience_type: string;
  segment_id: number | null;
  rules: unknown;
  rules_operator: 'all' | 'any';
  customer_ids: unknown;
  exclude_recent_hours: number | null;
  scheduled_at: Date | null;
  timezone: string;
  started_at: Date | null;
  completed_at: Date | null;
  throttle_per_minute: number | null;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  failed_count: number;
  skipped_count: number;
  cost: string;
  variables: unknown;
  utm: unknown;
  last_error: string | null;
  created_by_admin_id: number | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface CampaignListRow extends CampaignRow {
  template_name: string | null;
  template_category: string | null;
  segment_name: string | null;
  sender_name: string | null;
  created_by_name: string | null;
}

export interface RecipientRow extends RowDataPacket {
  id: number;
  campaign_id: number;
  customer_id: number | null;
  recipient: string;
  status: string;
  skip_reason: string | null;
  error_message: string | null;
  log_id: number | null;
  variables: unknown;
  sent_at: Date | null;
  first_name: string | null;
  last_name: string | null;
}

const LIST_COLUMNS = `
  c.*, t.name AS template_name, t.category AS template_category,
  s.name AS segment_name, sn.name AS sender_name,
  CONCAT(a.first_name, ' ', a.last_name) AS created_by_name`;

const LIST_JOINS = `
  LEFT JOIN notification_templates t ON t.id = c.template_id AND t.shop_id = c.shop_id
  LEFT JOIN customer_segments s      ON s.id = c.segment_id AND s.shop_id = c.shop_id
  LEFT JOIN messaging_senders sn     ON sn.id = c.sender_id AND sn.shop_id = c.shop_id
  LEFT JOIN admin_users a            ON a.id = c.created_by_admin_id`;

export const campaignsRepository = {
  async list(
    filters: { status?: string; channel?: string; search?: string },
    exec: Executor = pool,
  ): Promise<CampaignListRow[]> {
    const conditions = ['c.shop_id = ?', 'c.deleted_at IS NULL'];
    const params: unknown[] = [shopId()];

    if (filters.status) {
      conditions.push('c.status = ?');
      params.push(filters.status);
    }
    if (filters.channel) {
      conditions.push('c.channel = ?');
      params.push(filters.channel);
    }
    if (filters.search) {
      conditions.push('(c.name LIKE ? OR c.description LIKE ?)');
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }

    return query<CampaignListRow>(
      `SELECT ${LIST_COLUMNS} FROM message_campaigns c ${LIST_JOINS}
        WHERE ${conditions.join(' AND ')}
        ORDER BY c.created_at DESC
        LIMIT 200`,
      params,
      exec,
    );
  },

  async byId(id: number, exec: Executor = pool): Promise<CampaignListRow | null> {
    return queryOne<CampaignListRow>(
      `SELECT ${LIST_COLUMNS} FROM message_campaigns c ${LIST_JOINS} WHERE c.shop_id = ? AND c.id = ? LIMIT 1`,
      [shopId(), id],
      exec,
    );
  },

  async create(data: Record<string, unknown>, exec: Executor = pool): Promise<number> {
    const row = { ...data, shop_id: shopId() };
    const columns = Object.keys(row);
    return insert(
      `INSERT INTO message_campaigns (${columns.map((column) => `\`${column}\``).join(', ')})
       VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(row),
      exec,
    );
  },

  async update(id: number, data: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const columns = Object.keys(data);
    if (columns.length === 0) return;
    await execute(
      `UPDATE message_campaigns SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE shop_id = ? AND id = ?`,
      [...Object.values(data), shopId(), id],
      exec,
    );
  },

  async softDelete(id: number, exec: Executor = pool): Promise<void> {
    await execute('UPDATE message_campaigns SET deleted_at = NOW() WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  // ── recipients ────────────────────────────────────────────────────────────

  /**
   * Freezes the audience.
   *
   * INSERT IGNORE against the unique (campaign_id, customer_id): re-running the
   * freeze — after a crash, or because someone pressed start twice — adds the
   * people who were missing and cannot duplicate the ones already there.
   */
  async addRecipients(
    campaignId: number,
    rows: { customerId: number; recipient: string; variables: Record<string, string> }[],
    exec: Executor = pool,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await execute(
      `INSERT IGNORE INTO message_campaign_recipients (shop_id, campaign_id, customer_id, recipient, variables)
       VALUES ${rows.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
      rows.flatMap((row) => [shopId(), campaignId, row.customerId, row.recipient, JSON.stringify(row.variables)]),
      exec,
    );
    return result.affectedRows;
  },

  /**
   * Takes the next batch and marks it as being worked on, in one statement.
   *
   * The UPDATE-then-SELECT is what keeps a second worker — or a second server —
   * from picking up the same people: only rows this call moved out of 'pending'
   * are then read back.
   */
  async claimBatch(campaignId: number, limit: number, exec: Executor = pool): Promise<RecipientRow[]> {
    const claimed = await execute(
      `UPDATE message_campaign_recipients
          SET status = 'sending'
        WHERE shop_id = ? AND campaign_id = ? AND status = 'pending'
        ORDER BY id
        LIMIT ?`,
      [shopId(), campaignId, limit],
      exec,
    );
    if (claimed.affectedRows === 0) return [];

    return query<RecipientRow>(
      `SELECT r.*, c.first_name, c.last_name
         FROM message_campaign_recipients r
         LEFT JOIN customers c ON c.id = r.customer_id AND c.shop_id = r.shop_id
        WHERE r.shop_id = ? AND r.campaign_id = ? AND r.status = 'sending'
        ORDER BY r.id
        LIMIT ?`,
      [shopId(), campaignId, limit],
      exec,
    );
  },

  async markRecipient(
    id: number,
    data: { status: string; skipReason?: string | null; error?: string | null; logId?: number | null },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE message_campaign_recipients
          SET status = ?, skip_reason = ?, error_message = ?, log_id = ?,
              sent_at = CASE WHEN ? IN ('sent','delivered') THEN NOW() ELSE sent_at END,
              delivered_at = CASE WHEN ? = 'delivered' THEN NOW() ELSE delivered_at END
        WHERE shop_id = ? AND id = ?`,
      [
        data.status,
        data.skipReason ?? null,
        data.error ? data.error.slice(0, 500) : null,
        data.logId ?? null,
        data.status,
        data.status,
        shopId(),
        id,
      ],
      exec,
    );
  },

  /** Any 'sending' rows left behind by a restart go back in the queue. */
  async requeueStuck(campaignId: number, exec: Executor = pool): Promise<void> {
    await execute(
      "UPDATE message_campaign_recipients SET status = 'pending' WHERE shop_id = ? AND campaign_id = ? AND status = 'sending'",
      [shopId(), campaignId],
      exec,
    );
  },

  async cancelPending(campaignId: number, exec: Executor = pool): Promise<void> {
    await execute(
      "UPDATE message_campaign_recipients SET status = 'cancelled' WHERE shop_id = ? AND campaign_id = ? AND status IN ('pending','sending')",
      [shopId(), campaignId],
      exec,
    );
  },

  async pendingCount(campaignId: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      "SELECT COUNT(*) AS total FROM message_campaign_recipients WHERE shop_id = ? AND campaign_id = ? AND status IN ('pending','sending')",
      [shopId(), campaignId],
      exec,
    );
    return Number(row?.total ?? 0);
  },

  /**
   * The campaign's counters, recomputed from the recipients.
   *
   * Recomputed rather than incremented: a counter that is only ever added to
   * drifts the first time a batch half-fails, and this is the number the shop
   * reads to decide whether the campaign worked.
   */
  async refreshCounters(campaignId: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE message_campaigns c
          SET total_recipients = (SELECT COUNT(*) FROM message_campaign_recipients r WHERE r.shop_id = c.shop_id AND r.campaign_id = c.id),
              sent_count       = (SELECT COUNT(*) FROM message_campaign_recipients r WHERE r.shop_id = c.shop_id AND r.campaign_id = c.id AND r.status IN ('sent','delivered')),
              delivered_count  = (SELECT COUNT(*) FROM message_campaign_recipients r WHERE r.shop_id = c.shop_id AND r.campaign_id = c.id AND r.status = 'delivered'),
              failed_count     = (SELECT COUNT(*) FROM message_campaign_recipients r WHERE r.shop_id = c.shop_id AND r.campaign_id = c.id AND r.status = 'failed'),
              skipped_count    = (SELECT COUNT(*) FROM message_campaign_recipients r WHERE r.shop_id = c.shop_id AND r.campaign_id = c.id AND r.status = 'skipped'),
              cost             = (SELECT COALESCE(SUM(l.cost), 0) FROM notification_logs l WHERE l.shop_id = c.shop_id AND l.campaign_id = c.id)
        WHERE c.shop_id = ? AND c.id = ?`,
      [shopId(), campaignId],
      exec,
    );
  },

  async recipients(
    campaignId: number,
    filters: { status?: string; search?: string; limit: number; offset: number },
    exec: Executor = pool,
  ): Promise<RecipientRow[]> {
    const conditions = ['r.shop_id = ?', 'r.campaign_id = ?'];
    const params: unknown[] = [shopId(), campaignId];
    if (filters.status) {
      conditions.push('r.status = ?');
      params.push(filters.status);
    }
    if (filters.search) {
      conditions.push('(r.recipient LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ?)');
      const like = `%${filters.search}%`;
      params.push(like, like, like);
    }
    return query<RecipientRow>(
      `SELECT r.*, c.first_name, c.last_name
         FROM message_campaign_recipients r
         LEFT JOIN customers c ON c.id = r.customer_id AND c.shop_id = r.shop_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.id
        LIMIT ? OFFSET ?`,
      [...params, filters.limit, filters.offset],
      exec,
    );
  },

  async countRecipients(campaignId: number, status: string | undefined, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM message_campaign_recipients
        WHERE shop_id = ? AND campaign_id = ? ${status ? 'AND status = ?' : ''}`,
      status ? [shopId(), campaignId, status] : [shopId(), campaignId],
      exec,
    );
    return Number(row?.total ?? 0);
  },

  /** This shop's campaigns the worker should be running right now. */
  async due(exec: Executor = pool): Promise<CampaignRow[]> {
    return query<CampaignRow>(
      `SELECT * FROM message_campaigns
        WHERE shop_id = ?
          AND deleted_at IS NULL
          AND (status = 'sending'
               OR (status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()))
        ORDER BY scheduled_at, id
        LIMIT 20`,
      [shopId()],
      exec,
    );
  },

  /**
   * Which shops on this pod have campaign work, across all of them.
   *
   * The one cross-shop read in messaging, and it returns only ids: the tick
   * uses it to fan out one job per shop, each of which then reads its own
   * campaigns inside that shop's context.
   */
  async shopsWithDueCampaigns(exec: Executor = pool): Promise<number[]> {
    const rows = await tenancy.unscoped('messaging: find shops with due campaigns', () =>
      query<RowDataPacket & { shop_id: number }>(
        `SELECT DISTINCT shop_id FROM message_campaigns
          WHERE deleted_at IS NULL
            AND (status = 'sending'
                 OR (status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()))
          LIMIT 1000`,
        [],
        exec,
      ),
    );
    return rows.map((row) => Number(row.shop_id));
  },
};
