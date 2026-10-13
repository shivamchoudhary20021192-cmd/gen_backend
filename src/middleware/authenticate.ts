import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../core/ApiError';
import { consumeApiCall } from '../platform/apps/apiCallLimit';
import { appAuthenticator, extractAppToken } from '../platform/apps/appAuth';
import { tenancy } from '../platform/tenancy/context';
import { authService } from '../modules/auth/auth.service';
import type { AuthenticatedAdmin, AuthenticatedIdentity } from '../modules/auth/auth.types';

/**
 * A request that has already been through `authenticate`.
 *
 * `Express.Request` declares `admin` optional, because most of the tree is
 * public. A handler mounted behind this middleware is past that question, and
 * saying so in the type is better than a `!` on every line that reads it.
 */
export type AuthRequest = Request & { admin: AuthenticatedAdmin };

/** Behind `authenticateIdentity`: a signed-in person, shop not required. */
export type IdentityRequest = Request & { identity: AuthenticatedIdentity };

function bearer(req: Request): string {
  const header = req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw ApiError.unauthenticated('A Bearer access token is required.');
  }
  const token = header.slice(7).trim();
  if (!token) throw ApiError.unauthenticated('A Bearer access token is required.');
  return token;
}

async function resolve(req: Request, res: Response, requireShop: boolean): Promise<void> {
  // An installed app, presenting its offline access token. Apps are metered:
  // a leaky bucket per shop and app, sized by the shop's plan.
  const appToken = extractAppToken(req);
  if (appToken) {
    const admin = await appAuthenticator.resolve(appToken, req);
    // Once per request, however many routers on the path authenticate it.
    if (admin.app && !req.apiCallMetered) {
      await consumeApiCall(admin.shop, admin.app.appId, res);
      req.apiCallMetered = true;
    }
    req.admin = admin;
    req.shop = admin.shop;
    return;
  }

  const { admin, identity, sessionId, shop } = await authService.resolveFromAccessToken(bearer(req), {
    requestedShop: req.header('X-Veylog-Shop') ?? null,
    method: req.method,
    // The full path: inside a router, req.path is relative to its mount
    // ("/payment-method" under /billing), and the frozen-store allowance for
    // Billing matches on the section.
    path: `${req.baseUrl}${req.path}`,
  });

  req.identity = {
    id: identity.id,
    publicId: identity.public_id,
    email: identity.email,
    firstName: identity.first_name,
    lastName: identity.last_name,
    platformRole: identity.platform_role ?? 'none',
    sessionId,
    activeShopId: shop?.id ?? null,
  };

  if (admin && shop) {
    req.admin = admin;
    req.shop = shop;
    return;
  }

  if (requireShop) {
    throw new ApiError(
      409,
      'SHOP_REQUIRED',
      'You are not a member of any shop yet. Create a shop, or ask a shop owner to invite you.',
    );
  }
}

function runInShop(req: Request, next: NextFunction): void {
  if (req.shop) tenancy.run(req.shop, () => next());
  else next();
}

/**
 * Staff token or app token → req.admin + req.shop, and the rest of the request
 * runs as that shop. Throws 401 rather than silently continuing, so a route
 * that forgets `requirePermission` still cannot be reached anonymously.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    await resolve(req, res, true);
    runInShop(req, next);
  } catch (error) {
    next(error);
  }
}

/**
 * For the few routes about the person rather than a shop — which shops am I
 * in, switch shop, sign out, open a new shop. Sets req.identity always, and
 * req.admin/req.shop when the person has a shop to act in.
 */
export async function authenticateIdentity(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (extractAppToken(req)) throw ApiError.forbidden('App access tokens cannot manage staff sessions.');
    await resolve(req, res, false);
    runInShop(req, next);
  } catch (error) {
    next(error);
  }
}
