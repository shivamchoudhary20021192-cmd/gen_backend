import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { shopAuthRepository } from '../../modules/shop-auth/shopAuth.repository';
import { SESSION_TTL_DAYS } from '../../modules/shop-auth/shopAuth.service';
import { cookies, setCookie } from './storefrontHttp';

/**
 * The shopper's sign-in on the Online Store: a cookie, not a bearer token.
 *
 * Signing in is the same phone-code flow the Storefront API uses (the same
 * `customer_sessions` row, the same throttles); only the credential differs.
 * The API hands a single-page app an access/refresh pair it rotates. A
 * server-rendered store has several tabs and parallel requests sharing one
 * cookie jar, where rotating a refresh token would look like a replay and sign
 * the shopper out everywhere — so the cookie carries the session id itself,
 * signed, and every request checks that session is still live. Signing out,
 * or an admin blocking the customer, therefore takes effect on the next page.
 *
 * A second short-lived cookie carries a sign-in in progress (the code request,
 * the page to return to, and on sign-up the name and email typed), so the code
 * form needs no hidden fields a shopper could tamper with.
 */

const SESSION_COOKIE = '_veylog_customer';
const PENDING_COOKIE = '_veylog_login';
const ISSUER = 'veylor-shop-web';
const PENDING_TTL_SECONDS = 15 * 60;

interface SessionClaims {
  sub: string;
  sid: string;
  shop: number;
  typ: 'customer_web';
}

export interface PendingLogin {
  requestId: string;
  sentTo: string;
  channel: 'sms' | 'whatsapp';
  phone: string;
  returnTo: string;
  resendAt: number;
  /** From the register form: applied to the account once the code checks out. */
  profile?: { first_name?: string | null; last_name?: string | null; email?: string | null; accepts_marketing?: boolean };
}

function secret(purpose: string): string {
  return crypto.createHash('sha256').update(`${env.auth.jwtSecret}:${purpose}`).digest('hex');
}

export const customerSession = {
  /** Signs the shopper in on this browser. */
  start(res: Response, shopId: number, customerId: number, sessionId: number): void {
    const claims: SessionClaims = { sub: String(customerId), sid: String(sessionId), shop: shopId, typ: 'customer_web' };
    const token = jwt.sign(claims, secret('customer-web'), { issuer: ISSUER, expiresIn: `${SESSION_TTL_DAYS}d` });
    setCookie(res, SESSION_COOKIE, token, SESSION_TTL_DAYS * 86_400);
  },

  clear(res: Response): void {
    setCookie(res, SESSION_COOKIE, '', 0);
  },

  /** The signed-in customer, if the cookie is valid for this shop and its session is still live. */
  async current(req: Request, shopId: number): Promise<{ customerId: number; sessionId: number } | null> {
    const token = cookies(req)[SESSION_COOKIE];
    if (!token) return null;
    let claims: SessionClaims;
    try {
      claims = jwt.verify(token, secret('customer-web'), { issuer: ISSUER }) as SessionClaims;
    } catch {
      return null;
    }
    // A cookie is per host, but a shop's custom domain and platform domain are both
    // its own — the claim keeps a cookie minted for one shop from working on another.
    if (claims.typ !== 'customer_web' || claims.shop !== shopId) return null;
    const session = await shopAuthRepository.findSession(Number(claims.sid));
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) return null;
    if (session.customer_id !== Number(claims.sub)) return null;
    return { customerId: session.customer_id, sessionId: session.id };
  },

  // ── a sign-in in progress ───────────────────────────────────────────────

  setPending(res: Response, pending: PendingLogin): void {
    const token = jwt.sign({ ...pending, typ: 'customer_login' }, secret('customer-login'), { issuer: ISSUER, expiresIn: PENDING_TTL_SECONDS });
    setCookie(res, PENDING_COOKIE, token, PENDING_TTL_SECONDS);
  },

  pending(req: Request): PendingLogin | null {
    const token = cookies(req)[PENDING_COOKIE];
    if (!token) return null;
    try {
      const claims = jwt.verify(token, secret('customer-login'), { issuer: ISSUER }) as PendingLogin & { typ?: string };
      return claims.typ === 'customer_login' ? claims : null;
    } catch {
      return null;
    }
  },

  clearPending(res: Response): void {
    setCookie(res, PENDING_COOKIE, '', 0);
  },
};
