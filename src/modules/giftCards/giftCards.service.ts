import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { execute, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { roundMoney } from '../../platform/money/currency';
import { notificationEngine } from '../../platform/notifications/notificationEngine';
import { vault } from '../../platform/security/vault';
import { formatMoney } from '../../platform/shops/format';
import { onlineStoreUrl } from '../../platform/shops/urls';
import { shopId, tenancy } from '../../platform/tenancy/context';
import { auditService } from '../../shared/audit.service';
import { codeHash, formatCode, generateCode, isValidCode, lastCharacters, lookupToken, maskedCode, normaliseCode } from './giftCardCodes';
import { giftCardsRepository, type GiftCardRow, type GiftCardTransactionRow } from './giftCards.repository';

/**
 * Gift cards — Shopify's, end to end:
 *
 *   issue    staff issue one (Products → Gift cards), or a shopper buys one (a
 *            product marked as a gift card) and it is issued when the order is
 *            paid. Either way the recipient gets the code by email / SMS /
 *            WhatsApp (the shop's `gift_card.issued` templates) with a link to
 *            the card's page, /gift_cards/<token>, which shows the code and
 *            balance.
 *   spend    at checkout, in the same field as a discount code. A card is a way
 *            of paying, not a discount: the order's total and tax do not change;
 *            the cards pay what they can (orders.gift_card_total) and the rest
 *            is due by gateway or cash on delivery. Spending happens inside the
 *            order's transaction, cards locked, each debit guarded by the
 *            balance, so a card can never pay twice.
 *   return   cancelling an order credits back what its cards paid.
 *   ledger   every change is a gift_card_transactions row with the balance
 *            after it; staff can adjust with a note, disable and re-enable.
 */

export interface Actor {
  id: number | null;
  label: string | null;
}

const MAX_VALUE = 1_000_000;

// ── pure helpers (exported for tests) ──────────────────────────────────────

/** A DATE column as YYYY-MM-DD. */
export function dateOnly(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** Today where the shop is, as YYYY-MM-DD: a card "expires on" a date in the shop's calendar. */
export function todayIn(timezone: string | null | undefined, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export type CardState = 'active' | 'disabled' | 'expired' | 'used';

export function stateOf(card: Pick<GiftCardRow, 'status' | 'expires_on' | 'balance'>, today: string): CardState {
  if (card.status === 'disabled') return 'disabled';
  const expires = dateOnly(card.expires_on);
  if (expires && expires < today) return 'expired';
  if (Number(card.balance) <= 0) return 'used';
  return 'active';
}

/** Why a card cannot pay for this basket — or null if it can. */
export function unusableReason(card: Pick<GiftCardRow, 'status' | 'expires_on' | 'balance' | 'currency' | 'last_characters'>, currency: string, today: string): string | null {
  const label = `Gift card ${maskedCode(card.last_characters).slice(-8)}`;
  switch (stateOf(card, today)) {
    case 'disabled':
      return `${label} has been disabled.`;
    case 'expired':
      return `${label} expired on ${dateOnly(card.expires_on)}.`;
    case 'used':
      return `${label} has no balance left.`;
    default:
      return card.currency === currency ? null : `${label} is in ${card.currency}; this order is in ${currency}.`;
  }
}

/** What each card pays, in the order they were applied, until the total is covered. */
export function allocate(total: number, cards: Array<{ id: number; balance: number }>, currency: string): Array<{ id: number; amount: number }> {
  let remaining = roundMoney(Math.max(0, total), currency);
  return cards.map((card) => {
    const amount = roundMoney(Math.min(Math.max(0, card.balance), remaining), currency);
    remaining = roundMoney(remaining - amount, currency);
    return { id: card.id, amount };
  });
}

// ── presentation ────────────────────────────────────────────────────────────

function present(card: GiftCardRow, today = todayIn(tenancy.current().timezone)) {
  return {
    id: card.id,
    last_characters: card.last_characters,
    masked_code: maskedCode(card.last_characters),
    initial_value: Number(card.initial_value),
    balance: Number(card.balance),
    currency: card.currency,
    expires_on: dateOnly(card.expires_on),
    status: card.status,
    state: stateOf(card, today),
    source: card.source,
    customer: card.customer_id ? { id: card.customer_id, name: card.customer_name?.trim() || null, email: card.customer_email ?? null } : null,
    order: card.order_id ? { id: card.order_id, order_number: card.order_number ?? null } : null,
    recipient: card.recipient_email || card.recipient_phone || card.recipient_name ? { name: card.recipient_name, email: card.recipient_email, phone: card.recipient_phone, message: card.message } : null,
    note: card.note,
    created_at: card.created_at,
    last_used_at: card.last_used_at,
    disabled_at: card.disabled_at,
  };
}

function presentTransaction(row: GiftCardTransactionRow) {
  return {
    id: row.id,
    kind: row.kind,
    amount: Number(row.amount),
    balance_after: Number(row.balance_after),
    order: row.order_id ? { id: row.order_id, order_number: row.order_number ?? null } : null,
    note: row.note,
    actor_type: row.actor_type,
    created_at: row.created_at,
  };
}

// ── issuing ────────────────────────────────────────────────────────────────

interface IssueInput {
  value: number;
  currency?: string | null;
  code?: string | null;
  expires_on?: string | null;
  customer_id?: number | null;
  note?: string | null;
  recipient?: { name?: string | null; email?: string | null; phone?: string | null; message?: string | null } | null;
  notify?: boolean;
}

async function currencies(): Promise<Set<string>> {
  const shop = tenancy.current();
  const rows = await query<RowDataPacket & { currency: string }>('SELECT DISTINCT currency FROM markets WHERE shop_id = ? AND is_active = 1', [shopId()]).catch(() => []);
  return new Set([shop.currency, ...rows.map((row) => row.currency)]);
}

async function createCard(
  input: {
    value: number;
    currency: string;
    code: string | null;
    expiresOn: string | null;
    customerId: number | null;
    note: string | null;
    recipient: IssueInput['recipient'];
    source: GiftCardRow['source'];
    orderId?: number | null;
    orderItemId?: number | null;
    orderItemSequence?: number | null;
  },
  actor: { type: GiftCardTransactionRow['actor_type']; id: number | null },
  exec: Executor,
): Promise<{ id: number; code: string }> {
  const shop = shopId();
  let code = input.code;
  // Generated codes are checked against the shop's cards; a collision (79 bits) just draws again.
  for (let attempt = 0; !code && attempt < 5; attempt += 1) {
    const candidate = generateCode();
    if (!(await giftCardsRepository.byCodeHash(codeHash(shop, candidate), exec))) code = candidate;
  }
  if (!code) throw new Error('Could not draw a unique gift card code.');
  const hash = codeHash(shop, code);
  const token = lookupToken();
  const id = await giftCardsRepository.insert(
    {
      codeHash: hash,
      // Bound to the shop and the hash: the sealed code opens only for this card.
      codeSealed: vault.seal(code, `gift_card:${shop}:${hash}`),
      last: lastCharacters(code),
      lookupToken: token,
      value: input.value,
      currency: input.currency,
      expiresOn: input.expiresOn,
      source: input.source,
      customerId: input.customerId,
      orderId: input.orderId ?? null,
      orderItemId: input.orderItemId ?? null,
      orderItemSequence: input.orderItemSequence ?? null,
      recipient: input.recipient
        ? { name: input.recipient.name?.trim() || null, email: input.recipient.email?.trim() || null, phone: input.recipient.phone?.trim() || null, message: input.recipient.message?.trim() || null }
        : null,
      note: input.note,
      adminId: actor.type === 'admin' ? actor.id : null,
    },
    exec,
  );
  await giftCardsRepository.recordIssue(id, input.value, actor, input.orderId ?? null, exec);
  return { id, code };
}

function openCode(card: GiftCardRow): string | null {
  try {
    return vault.open(card.code_sealed, `gift_card:${card.shop_id}:${card.code_hash}`);
  } catch (error) {
    logger.error('gift_cards.code_unreadable', { gift_card_id: card.id, error: String(error) });
    return null;
  }
}

export function giftCardUrl(card: Pick<GiftCardRow, 'lookup_token'>): string {
  return `${onlineStoreUrl()}/gift_cards/${card.lookup_token}`;
}

/** Sends the card to whoever it is for: its recipient, else its customer. */
async function sendCard(card: GiftCardRow, code: string): Promise<Record<string, string>> {
  const customer = card.customer_id
    ? await queryOne<RowDataPacket & { first_name: string | null; email: string | null; phone: string | null; country_code: string | null }>(
        'SELECT first_name, email, phone, country_code FROM customers WHERE shop_id = ? AND id = ?',
        [shopId(), card.customer_id],
      )
    : null;
  const toRecipient = Boolean(card.recipient_email || card.recipient_phone);
  const firstName = (toRecipient ? card.recipient_name : customer?.first_name)?.trim().split(/\s+/)[0] || 'there';
  const expires = dateOnly(card.expires_on);
  return notificationEngine.notifyCustomer({
    key: 'gift_card.issued',
    recipient: toRecipient
      ? { customerId: null, email: card.recipient_email, phone: card.recipient_phone, countryCode: null }
      : { customerId: card.customer_id, email: customer?.email ?? null, phone: customer?.phone ?? null, countryCode: customer?.country_code ?? null },
    variables: {
      first_name: firstName,
      gift_card_code: formatCode(code),
      gift_card_value: formatMoney(Number(card.initial_value), { currency: card.currency }),
      gift_card_balance: formatMoney(Number(card.balance), { currency: card.currency }),
      gift_card_url: giftCardUrl(card),
      gift_card_expiry: expires ? `Valid until ${expires}.\n` : '',
      gift_card_message: card.message ? `“${card.message}”\n\n` : '',
      link: giftCardUrl(card),
    },
  });
}

export const giftCardsService = {
  async list(input: { q?: string; status?: 'enabled' | 'disabled' | 'expired' | 'used'; customer_id?: number; page?: number; limit?: number }) {
    const page = Math.max(1, Number(input.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(input.limit) || 25));
    const { rows, total } = await giftCardsRepository.list({ q: input.q ?? null, status: input.status ?? null, customerId: input.customer_id ?? null, page, limit });
    const today = todayIn(tenancy.current().timezone);
    const [totals] = await query<RowDataPacket & { outstanding: string | null; issued: number }>(
      `SELECT SUM(CASE WHEN status = 'enabled' AND (expires_on IS NULL OR expires_on >= CURRENT_DATE()) THEN balance ELSE 0 END) AS outstanding, COUNT(*) AS issued
         FROM gift_cards WHERE shop_id = ? AND currency = ?`,
      [shopId(), tenancy.current().currency],
    );
    return {
      gift_cards: rows.map((row) => present(row, today)),
      pagination: { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)) },
      summary: { issued: Number(totals?.issued ?? 0), outstanding: Number(totals?.outstanding ?? 0), currency: tenancy.current().currency },
    };
  },

  async get(id: number) {
    const card = await giftCardsRepository.byId(id);
    if (!card) throw ApiError.notFound('Gift card');
    const history = await giftCardsRepository.transactions(id);
    return { gift_card: { ...present(card), transactions: history.map(presentTransaction) } };
  },

  /** Issues a card. The full code is in the answer — the only time staff see it. */
  async issue(input: IssueInput, actor: Actor) {
    const shop = tenancy.current();
    const value = roundMoney(Number(input.value), input.currency ?? shop.currency);
    if (!(value > 0) || value > MAX_VALUE) throw ApiError.validation({ value: [`Enter an amount between 0 and ${MAX_VALUE}.`] });
    const currency = (input.currency ?? shop.currency).toUpperCase();
    if (!(await currencies()).has(currency)) throw ApiError.validation({ currency: ['Use the store’s currency or one of its markets’.'] });
    let code: string | null = null;
    if (input.code?.trim()) {
      code = normaliseCode(input.code);
      if (!isValidCode(code)) throw ApiError.validation({ code: ['A code is 8 to 20 letters and digits.'] });
      if (await giftCardsRepository.byCodeHash(codeHash(shop.id, code))) throw ApiError.conflict('A gift card with this code already exists.', 'CONFLICT');
    }
    const expiresOn = input.expires_on ? dateOnly(input.expires_on) : null;
    if (expiresOn && expiresOn < todayIn(shop.timezone)) throw ApiError.validation({ expires_on: ['Choose a date in the future.'] });
    if (input.customer_id) {
      const customer = await queryOne<RowDataPacket & { id: number }>('SELECT id FROM customers WHERE shop_id = ? AND id = ? AND deleted_at IS NULL', [shop.id, input.customer_id]);
      if (!customer) throw ApiError.validation({ customer_id: ['That customer does not exist.'] });
    }
    const created = await withTransaction((tx) =>
      createCard(
        { value, currency, code, expiresOn, customerId: input.customer_id ?? null, note: input.note?.trim() || null, recipient: input.recipient ?? null, source: 'manual' },
        { type: 'admin', id: actor.id },
        tx,
      ),
    );
    const card = (await giftCardsRepository.byId(created.id))!;
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'gift_card.issued', entityType: 'gift_card', entityId: card.id, summary: `Issued a ${formatMoney(value, { currency })} gift card ${maskedCode(card.last_characters)}` });
    let delivery: Record<string, string> | null = null;
    if (input.notify !== false && (card.recipient_email || card.recipient_phone || card.customer_id)) {
      delivery = await sendCard(card, created.code).catch((error) => {
        logger.warn('gift_cards.send_failed', { gift_card_id: card.id, error: String(error) });
        return null;
      });
    }
    return { gift_card: present(card), code: formatCode(created.code), delivery };
  },

  async update(id: number, input: { expires_on?: string | null; note?: string | null; customer_id?: number | null }, actor: Actor) {
    const card = await giftCardsRepository.byId(id);
    if (!card) throw ApiError.notFound('Gift card');
    const patch: Record<string, unknown> = {};
    if (input.expires_on !== undefined) {
      const expiresOn = input.expires_on ? dateOnly(input.expires_on) : null;
      if (expiresOn && expiresOn < todayIn(tenancy.current().timezone)) throw ApiError.validation({ expires_on: ['Choose a date in the future.'] });
      patch.expires_on = expiresOn;
    }
    if (input.note !== undefined) patch.note = input.note?.trim() || null;
    if (input.customer_id !== undefined) {
      if (input.customer_id) {
        const customer = await queryOne<RowDataPacket & { id: number }>('SELECT id FROM customers WHERE shop_id = ? AND id = ? AND deleted_at IS NULL', [shopId(), input.customer_id]);
        if (!customer) throw ApiError.validation({ customer_id: ['That customer does not exist.'] });
      }
      patch.customer_id = input.customer_id;
    }
    await giftCardsRepository.update(id, patch);
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'gift_card.updated', entityType: 'gift_card', entityId: id, summary: `Changed gift card ${maskedCode(card.last_characters)}`, changes: patch });
    return this.get(id);
  },

  async setEnabled(id: number, enabled: boolean, actor: Actor) {
    const card = await giftCardsRepository.byId(id);
    if (!card) throw ApiError.notFound('Gift card');
    await giftCardsRepository.update(id, { status: enabled ? 'enabled' : 'disabled', disabled_at: enabled ? null : new Date() });
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: enabled ? 'gift_card.enabled' : 'gift_card.disabled', entityType: 'gift_card', entityId: id, summary: `${enabled ? 'Re-enabled' : 'Disabled'} gift card ${maskedCode(card.last_characters)}` });
    return this.get(id);
  },

  /** Adds to or takes from a balance, with a reason; never below zero. */
  async adjust(id: number, input: { amount: number; note: string }, actor: Actor) {
    const card = await giftCardsRepository.byId(id);
    if (!card) throw ApiError.notFound('Gift card');
    const amount = roundMoney(Number(input.amount), card.currency);
    if (!amount) throw ApiError.validation({ amount: ['Enter an amount to add (or, negative, to take away).'] });
    if (Number(card.balance) + amount > MAX_VALUE) throw ApiError.validation({ amount: ['That would take the balance over the limit.'] });
    const balance = await withTransaction((tx) => giftCardsRepository.move(card, { kind: 'adjustment', amount, note: input.note.trim(), actorType: 'admin', actorId: actor.id }, tx));
    if (balance === null) throw ApiError.conflict(`The balance is ${formatMoney(Number(card.balance), { currency: card.currency })}; it cannot go below zero.`, 'INVALID_TRANSITION');
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'gift_card.adjusted', entityType: 'gift_card', entityId: id, summary: `${amount > 0 ? 'Added' : 'Took'} ${formatMoney(Math.abs(amount), { currency: card.currency })} ${amount > 0 ? 'to' : 'from'} gift card ${maskedCode(card.last_characters)}: ${input.note.trim()}` });
    return this.get(id);
  },

  /** Sends the card again (a new phone, a lost email). */
  async resend(id: number, actor: Actor) {
    const card = await giftCardsRepository.byId(id);
    if (!card) throw ApiError.notFound('Gift card');
    if (!(card.recipient_email || card.recipient_phone || card.customer_id)) throw ApiError.conflict('This card has no recipient or customer to send it to.', 'INVALID_TRANSITION');
    const code = openCode(card);
    if (!code) throw ApiError.conflict('The card’s code cannot be read back, so it cannot be sent.', 'INVALID_TRANSITION');
    const delivery = await sendCard(card, code);
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'gift_card.resent', entityType: 'gift_card', entityId: id, summary: `Sent gift card ${maskedCode(card.last_characters)} again` });
    return { delivery };
  },

  // ── the storefront ───────────────────────────────────────────────────────

  /** A card by what the shopper typed; null if no such card. */
  async findByCode(raw: string, exec: Executor = pool): Promise<GiftCardRow | null> {
    const code = normaliseCode(raw);
    if (!isValidCode(code)) return null;
    return giftCardsRepository.byCodeHash(codeHash(shopId(), code), exec);
  },

  /** The cards on a bag, and what each would pay towards `total`. */
  async forBag(ids: number[], total: number, currency: string) {
    const cards = await giftCardsRepository.byIds(ids);
    const today = todayIn(tenancy.current().timezone);
    const ordered = ids.map((id) => cards.find((card) => card.id === id)).filter((card): card is GiftCardRow => Boolean(card));
    const usable = ordered.filter((card) => unusableReason(card, currency, today) === null);
    const shares = allocate(total, usable.map((card) => ({ id: card.id, balance: Number(card.balance) })), currency);
    return ordered.map((card) => {
      const reason = unusableReason(card, currency, today);
      const amount = shares.find((share) => share.id === card.id)?.amount ?? 0;
      return { id: card.id, last_characters: card.last_characters, masked_code: maskedCode(card.last_characters), balance: Number(card.balance), currency: card.currency, amount, balance_after: roundMoney(Number(card.balance) - amount, card.currency), usable: reason === null, message: reason };
    });
  },

  /**
   * Spends the bag's cards on a new order, inside its transaction: locked,
   * re-checked, each debit guarded by the balance. A card that can no longer
   * pay stops the checkout with the reason, as a lapsed discount code does.
   */
  async spendOnOrder(orderId: number, ids: number[], total: number, currency: string, customerId: number | null, tx: Executor): Promise<{ total: number; cards: Array<{ id: number; last: string; amount: number }> }> {
    if (!ids.length || total <= 0) return { total: 0, cards: [] };
    const locked = await giftCardsRepository.lockForSpend(ids, tx);
    const today = todayIn(tenancy.current().timezone);
    const ordered = ids.map((id) => locked.find((card) => card.id === id)).filter((card): card is GiftCardRow => Boolean(card));
    for (const card of ordered) {
      const reason = unusableReason(card, currency, today);
      if (reason) throw ApiError.conflict(`${reason} Remove it to continue.`, 'GIFT_CARD_NOT_APPLICABLE');
    }
    const shares = allocate(total, ordered.map((card) => ({ id: card.id, balance: Number(card.balance) })), currency).filter((share) => share.amount > 0);
    const spent: Array<{ id: number; last: string; amount: number }> = [];
    for (const share of shares) {
      const card = ordered.find((candidate) => candidate.id === share.id)!;
      const balance = await giftCardsRepository.move(card, { kind: 'debit', amount: -share.amount, orderId, actorType: 'customer', actorId: customerId }, tx);
      if (balance === null) throw ApiError.conflict(`Gift card ${maskedCode(card.last_characters).slice(-8)} was just used elsewhere. Please review your order.`, 'GIFT_CARD_NOT_APPLICABLE');
      spent.push({ id: card.id, last: card.last_characters, amount: share.amount });
    }
    return { total: roundMoney(spent.reduce((sum, card) => sum + card.amount, 0), currency), cards: spent };
  },

  /** Gives back what an order's cards paid (the order was cancelled). Idempotent: only what is still out goes back. */
  async creditOrder(orderId: number, reason: string, tx: Executor): Promise<number> {
    let credited = 0;
    for (const { gift_card_id: cardId, net } of await giftCardsRepository.spentOnOrder(orderId, tx)) {
      if (net >= 0) continue;
      const amount = -net;
      const balance = await giftCardsRepository.move({ id: cardId }, { kind: 'credit', amount, orderId, note: reason, actorType: 'system' }, tx);
      if (balance !== null) credited += amount;
    }
    // Handed back, it no longer counts as paid on the order — so it can never be refunded as well.
    if (credited > 0) {
      await execute(
        'UPDATE orders SET gift_card_total = GREATEST(0, gift_card_total - ?), amount_paid = GREATEST(0, amount_paid - ?) WHERE shop_id = ? AND id = ?',
        [credited, credited, shopId(), orderId],
        tx,
      );
    }
    return credited;
  },

  /** What the order's gift cards paid and still hold (not yet credited back). */
  async outstandingOnOrder(orderId: number, exec: Executor = pool): Promise<number> {
    const spent = await giftCardsRepository.spentOnOrder(orderId, exec);
    return spent.reduce((sum, row) => sum + Math.max(0, -row.net), 0);
  },

  /**
   * Returns part of what an order's cards paid, for a refund: onto the cards
   * in the order they were spent, never more than each gave.
   */
  async refundToCards(orderId: number, amount: number, reason: string, tx: Executor): Promise<number> {
    let remaining = amount;
    let credited = 0;
    for (const { gift_card_id: cardId, net } of await giftCardsRepository.spentOnOrder(orderId, tx)) {
      if (remaining <= 0) break;
      const back = Math.min(remaining, Math.max(0, -net));
      if (back <= 0) continue;
      const balance = await giftCardsRepository.move({ id: cardId }, { kind: 'credit', amount: back, orderId, note: reason, actorType: 'admin' }, tx);
      if (balance === null) continue;
      remaining -= back;
      credited += back;
    }
    return credited;
  },

  /**
   * Issues the gift cards bought on an order, once it is paid: one per unit,
   * worth what was paid for it, sent to the customer. Safe to run twice — a
   * line's cards are numbered, and a number is only ever issued once.
   */
  async issueForOrder(orderId: number): Promise<number> {
    const order = await queryOne<RowDataPacket & { id: number; customer_id: number | null; currency: string; payment_status: string; order_status: string }>(
      'SELECT id, customer_id, currency, payment_status, order_status FROM orders WHERE shop_id = ? AND id = ?',
      [shopId(), orderId],
    );
    if (!order || order.payment_status !== 'paid' || order.order_status === 'cancelled') return 0;
    const lines = await query<RowDataPacket & { id: number; quantity: number; cancelled_quantity: number; unit_price: string; product_name: string }>(
      `SELECT oi.id, oi.quantity, oi.cancelled_quantity, oi.unit_price, oi.product_name
         FROM order_items oi JOIN products p ON p.shop_id = oi.shop_id AND p.id = oi.product_id
        WHERE oi.shop_id = ? AND oi.order_id = ? AND oi.line_type = 'product' AND p.is_gift_card = 1`,
      [shopId(), orderId],
    );
    let issued = 0;
    for (const line of lines) {
      const done = new Set(await giftCardsRepository.issuedForItem(line.id));
      for (let sequence = 1; sequence <= line.quantity - (line.cancelled_quantity ?? 0); sequence += 1) {
        if (done.has(sequence)) continue;
        let created: { id: number; code: string };
        try {
          created = await withTransaction((tx) =>
            createCard(
              { value: Number(line.unit_price), currency: order.currency, code: null, expiresOn: null, customerId: order.customer_id, note: `Bought on the order (${line.product_name})`, recipient: null, source: 'purchase', orderId, orderItemId: line.id, orderItemSequence: sequence },
              { type: 'system', id: null },
              tx,
            ),
          );
        } catch (error) {
          // Issued by a concurrent run of this job: the unique (line, sequence) key says so.
          if ((error as { code?: string }).code === 'ER_DUP_ENTRY') continue;
          throw error;
        }
        issued += 1;
        const card = (await giftCardsRepository.byId(created.id))!;
        await sendCard(card, created.code).catch((error) => logger.warn('gift_cards.send_failed', { gift_card_id: card.id, error: String(error) }));
      }
    }
    return issued;
  },

  /** The card behind /gift_cards/<token>, for its page. */
  async forPage(token: string) {
    if (!/^[0-9a-f]{32}$/.test(token)) return null;
    const card = await giftCardsRepository.byLookupToken(token);
    if (!card) return null;
    const code = openCode(card);
    return { card, code, today: todayIn(tenancy.current().timezone) };
  },
};
