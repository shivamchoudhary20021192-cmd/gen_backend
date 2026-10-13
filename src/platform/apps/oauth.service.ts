import crypto from 'node:crypto';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { hashToken } from '../../core/crypto';
import { authRepository } from '../../modules/auth/auth.repository';
import type { AuthenticatedAdmin } from '../../modules/auth/auth.types';
import { entitlements } from '../plans/entitlements';
import { shopDirectory } from '../shops/shopDirectory';
import { tenancy } from '../tenancy/context';
import { appsRepository, jsonList, type AppRow } from './apps.repository';
import { appsService, clientSecretOf, presentApp, verifyClientSecret } from './apps.service';
import { describeScopes, normaliseScopes } from './scopes';

/**
 * OAuth 2.0 authorization-code grant, shaped like Shopify's app install.
 *
 *   1. The app sends the merchant to the admin's consent screen with
 *      client_id, scope, redirect_uri and state.
 *   2. The admin shows `preview()` — who is asking, for what — and on approval
 *      calls `approve()`, which returns where to send the browser: the app's
 *      redirect_uri with a single-use code, the shop, the state, and an HMAC so
 *      the app can tell the redirect really came from us.
 *   3. The app's server exchanges code + client secret at /oauth/access_token
 *      for an offline Admin API token.
 *
 * The code lives ten minutes, works once, and only for the app it was issued
 * to. The redirect_uri must match one the app registered, character for
 * character: a lookalike URI is how codes get stolen.
 */

const CODE_TTL_MS = 10 * 60_000;

/** RFC 6749 §5.2 error, rendered as `{ error, error_description }`. */
export class OAuthError extends Error {
  constructor(
    readonly error: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unauthorized_client' | 'invalid_scope',
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = 'OAuthError';
  }
}

/** Sorted `key=value&…` of every parameter except the signature itself. */
export function oauthSignature(params: Record<string, string>, secret: string): string {
  const message = Object.keys(params)
    .filter((key) => key !== 'hmac' && key !== 'signature')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

interface AuthorizeRequest {
  client_id: string;
  scope?: string;
  redirect_uri: string;
  state?: string;
}

async function validate(request: AuthorizeRequest, principal: AuthenticatedAdmin): Promise<{ app: AppRow; scopes: string[] }> {
  if (principal.kind !== 'staff') throw ApiError.forbidden('Only a person can grant an app access to a store.');

  const app = await appsRepository.findByClientId(request.client_id);
  if (!app) throw ApiError.notFound('App');

  if (app.distribution === 'custom' && Number(app.owner_shop_id) !== principal.shop.id) {
    // A custom app exists for one shop. Anywhere else, it does not exist.
    throw ApiError.notFound('App');
  }
  if (app.distribution === 'public' && app.status !== 'published' && principal.platformRole !== 'admin') {
    throw ApiError.forbidden('This app is not available for installation yet.');
  }

  if (!jsonList(app.redirect_urls).includes(request.redirect_uri)) {
    throw ApiError.validation({ redirect_uri: ['This redirect URI is not registered for the app.'] });
  }

  const { scopes, unknown } = normaliseScopes(request.scope ?? jsonList(app.requested_scopes));
  if (unknown.length > 0) throw ApiError.validation({ scope: [`Unknown scope(s): ${unknown.join(', ')}`] });
  return { app, scopes };
}

export const oauthService = {
  async preview(request: AuthorizeRequest, principal: AuthenticatedAdmin) {
    const { app, scopes } = await validate(request, principal);
    const installation = await appsRepository.findInstallation(app.id);
    const shop = principal.shop;
    return {
      app: presentApp(app),
      requested_scopes: describeScopes(scopes),
      already_granted: installation?.status === 'active' ? describeScopes(jsonList(installation.granted_scopes)) : [],
      redirect_uri: request.redirect_uri,
      shop: { id: shop.publicId, name: shop.name, domain: `${shop.handle}.${env.platform.storefrontDomain}` },
    };
  },

  async approve(request: AuthorizeRequest, principal: AuthenticatedAdmin): Promise<{ redirect_to: string }> {
    const { app, scopes } = await validate(request, principal);
    const shop = principal.shop;

    const existing = await appsRepository.findInstallation(app.id);
    if (!existing || existing.status !== 'active') {
      // Refuse before the round trip, not after the app has done its half.
      await entitlements.assertWithinLimit('installed_apps', await appsRepository.countActiveInstallations());
    }

    const code = crypto.randomBytes(32).toString('hex');
    await appsRepository.insertCode({
      hash: hashToken(code),
      appId: app.id,
      shopId: shop.id,
      adminUserId: principal.id,
      scopes,
      redirectUri: request.redirect_uri,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });

    const params: Record<string, string> = {
      code,
      shop: `${shop.handle}.${env.platform.storefrontDomain}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    if (request.state) params.state = request.state;
    params.hmac = oauthSignature(params, clientSecretOf(app));

    const target = new URL(request.redirect_uri);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    return { redirect_to: target.toString() };
  },

  /** The app's server trades the code for an offline token. */
  async exchange(input: { client_id?: string; client_secret?: string; code?: string }) {
    if (!input.client_id || !input.client_secret || !input.code) {
      throw new OAuthError('invalid_request', 'client_id, client_secret and code are all required.');
    }
    const app = await appsRepository.findByClientId(input.client_id);
    if (!app || !verifyClientSecret(app, input.client_secret)) {
      throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    }

    const code = await appsRepository.consumeCode(hashToken(input.code));
    if (!code || Number(code.app_id) !== Number(app.id)) {
      throw new OAuthError('invalid_grant', 'The authorization code is invalid, expired, or already used.');
    }

    const shop = await shopDirectory.byId(Number(code.shop_id));
    if (!shop || shop.status === 'closed') throw new OAuthError('invalid_grant', 'The store is no longer available.');

    return tenancy.run(shop, async () => {
      const scopes = jsonList(code.scopes);
      const approver = await authRepository.findById(Number(code.admin_user_id));
      const installationId = await appsService.install(app, scopes, {
        id: Number(code.admin_user_id),
        email: approver?.email ?? `staff #${code.admin_user_id}`,
      });
      const accessToken = await appsService.issueAccessToken(app, installationId, scopes);
      return {
        access_token: accessToken,
        scope: scopes.join(','),
        shop: { id: shop.publicId, domain: `${shop.handle}.${env.platform.storefrontDomain}`, name: shop.name },
      };
    });
  },
};
