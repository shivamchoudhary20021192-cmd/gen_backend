import crypto from 'node:crypto';
import { env } from '../../config/env';

/**
 * Signed links for looking at a theme that is not live.
 *
 *   preview  — "Preview" in Online Store → Themes: a shareable link that shows
 *              an unpublished theme (14 days, like Shopify's preview links).
 *   design   — the theme editor's frame: the theme with unsaved changes laid
 *              over it, and the editor's outlines and events (24 hours).
 *
 * Either lets the holder past the store's password page, which is what the
 * merchant needs while building a store nobody else can see yet.
 */

export interface PreviewGrant {
  shopId: number;
  themeId: string;
  design: boolean;
  exp: number;
}

const secret = () => `${env.auth.jwtSecret}:theme-preview`;

export function signPreview(grant: Omit<PreviewGrant, 'exp'>, ttlSeconds = grant.design ? 86_400 : 14 * 86_400): string {
  const payload = Buffer.from(JSON.stringify({ ...grant, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyPreview(token: string | undefined | null, shopId: number): PreviewGrant | null {
  if (!token || token.length > 600) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PreviewGrant;
    if (grant.shopId !== shopId || grant.exp < Date.now() / 1000) return null;
    return grant;
  } catch {
    return null;
  }
}
