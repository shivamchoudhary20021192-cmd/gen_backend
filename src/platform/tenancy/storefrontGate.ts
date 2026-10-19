import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { asyncHandler } from '../../core/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { shopsRepository } from '../shops/shops.repository';
import { tenancy } from './context';
import { brandService } from '../shops/brand';

/**
 * The "opening soon" password page.
 *
 * While a shop is locked, anonymous storefront requests need the store
 * password: the storefront posts it to /storefront/unlock, gets a short-lived
 * signed token, and sends it back as `X-Veylog-Storefront-Unlock`. The token
 * binds the shop and a fragment of the current password hash, so changing the
 * password logs every visitor out of the preview.
 *
 * Headless storefronts using a storefront access token, the theme and shop
 * info the password page itself needs, and gateway callbacks are never gated.
 */

export const TOKEN_TTL_MS = 7 * 24 * 3_600_000;
// The newsletter too: an "opening soon" page is where a store collects its first emails.
// A page preview link is its own secret, like a theme preview link: it is how
// a draft gets reviewed while the store is still behind its password.
const OPEN_PATHS = [
  /^\/storefront\/(unlock|shop)$/,
  /^\/theme$/,
  /^\/payments\/razorpay\/webhook$/,
  /^\/newsletter\/(subscribe|unsubscribe)$/,
  /^\/content\/pages\/preview\/[0-9a-f-]{36}$/,
];

function sign(shopId: number, expiresAt: number, hashFragment: string): string {
  return crypto
    .createHmac('sha256', `${env.auth.jwtSecret}:storefront-unlock`)
    .update(`${shopId}.${expiresAt}.${hashFragment}`)
    .digest('base64url');
}

/** Also the Online Store's password-page cookie. */
export function issueStorefrontUnlock(shopId: number, passwordHash: string): string {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const fragment = passwordHash.slice(-16);
  return Buffer.from(`${shopId}.${expiresAt}.${sign(shopId, expiresAt, fragment)}`).toString('base64url');
}

export function isValidStorefrontUnlock(token: string, shopId: number, passwordHash: string): boolean {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  const [id, expires, signature] = decoded.split('.');
  if (Number(id) !== shopId || !signature || Number(expires) < Date.now()) return false;
  const expected = sign(shopId, Number(expires), passwordHash.slice(-16));
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Mounted after the storefront shop resolver. */
export async function storefrontGate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const shop = tenancy.currentOrNull();
    if (!shop?.storefrontLocked) return next();
    if (req.header('X-Veylog-Storefront-Access-Token')) return next();
    if (OPEN_PATHS.some((pattern) => pattern.test(req.path))) return next();

    const token = req.header('X-Veylog-Storefront-Unlock');
    const row = await shopsRepository.byId(shop.id);
    if (token && row?.storefront_password_hash && isValidStorefrontUnlock(token, shop.id, row.storefront_password_hash)) return next();
    next(new ApiError(401, 'UNAUTHENTICATED', 'This store is password protected.', { storefront_locked: true }));
  } catch (error) {
    next(error);
  }
}

export const storefrontGateRoutes = Router();

/** What the password page (and any storefront shell) needs before it can render. */
storefrontGateRoutes.get(
  '/storefront/shop',
  asyncHandler(async (_req: Request, res: Response) => {
    const shop = tenancy.current();
    const [brand, contact] = await Promise.all([
      brandService.storefront(),
      shopsRepository.byId(shop.id).then((row) => ({ email: row?.email ?? null, phone: row?.phone ?? null })),
    ]);
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({
      // How the store presents itself, for the header, footer and page titles.
      brand,
      contact,
      shop: {
        name: shop.name,
        handle: shop.handle,
        currency: shop.currency,
        locale: shop.locale,
        country_code: shop.countryCode,
        timezone: shop.timezone,
        status: shop.status,
        locked: shop.storefrontLocked,
        accepting_orders: shop.status === 'active',
        primary_domain: shop.primaryDomain,
        vertical: shop.vertical,
      },
    });
  }),
);

storefrontGateRoutes.post(
  '/storefront/unlock',
  rateLimit({ bucket: 'storefront.unlock', max: 10, windowSeconds: 300, blockSeconds: 900 }),
  validate({ body: z.object({ password: z.string().min(1).max(100) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const shop = tenancy.current();
    const row = await shopsRepository.byId(shop.id);
    if (!row?.storefront_password_enabled || !row.storefront_password_hash) {
      res.json({ unlocked: true, token: null });
      return;
    }
    const ok = await bcrypt.compare(String(req.body.password), row.storefront_password_hash);
    if (!ok) throw ApiError.unauthenticated('That password is not right.');
    res.json({ unlocked: true, token: issueStorefrontUnlock(shop.id, row.storefront_password_hash), expires_in: TOKEN_TTL_MS / 1000 });
  }),
);
