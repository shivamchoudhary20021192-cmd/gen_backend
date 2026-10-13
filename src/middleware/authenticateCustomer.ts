import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../core/ApiError';
import { shopAuthRepository } from '../modules/shop-auth/shopAuth.repository';
import { verifyCustomerAccessToken } from '../modules/shop-auth/shopAuth.service';

/**
 * Who, if anyone, is signed in on the storefront.
 *
 * Deliberately separate from the admin `authenticate`. The two token families
 * have different issuers and different `typ` claims, so an admin token cannot be
 * presented to a shop route or the other way round — and keeping the middleware
 * apart means neither can be mistaken for the other when a route is added.
 */

export interface SignedInCustomer {
  id: number;
  sessionId: number;
}

export type CustomerRequest = Request & { customer: SignedInCustomer };

async function resolve(req: Request): Promise<SignedInCustomer | null> {
  const header = req.header('Authorization');
  if (!header?.startsWith('Bearer ')) return null;

  let payload;
  try {
    payload = verifyCustomerAccessToken(header.slice(7).trim());
  } catch {
    return null;
  }

  const sessionId = Number(payload.sid);
  const session = await shopAuthRepository.findSession(sessionId);
  // The session is checked on every request rather than trusting the token
  // alone, so signing out — or an admin blocking someone — takes effect at once
  // instead of when the access token happens to expire.
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() < Date.now()) return null;
  if (session.customer_id !== Number(payload.sub)) return null;

  return { id: session.customer_id, sessionId };
}

/**
 * Attaches the customer when there is one, and lets the request through when
 * there is not.
 *
 * Most of the storefront works signed out — browsing, the bag, guest checkout —
 * so the common case is a route that behaves slightly differently for a known
 * customer rather than one that refuses strangers.
 */
export async function withCustomer(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const customer = await resolve(req);
    if (customer) req.customer = customer;
    next();
  } catch (error) {
    next(error);
  }
}

/** For the routes that genuinely need to know who is asking. */
export async function requireCustomer(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const customer = await resolve(req);
    if (!customer) {
      next(ApiError.unauthenticated('Please sign in to do that.'));
      return;
    }
    req.customer = customer;
    next();
  } catch (error) {
    next(error);
  }
}
