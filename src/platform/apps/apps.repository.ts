import { randomUUID } from 'node:crypto';
import { controlPlane, execute, insert, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../tenancy/context';

/**
 * Apps live in the control plane (an OAuth request names the app by client id
 * before any shop is known); installations are shop data. Tokens and codes are
 * control plane too — presenting one is how a request tells us its shop.
 */

export interface AppRow extends RowDataPacket {
  id: number;
  public_id: string;
  client_id: string;
  client_secret_ciphertext: string;
  client_secret_hint: string;
  handle: string;
  name: string;
  tagline: string | null;
  description: string | null;
  icon_url: string | null;
  developer_name: string | null;
  developer_email: string | null;
  support_url: string | null;
  privacy_policy_url: string | null;
  app_url: string | null;
  compliance_webhook_url: string | null;
  redirect_urls: unknown;
  requested_scopes: unknown;
  distribution: 'public' | 'custom';
  owner_shop_id: number | null;
  status: 'draft' | 'published' | 'delisted';
  webhook_api_version: string;
  bot_admin_user_id: number | null;
  created_by_admin_id: number | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface InstallationRow extends RowDataPacket {
  id: number;
  shop_id: number;
  app_id: number;
  granted_scopes: unknown;
  status: 'active' | 'uninstalled';
  installed_by_admin_id: number | null;
  installed_at: Date;
  uninstalled_at: Date | null;
}

export interface AccessTokenRow extends RowDataPacket {
  id: number;
  shop_id: number;
  app_id: number;
  installation_id: number;
  token_hint: string;
  scopes: unknown;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export interface OAuthCodeRow extends RowDataPacket {
  id: number;
  app_id: number;
  shop_id: number;
  admin_user_id: number;
  scopes: unknown;
  redirect_uri: string;
}

export interface StorefrontTokenRow extends RowDataPacket {
  id: number;
  shop_id: number;
  app_id: number | null;
  title: string;
  token_hint: string;
  created_by_admin_id: number | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export function jsonList(value: unknown): string[] {
  if (!value) return [];
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export interface NewApp {
  clientId: string;
  clientSecretCiphertext: string;
  clientSecretHint: string;
  handle: string;
  name: string;
  tagline: string | null;
  description: string | null;
  iconUrl: string | null;
  developerName: string | null;
  developerEmail: string | null;
  supportUrl: string | null;
  privacyPolicyUrl: string | null;
  appUrl: string | null;
  complianceWebhookUrl: string | null;
  redirectUrls: string[];
  requestedScopes: string[];
  distribution: 'public' | 'custom';
  ownerShopId: number | null;
  status: 'draft' | 'published';
  botAdminUserId: number | null;
  createdByAdminId: number | null;
}

export const appsRepository = {
  // ── apps (control plane) ──────────────────────────────────────────────────
  async findById(id: number, exec: Executor = controlPlane): Promise<AppRow | null> {
    return queryOne<AppRow>('SELECT * FROM apps WHERE id = ? AND deleted_at IS NULL', [id], exec);
  },

  async findByPublicId(publicId: string, exec: Executor = controlPlane): Promise<AppRow | null> {
    return queryOne<AppRow>('SELECT * FROM apps WHERE public_id = ? AND deleted_at IS NULL', [publicId], exec);
  },

  async findByClientId(clientId: string, exec: Executor = controlPlane): Promise<AppRow | null> {
    return queryOne<AppRow>('SELECT * FROM apps WHERE client_id = ? AND deleted_at IS NULL', [clientId], exec);
  },

  async handleTaken(handle: string, exec: Executor = controlPlane): Promise<boolean> {
    return (await queryOne<RowDataPacket>('SELECT id FROM apps WHERE handle = ?', [handle], exec)) !== null;
  },

  async listPublished(exec: Executor = controlPlane): Promise<AppRow[]> {
    return query<AppRow>(
      `SELECT * FROM apps WHERE distribution = 'public' AND status = 'published' AND deleted_at IS NULL ORDER BY name`,
      [],
      exec,
    );
  },

  async listAll(exec: Executor = controlPlane): Promise<AppRow[]> {
    return query<AppRow>('SELECT * FROM apps WHERE deleted_at IS NULL ORDER BY created_at DESC', [], exec);
  },

  async listCustomFor(ownerShopId: number, exec: Executor = controlPlane): Promise<AppRow[]> {
    return query<AppRow>(
      `SELECT * FROM apps WHERE distribution = 'custom' AND owner_shop_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
      [ownerShopId],
      exec,
    );
  },

  async findManyByIds(ids: number[], exec: Executor = controlPlane): Promise<AppRow[]> {
    if (ids.length === 0) return [];
    return query<AppRow>('SELECT * FROM apps WHERE id IN (?)', [ids], exec);
  },

  async insertApp(app: NewApp, exec: Executor = controlPlane): Promise<number> {
    return insert(
      `INSERT INTO apps
         (public_id, client_id, client_secret_ciphertext, client_secret_hint, handle, name, tagline, description,
          icon_url, developer_name, developer_email, support_url, privacy_policy_url, app_url, compliance_webhook_url,
          redirect_urls, requested_scopes, distribution, owner_shop_id, status, bot_admin_user_id, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        app.clientId,
        app.clientSecretCiphertext,
        app.clientSecretHint,
        app.handle,
        app.name,
        app.tagline,
        app.description,
        app.iconUrl,
        app.developerName,
        app.developerEmail,
        app.supportUrl,
        app.privacyPolicyUrl,
        app.appUrl,
        app.complianceWebhookUrl,
        JSON.stringify(app.redirectUrls),
        JSON.stringify(app.requestedScopes),
        app.distribution,
        app.ownerShopId,
        app.status,
        app.botAdminUserId,
        app.createdByAdminId,
      ],
      exec,
    );
  },

  async updateApp(id: number, fields: Record<string, unknown>, exec: Executor = controlPlane): Promise<void> {
    const allowed = [
      'name',
      'tagline',
      'description',
      'icon_url',
      'developer_name',
      'developer_email',
      'support_url',
      'privacy_policy_url',
      'app_url',
      'compliance_webhook_url',
      'redirect_urls',
      'requested_scopes',
      'status',
      'client_secret_ciphertext',
      'client_secret_hint',
    ];
    const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([key]) => `\`${key}\` = ?`).join(', ');
    const values = entries.map(([, value]) => (Array.isArray(value) ? JSON.stringify(value) : value));
    await execute(`UPDATE apps SET ${sets} WHERE id = ?`, [...values, id], exec);
  },

  async softDeleteApp(id: number, exec: Executor = controlPlane): Promise<void> {
    await execute("UPDATE apps SET deleted_at = NOW(), status = 'delisted' WHERE id = ?", [id], exec);
  },

  /** The identity an app's actions are attributed to. Cannot sign in: no password. */
  async createBotIdentity(handle: string, name: string, platformDomain: string, exec: Executor = controlPlane): Promise<number> {
    return insert(
      `INSERT INTO admin_users (public_id, email, first_name, last_name, status, account_type, is_super_admin)
       VALUES (?, ?, ?, 'App', 'active', 'app', 0)`,
      [randomUUID(), `app+${handle}@apps.${platformDomain}`, name.slice(0, 80)],
      exec,
    );
  },

  // ── installations (tenant) ────────────────────────────────────────────────
  async findInstallation(appId: number, exec?: Executor): Promise<InstallationRow | null> {
    return queryOne<InstallationRow>(
      'SELECT * FROM app_installations WHERE shop_id = ? AND app_id = ?',
      [shopId(), appId],
      exec,
    );
  },

  async findInstallationById(id: number, exec?: Executor): Promise<InstallationRow | null> {
    return queryOne<InstallationRow>('SELECT * FROM app_installations WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async listInstallations(exec?: Executor): Promise<InstallationRow[]> {
    return query<InstallationRow>(
      `SELECT * FROM app_installations WHERE shop_id = ? AND status = 'active' ORDER BY installed_at DESC`,
      [shopId()],
      exec,
    );
  },

  async countActiveInstallations(exec?: Executor): Promise<number> {
    const row = await queryOne<RowDataPacket>(
      `SELECT COUNT(*) AS n FROM app_installations WHERE shop_id = ? AND status = 'active'`,
      [shopId()],
      exec,
    );
    return Number(row?.n ?? 0);
  },

  /** Installs, or re-installs with the new grant. Returns the installation id. */
  async upsertInstallation(appId: number, scopes: string[], adminId: number | null, exec?: Executor): Promise<number> {
    await execute(
      `INSERT INTO app_installations (shop_id, app_id, granted_scopes, status, installed_by_admin_id)
       VALUES (?, ?, ?, 'active', ?)
       ON DUPLICATE KEY UPDATE
         -- Assignments apply left to right: read the old status before it is overwritten.
         installed_at = IF(status = 'uninstalled', NOW(), installed_at),
         uninstalled_at = NULL,
         granted_scopes = VALUES(granted_scopes),
         installed_by_admin_id = VALUES(installed_by_admin_id),
         status = 'active'`,
      [shopId(), appId, JSON.stringify(scopes), adminId],
      exec,
    );
    const row = await this.findInstallation(appId, exec);
    return Number(row!.id);
  },

  async markUninstalled(installationId: number, exec?: Executor): Promise<void> {
    await execute(
      `UPDATE app_installations SET status = 'uninstalled', uninstalled_at = NOW() WHERE shop_id = ? AND id = ?`,
      [shopId(), installationId],
      exec,
    );
  },

  // ── Admin API access tokens (control plane) ───────────────────────────────
  async insertAccessToken(
    data: { shopId: number; appId: number; installationId: number; hash: string; hint: string; scopes: string[] },
    exec: Executor = controlPlane,
  ): Promise<number> {
    return insert(
      `INSERT INTO app_access_tokens (shop_id, app_id, installation_id, token_hash, token_hint, scopes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.shopId, data.appId, data.installationId, data.hash, data.hint, JSON.stringify(data.scopes)],
      exec,
    );
  },

  async findLiveAccessToken(hash: string, exec: Executor = controlPlane): Promise<AccessTokenRow | null> {
    return queryOne<AccessTokenRow>(
      'SELECT * FROM app_access_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1',
      [hash],
      exec,
    );
  },

  async touchAccessToken(id: number, exec: Executor = controlPlane): Promise<void> {
    await execute('UPDATE app_access_tokens SET last_used_at = NOW() WHERE id = ?', [id], exec);
  },

  async listAccessTokens(shop: number, installationId: number, exec: Executor = controlPlane): Promise<AccessTokenRow[]> {
    return query<AccessTokenRow>(
      `SELECT * FROM app_access_tokens WHERE shop_id = ? AND installation_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      [shop, installationId],
      exec,
    );
  },

  async revokeAccessTokens(shop: number, installationId: number, reason: string, exec: Executor = controlPlane): Promise<number> {
    const result = await execute(
      `UPDATE app_access_tokens SET revoked_at = NOW(), revoked_reason = ?
        WHERE shop_id = ? AND installation_id = ? AND revoked_at IS NULL`,
      [reason, shop, installationId],
      exec,
    );
    return result.affectedRows;
  },

  // ── OAuth authorization codes (control plane) ─────────────────────────────
  async insertCode(
    data: { hash: string; appId: number; shopId: number; adminUserId: number; scopes: string[]; redirectUri: string; expiresAt: Date },
    exec: Executor = controlPlane,
  ): Promise<void> {
    await execute(
      `INSERT INTO oauth_authorization_codes (code_hash, app_id, shop_id, admin_user_id, scopes, redirect_uri, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.hash, data.appId, data.shopId, data.adminUserId, JSON.stringify(data.scopes), data.redirectUri, data.expiresAt],
      exec,
    );
  },

  /**
   * Marks a code used and returns it — in one statement, so two exchanges of
   * the same code cannot both succeed. The loser matches zero rows.
   */
  async consumeCode(hash: string, exec: Executor = controlPlane): Promise<OAuthCodeRow | null> {
    const result = await execute(
      `UPDATE oauth_authorization_codes SET used_at = NOW()
        WHERE code_hash = ? AND used_at IS NULL AND expires_at > NOW()`,
      [hash],
      exec,
    );
    if (result.affectedRows !== 1) return null;
    return queryOne<OAuthCodeRow>('SELECT * FROM oauth_authorization_codes WHERE code_hash = ?', [hash], exec);
  },

  async purgeExpiredCodes(exec: Executor = controlPlane): Promise<number> {
    const result = await execute(
      'DELETE FROM oauth_authorization_codes WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY) LIMIT 5000',
      [],
      exec,
    );
    return result.affectedRows;
  },

  // ── storefront access tokens (control plane) ──────────────────────────────
  async insertStorefrontToken(
    data: { shopId: number; appId: number | null; title: string; hash: string; hint: string; adminId: number | null },
    exec: Executor = controlPlane,
  ): Promise<number> {
    return insert(
      `INSERT INTO storefront_access_tokens (shop_id, app_id, title, token_hash, token_hint, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.shopId, data.appId, data.title, data.hash, data.hint, data.adminId],
      exec,
    );
  },

  async listStorefrontTokens(shop: number, exec: Executor = controlPlane): Promise<StorefrontTokenRow[]> {
    return query<StorefrontTokenRow>(
      'SELECT * FROM storefront_access_tokens WHERE shop_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
      [shop],
      exec,
    );
  },

  async revokeStorefrontToken(shop: number, id: number, exec: Executor = controlPlane): Promise<boolean> {
    const result = await execute(
      'UPDATE storefront_access_tokens SET revoked_at = NOW() WHERE shop_id = ? AND id = ? AND revoked_at IS NULL',
      [shop, id],
      exec,
    );
    return result.affectedRows === 1;
  },
};
