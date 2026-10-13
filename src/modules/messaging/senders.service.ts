import { ApiError } from '../../core/ApiError';
import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { clearMessagingSettingsCache } from './messagingSettings';
import type { SenderRow } from './messaging.repository';
import { shopId } from '../../platform/tenancy/context';

/**
 * Who a message comes from.
 *
 * A sender is the shop's identity on a channel, and — this is the part that is
 * easy to miss — it is where the compliance identifiers live. An SMS is not
 * legal in India because of what it says; it is legal because a registered
 * Principal Entity sent it under a registered header against a registered
 * template. Two of those three belong to the identity, so a shop with a
 * transactional gateway and a promotional gateway needs two senders and the
 * templates have to be able to point at the right one.
 *
 * Secrets are not stored here. `config` holds the non-secret half of a provider
 * connection — a region, a route, an account reference — and anything that
 * looks like a credential is masked on the way out and ignored on the way in,
 * because a key that is displayed in a browser is a key that ends up in a
 * screenshot.
 */

const SECRET_LIKE = /(secret|token|password|api_?key|auth)/i;

function maskConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    out[key] = SECRET_LIKE.test(key) && value ? '••••••••' : value;
  }
  return out;
}

function stripSecrets(config: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!config) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    // A masked value coming back from the form means "leave it alone", and a
    // real secret arriving from a browser is refused rather than stored.
    if (SECRET_LIKE.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface SenderStatsRow extends SenderRow {
  sent_30d: number;
  failed_30d: number;
  templates_using: number;
}

function present(row: SenderStatsRow) {
  return {
    id: row.id,
    channel: row.channel,
    name: row.name,
    provider: row.provider,
    status: row.status,
    is_default: row.is_default === 1,
    from_email: row.from_email,
    from_name: row.from_name,
    reply_to: row.reply_to,
    sms_header: row.sms_header,
    dlt_pe_id: row.dlt_pe_id,
    dlt_entity_name: row.dlt_entity_name,
    waba_id: row.waba_id,
    phone_number_id: row.phone_number_id,
    display_phone: row.display_phone,
    quality_rating: row.quality_rating,
    daily_limit: row.daily_limit,
    notes: row.notes,
    config: maskConfig(row.config),
    // Said plainly rather than implied by the provider name, because "why did
    // the customer not get it" is the question this screen exists to answer.
    delivers: row.provider !== 'simulator' && row.provider !== 'logging',
    stats: {
      sent_30d: Number(row.sent_30d ?? 0),
      failed_30d: Number(row.failed_30d ?? 0),
      templates_using: Number(row.templates_using ?? 0),
    },
  };
}

const COLUMNS = `
  s.*,
  COALESCE(stats.sent, 0)   AS sent_30d,
  COALESCE(stats.failed, 0) AS failed_30d,
  (SELECT COUNT(*) FROM notification_templates t
    WHERE t.shop_id = s.shop_id AND t.sender_id = s.id AND t.deleted_at IS NULL) AS templates_using`;

const STATS_JOIN = `
  LEFT JOIN (
    SELECT sender_id,
           SUM(status IN ('sent','delivered','read')) AS sent,
           SUM(status IN ('failed','bounced'))        AS failed
      FROM notification_logs
     WHERE shop_id = ? AND queued_at >= NOW() - INTERVAL 30 DAY
     GROUP BY sender_id
  ) AS stats ON stats.sender_id = s.id`;

export const sendersService = {
  async list(channel: string | undefined, exec: Executor = pool) {
    const rows = await query<SenderStatsRow>(
      `SELECT ${COLUMNS}
         FROM messaging_senders s ${STATS_JOIN}
        WHERE s.shop_id = ? AND s.deleted_at IS NULL ${channel ? 'AND s.channel = ?' : ''}
        ORDER BY s.channel, s.is_default DESC, s.name`,
      // The first placeholder is the one inside STATS_JOIN.
      channel ? [shopId(), shopId(), channel] : [shopId(), shopId()],
      exec,
    );
    return { senders: rows.map(present) };
  },

  async get(id: number, exec: Executor = pool) {
    const row = await queryOne<SenderStatsRow>(
      `SELECT ${COLUMNS} FROM messaging_senders s ${STATS_JOIN} WHERE s.shop_id = ? AND s.id = ? AND s.deleted_at IS NULL LIMIT 1`,
      [shopId(), shopId(), id],
      exec,
    );
    if (!row) throw ApiError.notFound('Sender');
    return present(row);
  },

  async create(input: Record<string, unknown>, adminId: number, exec: Executor = pool) {
    const id = await insert(
      `INSERT INTO messaging_senders
         (shop_id, channel, name, provider, status, is_default, from_email, from_name, reply_to,
          sms_header, dlt_pe_id, dlt_entity_name, waba_id, phone_number_id, display_phone,
          config, daily_limit, notes, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        input.channel,
        input.name,
        input.provider ?? 'simulator',
        input.status ?? 'active',
        input.from_email ?? null,
        input.from_name ?? null,
        input.reply_to ?? null,
        input.sms_header ?? null,
        input.dlt_pe_id ?? null,
        input.dlt_entity_name ?? null,
        input.waba_id ?? null,
        input.phone_number_id ?? null,
        input.display_phone ?? null,
        JSON.stringify(stripSecrets(input.config as Record<string, unknown>)),
        input.daily_limit ?? null,
        input.notes ?? null,
        adminId,
      ],
      exec,
    );

    if (input.is_default) await this.makeDefault(id, exec);
    return this.get(id, exec);
  },

  async update(id: number, input: Record<string, unknown>, exec: Executor = pool) {
    await this.get(id, exec);

    const patch: Record<string, unknown> = {};
    for (const column of [
      'name', 'provider', 'status', 'from_email', 'from_name', 'reply_to',
      'sms_header', 'dlt_pe_id', 'dlt_entity_name', 'waba_id', 'phone_number_id',
      'display_phone', 'daily_limit', 'notes',
    ]) {
      if (input[column] !== undefined) patch[column] = input[column] ?? null;
    }
    if (input.config !== undefined) {
      patch.config = JSON.stringify(stripSecrets(input.config as Record<string, unknown>));
    }

    if (Object.keys(patch).length > 0) {
      await execute(
        `UPDATE messaging_senders SET ${Object.keys(patch).map((column) => `\`${column}\` = ?`).join(', ')} WHERE shop_id = ? AND id = ?`,
        [...Object.values(patch), shopId(), id],
        exec,
      );
    }

    if (input.is_default === true) await this.makeDefault(id, exec);
    clearMessagingSettingsCache();
    return this.get(id, exec);
  },

  /** Exactly one default per channel, enforced by clearing the others. */
  async makeDefault(id: number, exec: Executor = pool) {
    const row = await queryOne<RowDataPacket & { channel: string }>(
      'SELECT channel FROM messaging_senders WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
      [shopId(), id],
      exec,
    );
    if (!row) throw ApiError.notFound('Sender');
    await execute('UPDATE messaging_senders SET is_default = 0 WHERE shop_id = ? AND channel = ?', [shopId(), row.channel], exec);
    await execute('UPDATE messaging_senders SET is_default = 1 WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
    return { is_default: true };
  },

  /**
   * Removing one is refused while templates still point at it.
   *
   * The alternative — nulling their sender — turns a working template into one
   * that silently falls back to whatever the channel default happens to be,
   * which for a shop with a transactional and a promotional gateway is how
   * marketing goes out under the transactional header.
   */
  async remove(id: number, exec: Executor = pool) {
    const sender = await this.get(id, exec);
    if (sender.stats.templates_using > 0) {
      throw ApiError.conflict(
        `${sender.stats.templates_using} template${sender.stats.templates_using === 1 ? '' : 's'} still send from this sender. Point them elsewhere first.`,
        'IN_USE',
      );
    }
    await execute('UPDATE messaging_senders SET deleted_at = NOW(), is_default = 0 WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
    return { deleted: true };
  },

  /**
   * What is missing before this identity can send for real.
   *
   * Not a network call — there is nothing to call yet. It is the checklist a
   * shop has to work through with its BSP and the DLT portal, answered from
   * what has been filled in, which is the useful half of a "test connection"
   * button while the provider is simulated.
   */
  async readiness(id: number, exec: Executor = pool) {
    const sender = await this.get(id, exec);
    const missing: { field: string; message: string }[] = [];

    if (sender.provider === 'simulator' || sender.provider === 'logging') {
      missing.push({
        field: 'provider',
        message: 'No provider is connected, so messages from this sender are recorded rather than delivered.',
      });
    }
    if (sender.channel === 'email' && !sender.from_email) {
      missing.push({ field: 'from_email', message: 'A From address is required.' });
    }
    if (sender.channel === 'sms') {
      if (!sender.sms_header) missing.push({ field: 'sms_header', message: 'The registered sender header is required.' });
      if (!sender.dlt_pe_id) missing.push({ field: 'dlt_pe_id', message: 'The Principal Entity ID from the DLT registry is required.' });
    }
    if (sender.channel === 'whatsapp') {
      if (!sender.waba_id) missing.push({ field: 'waba_id', message: 'The WhatsApp Business Account ID is required.' });
      if (!sender.phone_number_id) missing.push({ field: 'phone_number_id', message: 'The phone number ID is required.' });
    }

    return { ready: missing.length === 0, delivers: sender.delivers, missing };
  },
};
