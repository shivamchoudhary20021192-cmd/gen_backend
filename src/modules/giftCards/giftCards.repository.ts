import { execute, insert, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface GiftCardRow extends RowDataPacket {
  id: number;
  shop_id: number;
  code_hash: string;
  code_sealed: string;
  last_characters: string;
  lookup_token: string;
  initial_value: string;
  balance: string;
  currency: string;
  expires_on: string | Date | null;
  status: 'enabled' | 'disabled';
  source: 'manual' | 'purchase' | 'api';
  customer_id: number | null;
  order_id: number | null;
  order_item_id: number | null;
  order_item_sequence: number | null;
  recipient_name: string | null;
  recipient_email: string | null;
  recipient_phone: string | null;
  message: string | null;
  note: string | null;
  created_by_admin_id: number | null;
  disabled_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
  customer_name?: string | null;
  customer_email?: string | null;
  order_number?: string | null;
}

export interface GiftCardTransactionRow extends RowDataPacket {
  id: number;
  gift_card_id: number;
  kind: 'issue' | 'debit' | 'credit' | 'adjustment';
  amount: string;
  balance_after: string;
  order_id: number | null;
  order_number?: string | null;
  note: string | null;
  actor_type: 'admin' | 'customer' | 'system';
  actor_id: number | null;
  created_at: Date;
}

const SELECT = `SELECT g.*, TRIM(CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, ''))) AS customer_name, c.email AS customer_email, o.order_number
    FROM gift_cards g
    LEFT JOIN customers c ON c.shop_id = g.shop_id AND c.id = g.customer_id
    LEFT JOIN orders o ON o.shop_id = g.shop_id AND o.id = g.order_id`;

export const giftCardsRepository = {
  async insert(
    input: {
      codeHash: string;
      codeSealed: string;
      last: string;
      lookupToken: string;
      value: number;
      currency: string;
      expiresOn: string | null;
      source: GiftCardRow['source'];
      customerId: number | null;
      orderId?: number | null;
      orderItemId?: number | null;
      orderItemSequence?: number | null;
      recipient?: { name: string | null; email: string | null; phone: string | null; message: string | null } | null;
      note: string | null;
      adminId: number | null;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO gift_cards
         (shop_id, code_hash, code_sealed, last_characters, lookup_token, initial_value, balance, currency, expires_on, status, source,
          customer_id, order_id, order_item_id, order_item_sequence, recipient_name, recipient_email, recipient_phone, message, note, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        input.codeHash,
        input.codeSealed,
        input.last,
        input.lookupToken,
        input.value,
        input.value,
        input.currency,
        input.expiresOn,
        input.source,
        input.customerId,
        input.orderId ?? null,
        input.orderItemId ?? null,
        input.orderItemSequence ?? null,
        input.recipient?.name ?? null,
        input.recipient?.email ?? null,
        input.recipient?.phone ?? null,
        input.recipient?.message ?? null,
        input.note,
        input.adminId,
      ],
      exec,
    );
  },

  async byId(id: number, exec: Executor = pool): Promise<GiftCardRow | null> {
    return queryOne<GiftCardRow>(`${SELECT} WHERE g.shop_id = ? AND g.id = ?`, [shopId(), id], exec);
  },

  async byCodeHash(hash: string, exec: Executor = pool): Promise<GiftCardRow | null> {
    return queryOne<GiftCardRow>('SELECT * FROM gift_cards WHERE shop_id = ? AND code_hash = ?', [shopId(), hash], exec);
  },

  async byLookupToken(token: string, exec: Executor = pool): Promise<GiftCardRow | null> {
    return queryOne<GiftCardRow>('SELECT * FROM gift_cards WHERE shop_id = ? AND lookup_token = ?', [shopId(), token], exec);
  },

  async byIds(ids: number[], exec: Executor = pool): Promise<GiftCardRow[]> {
    if (!ids.length) return [];
    return query<GiftCardRow>(`SELECT * FROM gift_cards WHERE shop_id = ? AND id IN (${ids.map(() => '?').join(', ')})`, [shopId(), ...ids], exec);
  },

  /** Locks the cards, in id order (so two checkouts sharing cards cannot deadlock), for spending. */
  async lockForSpend(ids: number[], exec: Executor): Promise<GiftCardRow[]> {
    if (!ids.length) return [];
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    return query<GiftCardRow>(
      `SELECT * FROM gift_cards WHERE shop_id = ? AND id IN (${sorted.map(() => '?').join(', ')}) ORDER BY id FOR UPDATE`,
      [shopId(), ...sorted],
      exec,
    );
  },

  async list(
    filters: { q?: string | null; status?: 'enabled' | 'disabled' | 'expired' | 'used' | null; customerId?: number | null; page: number; limit: number },
    exec: Executor = pool,
  ): Promise<{ rows: GiftCardRow[]; total: number }> {
    const where = ['g.shop_id = ?'];
    const params: unknown[] = [shopId()];
    if (filters.status === 'enabled') where.push("g.status = 'enabled' AND (g.expires_on IS NULL OR g.expires_on >= CURRENT_DATE()) AND g.balance > 0");
    if (filters.status === 'disabled') where.push("g.status = 'disabled'");
    if (filters.status === 'expired') where.push("g.status = 'enabled' AND g.expires_on < CURRENT_DATE()");
    if (filters.status === 'used') where.push('g.balance = 0');
    if (filters.customerId) {
      where.push('g.customer_id = ?');
      params.push(filters.customerId);
    }
    if (filters.q) {
      const term = filters.q.trim();
      const last = term.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-4);
      const like = `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      where.push('(g.last_characters = ? OR c.email LIKE ? OR CONCAT_WS(\' \', c.first_name, c.last_name) LIKE ? OR g.recipient_email LIKE ? OR o.order_number LIKE ?)');
      params.push(last, like, like, like, like);
    }
    const clause = where.join(' AND ');
    const [count] = await query<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM gift_cards g
         LEFT JOIN customers c ON c.shop_id = g.shop_id AND c.id = g.customer_id
         LEFT JOIN orders o ON o.shop_id = g.shop_id AND o.id = g.order_id
        WHERE ${clause}`,
      params,
      exec,
    );
    const rows = await query<GiftCardRow>(`${SELECT} WHERE ${clause} ORDER BY g.id DESC LIMIT ? OFFSET ?`, [...params, filters.limit, (filters.page - 1) * filters.limit], exec);
    return { rows, total: Number(count?.total ?? 0) };
  },

  async update(id: number, patch: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const columns = Object.keys(patch);
    if (!columns.length) return;
    await execute(`UPDATE gift_cards SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE shop_id = ? AND id = ?`, [...columns.map((column) => patch[column]), shopId(), id], exec);
  },

  /**
   * Changes a balance and records why, together. A debit is guarded by the
   * balance itself, so two spends racing for the same money cannot both land.
   */
  async move(
    card: Pick<GiftCardRow, 'id'>,
    input: { kind: GiftCardTransactionRow['kind']; amount: number; orderId?: number | null; note?: string | null; actorType: GiftCardTransactionRow['actor_type']; actorId?: number | null },
    exec: Executor,
  ): Promise<number | null> {
    const result = await execute(
      `UPDATE gift_cards SET balance = balance + ?, last_used_at = IF(? < 0, NOW(), last_used_at)
        WHERE shop_id = ? AND id = ? AND balance + ? >= 0`,
      [input.amount, input.amount, shopId(), card.id, input.amount],
      exec,
    );
    if (result.affectedRows !== 1) return null;
    const row = await queryOne<RowDataPacket & { balance: string }>('SELECT balance FROM gift_cards WHERE shop_id = ? AND id = ?', [shopId(), card.id], exec);
    const balance = Number(row?.balance ?? 0);
    await execute(
      `INSERT INTO gift_card_transactions (shop_id, gift_card_id, kind, amount, balance_after, order_id, note, actor_type, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [shopId(), card.id, input.kind, input.amount, balance, input.orderId ?? null, input.note ?? null, input.actorType, input.actorId ?? null],
      exec,
    );
    return balance;
  },

  async recordIssue(cardId: number, value: number, actor: { type: GiftCardTransactionRow['actor_type']; id: number | null }, orderId: number | null, exec: Executor): Promise<void> {
    await execute(
      `INSERT INTO gift_card_transactions (shop_id, gift_card_id, kind, amount, balance_after, order_id, actor_type, actor_id)
       VALUES (?, ?, 'issue', ?, ?, ?, ?, ?)`,
      [shopId(), cardId, value, value, orderId, actor.type, actor.id],
      exec,
    );
  },

  async transactions(cardId: number, exec: Executor = pool): Promise<GiftCardTransactionRow[]> {
    return query<GiftCardTransactionRow>(
      `SELECT t.*, o.order_number FROM gift_card_transactions t
         LEFT JOIN orders o ON o.shop_id = t.shop_id AND o.id = t.order_id
        WHERE t.shop_id = ? AND t.gift_card_id = ? ORDER BY t.id DESC`,
      [shopId(), cardId],
      exec,
    );
  },

  /** What an order took from each card, less what has already gone back. */
  async spentOnOrder(orderId: number, exec: Executor = pool): Promise<Array<{ gift_card_id: number; net: number }>> {
    const rows = await query<RowDataPacket & { gift_card_id: number; net: string }>(
      `SELECT gift_card_id, SUM(amount) AS net FROM gift_card_transactions
        WHERE shop_id = ? AND order_id = ? AND kind IN ('debit', 'credit')
        GROUP BY gift_card_id`,
      [shopId(), orderId],
      exec,
    );
    return rows.map((row) => ({ gift_card_id: Number(row.gift_card_id), net: Number(row.net) }));
  },

  /** The cards already issued for an order line, by sequence. */
  async issuedForItem(orderItemId: number, exec: Executor = pool): Promise<number[]> {
    const rows = await query<RowDataPacket & { order_item_sequence: number }>(
      'SELECT order_item_sequence FROM gift_cards WHERE shop_id = ? AND order_item_id = ?',
      [shopId(), orderItemId],
      exec,
    );
    return rows.map((row) => Number(row.order_item_sequence));
  },
};
