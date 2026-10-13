import crypto from 'node:crypto';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { execute, insert, query, queryOne, type RowDataPacket } from '../../db/pool';
import { messagingRepository } from '../../modules/messaging/messaging.repository';
import { auditService } from '../../shared/audit.service';
import { eventBus } from '../events/eventBus';
import { notificationEngine } from '../notifications/notificationEngine';
import { onlineStoreUrl } from '../shops/urls';
import { shopId, tenancy } from '../tenancy/context';
import { collectCustomerData, eraseCustomerData, lastOrderAt, ordersOf, subjectFor, type Subject } from './customerData';
import { policies } from './policies';
import { privacySettings } from './privacySettings';

/**
 * Privacy requests (Customers → Consents & privacy): a person asking to see,
 * correct, take away or erase the data the store holds about them, to
 * withdraw consent, or to raise a grievance — the rights of GDPR Arts. 15–21,
 * CCPA/CPRA, and DPDP ss.11–14.
 *
 *   verifying    made on the storefront; waiting for the requester to click
 *                the link emailed to them, so no one can ask for someone
 *                else's data. Requests from a signed-in account, or entered
 *                by staff who checked who they were talking to, skip this.
 *   received     confirmed; the response deadline runs from here
 *                (shop_privacy_settings.request_response_days, 30 by default
 *                — the GDPR's month).
 *   in_progress  staff have started: a data export exists, say.
 *   scheduled    an erasure, waiting out its grace period — and, if the
 *                customer ordered recently, the window for returns and
 *                chargebacks — before the sweep runs it. Cancellable until then.
 *   completed | rejected | cancelled
 *
 * Apps hear about access requests (customers/data_request) and erasures
 * (customers/redact), as on Shopify, so data they hold goes too.
 */

export type RequestType = 'access' | 'portability' | 'correction' | 'erasure' | 'withdraw_consent' | 'grievance';
export type RequestStatus = 'verifying' | 'received' | 'in_progress' | 'scheduled' | 'completed' | 'rejected' | 'cancelled';
export type RequestSource = 'storefront' | 'account' | 'admin' | 'api';

export const REQUEST_TYPES: RequestType[] = ['access', 'portability', 'correction', 'erasure', 'withdraw_consent', 'grievance'];

const ACTION_WORDS: Record<RequestType, string> = {
  access: 'receive a copy of',
  portability: 'receive a portable copy of',
  correction: 'correct',
  erasure: 'erase',
  withdraw_consent: 'withdraw your marketing consent for',
  grievance: 'raise a concern about',
};

export const TYPE_LABELS: Record<RequestType, string> = {
  access: 'Access',
  portability: 'Data portability',
  correction: 'Correction',
  erasure: 'Erasure',
  withdraw_consent: 'Withdraw consent',
  grievance: 'Grievance',
};

const VERIFY_HOURS = 48;
const EXPORT_DAYS = 30;
const CUSTOMER_LINK_DAYS = 7;

type Actor = { id: number | null; label: string | null };

interface RequestRow extends RowDataPacket {
  id: number;
  reference: string;
  customer_id: number | null;
  contact_value: string;
  request_type: RequestType;
  source: RequestSource;
  requester_country: string | null;
  status: RequestStatus;
  details: string | null;
  verification_token_hash: string | null;
  verification_expires_at: Date | null;
  verified_at: Date | null;
  due_at: Date | null;
  scheduled_for: Date | null;
  processed_at: Date | null;
  completed_at: Date | null;
  outcome_note: string | null;
  handled_by_admin_id: number | null;
  created_at: Date;
  updated_at: Date;
  first_name?: string | null;
  last_name?: string | null;
  customer_email?: string | null;
  customer_status?: string | null;
}

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
const dayString = (value: Date) => value.toISOString().slice(0, 10);

function newReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  return `PR-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

function present(row: RequestRow) {
  const overdue = Boolean(row.due_at && ['received', 'in_progress'].includes(row.status) && row.due_at.getTime() < Date.now());
  return {
    id: Number(row.id),
    reference: row.reference,
    type: row.request_type,
    type_label: TYPE_LABELS[row.request_type],
    status: row.status,
    source: row.source,
    contact: row.contact_value,
    requester_country: row.requester_country,
    details: row.details,
    customer: row.customer_id
      ? {
          id: Number(row.customer_id),
          name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
          email: row.customer_email ?? null,
          erased: row.customer_status === 'deleted',
        }
      : null,
    verified_at: iso(row.verified_at),
    due_at: iso(row.due_at),
    overdue,
    scheduled_for: iso(row.scheduled_for),
    processed_at: iso(row.processed_at),
    completed_at: iso(row.completed_at),
    outcome_note: row.outcome_note,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

const SELECT = `SELECT r.*, c.first_name, c.last_name, c.email AS customer_email, c.status AS customer_status
                  FROM data_requests r
                  LEFT JOIN customers c ON c.shop_id = r.shop_id AND c.id = r.customer_id`;

async function row(id: number): Promise<RequestRow> {
  const found = await queryOne<RequestRow>(`${SELECT} WHERE r.shop_id = ? AND r.id = ?`, [shopId(), id]);
  if (!found) throw ApiError.notFound('Privacy request');
  return found;
}

async function contactLine(): Promise<string> {
  const settings = await privacySettings.get();
  const shop = tenancy.current();
  const support = await queryOne<RowDataPacket & { value: string | null }>(
    "SELECT value FROM settings WHERE shop_id = ? AND setting_key = 'store.support_email' LIMIT 1",
    [shopId()],
  );
  return settings.privacy_email || settings.grievance_officer_email || support?.value || shop.name;
}

async function firstName(customerId: number | null): Promise<string> {
  if (!customerId) return 'there';
  const customer = await queryOne<RowDataPacket & { first_name: string | null }>('SELECT first_name FROM customers WHERE shop_id = ? AND id = ?', [shopId(), customerId]);
  return customer?.first_name?.trim().split(/\s+/)[0] || 'there';
}

/** Email the requester (by the contact they gave: an email address, or the customer's). */
async function notifyRequester(request: RequestRow, key: string, variables: Record<string, string>): Promise<void> {
  const email = request.contact_value.includes('@') ? request.contact_value : request.customer_email ?? null;
  if (!email) return;
  try {
    await notificationEngine.notifyCustomer({
      key,
      recipient: { customerId: request.customer_id, email, phone: null, countryCode: null },
      variables: {
        first_name: await firstName(request.customer_id),
        reference: request.reference,
        request_action: ACTION_WORDS[request.request_type],
        privacy_contact: await contactLine(),
        ...variables,
      },
    });
  } catch (error) {
    logger.warn('privacy.notify_failed', { key, request: request.reference, error: error instanceof Error ? error.message : String(error) });
  }
}

async function subjectOf(request: RequestRow): Promise<Subject> {
  return subjectFor({ customerId: request.customer_id, contact: request.contact_value });
}

async function webhookCustomer(request: RequestRow, subject: Subject) {
  const customer = subject.customerId
    ? await queryOne<RowDataPacket & { public_id: string }>('SELECT public_id FROM customers WHERE shop_id = ? AND id = ?', [shopId(), subject.customerId])
    : null;
  return { id: customer?.public_id ?? null, email: subject.emails[0] ?? null, phone: subject.phones[0] ?? null, reference: request.reference };
}

export const privacyRequests = {
  /**
   * A new request. `verified` when who is asking is already known — a
   * signed-in customer, or staff who checked — else the requester is sent a
   * link to confirm it is theirs.
   */
  async create(input: {
    type: RequestType;
    source: RequestSource;
    contact: string;
    customerId?: number | null;
    details?: string | null;
    country?: string | null;
    verified: boolean;
    actor?: Actor;
  }) {
    const contact = input.contact.trim().toLowerCase().slice(0, 191);
    if (!contact) throw ApiError.validation({ contact: ['An email address or phone number is required.'] });
    const subject = await subjectFor({ customerId: input.customerId ?? null, contact });
    const settings = await privacySettings.get();
    const token = input.verified ? null : newToken();
    const now = new Date();
    let reference = newReference();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const clash = await queryOne<RowDataPacket>('SELECT id FROM data_requests WHERE shop_id = ? AND reference = ?', [shopId(), reference]);
      if (!clash) break;
      reference = newReference();
    }
    const id = await insert(
      `INSERT INTO data_requests
         (shop_id, reference, customer_id, contact_value, request_type, source, requester_country, status, details,
          verification_token_hash, verification_expires_at, verified_at, due_at, handled_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        reference,
        subject.customerId,
        contact,
        input.type,
        input.source,
        input.country ?? null,
        input.verified ? 'received' : 'verifying',
        input.details?.trim().slice(0, 4000) || null,
        token ? hash(token) : null,
        token ? new Date(now.getTime() + VERIFY_HOURS * 3_600_000) : null,
        input.verified ? now : null,
        input.verified ? new Date(now.getTime() + settings.request_response_days * 86_400_000) : null,
        input.actor?.id ?? null,
      ],
    );
    const request = await row(id);
    if (token) {
      await notifyRequester(request, 'privacy.request_verify', {
        contact,
        link: `${onlineStoreUrl()}/privacy/request/verify?token=${encodeURIComponent(token)}`,
      });
    } else {
      await this.acknowledge(request);
    }
    await auditService.log({
      actorId: input.actor?.id ?? null,
      actorLabel: input.actor?.label ?? (input.source === 'admin' ? null : 'shopper'),
      action: 'privacy.request_created',
      entityType: 'data_request',
      entityId: id,
      summary: `${TYPE_LABELS[input.type]} request ${reference} (${input.source})`,
    });
    return { request: present(request), verificationRequired: Boolean(token) };
  },

  /** Confirmed: tell the requester when to expect an answer, and tell staff. */
  async acknowledge(request: RequestRow): Promise<void> {
    await notifyRequester(request, 'privacy.request_received', { due_date: request.due_at ? dayString(request.due_at) : '' });
    await notificationEngine
      .notifyStaff({
        key: 'staff.privacy_request',
        title: `New privacy request ${request.reference}`,
        body: `${TYPE_LABELS[request.request_type]} request from ${request.contact_value}.${request.due_at ? ` Respond by ${dayString(request.due_at)}.` : ''}`,
        linkUrl: `/privacy?request=${request.id}`,
        entityType: 'data_request',
        entityId: Number(request.id),
        variables: { reference: request.reference },
      })
      .catch((error: unknown) => logger.warn('privacy.staff_notify_failed', { error: error instanceof Error ? error.message : String(error) }));
  },

  /** The requester clicked the link: the request is theirs, and the clock starts. */
  async verify(token: string) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const found = await queryOne<RequestRow>(
      `${SELECT} WHERE r.shop_id = ? AND r.verification_token_hash = ? AND r.status = 'verifying' AND r.verification_expires_at > UTC_TIMESTAMP()`,
      [shopId(), hash(token)],
    );
    if (!found) return null;
    const settings = await privacySettings.get();
    await execute(
      `UPDATE data_requests
          SET status = 'received', verified_at = UTC_TIMESTAMP(), verification_token_hash = NULL,
              due_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY)
        WHERE shop_id = ? AND id = ?`,
      [settings.request_response_days, shopId(), found.id],
    );
    const request = await row(Number(found.id));
    await this.acknowledge(request);
    return present(request);
  },

  async list(filters: { status?: RequestStatus | 'open'; type?: RequestType; q?: string; customer_id?: number; page?: number; limit?: number }) {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
    const where = ['r.shop_id = ?'];
    const params: unknown[] = [shopId()];
    if (filters.status === 'open') where.push("r.status IN ('received','in_progress','scheduled')");
    else if (filters.status) {
      where.push('r.status = ?');
      params.push(filters.status);
    }
    if (filters.type) {
      where.push('r.request_type = ?');
      params.push(filters.type);
    }
    if (filters.customer_id) {
      where.push('r.customer_id = ?');
      params.push(filters.customer_id);
    }
    if (filters.q) {
      where.push('(r.reference LIKE ? OR r.contact_value LIKE ?)');
      params.push(`%${filters.q}%`, `%${filters.q}%`);
    }
    const total = await queryOne<RowDataPacket & { n: number }>(`SELECT COUNT(*) AS n FROM data_requests r WHERE ${where.join(' AND ')}`, params);
    const rows = await query<RequestRow>(
      `${SELECT} WHERE ${where.join(' AND ')}
        ORDER BY FIELD(r.status, 'received', 'in_progress', 'scheduled', 'verifying', 'completed', 'rejected', 'cancelled'), r.due_at IS NULL, r.due_at, r.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    const counts = await query<RowDataPacket & { status: RequestStatus; n: number; overdue: number }>(
      `SELECT status, COUNT(*) AS n, SUM(due_at < UTC_TIMESTAMP() AND status IN ('received','in_progress')) AS overdue
         FROM data_requests WHERE shop_id = ? GROUP BY status`,
      [shopId()],
    );
    return {
      requests: rows.map(present),
      pagination: { page, limit, total: Number(total?.n ?? 0) },
      counts: Object.fromEntries(counts.map((entry) => [entry.status, Number(entry.n)])),
      overdue: counts.reduce((sum, entry) => sum + Number(entry.overdue ?? 0), 0),
    };
  },

  async get(id: number) {
    const request = await row(id);
    const subject = await subjectOf(request);
    const exports = await query<RowDataPacket & { id: number; size_bytes: number; expires_at: Date; downloaded_at: Date | null; created_at: Date; download_token_hash: string | null }>(
      'SELECT id, size_bytes, expires_at, downloaded_at, created_at, download_token_hash FROM customer_data_exports WHERE shop_id = ? AND data_request_id = ? ORDER BY id DESC',
      [shopId(), id],
    );
    const orders = await ordersOf(subject);
    const last = await lastOrderAt(subject);
    return {
      request: present(request),
      subject: { customer_id: subject.customerId, emails: subject.emails, phones: subject.phones, orders: orders.length, last_order_at: iso(last) },
      exports: exports.map((entry) => ({
        id: Number(entry.id),
        size_bytes: Number(entry.size_bytes),
        expires_at: iso(entry.expires_at),
        downloaded_at: iso(entry.downloaded_at),
        sent_to_customer: Boolean(entry.download_token_hash),
        created_at: iso(entry.created_at),
      })),
      erasure_would_run_at: request.request_type === 'erasure' ? iso(await this.erasureDate(subject)) : null,
    };
  },

  /** Staff confirmed who the requester is some other way (a call, an ID check). */
  async markVerified(id: number, actor: Actor) {
    const request = await row(id);
    if (request.status !== 'verifying') throw ApiError.conflict('This request is already verified.');
    const settings = await privacySettings.get();
    await execute(
      `UPDATE data_requests SET status = 'received', verified_at = UTC_TIMESTAMP(), verification_token_hash = NULL,
              due_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY), handled_by_admin_id = ? WHERE shop_id = ? AND id = ?`,
      [settings.request_response_days, actor.id, shopId(), id],
    );
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'privacy.request_verified', entityType: 'data_request', entityId: id, summary: `Verified ${request.reference} by hand` });
    const updated = await row(id);
    await this.acknowledge(updated);
    return present(updated);
  },

  async start(id: number, actor: Actor) {
    const request = await row(id);
    if (request.status !== 'received') throw ApiError.conflict('Only a received request can be started.');
    await execute("UPDATE data_requests SET status = 'in_progress', handled_by_admin_id = ? WHERE shop_id = ? AND id = ?", [actor.id, shopId(), id]);
    return present(await row(id));
  },

  /** Builds the data file for an access or portability request, and tells apps (customers/data_request). */
  async exportData(id: number, actor: Actor) {
    const request = await row(id);
    if (!['received', 'in_progress'].includes(request.status)) throw ApiError.conflict('Verify the request before exporting data for it.');
    const subject = await subjectOf(request);
    const data = await collectCustomerData(subject);
    const content = JSON.stringify(data, null, 2);
    const exportId = await insert(
      `INSERT INTO customer_data_exports (shop_id, data_request_id, customer_id, content, size_bytes, expires_at, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY), ?)`,
      [shopId(), id, subject.customerId, content, Buffer.byteLength(content), EXPORT_DAYS, actor.id],
    );
    if (request.status === 'received') await execute("UPDATE data_requests SET status = 'in_progress', handled_by_admin_id = ? WHERE shop_id = ? AND id = ?", [actor.id, shopId(), id]);
    const shop = tenancy.current();
    await eventBus.publishSafely(
      'customers/data_request',
      {
        shop_id: shop.publicId,
        shop_domain: shop.primaryDomain,
        orders_requested: (await ordersOf(subject)).map((order) => order.public_id),
        customer: await webhookCustomer(request, subject),
        data_request: { id: request.reference },
      },
      { resourceType: 'data_request', resourceId: id, actorType: 'admin', actorId: actor.id },
    );
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'privacy.data_exported', entityType: 'data_request', entityId: id, summary: `Exported the data for ${request.reference}` });
    return { export: { id: exportId, size_bytes: Buffer.byteLength(content) }, request: present(await row(id)) };
  },

  async exportContent(id: number): Promise<{ filename: string; content: string }> {
    const request = await row(id);
    const latest = await queryOne<RowDataPacket & { content: string }>(
      'SELECT content FROM customer_data_exports WHERE shop_id = ? AND data_request_id = ? AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1',
      [shopId(), id],
    );
    if (!latest) throw ApiError.notFound('Data export');
    return { filename: `${request.reference.toLowerCase()}-data.json`, content: latest.content };
  },

  /** Emails the requester a link to their data file (7 days), and completes the request. */
  async sendExport(id: number, actor: Actor) {
    const request = await row(id);
    const latest = await queryOne<RowDataPacket & { id: number }>(
      'SELECT id FROM customer_data_exports WHERE shop_id = ? AND data_request_id = ? AND expires_at > UTC_TIMESTAMP() ORDER BY id DESC LIMIT 1',
      [shopId(), id],
    );
    if (!latest) throw ApiError.conflict('Export the data first.');
    const token = newToken();
    await execute(
      'UPDATE customer_data_exports SET download_token_hash = ?, expires_at = LEAST(expires_at, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY)) WHERE shop_id = ? AND id = ?',
      [hash(token), CUSTOMER_LINK_DAYS, shopId(), latest.id],
    );
    const link = `${onlineStoreUrl()}/privacy/exports/${token}`;
    await this.finish(request, 'completed', `Your data is ready. Download it here (the link works for ${CUSTOMER_LINK_DAYS} days): ${link}`, actor, { link_line: '' });
    return present(await row(id));
  },

  /** A download link the requester was sent; each use is recorded. */
  async exportByToken(token: string): Promise<{ filename: string; content: string } | null> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const found = await queryOne<RowDataPacket & { id: number; content: string; data_request_id: number }>(
      'SELECT id, content, data_request_id FROM customer_data_exports WHERE shop_id = ? AND download_token_hash = ? AND expires_at > UTC_TIMESTAMP()',
      [shopId(), hash(token)],
    );
    if (!found) return null;
    await execute('UPDATE customer_data_exports SET downloaded_at = UTC_TIMESTAMP() WHERE shop_id = ? AND id = ?', [shopId(), found.id]);
    const reference = await queryOne<RowDataPacket & { reference: string }>('SELECT reference FROM data_requests WHERE shop_id = ? AND id = ?', [shopId(), found.data_request_id]);
    return { filename: `${(reference?.reference ?? 'privacy').toLowerCase()}-data.json`, content: found.content };
  },

  /** When an erasure may run: after the grace period, and after the returns/chargeback window of their last order. */
  async erasureDate(subject: Subject): Promise<Date> {
    const settings = await privacySettings.get();
    const grace = Date.now() + settings.erasure_grace_days * 86_400_000;
    const last = await lastOrderAt(subject);
    const hold = last ? last.getTime() + settings.erasure_order_hold_days * 86_400_000 : 0;
    return new Date(Math.max(grace, hold));
  },

  async scheduleErasure(id: number, actor: Actor) {
    const request = await row(id);
    if (request.request_type !== 'erasure') throw ApiError.conflict('Only an erasure request can be scheduled for erasure.');
    if (!['received', 'in_progress'].includes(request.status)) throw ApiError.conflict('Verify the request before scheduling the erasure.');
    const when = await this.erasureDate(await subjectOf(request));
    await execute("UPDATE data_requests SET status = 'scheduled', scheduled_for = ?, handled_by_admin_id = ? WHERE shop_id = ? AND id = ?", [when, actor.id, shopId(), id]);
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'privacy.erasure_scheduled', entityType: 'data_request', entityId: id, summary: `Scheduled erasure for ${request.reference} on ${dayString(when)}` });
    return present(await row(id));
  },

  async cancelErasure(id: number, actor: Actor) {
    const request = await row(id);
    if (request.status !== 'scheduled') throw ApiError.conflict('This erasure is not scheduled.');
    await execute("UPDATE data_requests SET status = 'received', scheduled_for = NULL WHERE shop_id = ? AND id = ?", [shopId(), id]);
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'privacy.erasure_cancelled', entityType: 'data_request', entityId: id, summary: `Cancelled the scheduled erasure for ${request.reference}` });
    return present(await row(id));
  },

  /** The sweep's job: erase, tell apps (customers/redact), tell the requester. */
  async runErasure(id: number) {
    const request = await row(id);
    if (request.status !== 'scheduled' || !request.scheduled_for || request.scheduled_for.getTime() > Date.now()) return;
    const subject = await subjectOf(request);
    const orders = await ordersOf(subject);
    const customer = await webhookCustomer(request, subject);
    const email = request.contact_value.includes('@') ? request.contact_value : request.customer_email ?? null;
    const summary = await eraseCustomerData(subject);
    const note = `Erased. Deleted: ${Object.entries(summary.deleted).map(([table, n]) => `${table} ${n}`).join(', ') || 'nothing'}. Anonymised: ${Object.entries(summary.anonymised).map(([table, n]) => `${table} ${n}`).join(', ') || 'nothing'}. Kept: ${summary.kept.join('; ')}.`;
    await execute(
      "UPDATE data_requests SET status = 'completed', processed_at = UTC_TIMESTAMP(), completed_at = UTC_TIMESTAMP(), outcome_note = ? WHERE shop_id = ? AND id = ?",
      [note.slice(0, 5000), shopId(), id],
    );
    const shop = tenancy.current();
    await eventBus.publishSafely(
      'customers/redact',
      { shop_id: shop.publicId, shop_domain: shop.primaryDomain, customer, orders_to_redact: orders.map((order) => order.public_id) },
      { resourceType: 'data_request', resourceId: id, actorType: 'system', actorId: null },
    );
    await auditService.log({ actorId: null, actorLabel: 'privacy sweep', action: 'privacy.erasure_completed', entityType: 'data_request', entityId: id, summary: `Erased the data for ${request.reference}` });
    if (email) {
      await notifyRequester({ ...request, contact_value: email, customer_id: null } as RequestRow, 'privacy.request_completed', {
        outcome: 'We have erased your personal data. Records we must keep by law — orders and invoices, for tax — are kept without your browsing data, and deleted when the law allows.',
        link_line: '',
      });
    }
  },

  /** Withdraws every marketing consent (email, SMS, WhatsApp) and unsubscribes them, then completes the request. */
  async withdrawConsent(id: number, actor: Actor) {
    const request = await row(id);
    if (!['received', 'in_progress'].includes(request.status)) throw ApiError.conflict('Verify the request first.');
    const subject = await subjectOf(request);
    const noticeVersion = String(await policies.privacyVersion());
    if (subject.customerId) {
      const customer = await queryOne<RowDataPacket & { email: string | null; phone: string | null; accepts_email_marketing: number; accepts_sms_marketing: number; accepts_whatsapp_marketing: number }>(
        'SELECT email, phone, accepts_email_marketing, accepts_sms_marketing, accepts_whatsapp_marketing FROM customers WHERE shop_id = ? AND id = ?',
        [shopId(), subject.customerId],
      );
      for (const channel of ['email', 'sms', 'whatsapp'] as const) {
        await messagingRepository.recordConsent({
          customerId: subject.customerId,
          subjectIdentifier: (channel === 'email' ? customer?.email : customer?.phone) ?? request.contact_value,
          purpose: `marketing_${channel}`,
          status: 'withdrawn',
          source: 'support',
          noticeVersion: noticeVersion || '0',
          ip: null,
          userAgent: null,
          evidence: { privacy_request: request.reference },
        });
      }
      await execute(
        'UPDATE customers SET accepts_email_marketing = 0, accepts_sms_marketing = 0, accepts_whatsapp_marketing = 0 WHERE shop_id = ? AND id = ?',
        [shopId(), subject.customerId],
      );
    }
    await execute(
      "UPDATE newsletter_subscribers SET status = 'unsubscribed', unsubscribed_at = UTC_TIMESTAMP() WHERE shop_id = ? AND status <> 'unsubscribed' AND (customer_id = ? OR email IN (?) OR phone IN (?))",
      [shopId(), subject.customerId ?? 0, subject.emails.length ? subject.emails : ['\u0000'], subject.phones.length ? subject.phones : ['\u0000']],
    );
    await this.finish(request, 'completed', 'We have withdrawn your consent to marketing by email, SMS and WhatsApp. You will still get messages about your orders.', actor, { link_line: '' });
    return present(await row(id));
  },

  async complete(id: number, note: string | null, actor: Actor) {
    const request = await row(id);
    if (!['received', 'in_progress'].includes(request.status)) throw ApiError.conflict('Only an open request can be completed.');
    await this.finish(request, 'completed', note?.trim() || 'We have completed your request.', actor, { link_line: '' });
    return present(await row(id));
  },

  async reject(id: number, note: string, actor: Actor) {
    const request = await row(id);
    if (['completed', 'rejected', 'cancelled'].includes(request.status)) throw ApiError.conflict('This request is already closed.');
    if (!note.trim()) throw ApiError.validation({ note: ['Say why the request is refused — the requester is told.'] });
    await this.finish(request, 'rejected', `We could not complete your request: ${note.trim()}`, actor, { link_line: '' });
    return present(await row(id));
  },

  async finish(request: RequestRow, status: 'completed' | 'rejected', outcome: string, actor: Actor, variables: Record<string, string>) {
    await execute(
      'UPDATE data_requests SET status = ?, completed_at = UTC_TIMESTAMP(), outcome_note = ?, handled_by_admin_id = ? WHERE shop_id = ? AND id = ?',
      [status, outcome.slice(0, 5000), actor.id, shopId(), request.id],
    );
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: `privacy.request_${status}`, entityType: 'data_request', entityId: Number(request.id), summary: `${status === 'completed' ? 'Completed' : 'Refused'} ${request.reference}` });
    await notifyRequester(request, 'privacy.request_completed', { outcome, ...variables });
  },
};
