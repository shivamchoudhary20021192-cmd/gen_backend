import { randomBytes } from 'node:crypto';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';
import { auditService } from '../../shared/audit.service';
import { messagingService } from '../messaging/messaging.service';

/**
 * The storefront's mailing list.
 *
 * Customers here are identified by phone, so an email typed into a footer
 * cannot be a customer on its own: it is a subscriber. Every opt-in and
 * opt-out still lands in the append-only `customer_consents` log — against
 * the customer when the email is theirs (and then their email-marketing flag
 * follows, which is what campaign audiences read), against the email itself
 * otherwise. Unsubscribing never needs a sign-in: every subscriber holds a
 * token for the link at the bottom of each email.
 */

export type SubscriberSource = 'footer' | 'checkout' | 'popup' | 'account' | 'import' | 'admin';

/** customer_consents.source has its own vocabulary. */
const CONSENT_SOURCE: Record<SubscriberSource, string> = {
  footer: 'footer',
  checkout: 'checkout',
  popup: 'popup',
  account: 'preference_center',
  import: 'import',
  admin: 'admin',
};

interface SubscriberRow extends RowDataPacket {
  id: number;
  email: string;
  status: 'subscribed' | 'unsubscribed';
  source: SubscriberSource;
  customer_id: number | null;
  unsubscribe_token: string;
  country_code: string | null;
  subscribed_at: Date;
  unsubscribed_at: Date | null;
}

interface Meta {
  ip: string | null;
  userAgent: string | null;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function customersWithEmail(email: string): Promise<number[]> {
  const rows = await query<RowDataPacket & { id: number }>(
    'SELECT id FROM customers WHERE shop_id = ? AND LOWER(email) = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 5',
    [shopId(), email],
  );
  return rows.map((row) => Number(row.id));
}

/** A consent row for an email that is nobody's customer (yet). */
async function recordSubjectConsent(email: string, granted: boolean, source: SubscriberSource, meta: Meta, evidence: unknown): Promise<void> {
  await execute(
    `INSERT INTO customer_consents (shop_id, customer_id, subject_identifier, purpose, status, notice_version, source, ip, user_agent, evidence)
     VALUES (?, NULL, ?, 'marketing_email', ?, ?, ?, ${meta.ip ? 'INET6_ATON(?)' : 'NULL'}, ?, ?)`,
    [
      shopId(),
      email,
      granted ? 'granted' : 'withdrawn',
      process.env.PRIVACY_NOTICE_VERSION ?? '2026-09',
      CONSENT_SOURCE[source],
      ...(meta.ip ? [meta.ip] : []),
      meta.userAgent?.slice(0, 255) ?? null,
      JSON.stringify(evidence ?? null),
    ],
  );
}

/** The consent change, for the customers the email belongs to or else for the email itself. */
async function recordConsent(email: string, customerIds: number[], granted: boolean, source: SubscriberSource, meta: Meta, evidence: unknown): Promise<void> {
  if (customerIds.length === 0) {
    await recordSubjectConsent(email, granted, source, meta, evidence);
    return;
  }
  for (const customerId of customerIds) {
    await messagingService.setMarketingConsent({
      customerId,
      subjectIdentifier: email,
      channel: 'email',
      granted,
      source: CONSENT_SOURCE[source],
      ip: meta.ip,
      userAgent: meta.userAgent,
      evidence,
    });
  }
}

function present(row: SubscriberRow & { customer_name?: string | null }) {
  return {
    id: Number(row.id),
    email: row.email,
    status: row.status,
    source: row.source,
    customer: row.customer_id ? { id: Number(row.customer_id), name: row.customer_name ?? null } : null,
    country_code: row.country_code,
    subscribed_at: row.subscribed_at,
    unsubscribed_at: row.unsubscribed_at,
  };
}

export const newsletterService = {
  /**
   * Adds an email to the list, or re-subscribes one that had left. The
   * answer is the same whether or not the address was already on the list,
   * so the form cannot be used to find out who subscribes.
   */
  async subscribe(
    input: { email: string; source: SubscriberSource; customerId?: number | null; countryCode?: string | null; wording?: string | null },
    meta: Meta,
  ): Promise<{ subscribed: true }> {
    const email = normaliseEmail(input.email);
    const existing = await queryOne<SubscriberRow>('SELECT * FROM newsletter_subscribers WHERE shop_id = ? AND email = ? LIMIT 1', [shopId(), email]);
    if (existing?.status === 'subscribed') {
      if (input.customerId && !existing.customer_id) {
        await execute('UPDATE newsletter_subscribers SET customer_id = ? WHERE shop_id = ? AND id = ?', [input.customerId, shopId(), existing.id]);
      }
      return { subscribed: true };
    }

    const customerIds = input.customerId ? [input.customerId] : await customersWithEmail(email);
    if (existing) {
      await execute(
        `UPDATE newsletter_subscribers
            SET status = 'subscribed', source = ?, subscribed_at = NOW(), unsubscribed_at = NULL,
                customer_id = COALESCE(?, customer_id), country_code = COALESCE(?, country_code)
          WHERE shop_id = ? AND id = ?`,
        [input.source, customerIds[0] ?? null, input.countryCode ?? null, shopId(), existing.id],
      );
    } else {
      await execute(
        `INSERT INTO newsletter_subscribers (shop_id, email, status, source, customer_id, unsubscribe_token, country_code)
         VALUES (?, ?, 'subscribed', ?, ?, ?, ?)`,
        [shopId(), email, input.source, customerIds[0] ?? null, randomBytes(32).toString('base64url'), input.countryCode ?? null],
      );
    }
    // What the person agreed to, in the words they saw.
    await recordConsent(email, customerIds, true, input.source, meta, { wording: input.wording ?? null, via: 'newsletter' });
    logger.info('newsletter.subscribed', { source: input.source, linked_customers: customerIds.length });
    return { subscribed: true };
  },

  /** The link at the bottom of every email. Unknown or used tokens answer the same. */
  async unsubscribeByToken(token: string, meta: Meta): Promise<{ unsubscribed: true; email: string | null }> {
    const row = await queryOne<SubscriberRow>('SELECT * FROM newsletter_subscribers WHERE shop_id = ? AND unsubscribe_token = ? LIMIT 1', [shopId(), token]);
    if (!row) return { unsubscribed: true, email: null };
    if (row.status === 'subscribed') await this.leave(row, 'footer', meta, { via: 'unsubscribe_link' });
    // Masked: whoever holds the link knows the address, but a forwarded email need not show it in full.
    const [name, domain] = row.email.split('@');
    return { unsubscribed: true, email: `${name.slice(0, 2)}…@${domain}` };
  },

  async unsubscribeById(id: number, actor: { id: number | null; label: string | null }, meta: Meta) {
    const row = await queryOne<SubscriberRow>('SELECT * FROM newsletter_subscribers WHERE shop_id = ? AND id = ? LIMIT 1', [shopId(), id]);
    if (!row) throw ApiError.notFound('Subscriber');
    if (row.status === 'subscribed') {
      await this.leave(row, 'admin', meta, { via: 'admin', by: actor.label });
      await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'newsletter.unsubscribed', entityType: 'newsletter_subscriber', entityId: row.id, summary: `Unsubscribed ${row.email}` });
    }
    return { unsubscribed: true };
  },

  async leave(row: SubscriberRow, source: SubscriberSource, meta: Meta, evidence: unknown): Promise<void> {
    await execute("UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = NOW() WHERE shop_id = ? AND id = ?", [shopId(), row.id]);
    const customerIds = row.customer_id ? [Number(row.customer_id)] : await customersWithEmail(row.email);
    await recordConsent(row.email, customerIds, false, source, meta, evidence);
  },

  /**
   * After an order: a subscriber who has just become a customer is linked,
   * and their standing consent follows onto the customer record, so
   * campaigns (which address customers) reach them.
   */
  async linkCustomer(emailInput: string, customerId: number, meta: Meta): Promise<void> {
    const email = normaliseEmail(emailInput);
    const row = await queryOne<SubscriberRow>('SELECT * FROM newsletter_subscribers WHERE shop_id = ? AND email = ? LIMIT 1', [shopId(), email]);
    if (!row || row.customer_id) return;
    await execute('UPDATE newsletter_subscribers SET customer_id = ? WHERE shop_id = ? AND id = ?', [customerId, shopId(), row.id]);
    if (row.status === 'subscribed') {
      await messagingService.setMarketingConsent({
        customerId,
        subjectIdentifier: email,
        channel: 'email',
        granted: true,
        source: CONSENT_SOURCE[row.source],
        ip: meta.ip,
        userAgent: meta.userAgent,
        evidence: { via: 'newsletter_subscriber', subscriber_id: Number(row.id), subscribed_at: row.subscribed_at },
      });
    }
  },

  async list(filters: { status?: 'subscribed' | 'unsubscribed'; q?: string; page: number; limit: number }) {
    const where = ['s.shop_id = ?'];
    const params: unknown[] = [shopId()];
    if (filters.status) {
      where.push('s.status = ?');
      params.push(filters.status);
    }
    if (filters.q) {
      where.push('s.email LIKE ?');
      params.push(`%${filters.q.toLowerCase()}%`);
    }
    const rows = await query<SubscriberRow & { customer_name: string | null }>(
      `SELECT s.*, NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS customer_name
         FROM newsletter_subscribers s
         LEFT JOIN customers c ON c.shop_id = s.shop_id AND c.id = s.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.subscribed_at DESC, s.id DESC
        LIMIT ? OFFSET ?`,
      [...params, filters.limit, (filters.page - 1) * filters.limit],
    );
    const total = await queryOne<RowDataPacket & { total: number }>(`SELECT COUNT(*) AS total FROM newsletter_subscribers s WHERE ${where.join(' AND ')}`, params);
    const counts = await query<RowDataPacket & { status: string; total: number }>(
      "SELECT status, COUNT(*) AS total FROM newsletter_subscribers WHERE shop_id = ? GROUP BY status",
      [shopId()],
    );
    const lastThirty = await queryOne<RowDataPacket & { total: number }>(
      "SELECT COUNT(*) AS total FROM newsletter_subscribers WHERE shop_id = ? AND status = 'subscribed' AND subscribed_at >= NOW() - INTERVAL 30 DAY",
      [shopId()],
    );
    const count = Number(total?.total ?? 0);
    return {
      subscribers: rows.map(present),
      counts: {
        subscribed: Number(counts.find((row) => row.status === 'subscribed')?.total ?? 0),
        unsubscribed: Number(counts.find((row) => row.status === 'unsubscribed')?.total ?? 0),
        new_last_30_days: Number(lastThirty?.total ?? 0),
      },
      pagination: { page: filters.page, limit: filters.limit, total: count, pages: Math.max(1, Math.ceil(count / filters.limit)) },
    };
  },

  /** Everyone currently subscribed, for an email tool: CSV with a header row. */
  async exportCsv(): Promise<string> {
    const rows = await query<SubscriberRow>(
      "SELECT * FROM newsletter_subscribers WHERE shop_id = ? AND status = 'subscribed' ORDER BY subscribed_at",
      [shopId()],
    );
    const escape = (value: unknown) => {
      const text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
      // A leading =, +, - or @ is a formula to a spreadsheet; neutralise it.
      const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [['email', 'source', 'country', 'subscribed_at', 'customer_id'].join(',')];
    for (const row of rows) lines.push([row.email, row.source, row.country_code, row.subscribed_at, row.customer_id].map(escape).join(','));
    return `${lines.join('\n')}\n`;
  },
};
