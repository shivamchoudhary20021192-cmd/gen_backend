import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { hashToken, randomToken, safeEqual } from '../../core/crypto';
import { logger } from '../../core/logger';
import { withTransaction } from '../../db/transaction';
import { messagingService } from '../messaging/messaging.service';
import { shopAccountRepository } from '../shop-account/shopAccount.repository';
import { shopAuthRepository, type CustomerRow } from './shopAuth.repository';
import { callingCodeFor } from '../../platform/geo/phone';
import { tenancy } from '../../platform/tenancy/context';

/**
 * Customer accounts, by phone.
 *
 * No passwords. A shopper enters their mobile number, receives a code, and is
 * signed in — which is what people expect in India and what the schema was
 * designed for in phase 1 (`otp_requests`, `otp_throttle`, `customer_sessions`
 * have been sitting empty ever since).
 *
 * The properties that matter:
 *
 *   - the code is never stored. Only an HMAC of it, peppered, so a database
 *     dump does not let anyone sign in as a customer
 *   - requesting a code never reveals whether that number has an account. The
 *     response is identical either way
 *   - attempts are counted under a row lock, because five guesses at a
 *     six-digit code is a real limit and ten parallel guesses at one is not
 *   - sending costs money and lands on a stranger's phone if the number is not
 *     theirs, so the throttle is per phone *and* per address
 */

const OTP_LENGTH = 6;
const OTP_TTL_SECONDS = 300;
const RESEND_AFTER_SECONDS = 30;

/** Per number: enough for a genuine retry, not enough to be a nuisance. */
const PHONE_WINDOW_MINUTES = 60;
const PHONE_MAX_PER_WINDOW = 5;

/** Per address: one person helping a few others is fine; a script is not. */
const IP_WINDOW_MINUTES = 60;
const IP_MAX_PER_WINDOW = 20;

const SESSION_TTL_DAYS = 90;
const ACCESS_TTL_MINUTES = 30;

export interface CustomerTokenPayload {
  sub: string;
  sid: string;
  jti: string;
  typ: 'customer_access';
}

function signAccessToken(customerId: number, sessionId: number, jti: string): string {
  const payload: CustomerTokenPayload = {
    sub: String(customerId),
    sid: String(sessionId),
    jti,
    typ: 'customer_access',
  };
  return jwt.sign(payload, env.auth.jwtSecret, {
    expiresIn: `${ACCESS_TTL_MINUTES}m`,
    // A different issuer from the admin token, so an admin token can never be
    // presented as a customer token or the other way round.
    issuer: 'veylor-shop',
  });
}

export function verifyCustomerAccessToken(token: string): CustomerTokenPayload {
  const decoded = jwt.verify(token, env.auth.jwtSecret, { issuer: 'veylor-shop' }) as CustomerTokenPayload;
  if (decoded.typ !== 'customer_access') throw new Error('wrong token type');
  return decoded;
}

/**
 * A six-digit code with no modulo bias.
 *
 * `randomInt` over the exact range rather than `randomBytes % 1000000`, which
 * would make the low codes fractionally likelier. It costs nothing to do right.
 */
function generateCode(): string {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

function publicCustomer(row: CustomerRow) {
  return {
    id: row.public_id,
    phone: row.phone,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    accepts_whatsapp_marketing: row.accepts_whatsapp_marketing === 1,
    orders_count: row.orders_count,
  };
}

export const shopAuthService = {
  /**
   * Issues a code.
   *
   * The response is the same whether or not the number belongs to an existing
   * customer: a sign-in form that answers differently is a way to find out who
   * shops here.
   */
  async requestOtp(
    input: { phone: string; channel: 'sms' | 'whatsapp' },
    meta: { ip: string | null; userAgent: string | null },
  ) {
    const countryCode = `+${callingCodeFor(tenancy.current().countryCode) ?? '91'}`;
    const phone = input.phone.trim();

    const byPhone = await shopAuthRepository.touchThrottle({
      identifier: `${countryCode}${phone}`,
      identifierType: 'phone',
      windowMinutes: PHONE_WINDOW_MINUTES,
    });
    if (byPhone.blockedUntil && byPhone.blockedUntil > new Date()) {
      throw ApiError.rateLimited(
        Math.ceil((byPhone.blockedUntil.getTime() - Date.now()) / 1000),
        'Too many codes have been requested for this number. Please try again later.',
      );
    }
    if (byPhone.count > PHONE_MAX_PER_WINDOW) {
      await shopAuthRepository.block({
        identifier: `${countryCode}${phone}`,
        identifierType: 'phone',
        minutes: 60,
        reason: 'otp_request_flood',
        windowMinutes: PHONE_WINDOW_MINUTES,
      });
      throw ApiError.rateLimited(3600, 'Too many codes have been requested for this number. Please try again later.');
    }

    if (meta.ip) {
      const byIp = await shopAuthRepository.touchThrottle({
        identifier: meta.ip,
        identifierType: 'ip',
        windowMinutes: IP_WINDOW_MINUTES,
      });
      if (byIp.count > IP_MAX_PER_WINDOW) {
        logger.warn('shop_auth.otp_ip_flood', { count: byIp.count });
        throw ApiError.rateLimited(3600, 'Too many codes have been requested. Please try again later.');
      }
    }

    const existing = await shopAuthRepository.findCustomerByPhone(countryCode, phone);
    if (existing && existing.status === 'blocked') {
      // Refused, but with the same shape as any other failure to send — telling
      // someone their account is blocked at a sign-in form tells an attacker too.
      logger.warn('shop_auth.blocked_customer_otp', { customer_id: existing.id });
      throw ApiError.conflict('We could not send a code to that number. Please contact us.');
    }

    await shopAuthRepository.cancelOutstandingOtps(countryCode, phone, 'login');

    const code = generateCode();
    const requestId = crypto.randomUUID();

    await shopAuthRepository.createOtp({
      requestId,
      countryCode,
      phone,
      purpose: 'login',
      channel: input.channel,
      // Peppered, so the codes in a leaked table cannot be checked offline.
      otpHash: hashToken(code),
      customerId: existing?.id ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      ttlSeconds: OTP_TTL_SECONDS,
    });

    // Transactional, so it needs no marketing consent — this is a code the
    // person just asked for.
    const outcome = await messagingService.send({
      eventKey: 'otp.login',
      channel: input.channel,
      to: `${countryCode}${phone}`.replace('+', ''),
      variables: { otp: code, minutes: String(OTP_TTL_SECONDS / 60) },
      customerId: existing?.id ?? null,
    });

    if (!outcome.sent) {
      logger.error('shop_auth.otp_send_failed', { reason: outcome.reason, detail: outcome.detail });
    }

    return {
      request_id: requestId,
      expires_in: OTP_TTL_SECONDS,
      resend_after: RESEND_AFTER_SECONDS,
      channel: input.channel,
      // Only ever the last two digits, and only for the number they just typed.
      sent_to: `••••••${phone.slice(-2)}`,
    };
  },

  /**
   * Checks a code and signs the customer in, creating the account if new.
   *
   * Note what this does *not* do: throw from inside the transaction on a wrong
   * code. Recording the failed attempt and then throwing would roll the
   * increment back with everything else, so `attempts` would stay at zero and
   * the five-guess limit would never bite — a six-digit code could be walked
   * through at leisure. The transaction therefore returns a verdict, commits,
   * and the refusal is raised outside it.
   */
  async verifyOtp(
    input: { request_id: string; code: string; session_token?: string | null },
    meta: { ip: string | null; userAgent: string | null },
  ) {
    type Verdict =
      | { ok: false; message: string }
      | {
          ok: true;
          payload: {
            access_token: string;
            refresh_token: string;
            token_type: 'Bearer';
            expires_in: number;
            is_new_account: boolean;
            customer: ReturnType<typeof publicCustomer>;
          };
        };

    const verdict = await withTransaction<Verdict>(async (tx) => {
      const otp = await shopAuthRepository.lockOtp(input.request_id, tx);
      if (!otp) return { ok: false, message: 'That code has expired. Please request a new one.' };

      if (otp.status === 'verified') {
        return { ok: false, message: 'That code has already been used. Please request a new one.' };
      }
      if (otp.status !== 'sent' && otp.status !== 'pending') {
        return { ok: false, message: 'That code is no longer valid. Please request a new one.' };
      }
      if (new Date(otp.expires_at).getTime() < Date.now()) {
        await shopAuthRepository.setOtpStatus(otp.id, 'expired', tx);
        return { ok: false, message: 'That code has expired. Please request a new one.' };
      }
      if (otp.attempts >= otp.max_attempts) {
        await shopAuthRepository.setOtpStatus(otp.id, 'failed', tx);
        return { ok: false, message: 'Too many incorrect attempts. Please request a new code.' };
      }

      await shopAuthRepository.recordOtpAttempt(otp.id, tx);

      if (!safeEqual(hashToken(input.code.trim()), otp.otp_hash)) {
        const remaining = otp.max_attempts - otp.attempts - 1;
        if (remaining <= 0) {
          // Retired here rather than on the next attempt, so the code is dead
          // the moment the last guess is spent.
          await shopAuthRepository.setOtpStatus(otp.id, 'failed', tx);
        }
        return {
          ok: false,
          message:
            remaining > 0
              ? `That code is not right. ${remaining} ${remaining === 1 ? 'try' : 'tries'} left.`
              : 'That code is not right. Please request a new one.',
        };
      }

      await shopAuthRepository.setOtpStatus(otp.id, 'verified', tx);

      let customer = await shopAuthRepository.findCustomerByPhone(otp.country_code, otp.phone, tx);
      const isNew = !customer;
      if (!customer) {
        const id = await shopAuthRepository.createCustomer(
          { countryCode: otp.country_code, phone: otp.phone, source: 'web' },
          tx,
        );
        customer = await shopAuthRepository.findCustomerById(id, tx);
      } else {
        await shopAuthRepository.markPhoneVerified(customer.id, tx);
      }
      if (!customer) throw ApiError.internal('The account could not be created.');

      const refreshToken = randomToken(48);
      const jti = crypto.randomUUID();
      const sessionId = await shopAuthRepository.createSession(
        {
          customerId: customer.id,
          refreshTokenHash: hashToken(refreshToken),
          accessJti: jti,
          ip: meta.ip,
          userAgent: meta.userAgent,
          ttlDays: SESSION_TTL_DAYS,
        },
        tx,
      );

      /**
       * Everything this person did before they had an account becomes theirs.
       *
       * Done here rather than in the route because the route only ever sees the
       * public UUID — an earlier version of this passed that to a function
       * expecting the numeric id, which silently claimed nothing at all.
       */
      if (input.session_token) {
        await shopAccountRepository.claimGuestHistory(
          { customerId: customer.id, sessionToken: input.session_token },
          tx,
        );
      }

      logger.info('shop_auth.signed_in', { customer_id: customer.id, new_account: isNew });

      return {
        ok: true,
        payload: {
          access_token: signAccessToken(customer.id, sessionId, jti),
          refresh_token: refreshToken,
          token_type: 'Bearer' as const,
          expires_in: ACCESS_TTL_MINUTES * 60,
          is_new_account: isNew,
          customer: publicCustomer(customer),
        },
      };
    });

    // Outside the transaction, so the attempt that was just counted stays counted.
    if (!verdict.ok) throw ApiError.badRequest(verdict.message);
    return verdict.payload;
  },

  /**
   * Trades a refresh token for a new pair.
   *
   * A token that has already been rotated away is a replay — either the real
   * customer's token was stolen and used, or the thief's was. There is no way to
   * tell which, so every session for that customer is revoked and they sign in
   * again. The same rule the admin sessions use.
   */
  async refresh(refreshToken: string, meta: { ip: string | null; userAgent: string | null }) {
    void meta;
    const hash = hashToken(refreshToken);
    const session = await shopAuthRepository.findSessionByRefreshHash(hash);
    if (!session) throw ApiError.unauthenticated('Please sign in again.');

    if (session.revoked_at) {
      await shopAuthRepository.revokeAllSessions(session.customer_id);
      logger.warn('shop_auth.refresh_replay', { customer_id: session.customer_id });
      throw ApiError.unauthenticated('Please sign in again.');
    }
    if (new Date(session.expires_at).getTime() < Date.now()) {
      await shopAuthRepository.revokeSession(session.id, 'expired');
      throw ApiError.unauthenticated('Please sign in again.');
    }

    const customer = await shopAuthRepository.findCustomerById(session.customer_id);
    if (!customer || customer.status === 'blocked') {
      await shopAuthRepository.revokeSession(session.id, 'admin');
      throw ApiError.unauthenticated('Please sign in again.');
    }

    const nextRefresh = randomToken(48);
    const jti = crypto.randomUUID();
    await shopAuthRepository.rotateSession({
      id: session.id,
      refreshTokenHash: hashToken(nextRefresh),
      accessJti: jti,
    });

    return {
      access_token: signAccessToken(customer.id, session.id, jti),
      refresh_token: nextRefresh,
      token_type: 'Bearer' as const,
      expires_in: ACCESS_TTL_MINUTES * 60,
      customer: publicCustomer(customer),
    };
  },

  async logout(sessionId: number): Promise<void> {
    await shopAuthRepository.revokeSession(sessionId, 'logout');
  },

  async me(customerId: number) {
    const customer = await shopAuthRepository.findCustomerById(customerId);
    if (!customer) throw ApiError.unauthenticated('Please sign in again.');
    return { customer: publicCustomer(customer) };
  },

  /** The opt-in, asked for and withdrawable from the account area. */
  async setWhatsappMarketing(
    customerId: number,
    granted: boolean,
    meta: { ip: string | null; userAgent: string | null; source: string },
  ) {
    const customer = await shopAuthRepository.findCustomerById(customerId);
    if (!customer) throw ApiError.unauthenticated('Please sign in again.');

    await messagingService.setMarketingConsent({
      customerId,
      subjectIdentifier: `${customer.country_code}${customer.phone}`,
      channel: 'whatsapp',
      granted,
      source: meta.source,
      ip: meta.ip,
      userAgent: meta.userAgent,
      evidence: { asked: 'storefront opt-in control', granted },
    });

    return { accepts_whatsapp_marketing: granted };
  },
};

export { publicCustomer, OTP_TTL_SECONDS, SESSION_TTL_DAYS };
