import type { PoolConnection } from 'mysql2/promise';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { shopId, tenancy } from '../tenancy/context';

/**
 * Everything the store holds about one person: gathered for an access or
 * portability request, erased (or, where the law says keep it, stripped of
 * what identifies them) for an erasure request.
 *
 * A person is a customer record, or — for someone who only ever checked out
 * as a guest, wrote in, or signed up to the newsletter — an email address or
 * phone number. Both are looked for, so a customer's guest orders placed
 * before they had an account come with them.
 */

export interface Subject {
  customerId: number | null;
  emails: string[];
  phones: string[];
}

/** Columns that are secrets, not data about the person: never exported. */
const SECRET_COLUMN = /(^|_)(hash|token|secret|sealed|password|jti)($|_)|^code_hash$|^lookup_token$|^shop_id$/;

function readable(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    if (value.length === 4) return Array.from(value).join('.');
    if (value.length === 16) return (value.toString('hex').match(/.{4}/g) ?? []).join(':');
    return value.toString('base64');
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

function clean(rows: RowDataPacket[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !SECRET_COLUMN.test(key)).map(([key, value]) => [key, readable(value)])));
}

/** A value a column can never hold, so an empty contact list matches nothing. */
const NONE = '\u0000none';
const list = (values: string[]) => (values.length ? values : [NONE]);

/** The customer and their contact details, from a customer id and/or a contact. */
export async function subjectFor(input: { customerId: number | null; contact: string | null }): Promise<Subject> {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const addContact = (value: string | null | undefined) => {
    const text = (value ?? '').trim();
    if (!text) return;
    if (text.includes('@')) emails.add(text.toLowerCase());
    else phones.add(text.replace(/\D/g, '').slice(-15));
  };
  addContact(input.contact);
  let customerId = input.customerId;
  if (!customerId && input.contact) {
    const found = await queryOne<RowDataPacket & { id: number }>(
      'SELECT id FROM customers WHERE shop_id = ? AND (email = ? OR phone = ?) ORDER BY id LIMIT 1',
      [shopId(), [...emails][0] ?? NONE, [...phones][0] ?? NONE],
    );
    customerId = found ? Number(found.id) : null;
  }
  if (customerId) {
    const customer = await queryOne<RowDataPacket & { email: string | null; phone: string | null }>('SELECT email, phone FROM customers WHERE shop_id = ? AND id = ?', [shopId(), customerId]);
    if (customer) {
      addContact(customer.email);
      addContact(customer.phone);
    }
  }
  return { customerId, emails: [...emails], phones: [...phones] };
}

/** The data file for an access or portability request: plain JSON, one section per kind of data. */
export async function collectCustomerData(subject: Subject): Promise<Record<string, unknown>> {
  const shop = tenancy.current();
  const id = subject.customerId ?? 0;
  const emails = list(subject.emails);
  const phones = list(subject.phones);
  const contacts = [...emails, ...phones];
  const s = shopId();

  const orders = await query<RowDataPacket & { id: number }>(
    'SELECT * FROM orders WHERE shop_id = ? AND (customer_id = ? OR contact_email IN (?) OR contact_phone IN (?)) ORDER BY id',
    [s, id, emails, phones],
  );
  const orderIds = orders.length ? orders.map((order) => Number(order.id)) : [0];
  const wishlists = await query<RowDataPacket & { id: number }>('SELECT * FROM wishlists WHERE shop_id = ? AND customer_id = ?', [s, id]);
  const loyalty = await query<RowDataPacket & { id: number }>('SELECT * FROM loyalty_accounts WHERE shop_id = ? AND customer_id = ?', [s, id]);
  const tickets = await query<RowDataPacket & { id: number }>(
    'SELECT * FROM support_tickets WHERE shop_id = ? AND (customer_id = ? OR email IN (?) OR phone IN (?))',
    [s, id, emails, phones],
  );

  const sections: Record<string, RowDataPacket[]> = {
    customer: await query('SELECT * FROM customers WHERE shop_id = ? AND id = ?', [s, id]),
    addresses: await query('SELECT * FROM customer_addresses WHERE shop_id = ? AND customer_id = ? AND deleted_at IS NULL', [s, id]),
    orders,
    order_items: await query('SELECT * FROM order_items WHERE shop_id = ? AND order_id IN (?) ORDER BY order_id, id', [s, orderIds]),
    order_addresses: await query('SELECT * FROM order_addresses WHERE shop_id = ? AND order_id IN (?)', [s, orderIds]),
    returns: await query('SELECT * FROM return_requests WHERE shop_id = ? AND (customer_id = ? OR order_id IN (?))', [s, id, orderIds]),
    marketing_consents: await query(
      'SELECT id, customer_id, subject_identifier, purpose, status, notice_version, source, created_at FROM customer_consents WHERE shop_id = ? AND (customer_id = ? OR subject_identifier IN (?)) ORDER BY id',
      [s, id, contacts],
    ),
    cookie_consents: await query('SELECT * FROM customer_tracking_consents WHERE shop_id = ? AND customer_id = ? ORDER BY id', [s, id]),
    newsletter: await query('SELECT * FROM newsletter_subscribers WHERE shop_id = ? AND (customer_id = ? OR email IN (?) OR phone IN (?))', [s, id, emails, phones]),
    reviews: await query('SELECT * FROM reviews WHERE shop_id = ? AND (customer_id = ? OR author_email IN (?))', [s, id, emails]),
    blog_comments: await query('SELECT * FROM blog_comments WHERE shop_id = ? AND (customer_id = ? OR email IN (?))', [s, id, emails]),
    wishlists,
    wishlist_items: await query('SELECT * FROM wishlist_items WHERE shop_id = ? AND wishlist_id IN (?)', [s, wishlists.length ? wishlists.map((w) => Number(w.id)) : [0]]),
    back_in_stock_requests: await query('SELECT * FROM back_in_stock_requests WHERE shop_id = ? AND (customer_id = ? OR email IN (?) OR phone IN (?))', [s, id, emails, phones]),
    gift_cards: await query('SELECT * FROM gift_cards WHERE shop_id = ? AND (customer_id = ? OR recipient_email IN (?) OR recipient_phone IN (?))', [s, id, emails, phones]),
    loyalty_accounts: loyalty,
    loyalty_transactions: await query('SELECT * FROM loyalty_transactions WHERE shop_id = ? AND loyalty_account_id IN (?)', [s, loyalty.length ? loyalty.map((l) => Number(l.id)) : [0]]),
    quiz_submissions: await query('SELECT * FROM quiz_submissions WHERE shop_id = ? AND customer_id = ?', [s, id]),
    contact_messages: await query('SELECT * FROM contact_messages WHERE shop_id = ? AND (email IN (?) OR phone IN (?))', [s, emails, phones]),
    support_tickets: tickets,
    messages_sent: await query(
      'SELECT id, channel, event_key, recipient, status, queued_at, sent_at, delivered_at FROM notification_logs WHERE shop_id = ? AND (customer_id = ? OR recipient IN (?)) ORDER BY id DESC LIMIT 500',
      [s, id, contacts],
    ),
    staff_notes: await query('SELECT id, note, created_at FROM customer_notes WHERE shop_id = ? AND customer_id = ?', [s, id]),
    privacy_requests: await query(
      'SELECT reference, request_type, status, source, details, created_at, verified_at, due_at, completed_at, outcome_note FROM data_requests WHERE shop_id = ? AND (customer_id = ? OR contact_value IN (?))',
      [s, id, contacts],
    ),
  };

  return {
    format: 'veylog.customer-data/1',
    generated_at: new Date().toISOString(),
    store: { name: shop.name, handle: shop.handle },
    subject: { customer_id: subject.customerId, emails: subject.emails, phones: subject.phones },
    ...Object.fromEntries(Object.entries(sections).map(([key, rows]) => [key, clean(rows)])),
  };
}

export interface ErasureSummary {
  customer_anonymised: boolean;
  deleted: Record<string, number>;
  anonymised: Record<string, number>;
  kept: string[];
}

/**
 * Erases a person. What the store must keep — orders, invoices and returns,
 * which tax law requires for years, and the record that consents were given
 * and withdrawn — is kept, with the tracking data on them removed. Everything
 * else is deleted, or anonymised where deleting it would break someone
 * else's record (a review others voted on, a gift card someone paid for).
 *
 * The customer row stays, anonymised (status 'deleted'), so the orders it
 * placed still add up; it can never sign in again — its phone number is
 * replaced with a placeholder no one can receive a code on.
 */
export async function eraseCustomerData(subject: Subject): Promise<ErasureSummary> {
  const id = subject.customerId ?? 0;
  const emails = list(subject.emails);
  const phones = list(subject.phones);
  const contacts = [...emails, ...phones];
  const deleted: Record<string, number> = {};
  const anonymised: Record<string, number> = {};

  await withTransaction(async (tx: PoolConnection) => {
    const s = shopId();
    const run = async (bucket: Record<string, number>, table: string, sql: string, params: unknown[]) => {
      const result = await execute(sql, params, tx);
      if (result.affectedRows) bucket[table] = (bucket[table] ?? 0) + result.affectedRows;
    };
    const remove = (table: string, sql: string, params: unknown[]) => run(deleted, table, sql, params);
    const strip = (table: string, sql: string, params: unknown[]) => run(anonymised, table, sql, params);

    // Gone entirely.
    await remove('customer_addresses', 'DELETE FROM customer_addresses WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await remove('customer_sessions', 'DELETE FROM customer_sessions WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await remove('customer_notes', 'DELETE FROM customer_notes WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await remove('customer_segment_members', 'DELETE FROM customer_segment_members WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await remove('customer_tag_assignments', 'DELETE FROM customer_tag_assignments WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await remove('coupon_customers', 'DELETE FROM coupon_customers WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await remove('wishlists', 'DELETE FROM wishlists WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await remove('back_in_stock_requests', 'DELETE FROM back_in_stock_requests WHERE shop_id = ? AND (customer_id = ? OR email IN (?) OR phone IN (?))', [s, id, emails, phones]);
    await remove('newsletter_subscribers', 'DELETE FROM newsletter_subscribers WHERE shop_id = ? AND (customer_id = ? OR email IN (?) OR phone IN (?))', [s, id, emails, phones]);
    await remove('quiz_submissions', 'DELETE FROM quiz_submissions WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await remove('product_views', 'DELETE FROM product_views WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await remove('review_invitations', 'DELETE FROM review_invitations WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await remove('review_votes', 'DELETE FROM review_votes WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await remove('otp_requests', 'DELETE FROM otp_requests WHERE shop_id = ? AND (customer_id = ? OR phone IN (?))', [s, id, phones]);
    await remove('message_campaign_recipients', 'DELETE FROM message_campaign_recipients WHERE shop_id = ? AND (customer_id = ? OR recipient IN (?))', [s, id, contacts]);
    await remove('contact_messages', 'DELETE FROM contact_messages WHERE shop_id = ? AND (email IN (?) OR phone IN (?))', [s, emails, phones]);
    await remove('order_tracking_lookups', 'DELETE FROM order_tracking_lookups WHERE shop_id = ? AND contact_value IN (?)', [s, contacts]);
    await remove('customer_data_exports', 'DELETE FROM customer_data_exports WHERE shop_id = ? AND customer_id = ?', [s, id]);

    // Kept, without what identifies them.
    await strip('reviews', "UPDATE reviews SET author_name = 'Anonymous', author_email = NULL, author_location = NULL, ip = NULL WHERE shop_id = ? AND (customer_id = ? OR author_email IN (?))", [s, id, emails]);
    await strip('blog_comments', "UPDATE blog_comments SET author = 'Anonymous', email = '', ip = NULL, user_agent = NULL WHERE shop_id = ? AND (customer_id = ? OR email IN (?))", [s, id, emails]);
    await strip('review_reports', 'UPDATE review_reports SET reporter_customer_id = NULL WHERE shop_id = ? AND reporter_customer_id = ?', [s, id]);
    await strip('search_queries', 'UPDATE search_queries SET customer_id = NULL WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await strip('media', 'UPDATE media SET uploaded_by_customer_id = NULL WHERE shop_id = ? AND uploaded_by_customer_id = ?', [s, id]);
    await strip('carts', 'UPDATE carts SET ip = NULL, user_agent = NULL, utm = NULL, recovery_token = NULL WHERE shop_id = ? AND customer_id = ?', [s, id]);
    await strip('gift_cards', 'UPDATE gift_cards SET recipient_name = NULL, recipient_email = NULL, recipient_phone = NULL, message = NULL WHERE shop_id = ? AND (customer_id = ? OR recipient_email IN (?) OR recipient_phone IN (?))', [s, id, emails, phones]);
    await strip('notification_logs', "UPDATE notification_logs SET recipient = 'erased' WHERE shop_id = ? AND (customer_id = ? OR recipient IN (?))", [s, id, contacts]);
    await strip('support_tickets', "UPDATE support_tickets SET name = 'Anonymous', email = NULL, phone = NULL WHERE shop_id = ? AND (customer_id = ? OR email IN (?) OR phone IN (?))", [s, id, emails, phones]);
    await strip('customer_consents', 'UPDATE customer_consents SET subject_identifier = NULL, ip = NULL, user_agent = NULL WHERE shop_id = ? AND (customer_id = ? OR subject_identifier IN (?))', [s, id, contacts]);
    await strip('customer_tracking_consents', 'UPDATE customer_tracking_consents SET ip_prefix = NULL, user_agent = NULL WHERE shop_id = ? AND customer_id = ?', [s, id]);
    // Orders stay for tax law; the browsing data on them does not need to.
    await strip('orders', 'UPDATE orders SET ip = NULL, user_agent = NULL, utm = NULL WHERE shop_id = ? AND (customer_id = ? OR contact_email IN (?) OR contact_phone IN (?))', [s, id, emails, phones]);
    if (subject.customerId) {
      await strip(
        'customers',
        `UPDATE customers
            SET first_name = NULL, last_name = NULL, email = NULL, phone = CONCAT('x', LPAD(id, 14, '0')),
                gender = 'undisclosed', date_of_birth = NULL, avatar_media_id = NULL,
                email_verified_at = NULL, phone_verified_at = NULL,
                accepts_email_marketing = 0, accepts_sms_marketing = 0, accepts_whatsapp_marketing = 0,
                skin_type_id = NULL, primary_concern_id = NULL, signup_utm = NULL, referred_by_customer_id = NULL,
                status = 'deleted', anonymised_at = UTC_TIMESTAMP(), deleted_at = COALESCE(deleted_at, UTC_TIMESTAMP())
          WHERE shop_id = ? AND id = ?`,
        [s, id],
      );
    }
  });

  return {
    customer_anonymised: Boolean(subject.customerId),
    deleted,
    anonymised,
    kept: ['orders, invoices and returns (tax law requires them)', 'the record of consents given and withdrawn (proof of consent)'],
  };
}

/** The orders a request covers, for the webhooks that tell apps. */
export async function ordersOf(subject: Subject): Promise<RowDataPacket[]> {
  return query<RowDataPacket & { id: number; public_id: string; order_number: string }>(
    'SELECT id, public_id, order_number FROM orders WHERE shop_id = ? AND (customer_id = ? OR contact_email IN (?) OR contact_phone IN (?))',
    [shopId(), subject.customerId ?? 0, list(subject.emails), list(subject.phones)],
  );
}

/** When the customer last ordered: erasure waits out the window for returns and chargebacks. */
export async function lastOrderAt(subject: Subject): Promise<Date | null> {
  const row = await queryOne<RowDataPacket & { at: Date | null }>(
    'SELECT MAX(placed_at) AS at FROM orders WHERE shop_id = ? AND (customer_id = ? OR contact_email IN (?) OR contact_phone IN (?))',
    [shopId(), subject.customerId ?? 0, list(subject.emails), list(subject.phones)],
  );
  return row?.at ?? null;
}
