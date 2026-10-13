import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface TemplateRow extends RowDataPacket {
  id: number;
  event_key: string;
  channel: string;
  category: string;
  locale: string;
  name: string;
  description: string | null;
  subject: string | null;
  preheader: string | null;
  header_text: string | null;
  body: string;
  footer_text: string | null;
  buttons: unknown;
  provider: string | null;
  sender_id: number | null;
  provider_template_id: string | null;
  dlt_template_id: string | null;
  approval_status: string | null;
  approval_note: string | null;
  approved_at: Date | null;
  variables: unknown;
  sample_variables: unknown;
  is_transactional: number;
  is_active: number;
  last_used_at: Date | null;
  usage_count: number;
  deleted_at: Date | null;
}

export interface SenderRow extends RowDataPacket {
  id: number;
  channel: string;
  name: string;
  provider: string;
  status: string;
  is_default: number;
  from_email: string | null;
  from_name: string | null;
  reply_to: string | null;
  sms_header: string | null;
  dlt_pe_id: string | null;
  dlt_entity_name: string | null;
  waba_id: string | null;
  phone_number_id: string | null;
  display_phone: string | null;
  quality_rating: string;
  config: unknown;
  daily_limit: number | null;
  notes: string | null;
}

export interface ConsentRow extends RowDataPacket {
  purpose: string;
  status: string;
  created_at: Date;
}

export const messagingRepository = {
  async findTemplate(eventKey: string, channel: string, exec: Executor = pool): Promise<TemplateRow | null> {
    return queryOne<TemplateRow>(
      `SELECT * FROM notification_templates
        WHERE shop_id = ? AND event_key = ? AND channel = ? AND is_active = 1 AND deleted_at IS NULL
        ORDER BY (locale = 'en') DESC, id
        LIMIT 1`,
      [shopId(), eventKey, channel],
      exec,
    );
  },

  async findTemplateById(id: number, exec: Executor = pool): Promise<TemplateRow | null> {
    return queryOne<TemplateRow>(
      'SELECT * FROM notification_templates WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
      [shopId(), id],
      exec,
    );
  },

  async findSender(id: number, exec: Executor = pool): Promise<SenderRow | null> {
    return queryOne<SenderRow>(
      'SELECT * FROM messaging_senders WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
      [shopId(), id],
      exec,
    );
  },

  /** The identity a channel falls back to when a template names none. */
  async defaultSender(channel: string, exec: Executor = pool): Promise<SenderRow | null> {
    return queryOne<SenderRow>(
      `SELECT * FROM messaging_senders
        WHERE shop_id = ? AND channel = ? AND deleted_at IS NULL AND status = 'active'
        ORDER BY is_default DESC, id
        LIMIT 1`,
      [shopId(), channel],
      exec,
    );
  },

  /** So the templates list can show what is actually being used, and what is not. */
  async touchTemplateUsage(templateId: number, exec: Executor = pool): Promise<void> {
    await execute(
      'UPDATE notification_templates SET last_used_at = NOW(), usage_count = usage_count + 1 WHERE shop_id = ? AND id = ?',
      [shopId(), templateId],
      exec,
    );
  },

  async listTemplates(exec: Executor = pool): Promise<TemplateRow[]> {
    return query<TemplateRow>(
      `SELECT * FROM notification_templates WHERE shop_id = ? ORDER BY channel, event_key`,
      [shopId()],
      exec,
    );
  },

  /**
   * The current state of one consent purpose.
   *
   * `customer_consents` is append-only — granting and withdrawing both write a
   * row — so "do they consent" is the latest row for that purpose, not the
   * existence of a row. Reading it any other way makes a withdrawal ineffective,
   * which is the one bug in a consent system that actually matters.
   */
  async latestConsent(
    customerId: number,
    purpose: string,
    exec: Executor = pool,
  ): Promise<ConsentRow | null> {
    return queryOne<ConsentRow>(
      `SELECT purpose, status, created_at
         FROM customer_consents
        WHERE shop_id = ? AND customer_id = ? AND purpose = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [shopId(), customerId, purpose],
      exec,
    );
  },

  /**
   * May we send marketing to this person on this channel?
   *
   * One definition, used by both the send path and the audience query, because
   * two definitions is how a campaign reports four thousand recipients and then
   * skips all four thousand.
   *
   * It is the **flag AND the log**:
   *
   *   - `customers.accepts_*_marketing` must be 1. It is the denormalised
   *     opt-in, set by the consent endpoint and by imports, and it is the only
   *     thing an imported list has.
   *   - and the append-only `customer_consents` log must not have a withdrawal
   *     more recent than the last grant. A withdrawal always wins, even if the
   *     flag was never updated.
   */
  async marketingAllowed(
    customerId: number,
    channel: 'whatsapp' | 'sms' | 'email',
    exec: Executor = pool,
  ): Promise<{ allowed: boolean; reason: 'ok' | 'never' | 'withdrawn' }> {
    const column =
      channel === 'whatsapp'
        ? 'accepts_whatsapp_marketing'
        : channel === 'sms'
          ? 'accepts_sms_marketing'
          : 'accepts_email_marketing';
    const purpose = `marketing_${channel}`;

    const row = await queryOne<RowDataPacket & { flag: number | null; latest: string | null }>(
      `SELECT c.${column} AS flag,
              (SELECT cc.status FROM customer_consents cc
                WHERE cc.shop_id = c.shop_id AND cc.customer_id = c.id AND cc.purpose = ?
                ORDER BY cc.created_at DESC, cc.id DESC LIMIT 1) AS latest
         FROM customers c WHERE c.shop_id = ? AND c.id = ? LIMIT 1`,
      [purpose, shopId(), customerId],
      exec,
    );

    if (!row) return { allowed: false, reason: 'never' };
    if (row.latest === 'withdrawn') return { allowed: false, reason: 'withdrawn' };
    if (row.flag === 1) return { allowed: true, reason: 'ok' };
    return { allowed: false, reason: 'never' };
  },

  async recordConsent(
    input: {
      customerId: number;
      subjectIdentifier: string;
      purpose: string;
      status: 'granted' | 'withdrawn';
      source: string;
      noticeVersion: string;
      ip: string | null;
      userAgent: string | null;
      evidence: unknown;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO customer_consents
         (shop_id, customer_id, subject_identifier, purpose, status, notice_version, source, ip, user_agent, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, INET6_ATON(?), ?, ?)`,
      [
        shopId(),
        input.customerId,
        input.subjectIdentifier,
        input.purpose,
        input.status,
        input.noticeVersion,
        input.source,
        input.ip,
        input.userAgent,
        JSON.stringify(input.evidence ?? null),
      ],
      exec,
    );
  },

  /** The denormalised flag the audience query filters on. */
  async setMarketingFlag(
    customerId: number,
    column: 'accepts_whatsapp_marketing' | 'accepts_sms_marketing' | 'accepts_email_marketing',
    value: boolean,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(`UPDATE customers SET ${column} = ? WHERE shop_id = ? AND id = ?`, [value ? 1 : 0, shopId(), customerId], exec);
  },

  async logMessage(
    input: {
      templateId: number | null;
      eventKey: string;
      channel: string;
      recipient: string;
      customerId: number | null;
      orderId: number | null;
      campaignId?: number | null;
      senderId?: number | null;
      sentByAdminId?: number | null;
      provider: string;
      providerMessageId: string | null;
      status: string;
      error: string | null;
      cost: number | null;
      payload: unknown;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO notification_logs
         (shop_id, template_id, event_key, channel, recipient, customer_id, order_id, campaign_id,
          sender_id, sent_by_admin_id, provider,
          provider_message_id, status, error_message, cost, payload,
          queued_at, sent_at, delivered_at, failed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(),
               CASE WHEN ? IN ('sent','delivered') THEN NOW() ELSE NULL END,
               CASE WHEN ? = 'delivered' THEN NOW() ELSE NULL END,
               CASE WHEN ? = 'failed' THEN NOW() ELSE NULL END)`,
      [
        shopId(),
        input.templateId,
        input.eventKey,
        input.channel,
        input.recipient,
        input.customerId,
        input.orderId,
        input.campaignId ?? null,
        input.senderId ?? null,
        input.sentByAdminId ?? null,
        input.provider,
        input.providerMessageId,
        input.status,
        input.error,
        input.cost,
        JSON.stringify(input.payload ?? null),
        input.status,
        input.status,
        input.status,
      ],
      exec,
    );
  },

  /**
   * When this customer was last messaged on this channel about anything
   * non-transactional.
   *
   * The frequency cap reads this. Someone who saved four things should hear
   * from the shop once, not four times.
   */
  async lastMarketingMessageAt(
    customerId: number,
    channel: string,
    exec: Executor = pool,
  ): Promise<Date | null> {
    const row = await queryOne<RowDataPacket & { last_at: Date | null }>(
      `SELECT MAX(l.queued_at) AS last_at
         FROM notification_logs l
         LEFT JOIN notification_templates t ON t.id = l.template_id AND t.shop_id = l.shop_id
        WHERE l.shop_id = ? AND l.customer_id = ? AND l.channel = ?
          AND COALESCE(t.is_transactional, 0) = 0
          AND l.status <> 'failed'`,
      [shopId(), customerId, channel],
      exec,
    );
    return row?.last_at ?? null;
  },

  /** The most recent code issued for a phone, for the OTP flow's own log. */
  async recentLogFor(
    eventKey: string,
    recipient: string,
    exec: Executor = pool,
  ): Promise<(RowDataPacket & { payload: unknown; status: string }) | null> {
    return queryOne<RowDataPacket & { payload: unknown; status: string }>(
      `SELECT payload, status FROM notification_logs
        WHERE shop_id = ? AND event_key = ? AND recipient = ?
        ORDER BY id DESC LIMIT 1`,
      [shopId(), eventKey, recipient],
      exec,
    );
  },
};
