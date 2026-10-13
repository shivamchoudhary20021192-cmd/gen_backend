import { execute, insert, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface CustomerRow extends RowDataPacket {
  id: number;
  public_id: string;
  country_code: string;
  phone: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  status: string;
  phone_verified_at: Date | null;
  accepts_whatsapp_marketing: number;
  orders_count: number;
  created_at: Date;
}

export interface OtpRow extends RowDataPacket {
  id: number;
  request_id: string;
  country_code: string;
  phone: string;
  purpose: string;
  channel: string;
  otp_hash: string;
  attempts: number;
  max_attempts: number;
  resend_count: number;
  status: string;
  customer_id: number | null;
  expires_at: Date;
  created_at: Date;
}

export interface CustomerSessionRow extends RowDataPacket {
  id: number;
  customer_id: number;
  refresh_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

export const shopAuthRepository = {
  async findCustomerByPhone(
    countryCode: string,
    phone: string,
    exec: Executor = pool,
  ): Promise<CustomerRow | null> {
    return queryOne<CustomerRow>(
      `SELECT * FROM customers
        WHERE shop_id = ? AND country_code = ? AND phone = ? AND deleted_at IS NULL
        LIMIT 1`,
      [shopId(), countryCode, phone],
      exec,
    );
  },

  async findCustomerById(id: number, exec: Executor = pool): Promise<CustomerRow | null> {
    return queryOne<CustomerRow>(
      `SELECT * FROM customers WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1`,
      [shopId(), id],
      exec,
    );
  },

  async createCustomer(
    input: { countryCode: string; phone: string; source: string },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO customers
         (shop_id, public_id, country_code, phone, status, phone_verified_at, signup_source, last_seen_at)
       VALUES (?, UUID(), ?, ?, 'active', NOW(), ?, NOW())`,
      [shopId(), input.countryCode, input.phone, input.source],
      exec,
    );
  },

  async markPhoneVerified(customerId: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE customers
          SET phone_verified_at = COALESCE(phone_verified_at, NOW()), last_seen_at = NOW()
        WHERE shop_id = ? AND id = ?`,
      [shopId(), customerId],
      exec,
    );
  },

  // ── one-time codes ────────────────────────────────────────────────────────

  async createOtp(
    input: {
      requestId: string;
      countryCode: string;
      phone: string;
      purpose: string;
      channel: string;
      otpHash: string;
      customerId: number | null;
      ip: string | null;
      userAgent: string | null;
      ttlSeconds: number;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO otp_requests
         (shop_id, request_id, country_code, phone, purpose, channel, otp_hash, customer_id,
          ip, user_agent, status, sent_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, INET6_ATON(?), ?, 'sent', NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND))`,
      [
        shopId(),
        input.requestId,
        input.countryCode,
        input.phone,
        input.purpose,
        input.channel,
        input.otpHash,
        input.customerId,
        input.ip,
        input.userAgent,
        input.ttlSeconds,
      ],
      exec,
    );
  },

  /**
   * Locks the code row for verification.
   *
   * `FOR UPDATE` because the attempt counter is the whole defence against
   * guessing a six-digit code: without the lock, ten parallel requests all read
   * `attempts = 0`, all increment to 1, and the limit of five never bites.
   */
  async lockOtp(requestId: string, exec: Executor): Promise<OtpRow | null> {
    return queryOne<OtpRow>(
      `SELECT * FROM otp_requests WHERE shop_id = ? AND request_id = ? FOR UPDATE`,
      [shopId(), requestId],
      exec,
    );
  },

  async recordOtpAttempt(id: number, exec: Executor): Promise<void> {
    await execute(`UPDATE otp_requests SET attempts = attempts + 1 WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
  },

  async setOtpStatus(
    id: number,
    status: 'verified' | 'expired' | 'failed' | 'cancelled',
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE otp_requests
          SET status = ?, verified_at = CASE WHEN ? = 'verified' THEN NOW() ELSE verified_at END
        WHERE shop_id = ? AND id = ?`,
      [status, status, shopId(), id],
      exec,
    );
  },

  /** Retires any code still outstanding for a phone, so only the newest works. */
  async cancelOutstandingOtps(
    countryCode: string,
    phone: string,
    purpose: string,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE otp_requests
          SET status = 'cancelled'
        WHERE shop_id = ? AND country_code = ? AND phone = ? AND purpose = ? AND status IN ('pending','sent')`,
      [shopId(), countryCode, phone, purpose],
      exec,
    );
  },

  // ── throttling ────────────────────────────────────────────────────────────

  /**
   * Counts a request against a rolling window and reports whether it is blocked.
   *
   * Sending an SMS or a WhatsApp message costs money and lands on a real
   * person's phone, so this is stricter than an ordinary rate limit — the abuse
   * here is using someone else's number as a target, which costs the shop and
   * annoys a stranger who never visited it.
   */
  async touchThrottle(
    input: { identifier: string; identifierType: 'phone' | 'ip' | 'device'; windowMinutes: number },
    exec: Executor = pool,
  ): Promise<{ count: number; blockedUntil: Date | null }> {
    const windowStart = `FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP() / (? * 60)) * (? * 60))`;
    await execute(
      `INSERT INTO otp_throttle (shop_id, identifier, identifier_type, window_start, request_count)
       VALUES (?, ?, ?, ${windowStart}, 1)
       ON DUPLICATE KEY UPDATE request_count = request_count + 1`,
      [shopId(), input.identifier, input.identifierType, input.windowMinutes, input.windowMinutes],
      exec,
    );

    const row = await queryOne<RowDataPacket & { request_count: number; blocked_until: Date | null }>(
      `SELECT request_count, blocked_until
         FROM otp_throttle
        WHERE shop_id = ? AND identifier = ? AND identifier_type = ? AND window_start = ${windowStart}`,
      [shopId(), input.identifier, input.identifierType, input.windowMinutes, input.windowMinutes],
      exec,
    );
    return { count: row?.request_count ?? 1, blockedUntil: row?.blocked_until ?? null };
  },

  async block(
    input: { identifier: string; identifierType: string; minutes: number; reason: string; windowMinutes: number },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE otp_throttle
          SET blocked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE), block_reason = ?
        WHERE shop_id = ? AND identifier = ? AND identifier_type = ?
          AND window_start = FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP() / (? * 60)) * (? * 60))`,
      [input.minutes, input.reason, shopId(), input.identifier, input.identifierType, input.windowMinutes, input.windowMinutes],
      exec,
    );
  },

  // ── sessions ──────────────────────────────────────────────────────────────

  async createSession(
    input: {
      customerId: number;
      refreshTokenHash: string;
      accessJti: string;
      ip: string | null;
      userAgent: string | null;
      ttlDays: number;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO customer_sessions
         (shop_id, customer_id, refresh_token_hash, access_token_jti, platform, ip, user_agent,
          issued_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, 'web', INET6_ATON(?), ?, NOW(), NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
      [shopId(), input.customerId, input.refreshTokenHash, input.accessJti, input.ip, input.userAgent, input.ttlDays],
      exec,
    );
  },

  /**
   * Scoped to the current shop, which is what binds a customer token to the
   * store that issued it: presented to another shop, it finds no session.
   */
  async findSession(id: number, exec: Executor = pool): Promise<CustomerSessionRow | null> {
    return queryOne<CustomerSessionRow>(
      `SELECT * FROM customer_sessions WHERE shop_id = ? AND id = ? LIMIT 1`,
      [shopId(), id],
      exec,
    );
  },

  async findSessionByRefreshHash(hash: string, exec: Executor = pool): Promise<CustomerSessionRow | null> {
    return queryOne<CustomerSessionRow>(
      `SELECT * FROM customer_sessions WHERE shop_id = ? AND refresh_token_hash = ? LIMIT 1`,
      [shopId(), hash],
      exec,
    );
  },

  async rotateSession(
    input: { id: number; refreshTokenHash: string; accessJti: string },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE customer_sessions
          SET refresh_token_hash = ?, access_token_jti = ?, last_used_at = NOW()
        WHERE shop_id = ? AND id = ?`,
      [input.refreshTokenHash, input.accessJti, shopId(), input.id],
      exec,
    );
  },

  async revokeSession(
    id: number,
    reason: 'logout' | 'rotation' | 'reuse_detected' | 'admin' | 'expired',
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE customer_sessions
          SET revoked_at = COALESCE(revoked_at, NOW()), revoked_reason = ?
        WHERE shop_id = ? AND id = ?`,
      [reason, shopId(), id],
      exec,
    );
  },

  /** Every live session for a customer — used when a refresh token is replayed. */
  async revokeAllSessions(customerId: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE customer_sessions
          SET revoked_at = NOW(), revoked_reason = 'reuse_detected'
        WHERE shop_id = ? AND customer_id = ? AND revoked_at IS NULL`,
      [shopId(), customerId],
      exec,
    );
  },

  async touchSession(id: number, exec: Executor = pool): Promise<void> {
    await execute(`UPDATE customer_sessions SET last_used_at = NOW() WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
  },
};
