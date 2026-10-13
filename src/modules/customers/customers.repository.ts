import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface CustomerRow extends RowDataPacket {
  id: number;
  public_id: string;
  country_code: string;
  phone: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  gender: string | null;
  date_of_birth: Date | null;
  avatar_media_id: number | null;
  status: 'active' | 'blocked' | 'deleted';
  phone_verified_at: Date | null;
  email_verified_at: Date | null;
  accepts_email_marketing: number;
  accepts_sms_marketing: number;
  accepts_whatsapp_marketing: number;
  skin_type_id: number | null;
  primary_concern_id: number | null;
  orders_count: number;
  total_spent: string;
  average_order_value: string;
  last_order_at: Date | null;
  last_seen_at: Date | null;
  rto_count: number;
  cod_blocked: number;
  signup_source: string;
  preferred_language: string | null;
  anonymised_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface CustomerAddressRow extends RowDataPacket {
  id: number;
  customer_id: number;
  label: string | null;
  address_type: string;
  first_name: string;
  last_name: string | null;
  phone: string;
  alternate_phone: string | null;
  line1: string;
  line2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  state_code: string | null;
  pincode: string;
  country: string;
  is_default_shipping: number;
  is_default_billing: number;
  is_verified: number;
  delivery_notes: string | null;
  created_at: Date;
}

export interface CustomerNoteRow extends RowDataPacket {
  id: number;
  customer_id: number;
  admin_user_id: number | null;
  note: string;
  is_pinned: number;
  created_at: Date;
  author_name: string | null;
}

export interface CustomerConsentRow extends RowDataPacket {
  id: number;
  purpose: string;
  status: 'granted' | 'withdrawn';
  source: string;
  notice_version: string | null;
  created_at: Date;
}

export interface CustomerFilters {
  search?: string;
  status?: string;
  codBlocked?: boolean;
  marketing?: 'email' | 'sms' | 'whatsapp';
  hasOrders?: boolean;
  includeDeleted?: boolean;
}

function buildWhere(filters: CustomerFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = ['c.shop_id = ?'];
  const params: unknown[] = [shopId()];

  if (!filters.includeDeleted) conditions.push('c.deleted_at IS NULL');

  if (filters.search) {
    // Phone is the identity here, so a partial phone must match — people read
    // out the last four digits far more often than a full number.
    conditions.push(
      "(c.phone LIKE ? OR c.email LIKE ? OR CONCAT_WS(' ', c.first_name, c.last_name) LIKE ?)",
    );
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  if (filters.status) {
    conditions.push('c.status = ?');
    params.push(filters.status);
  }
  if (filters.codBlocked !== undefined) {
    conditions.push('c.cod_blocked = ?');
    params.push(filters.codBlocked ? 1 : 0);
  }
  if (filters.hasOrders !== undefined) {
    conditions.push(filters.hasOrders ? 'c.orders_count > 0' : 'c.orders_count = 0');
  }
  if (filters.marketing) {
    const column = {
      email: 'accepts_email_marketing',
      sms: 'accepts_sms_marketing',
      whatsapp: 'accepts_whatsapp_marketing',
    }[filters.marketing];
    conditions.push(`c.${column} = 1`);
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

export const customersRepository = {
  async list(
    filters: CustomerFilters,
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<CustomerRow[]> {
    const { clause, params } = buildWhere(filters);
    return query<CustomerRow>(
      `SELECT c.* FROM customers c ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async count(filters: CustomerFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM customers c ${clause}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  async findById(id: number, exec: Executor = pool): Promise<CustomerRow | null> {
    return queryOne<CustomerRow>('SELECT * FROM customers WHERE shop_id = ? AND id = ? LIMIT 1', [shopId(), id], exec);
  },

  async findByPhone(countryCode: string, phone: string, exec: Executor = pool): Promise<CustomerRow | null> {
    return queryOne<CustomerRow>(
      'SELECT * FROM customers WHERE shop_id = ? AND country_code = ? AND phone = ? LIMIT 1',
      [shopId(), countryCode, phone],
      exec,
    );
  },

  async emailTaken(email: string, excludeId: number | null, exec: Executor = pool): Promise<boolean> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      `SELECT id FROM customers WHERE shop_id = ? AND email = ? AND deleted_at IS NULL ${excludeId ? 'AND id <> ?' : ''} LIMIT 1`,
      excludeId ? [shopId(), email, excludeId] : [shopId(), email],
      exec,
    );
    return Boolean(row);
  },

  async update(id: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `\`${k}\` = ?`).join(', ');
    await execute(`UPDATE customers SET ${assignments} WHERE shop_id = ? AND id = ?`, [...Object.values(fields), shopId(), id], exec);
  },

  /** Blocking someone with a live session is not blocking them. */
  async revokeSessions(customerId: number, exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM customer_sessions WHERE shop_id = ? AND customer_id = ?', [shopId(), customerId], exec);
  },

  async addresses(customerId: number, exec: Executor = pool): Promise<CustomerAddressRow[]> {
    return query<CustomerAddressRow>(
      `SELECT * FROM customer_addresses
        WHERE shop_id = ? AND customer_id = ? AND deleted_at IS NULL
        ORDER BY is_default_shipping DESC, id DESC`,
      [shopId(), customerId],
      exec,
    );
  },

  async notes(customerId: number, exec: Executor = pool): Promise<CustomerNoteRow[]> {
    return query<CustomerNoteRow>(
      `SELECT n.*, CONCAT_WS(' ', a.first_name, a.last_name) AS author_name
         FROM customer_notes n
         LEFT JOIN admin_users a ON a.id = n.admin_user_id
        WHERE n.shop_id = ? AND n.customer_id = ?
        ORDER BY n.is_pinned DESC, n.created_at DESC`,
      [shopId(), customerId],
      exec,
    );
  },

  async addNote(
    customerId: number,
    adminUserId: number,
    note: string,
    isPinned: boolean,
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      'INSERT INTO customer_notes (shop_id, customer_id, admin_user_id, note, is_pinned) VALUES (?, ?, ?, ?, ?)',
      [shopId(), customerId, adminUserId, note, isPinned ? 1 : 0],
      exec,
    );
  },

  async deleteNote(customerId: number, noteId: number, exec: Executor = pool): Promise<number> {
    const result = await execute(
      'DELETE FROM customer_notes WHERE shop_id = ? AND id = ? AND customer_id = ?',
      [shopId(), noteId, customerId],
      exec,
    );
    return result.affectedRows;
  },

  async consents(customerId: number, exec: Executor = pool): Promise<CustomerConsentRow[]> {
    // One row per purpose: consent is append-only, so the latest row wins.
    return query<CustomerConsentRow>(
      `SELECT cc.* FROM customer_consents cc
         JOIN (SELECT purpose, MAX(id) AS latest_id
                 FROM customer_consents WHERE shop_id = ? AND customer_id = ? GROUP BY purpose) newest
           ON newest.latest_id = cc.id
        ORDER BY cc.purpose`,
      [shopId(), customerId],
      exec,
    );
  },

  /**
   * Recompute the denormalised order stats.
   *
   * These columns exist so the customer list can sort by spend without joining
   * every order — but a cache that nothing refreshes is just a lie with an
   * index on it, so every write that can change them calls this.
   */
  async refreshStats(customerId: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE customers c
          SET c.orders_count = (
                SELECT COUNT(*) FROM orders o
                 WHERE o.shop_id = c.shop_id AND o.customer_id = c.id AND o.order_status NOT IN ('cancelled')),
              c.total_spent = (
                SELECT COALESCE(SUM((o.grand_total - o.amount_refunded) * o.exchange_rate), 0) FROM orders o
                 WHERE o.shop_id = c.shop_id AND o.customer_id = c.id AND o.payment_status IN ('paid','cod_collected','partially_refunded')),
              c.last_order_at = (
                SELECT MAX(o.placed_at) FROM orders o WHERE o.shop_id = c.shop_id AND o.customer_id = c.id),
              c.rto_count = (
                SELECT COUNT(*) FROM orders o WHERE o.shop_id = c.shop_id AND o.customer_id = c.id AND o.order_status = 'rto')
        WHERE c.shop_id = ? AND c.id = ?`,
      [shopId(), customerId],
      exec,
    );
    await execute(
      `UPDATE customers
          SET average_order_value = CASE WHEN orders_count > 0 THEN total_spent / orders_count ELSE 0 END
        WHERE shop_id = ? AND id = ?`,
      [shopId(), customerId],
      exec,
    );
  },
};
