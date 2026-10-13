import { themeExtensions } from './themeExtensions';
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { hashToken, safeEqual } from '../../core/crypto';
import { slugify } from '../../core/slug';
import { auditService } from '../../shared/audit.service';
import { eventBus } from '../events/eventBus';
import { jobQueue } from '../jobs/queue';
import { defineJob } from '../jobs/registry';
import { entitlements } from '../plans/entitlements';
import { vault } from '../security/vault';
import { tenancy, type ShopContext } from '../tenancy/context';
import { STOREFRONT_TOKEN_PREFIX, storefrontTokenResolver } from '../tenancy/storefrontTokens';
import { webhooksRepository } from '../webhooks/webhooks.repository';
import { appsRepository, jsonList, type AppRow, type InstallationRow } from './apps.repository';
import { appTokenCache } from './appAuth';
import { describeScopes, normaliseScopes } from './scopes';

/**
 * Apps: registering them, installing them, and removing them cleanly.
 *
 * Secrets are shown exactly once — the client secret when an app is created,
 * an access token when it is issued — and kept only sealed (client secret) or
 * hashed (tokens). A merchant who loses one rotates it; nobody can read it back.
 */

export const ACCESS_TOKEN_PREFIX = 'vlat_';
const CLIENT_SECRET_PREFIX = 'vlss_';

interface Actor {
  id: number;
  email: string;
}

export function clientSecretOf(app: AppRow): string {
  return vault.open(app.client_secret_ciphertext, `app:${app.public_id}`);
}

export function verifyClientSecret(app: AppRow, presented: string): boolean {
  return safeEqual(clientSecretOf(app), presented);
}

function newClientSecret(): string {
  return `${CLIENT_SECRET_PREFIX}${randomBytes(32).toString('hex')}`;
}

export function presentApp(app: AppRow) {
  return {
    id: app.public_id,
    client_id: app.client_id,
    handle: app.handle,
    name: app.name,
    tagline: app.tagline,
    description: app.description,
    icon_url: app.icon_url,
    developer_name: app.developer_name,
    support_url: app.support_url,
    privacy_policy_url: app.privacy_policy_url,
    app_url: app.app_url,
    distribution: app.distribution,
    status: app.status,
    requested_scopes: describeScopes(jsonList(app.requested_scopes)),
    redirect_urls: jsonList(app.redirect_urls),
    compliance_webhook_url: app.compliance_webhook_url,
    client_secret_hint: app.client_secret_hint,
    webhook_api_version: app.webhook_api_version,
    created_at: app.created_at.toISOString(),
  };
}

function presentInstallation(installation: InstallationRow, app: AppRow | undefined) {
  return {
    id: installation.id,
    app: app
      ? { id: app.public_id, handle: app.handle, name: app.name, icon_url: app.icon_url, app_url: app.app_url, distribution: app.distribution }
      : null,
    granted_scopes: describeScopes(jsonList(installation.granted_scopes)),
    status: installation.status,
    installed_at: installation.installed_at.toISOString(),
  };
}

export interface RegisterAppInput {
  name: string;
  handle?: string;
  tagline?: string | null;
  description?: string | null;
  icon_url?: string | null;
  developer_name?: string | null;
  developer_email?: string | null;
  support_url?: string | null;
  privacy_policy_url?: string | null;
  app_url?: string | null;
  compliance_webhook_url?: string | null;
  redirect_urls: string[];
  requested_scopes: string[];
}

async function uniqueHandle(desired: string): Promise<string> {
  const base = slugify(desired).slice(0, 60) || 'app';
  let candidate = base;
  for (let n = 2; await appsRepository.handleTaken(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

export const appsService = {
  /**
   * Registers an app. Public apps are registered by the platform (and later
   * published); custom apps by a shop, for itself. Returns the client secret
   * once.
   */
  async register(
    input: RegisterAppInput,
    options: { distribution: 'public' | 'custom'; ownerShopId: number | null; actor: Actor },
  ): Promise<{ app: ReturnType<typeof presentApp>; client_secret: string }> {
    const { scopes, unknown } = normaliseScopes(input.requested_scopes);
    if (unknown.length > 0) throw ApiError.validation({ requested_scopes: [`Unknown scope(s): ${unknown.join(', ')}`] });

    const handle = await uniqueHandle(input.handle ?? input.name);
    const clientId = randomBytes(16).toString('hex');
    const secret = newClientSecret();
    const botId = await appsRepository.createBotIdentity(handle, input.name, env.platform.storefrontDomain);

    // The vault's associated data is the app's public id, which is only known
    // once the row exists — so it is sealed in two steps.
    const id = await appsRepository.insertApp({
      clientId,
      clientSecretCiphertext: 'pending',
      clientSecretHint: vault.hint(secret),
      handle,
      name: input.name,
      tagline: input.tagline ?? null,
      description: input.description ?? null,
      iconUrl: input.icon_url ?? null,
      developerName: input.developer_name ?? null,
      developerEmail: input.developer_email ?? null,
      supportUrl: input.support_url ?? null,
      privacyPolicyUrl: input.privacy_policy_url ?? null,
      appUrl: input.app_url ?? null,
      complianceWebhookUrl: input.compliance_webhook_url ?? null,
      redirectUrls: input.redirect_urls,
      requestedScopes: scopes,
      distribution: options.distribution,
      ownerShopId: options.ownerShopId,
      status: options.distribution === 'custom' ? 'published' : 'draft',
      botAdminUserId: botId,
      createdByAdminId: options.actor.id,
    });
    const app = (await appsRepository.findById(id))!;
    await appsRepository.updateApp(id, { client_secret_ciphertext: vault.seal(secret, `app:${app.public_id}`) });

    return { app: presentApp((await appsRepository.findById(id))!), client_secret: secret };
  },

  async rotateClientSecret(app: AppRow): Promise<{ client_secret: string }> {
    const secret = newClientSecret();
    await appsRepository.updateApp(app.id, {
      client_secret_ciphertext: vault.seal(secret, `app:${app.public_id}`),
      client_secret_hint: vault.hint(secret),
    });
    return { client_secret: secret };
  },

  /** Public apps a merchant can install, marked with whether this shop has. */
  async catalog() {
    const [apps, installations] = await Promise.all([appsRepository.listPublished(), appsRepository.listInstallations()]);
    const installed = new Set(installations.map((installation) => Number(installation.app_id)));
    return apps.map((app) => ({ ...presentApp(app), installed: installed.has(Number(app.id)) }));
  },

  async installations() {
    const installations = await appsRepository.listInstallations();
    const apps = await appsRepository.findManyByIds(installations.map((installation) => Number(installation.app_id)));
    const byId = new Map(apps.map((app) => [Number(app.id), app]));
    return installations.map((installation) => presentInstallation(installation, byId.get(Number(installation.app_id))));
  },

  /**
   * Installs (or re-grants) an app in the current shop. Enforces the plan's
   * app limit only for a NEW installation — changing an existing app's scopes
   * does not count again.
   */
  async install(app: AppRow, scopes: string[], actor: Actor | null): Promise<number> {
    const existing = await appsRepository.findInstallation(app.id);
    if (!existing || existing.status !== 'active') {
      await entitlements.assertWithinLimit('installed_apps', await appsRepository.countActiveInstallations());
    }
    const installationId = await appsRepository.upsertInstallation(app.id, scopes, actor?.id ?? null);
    // Its theme blocks start showing on the storefront now, not when a cache expires.
    themeExtensions.clearCache();
    await auditService.log({
      actorId: actor?.id ?? null,
      actorLabel: actor?.email ?? null,
      action: existing?.status === 'active' ? 'app.scopes_changed' : 'app.installed',
      entityType: 'app',
      entityId: app.id,
      summary: `${app.name} ${existing?.status === 'active' ? 'was granted' : 'was installed with'} ${scopes.join(', ') || 'no scopes'}`,
      context: { installation_id: installationId, scopes },
    });
    return installationId;
  },

  /** Issues a new offline token and revokes the installation's previous ones. */
  async issueAccessToken(app: AppRow, installationId: number, scopes: string[]): Promise<string> {
    const shop = tenancy.current();
    const token = `${ACCESS_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
    await appsRepository.revokeAccessTokens(shop.id, installationId, 'rotated');
    appTokenCache.clear();
    await appsRepository.insertAccessToken({
      shopId: shop.id,
      appId: app.id,
      installationId,
      hash: hashToken(token),
      hint: token.slice(-6),
      scopes,
    });
    return token;
  },

  /**
   * Removes an app from the current shop.
   *
   * Tokens die at once. Webhook subscriptions are disabled — except the
   * app/uninstalled one, which has to survive long enough to tell the app it
   * was removed. A cleanup job deletes them all once that delivery has had
   * its full retry window.
   */
  async uninstall(installationId: number, actor: Actor | null, reason = 'uninstalled'): Promise<void> {
    const shop = tenancy.current();
    const installation = await appsRepository.findInstallationById(installationId);
    if (!installation || installation.status !== 'active') throw ApiError.notFound('App installation');
    const app = await appsRepository.findById(Number(installation.app_id));

    await appsRepository.markUninstalled(installationId);
    themeExtensions.clearCache();
    await appsRepository.revokeAccessTokens(shop.id, installationId, reason);
    appTokenCache.clear();
    await webhooksRepository.disableForApp(Number(installation.app_id), 'The app was uninstalled.', 'app/uninstalled');

    await eventBus.publish(
      'app/uninstalled',
      { app_id: app?.public_id ?? null, shop_id: shop.publicId, shop_domain: shop.primaryDomain, reason },
      { onlyAppId: Number(installation.app_id), actorType: actor ? 'admin' : 'app', actorId: actor?.id ?? null },
    );
    await jobQueue.enqueue(
      'apps.cleanup_uninstalled',
      { app_id: Number(installation.app_id) },
      { delayMs: 49 * 3600_000, uniqueKey: `apps.cleanup:${shop.id}:${installationId}:${Date.now()}` },
    );

    await auditService.log({
      actorId: actor?.id ?? null,
      actorLabel: actor?.email ?? app?.name ?? null,
      action: 'app.uninstalled',
      entityType: 'app',
      entityId: Number(installation.app_id),
      summary: `${app?.name ?? 'An app'} was uninstalled`,
      context: { installation_id: installationId, reason },
    });
  },

  /**
   * A custom app: built by this shop, for this shop. Installed immediately;
   * the Admin API token and client secret are returned once.
   */
  async createCustomApp(
    shop: ShopContext,
    input: { name: string; scopes: string[]; webhook_api_version?: string },
    actor: Actor,
  ): Promise<{ app: ReturnType<typeof presentApp>; access_token: string; client_secret: string }> {
    await entitlements.assertFeature('api_access');
    const registered = await this.register(
      { name: input.name, redirect_urls: [], requested_scopes: input.scopes },
      { distribution: 'custom', ownerShopId: shop.id, actor },
    );
    const app = (await appsRepository.findByPublicId(registered.app.id))!;
    const scopes = jsonList(app.requested_scopes);
    const installationId = await this.install(app, scopes, actor);
    const accessToken = await this.issueAccessToken(app, installationId, scopes);
    return { app: registered.app, access_token: accessToken, client_secret: registered.client_secret };
  },

  async createStorefrontToken(title: string, actor: Actor, appId: number | null = null) {
    const shop = tenancy.current();
    const token = `${STOREFRONT_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
    const id = await appsRepository.insertStorefrontToken({
      shopId: shop.id,
      appId,
      title,
      hash: hashToken(token),
      hint: token.slice(-6),
      adminId: actor.id,
    });
    return { id, title, access_token: token };
  },

  async listStorefrontTokens() {
    const rows = await appsRepository.listStorefrontTokens(tenancy.current().id);
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      token_hint: `…${row.token_hint}`,
      last_used_at: row.last_used_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
    }));
  },

  async revokeStorefrontToken(id: number): Promise<void> {
    const revoked = await appsRepository.revokeStorefrontToken(tenancy.current().id, id);
    if (!revoked) throw ApiError.notFound('Storefront access token');
    storefrontTokenResolver.forget();
  },
};

defineJob<{ app_id: number }>({
  type: 'apps.cleanup_uninstalled',
  shopScoped: true,
  maxAttempts: 3,
  async handler(payload) {
    const installation = await appsRepository.findInstallation(payload.app_id);
    // Re-installed in the meantime: its subscriptions are live again.
    if (installation?.status === 'active') return;
    await webhooksRepository.deleteForApp(payload.app_id);
  },
});
