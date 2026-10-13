import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

// ── Row types ────────────────────────────────────────────────────────────────

export interface SettingRow extends RowDataPacket {
  id: number;
  group_key: string;
  setting_key: string;
  label: string;
  value: string | null;
  value_type: 'string' | 'number' | 'boolean' | 'json';
  description: string | null;
  is_public: number;
  updated_at: Date;
}

export interface PaymentTransactionRow extends RowDataPacket {
  id: number;
  order_id: number;
  order_number: string;
  gateway: string;
  gateway_order_id: string | null;
  gateway_payment_id: string | null;
  method: string | null;
  amount: string;
  currency: string;
  status: string;
  card_network: string | null;
  card_last4: string | null;
  card_issuer: string | null;
  upi_vpa: string | null;
  bank: string | null;
  wallet: string | null;
  is_international: number;
  gateway_fee: string;
  gateway_tax: string;
  error_code: string | null;
  error_description: string | null;
  authorized_at: Date | null;
  captured_at: Date | null;
  failed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RefundRow extends RowDataPacket {
  id: number;
  order_id: number;
  order_number: string;
  payment_id: number | null;
  gateway_refund_id: string | null;
  amount: string;
  refund_type: 'full' | 'partial';
  reason: string | null;
  internal_note: string | null;
  status: string;
  speed: 'normal' | 'optimum' | 'instant';
  arn: string | null;
  initiated_by_admin_id: number | null;
  admin_name?: string | null;
  processed_at: Date | null;
  created_at: Date;
}

export interface WebhookEventRow extends RowDataPacket {
  id: number;
  gateway: string;
  event_id: string;
  event_type: string;
  status: 'received' | 'processing' | 'processed' | 'failed' | 'ignored';
  attempts: number;
  last_error: string | null;
  order_id: number | null;
  order_number?: string | null;
  payment_id: number | null;
  received_at: Date;
  processed_at: Date | null;
}

export interface PaymentFilters {
  status?: string;
  gateway?: string;
  method?: string;
  search?: string;
}

// ── Repository ───────────────────────────────────────────────────────────────

export const paymentsRepository = {
  // ── Settings ─────────────────────────────────────────────────────────────

  async getPaymentSettings(exec: Executor = pool): Promise<SettingRow[]> {
    return query<SettingRow>(
      `SELECT * FROM settings WHERE shop_id = ? AND group_key = 'payment' ORDER BY sort_order ASC, id ASC`,
      [shopId()],
      exec,
    );
  },

  async upsertSetting(
    settingKey: string,
    label: string,
    value: string,
    valueType: 'string' | 'number' | 'boolean' | 'json' = 'string',
    isPublic: boolean = false,
    adminId?: number,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `INSERT INTO settings
         (shop_id, group_key, setting_key, label, value, value_type, is_public, updated_by_admin_id)
       VALUES (?, 'payment', ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         value = VALUES(value),
         updated_by_admin_id = VALUES(updated_by_admin_id),
         updated_at = CURRENT_TIMESTAMP`,
      [shopId(), settingKey, label, value, valueType, isPublic ? 1 : 0, adminId ?? null],
      exec,
    );
  },

  // ── Transactions ─────────────────────────────────────────────────────────

  async listPayments(
    filters: PaymentFilters,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<PaymentTransactionRow[]> {
    const conditions: string[] = ['p.shop_id = ?'];
    const params: unknown[] = [shopId()];

    if (filters.status) {
      conditions.push('p.status = ?');
      params.push(filters.status);
    }
    if (filters.gateway) {
      conditions.push('p.gateway = ?');
      params.push(filters.gateway);
    }
    if (filters.method) {
      conditions.push('p.method = ?');
      params.push(filters.method);
    }
    if (filters.search) {
      conditions.push(
        '(o.order_number LIKE ? OR p.gateway_payment_id LIKE ? OR p.gateway_order_id LIKE ? OR p.upi_vpa LIKE ?)',
      );
      const term = `%${filters.search}%`;
      params.push(term, term, term, term);
    }

    return query<PaymentTransactionRow>(
      `SELECT p.*, o.order_number
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async countPayments(filters: PaymentFilters, exec: Executor = pool): Promise<number> {
    const conditions: string[] = ['p.shop_id = ?'];
    const params: unknown[] = [shopId()];

    if (filters.status) {
      conditions.push('p.status = ?');
      params.push(filters.status);
    }
    if (filters.gateway) {
      conditions.push('p.gateway = ?');
      params.push(filters.gateway);
    }
    if (filters.method) {
      conditions.push('p.method = ?');
      params.push(filters.method);
    }
    if (filters.search) {
      conditions.push(
        '(o.order_number LIKE ? OR p.gateway_payment_id LIKE ? OR p.gateway_order_id LIKE ? OR p.upi_vpa LIKE ?)',
      );
      const term = `%${filters.search}%`;
      params.push(term, term, term, term);
    }

    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE ${conditions.join(' AND ')}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  async getPaymentById(id: number, exec: Executor = pool): Promise<PaymentTransactionRow | null> {
    return queryOne<PaymentTransactionRow>(
      `SELECT p.*, o.order_number
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE p.shop_id = ? AND p.id = ?
        LIMIT 1`,
      [shopId(), id],
      exec,
    );
  },

  // ── Refunds ──────────────────────────────────────────────────────────────

  async listRefunds(
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<RefundRow[]> {
    return query<RefundRow>(
      `SELECT r.*, o.order_number,
              CONCAT_WS(' ', au.first_name, au.last_name) AS admin_name
         FROM refunds r
         JOIN orders o ON o.id = r.order_id
         LEFT JOIN admin_users au ON au.id = r.initiated_by_admin_id
        WHERE r.shop_id = ?
        ORDER BY r.created_at DESC
        LIMIT ? OFFSET ?`,
      [shopId(), limit, offset],
      exec,
    );
  },

  async countRefunds(exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM refunds WHERE shop_id = ?`,
      [shopId()],
      exec,
    );
    return row?.total ?? 0;
  },

  // ── Webhooks ─────────────────────────────────────────────────────────────

  async listWebhooks(
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<WebhookEventRow[]> {
    return query<WebhookEventRow>(
      `SELECT w.id, w.gateway, w.event_id, w.event_type, w.status, w.attempts,
              w.last_error, w.order_id, o.order_number, w.payment_id, w.received_at, w.processed_at
         FROM payment_webhook_events w
         LEFT JOIN orders o ON o.id = w.order_id AND o.shop_id = w.shop_id
        WHERE w.shop_id = ?
        ORDER BY w.received_at DESC
        LIMIT ? OFFSET ?`,
      [shopId(), limit, offset],
      exec,
    );
  },

  async countWebhooks(exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM payment_webhook_events WHERE shop_id = ?`,
      [shopId()],
      exec,
    );
    return row?.total ?? 0;
  },

  // ── The paying side ──────────────────────────────────────────────────────

  /**
   * The order a payment is for, locked.
   *
   * `FOR UPDATE` because the browser callback and the webhook routinely arrive
   * within the same second describing the same payment. Without the lock both
   * read `payment_status = 'pending'`, both decide to mark it paid, and the
   * order ends up with two payment rows and a doubled `amount_paid`.
   */
  async lockOrderForPayment(orderId: number, exec: Executor): Promise<PayableOrderRow | null> {
    return queryOne<PayableOrderRow>(
      `SELECT id, order_number, order_status, payment_status, payment_method, currency,
              grand_total, amount_paid, amount_due, customer_id, contact_phone, contact_email,
              customer_name
         FROM orders
        WHERE shop_id = ? AND id = ?
        FOR UPDATE`,
      [shopId(), orderId],
      exec,
    );
  },

  /** The same order, by its number and the phone it was placed with. */
  async findPayableOrder(orderNumber: string, phone: string, exec: Executor = pool): Promise<PayableOrderRow | null> {
    return queryOne<PayableOrderRow>(
      `SELECT id, order_number, order_status, payment_status, payment_method, currency,
              grand_total, amount_paid, amount_due, customer_id, contact_phone, contact_email,
              customer_name
         FROM orders
        WHERE shop_id = ? AND order_number = ? AND contact_phone = ?
        LIMIT 1`,
      [shopId(), orderNumber, phone],
      exec,
    );
  },

  /** The gateway order already minted for this order, if one was. */
  async findOpenGatewayOrder(orderId: number, exec: Executor = pool, gateway = 'razorpay'): Promise<PaymentRow | null> {
    return queryOne<PaymentRow>(
      `SELECT * FROM payments
        WHERE shop_id = ? AND order_id = ? AND gateway = ? AND gateway_order_id IS NOT NULL
          AND status IN ('created', 'pending')
        ORDER BY id DESC
        LIMIT 1`,
      [shopId(), orderId, gateway],
      exec,
    );
  },

  async findPaymentByGatewayPaymentId(gatewayPaymentId: string, exec: Executor = pool): Promise<PaymentRow | null> {
    return queryOne<PaymentRow>(
      `SELECT * FROM payments WHERE shop_id = ? AND gateway_payment_id = ? LIMIT 1`,
      [shopId(), gatewayPaymentId],
      exec,
    );
  },

  async findPaymentByGatewayOrderId(gatewayOrderId: string, exec: Executor = pool): Promise<PaymentRow | null> {
    return queryOne<PaymentRow>(
      `SELECT * FROM payments WHERE shop_id = ? AND gateway_order_id = ? ORDER BY id DESC LIMIT 1`,
      [shopId(), gatewayOrderId],
      exec,
    );
  },

  /** Records the gateway order, before the shopper is sent to pay. */
  async createGatewayOrder(
    input: {
      orderId: number;
      gatewayOrderId: string;
      amount: number;
      currency: string;
      attemptNo: number;
      gateway?: string;
      connectionId?: number | null;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO payments (shop_id, order_id, gateway, connection_id, gateway_order_id, amount, currency, status, attempt_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?)`,
      [
        shopId(),
        input.orderId,
        input.gateway ?? 'razorpay',
        input.connectionId ?? null,
        input.gatewayOrderId,
        input.amount,
        input.currency,
        input.attemptNo,
      ],
      exec,
    );
  },

  async countAttempts(orderId: number, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM payments WHERE shop_id = ? AND order_id = ?`,
      [shopId(), orderId],
      exec,
    );
    return row?.total ?? 0;
  },

  /**
   * Writes what the gateway said about a payment onto its row.
   *
   * Keyed on `gateway_payment_id`, which is unique — so the callback and the
   * webhook describing the same payment converge on one row rather than racing
   * to create two. `card_last4` is the only card data stored, and it is what
   * the gateway returned for display.
   */
  async upsertPaymentAttempt(
    input: {
      orderId: number;
      /** Defaults to razorpay, the gateway every existing caller speaks for. */
      gateway?: string;
      /** The integration connection that took the payment, when there is one. */
      connectionId?: number | null;
      gatewayOrderId: string | null;
      gatewayPaymentId: string;
      signature: string | null;
      signatureVerified: boolean;
      amount: number;
      currency: string;
      status: string;
      method: string | null;
      cardNetwork: string | null;
      cardLast4: string | null;
      cardIssuer: string | null;
      upiVpa: string | null;
      bank: string | null;
      wallet: string | null;
      isInternational: boolean;
      fee: number;
      tax: number;
      errorCode: string | null;
      errorDescription: string | null;
      errorSource: string | null;
      errorStep: string | null;
      errorReason: string | null;
      raw: unknown;
      authorizedAt: Date | null;
      capturedAt: Date | null;
      failedAt: Date | null;
    },
    exec: Executor = pool,
  ): Promise<number> {
    await execute(
      `INSERT INTO payments
         (shop_id, order_id, gateway, connection_id, gateway_order_id, gateway_payment_id, gateway_signature, signature_verified,
          amount, currency, status, method, card_network, card_last4, card_issuer, upi_vpa, bank, wallet,
          is_international, gateway_fee, gateway_tax, error_code, error_description, error_source,
          error_step, error_reason, raw_response, authorized_at, captured_at, failed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
          connection_id = COALESCE(VALUES(connection_id), connection_id),
          gateway_order_id = COALESCE(VALUES(gateway_order_id), gateway_order_id),
          gateway_signature = COALESCE(VALUES(gateway_signature), gateway_signature),
          -- Verification is sticky: a webhook carrying no checkout signature
          -- must not un-verify a payment the callback already proved.
          signature_verified = GREATEST(signature_verified, VALUES(signature_verified)),
          amount = VALUES(amount),
          status = VALUES(status),
          method = COALESCE(VALUES(method), method),
          card_network = COALESCE(VALUES(card_network), card_network),
          card_last4 = COALESCE(VALUES(card_last4), card_last4),
          card_issuer = COALESCE(VALUES(card_issuer), card_issuer),
          upi_vpa = COALESCE(VALUES(upi_vpa), upi_vpa),
          bank = COALESCE(VALUES(bank), bank),
          wallet = COALESCE(VALUES(wallet), wallet),
          is_international = VALUES(is_international),
          gateway_fee = VALUES(gateway_fee),
          gateway_tax = VALUES(gateway_tax),
          error_code = VALUES(error_code),
          error_description = VALUES(error_description),
          error_source = VALUES(error_source),
          error_step = VALUES(error_step),
          error_reason = VALUES(error_reason),
          raw_response = VALUES(raw_response),
          authorized_at = COALESCE(VALUES(authorized_at), authorized_at),
          captured_at = COALESCE(VALUES(captured_at), captured_at),
          failed_at = COALESCE(VALUES(failed_at), failed_at)`,
      [
        shopId(),
        input.orderId,
        input.gateway ?? 'razorpay',
        input.connectionId ?? null,
        input.gatewayOrderId,
        input.gatewayPaymentId,
        input.signature,
        input.signatureVerified ? 1 : 0,
        input.amount,
        input.currency,
        input.status,
        input.method,
        input.cardNetwork,
        input.cardLast4,
        input.cardIssuer,
        input.upiVpa,
        input.bank,
        input.wallet,
        input.isInternational ? 1 : 0,
        input.fee,
        input.tax,
        input.errorCode,
        input.errorDescription,
        input.errorSource,
        input.errorStep,
        input.errorReason,
        JSON.stringify(input.raw ?? null),
        input.authorizedAt,
        input.capturedAt,
        input.failedAt,
      ],
      exec,
    );

    const row = await queryOne<RowDataPacket & { id: number }>(
      `SELECT id FROM payments WHERE shop_id = ? AND gateway_payment_id = ? LIMIT 1`,
      [shopId(), input.gatewayPaymentId],
      exec,
    );
    return row?.id ?? 0;
  },

  /**
   * Retires the placeholder row minted before the shopper went to pay.
   *
   * Without this an abandoned attempt sits at `created` forever and
   * `findOpenGatewayOrder` keeps handing the same dead gateway order to the
   * next attempt.
   */
  async closeStaleGatewayOrders(orderId: number, keepPaymentId: number, exec: Executor): Promise<void> {
    await execute(
      `UPDATE payments SET status = 'cancelled'
        WHERE shop_id = ? AND order_id = ? AND id <> ? AND status IN ('created', 'pending')`,
      [shopId(), orderId, keepPaymentId],
      exec,
    );
  },

  async markOrderPaid(
    input: { orderId: number; amountPaid: number; amountDue: number; confirm: boolean },
    exec: Executor,
  ): Promise<void> {
    await execute(
      `UPDATE orders
          SET payment_status = 'paid',
              amount_paid = ?,
              amount_due = ?,
              order_status = CASE WHEN ? = 1 AND order_status = 'pending' THEN 'confirmed' ELSE order_status END,
              confirmed_at = CASE WHEN ? = 1 AND confirmed_at IS NULL THEN NOW() ELSE confirmed_at END
        WHERE shop_id = ? AND id = ?`,
      [input.amountPaid, input.amountDue, input.confirm ? 1 : 0, input.confirm ? 1 : 0, shopId(), input.orderId],
      exec,
    );
  },

  async markOrderPaymentFailed(orderId: number, exec: Executor): Promise<void> {
    await execute(
      `UPDATE orders SET payment_status = 'failed' WHERE shop_id = ? AND id = ? AND payment_status = 'pending'`,
      [shopId(), orderId],
      exec,
    );
  },

  async addOrderHistory(
    input: {
      orderId: number;
      statusType: 'order' | 'payment' | 'fulfillment';
      fromStatus: string | null;
      toStatus: string;
      note: string | null;
      isCustomerVisible: boolean;
    },
    exec: Executor,
  ): Promise<void> {
    await execute(
      `INSERT INTO order_status_history
         (shop_id, order_id, status_type, from_status, to_status, note, actor_type, is_customer_visible)
       VALUES (?, ?, ?, ?, ?, ?, 'system', ?)`,
      [
        shopId(),
        input.orderId,
        input.statusType,
        input.fromStatus,
        input.toStatus,
        input.note,
        input.isCustomerVisible ? 1 : 0,
      ],
      exec,
    );
  },

  // ── Refunds that move money ──────────────────────────────────────────────

  async findRefundById(id: number, exec: Executor = pool): Promise<RefundStateRow | null> {
    return queryOne<RefundStateRow>(
      `SELECT id, order_id, payment_id, gateway_refund_id, amount, status FROM refunds WHERE shop_id = ? AND id = ? LIMIT 1`,
      [shopId(), id],
      exec,
    );
  },

  async findRefundByGatewayId(gatewayRefundId: string, exec: Executor = pool): Promise<RefundStateRow | null> {
    return queryOne<RefundStateRow>(
      `SELECT id, order_id, payment_id, gateway_refund_id, amount, status
         FROM refunds WHERE shop_id = ? AND gateway_refund_id = ? LIMIT 1`,
      [shopId(), gatewayRefundId],
      exec,
    );
  },

  async attachGatewayRefund(
    input: { refundId: number; gatewayRefundId: string; status: string; speed: string | null; arn: string | null; raw: unknown },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE refunds
          SET gateway_refund_id = ?, status = ?, speed = ?, arn = COALESCE(?, arn),
              raw_response = ?, processed_at = CASE WHEN ? = 'processed' THEN NOW() ELSE processed_at END
        WHERE shop_id = ? AND id = ?`,
      [
        input.gatewayRefundId,
        input.status,
        input.speed ?? 'normal',
        input.arn,
        JSON.stringify(input.raw ?? null),
        input.status,
        shopId(),
        input.refundId,
      ],
      exec,
    );
  },

  /**
   * Undoes a refund the gateway refused.
   *
   * The refund row is written before the gateway is called, so that a refund
   * that moved money is never missing from our records. The cost of that order
   * is this: when the call fails, the order's refunded total has to be put
   * back. The refund row itself is kept and marked `failed` — deleting it would
   * erase the fact that someone tried.
   */
  async reverseFailedRefund(
    input: { refundId: number; orderId: number; amount: number; restorePaymentStatus: string; error: string },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE refunds SET status = 'failed', internal_note = CONCAT_WS(' — ', internal_note, ?) WHERE shop_id = ? AND id = ?`,
      [input.error.slice(0, 400), shopId(), input.refundId],
      exec,
    );
    await execute(
      `UPDATE orders
          SET amount_refunded = GREATEST(0, amount_refunded - ?), payment_status = ?
        WHERE shop_id = ? AND id = ?`,
      [input.amount, input.restorePaymentStatus, shopId(), input.orderId],
      exec,
    );
  },

  async setRefundStatus(
    input: { refundId: number; status: string; arn: string | null; raw: unknown },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE refunds
          SET status = ?, arn = COALESCE(?, arn), raw_response = ?,
              processed_at = CASE WHEN ? = 'processed' THEN NOW() ELSE processed_at END
        WHERE shop_id = ? AND id = ?`,
      [input.status, input.arn, JSON.stringify(input.raw ?? null), input.status, shopId(), input.refundId],
      exec,
    );
  },

  // ── Webhook events ───────────────────────────────────────────────────────

  /**
   * Stores a webhook exactly once.
   *
   * Razorpay retries an event until it gets a 2xx, so the same delivery arrives
   * repeatedly by design. The unique index on `(gateway, event_id)` is what
   * makes replay harmless; this returns null when the event has been seen.
   */
  async recordWebhookEvent(
    input: {
      gateway?: string;
      eventId: string;
      eventType: string;
      payload: unknown;
      signature: string | null;
      signatureValid: boolean;
      orderId: number | null;
    },
    exec: Executor = pool,
  ): Promise<number | null> {
    const result = await execute(
      `INSERT IGNORE INTO payment_webhook_events
         (shop_id, gateway, event_id, event_type, payload, signature, signature_valid, order_id, status, attempts, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', 1, NOW())`,
      [
        shopId(),
        input.gateway ?? 'razorpay',
        input.eventId,
        input.eventType,
        JSON.stringify(input.payload ?? null),
        input.signature,
        input.signatureValid ? 1 : 0,
        input.orderId,
      ],
      exec,
    );
    return result.affectedRows === 0 ? null : result.insertId;
  },

  async completeWebhookEvent(
    input: { id: number; status: 'processed' | 'failed' | 'ignored'; error: string | null; orderId: number | null; paymentId: number | null },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE payment_webhook_events
          SET status = ?, last_error = ?, order_id = COALESCE(?, order_id),
              payment_id = COALESCE(?, payment_id), processed_at = NOW()
        WHERE shop_id = ? AND id = ?`,
      [input.status, input.error, input.orderId, input.paymentId, shopId(), input.id],
      exec,
    );
  },
};

export interface PayableOrderRow extends RowDataPacket {
  id: number;
  order_number: string;
  order_status: string;
  payment_status: string;
  payment_method: string;
  currency: string;
  grand_total: string;
  amount_paid: string;
  amount_due: string;
  customer_id: number | null;
  contact_phone: string;
  contact_email: string | null;
  customer_name: string | null;
}

export interface PaymentRow extends RowDataPacket {
  id: number;
  order_id: number;
  gateway: string;
  connection_id: number | null;
  gateway_order_id: string | null;
  gateway_payment_id: string | null;
  signature_verified: number;
  amount: string;
  currency: string;
  status: string;
  attempt_no: number;
}

export interface RefundStateRow extends RowDataPacket {
  id: number;
  order_id: number;
  payment_id: number | null;
  gateway_refund_id: string | null;
  amount: string;
  status: string;
}
