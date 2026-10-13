import { controlPlane, execute, insert, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';
import type { PlatformRole, ShopMembership } from './auth.types';

export interface AdminRow extends RowDataPacket {
  id: number;
  public_id: string;
  email: string;
  password_hash: string | null;
  first_name: string;
  last_name: string | null;
  phone: string | null;
  avatar_media_id: number | null;
  job_title: string | null;
  status: 'invited' | 'active' | 'suspended' | 'disabled';
  is_super_admin: number;
  platform_role: PlatformRole;
  account_type: 'human' | 'app' | 'system';
  mfa_enabled: number;
  /** Vault-sealed base32 TOTP secret. Set with mfa_enabled = 0 while enrolment is pending. */
  mfa_secret: string | null;
  /** Peppered hashes of the unused recovery codes. */
  mfa_recovery_codes: string[] | null;
  mfa_last_used_step: number | null;
  mfa_enabled_at: Date | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  password_changed_at: Date | null;
  must_change_password: number;
  timezone: string;
  locale: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface SessionRow extends RowDataPacket {
  id: number;
  admin_user_id: number;
  active_shop_id: number | null;
  session_token_hash: string;
  refresh_token_hash: string | null;
  ip: Buffer | null;
  user_agent: string | null;
  mfa_satisfied_at: Date | null;
  last_active_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  created_at: Date;
}

export interface PermissionRow extends RowDataPacket {
  slug: string;
  source: 'role' | 'direct';
}

export interface MembershipRow extends RowDataPacket {
  id: number;
  shop_id: number;
  admin_user_id: number;
  is_owner: number;
  has_full_access: number;
  status: 'invited' | 'active' | 'suspended';
}

/**
 * Data access for authentication. No business rules live here — deciding that
 * a locked account is a 403 is the service's job.
 */
export const authRepository = {
  async findByEmail(email: string, exec: Executor = controlPlane): Promise<AdminRow | null> {
    return queryOne<AdminRow>(
      `SELECT * FROM admin_users WHERE email = ? AND deleted_at IS NULL LIMIT 1`,
      [email],
      exec,
    );
  },

  async findById(id: number, exec: Executor = controlPlane): Promise<AdminRow | null> {
    return queryOne<AdminRow>(
      `SELECT * FROM admin_users WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [id],
      exec,
    );
  },

  async recordFailedLogin(id: number, lockUntil: Date | null, exec: Executor = controlPlane): Promise<void> {
    await execute(
      `UPDATE admin_users
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = COALESCE(?, locked_until)
        WHERE id = ?`,
      [lockUntil, id],
      exec,
    );
  },

  async recordSuccessfulLogin(id: number, ip: string | null, exec: Executor = controlPlane): Promise<void> {
    await execute(
      `UPDATE admin_users
          SET failed_login_attempts = 0,
              locked_until = NULL,
              last_login_at = NOW(),
              last_login_ip = ${ip ? 'INET6_ATON(?)' : 'NULL'}
        WHERE id = ?`,
      ip ? [ip, id] : [id],
      exec,
    );
  },

  async createSession(
    data: {
      adminUserId: number;
      activeShopId: number | null;
      sessionTokenHash: string;
      refreshTokenHash: string;
      ip: string | null;
      userAgent: string | null;
      expiresAt: Date;
      /** True when the sign-in that opened this session passed a second factor. */
      mfaSatisfied: boolean;
    },
    exec: Executor = controlPlane,
  ): Promise<number> {
    return insert(
      `INSERT INTO admin_sessions
         (admin_user_id, active_shop_id, session_token_hash, refresh_token_hash, ip, user_agent, expires_at, mfa_satisfied_at)
       VALUES (?, ?, ?, ?, ${data.ip ? 'INET6_ATON(?)' : 'NULL'}, ?, ?, ${data.mfaSatisfied ? 'NOW()' : 'NULL'})`,
      data.ip
        ? [data.adminUserId, data.activeShopId, data.sessionTokenHash, data.refreshTokenHash, data.ip, data.userAgent, data.expiresAt]
        : [data.adminUserId, data.activeShopId, data.sessionTokenHash, data.refreshTokenHash, data.userAgent, data.expiresAt],
      exec,
    );
  },

  /** Primary-key lookup: the JWT carries the session id, not a secret. */
  async findLiveSessionById(id: number, exec: Executor = controlPlane): Promise<SessionRow | null> {
    return queryOne<SessionRow>(
      `SELECT * FROM admin_sessions
        WHERE id = ? AND revoked_at IS NULL AND expires_at > NOW()
        LIMIT 1`,
      [id],
      exec,
    );
  },

  async findByRefreshHash(hash: string, exec: Executor = controlPlane): Promise<SessionRow | null> {
    return queryOne<SessionRow>(
      `SELECT * FROM admin_sessions WHERE refresh_token_hash = ? LIMIT 1`,
      [hash],
      exec,
    );
  },

  /**
   * Rotates ONLY the refresh token. The session identity is untouched, so
   * access tokens already issued for this session keep working until they
   * expire — refreshing on one tab must not sign out the other three.
   *
   * The WHERE clause carries the OLD hash, so two concurrent refreshes with the
   * same token cannot both succeed: the loser matches zero rows and the caller
   * treats that as replay.
   */
  async rotateRefreshToken(
    sessionId: number,
    oldHash: string,
    newRefreshHash: string,
    expiresAt: Date,
    exec: Executor = controlPlane,
  ): Promise<boolean> {
    const result = await execute(
      `UPDATE admin_sessions
          SET refresh_token_hash = ?, expires_at = ?, last_active_at = NOW()
        WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`,
      [newRefreshHash, expiresAt, sessionId, oldHash],
      exec,
    );
    return result.affectedRows === 1;
  },

  async touchSession(sessionId: number, exec: Executor = controlPlane): Promise<void> {
    await execute(`UPDATE admin_sessions SET last_active_at = NOW() WHERE id = ?`, [sessionId], exec);
  },

  async revokeSession(sessionId: number, reason: string, exec: Executor = controlPlane): Promise<void> {
    await execute(
      `UPDATE admin_sessions SET revoked_at = NOW(), revoked_reason = ? WHERE id = ? AND revoked_at IS NULL`,
      [reason, sessionId],
      exec,
    );
  },

  async revokeAllForAdmin(adminId: number, reason: string, exceptSessionId?: number, exec: Executor = controlPlane): Promise<number> {
    const result = await execute(
      `UPDATE admin_sessions
          SET revoked_at = NOW(), revoked_reason = ?
        WHERE admin_user_id = ? AND revoked_at IS NULL ${exceptSessionId ? 'AND id <> ?' : ''}`,
      exceptSessionId ? [reason, adminId, exceptSessionId] : [reason, adminId],
      exec,
    );
    return result.affectedRows;
  },

  async listSessions(adminId: number, exec: Executor = controlPlane): Promise<SessionRow[]> {
    return query<SessionRow>(
      `SELECT * FROM admin_sessions
        WHERE admin_user_id = ? AND revoked_at IS NULL AND expires_at > NOW()
        ORDER BY last_active_at DESC`,
      [adminId],
      exec,
    );
  },

  /**
   * Resolved permissions IN THE CURRENT SHOP: role grants plus direct allows,
   * minus direct denies. The EXCEPT is expressed as a NOT EXISTS so a per-user
   * `deny` always beats a role `allow`, regardless of how many roles granted it.
   *
   * Roles and grants are per shop — the same person can be Operations in one
   * store and Support in another — so every tenant table here is scoped.
   */
  async resolvePermissions(adminId: number, exec?: Executor): Promise<string[]> {
    const shop = shopId();
    const rows = await query<PermissionRow>(
      `SELECT DISTINCT p.slug, 'role' AS source
         FROM admin_user_roles aur
         JOIN role_permissions rp ON rp.role_id = aur.role_id AND rp.shop_id = aur.shop_id
         JOIN permissions p       ON p.id = rp.permission_id
        WHERE aur.shop_id = ? AND aur.admin_user_id = ?
          AND NOT EXISTS (
                SELECT 1 FROM admin_user_permissions d
                 WHERE d.shop_id = aur.shop_id
                   AND d.admin_user_id = aur.admin_user_id
                   AND d.permission_id = p.id
                   AND d.effect = 'deny')
       UNION
       SELECT DISTINCT p.slug, 'direct' AS source
         FROM admin_user_permissions aup
         JOIN permissions p ON p.id = aup.permission_id
        WHERE aup.shop_id = ? AND aup.admin_user_id = ?
          AND aup.effect = 'allow'
          AND (aup.expires_at IS NULL OR aup.expires_at > NOW())`,
      [shop, adminId, shop, adminId],
      exec,
    );
    return rows.map((r) => r.slug);
  },

  /** Read-only access for platform support staff: every `.view` permission. */
  async viewPermissions(exec: Executor = controlPlane): Promise<string[]> {
    const rows = await query<PermissionRow>(`SELECT slug FROM permissions WHERE action = 'view'`, [], exec);
    return rows.map((r) => r.slug);
  },

  /** Every shop this person belongs to, active memberships first. */
  async listMemberships(adminId: number, exec: Executor = controlPlane): Promise<ShopMembership[]> {
    const rows = await query<RowDataPacket>(
      `SELECT s.id AS shop_id, s.handle, s.name, s.status,
              (SELECT d.hostname FROM shop_domains d WHERE d.shop_id = s.id AND d.is_primary = 1 LIMIT 1) AS primary_domain,
              ss.is_owner, ss.has_full_access, ss.status AS member_status
         FROM shop_staff ss
         JOIN shops s ON s.id = ss.shop_id
        WHERE ss.admin_user_id = ? AND s.status <> 'closed'
        ORDER BY ss.status = 'active' DESC, ss.last_accessed_at DESC, s.id`,
      [adminId],
      exec,
    );
    return rows.map((row) => ({
      shop_id: Number(row.shop_id),
      handle: row.handle,
      name: row.name,
      status: row.status,
      primary_domain: row.primary_domain,
      is_owner: Number(row.is_owner) === 1,
      has_full_access: Number(row.has_full_access) === 1,
      member_status: row.member_status,
    }));
  },

  async findMembership(shop: number, adminId: number, exec: Executor = controlPlane): Promise<MembershipRow | null> {
    return queryOne<MembershipRow>(
      `SELECT id, shop_id, admin_user_id, is_owner, has_full_access, status
         FROM shop_staff WHERE shop_id = ? AND admin_user_id = ? LIMIT 1`,
      [shop, adminId],
      exec,
    );
  },

  async touchMembership(shop: number, adminId: number, exec: Executor = controlPlane): Promise<void> {
    await execute(
      'UPDATE shop_staff SET last_accessed_at = NOW() WHERE shop_id = ? AND admin_user_id = ?',
      [shop, adminId],
      exec,
    );
  },

  async setActiveShop(sessionId: number, shop: number | null, exec: Executor = controlPlane): Promise<void> {
    await execute('UPDATE admin_sessions SET active_shop_id = ? WHERE id = ?', [shop, sessionId], exec);
  },

  async updatePassword(adminId: number, passwordHash: string, exec: Executor = controlPlane): Promise<void> {
    await execute(
      `UPDATE admin_users
          SET password_hash = ?, password_changed_at = NOW(), must_change_password = 0,
              failed_login_attempts = 0, locked_until = NULL
        WHERE id = ?`,
      [passwordHash, adminId],
      exec,
    );
  },

  // ── two-step sign-in ───────────────────────────────────────────────────────

  /** Starts (or restarts) enrolment. Refuses while MFA is already on. */
  async setPendingMfaSecret(adminId: number, sealedSecret: string, exec: Executor = controlPlane): Promise<boolean> {
    const result = await execute(
      `UPDATE admin_users
          SET mfa_secret = ?, mfa_recovery_codes = NULL, mfa_last_used_step = NULL
        WHERE id = ? AND mfa_enabled = 0`,
      [sealedSecret, adminId],
      exec,
    );
    return result.affectedRows === 1;
  },

  /** Completes enrolment; matches only while it is still pending. */
  async enableMfa(adminId: number, recoveryHashes: string[], step: number, exec: Executor = controlPlane): Promise<boolean> {
    const result = await execute(
      `UPDATE admin_users
          SET mfa_enabled = 1, mfa_enabled_at = NOW(), mfa_recovery_codes = CAST(? AS JSON), mfa_last_used_step = ?
        WHERE id = ? AND mfa_enabled = 0 AND mfa_secret IS NOT NULL`,
      [JSON.stringify(recoveryHashes), step, adminId],
      exec,
    );
    return result.affectedRows === 1;
  },

  async disableMfa(adminId: number, exec: Executor = controlPlane): Promise<void> {
    await execute(
      `UPDATE admin_users
          SET mfa_enabled = 0, mfa_secret = NULL, mfa_recovery_codes = NULL,
              mfa_last_used_step = NULL, mfa_enabled_at = NULL
        WHERE id = ?`,
      [adminId],
      exec,
    );
  },

  /**
   * Records a TOTP step as used, only if it is later than the last one. The
   * comparison and the write are one statement, so a replayed code — or two
   * requests racing with the same code — match zero rows.
   */
  async consumeTotpStep(adminId: number, step: number, exec: Executor = controlPlane): Promise<boolean> {
    const result = await execute(
      `UPDATE admin_users
          SET mfa_last_used_step = ?
        WHERE id = ? AND (mfa_last_used_step IS NULL OR mfa_last_used_step < ?)`,
      [step, adminId, step],
      exec,
    );
    return result.affectedRows === 1;
  },

  /** Removes one recovery code by its hash; false when it is not (or no longer) there. */
  async consumeRecoveryCode(adminId: number, codeHash: string, exec: Executor = controlPlane): Promise<boolean> {
    const result = await execute(
      `UPDATE admin_users
          SET mfa_recovery_codes = JSON_REMOVE(mfa_recovery_codes, JSON_UNQUOTE(JSON_SEARCH(mfa_recovery_codes, 'one', ?)))
        WHERE id = ? AND mfa_enabled = 1 AND JSON_SEARCH(mfa_recovery_codes, 'one', ?) IS NOT NULL`,
      [codeHash, adminId, codeHash],
      exec,
    );
    return result.affectedRows === 1;
  },

  async replaceRecoveryCodes(adminId: number, recoveryHashes: string[], exec: Executor = controlPlane): Promise<void> {
    await execute(
      `UPDATE admin_users SET mfa_recovery_codes = CAST(? AS JSON) WHERE id = ? AND mfa_enabled = 1`,
      [JSON.stringify(recoveryHashes), adminId],
      exec,
    );
  },

  /**
   * Counts a sign-in code attempt BEFORE the code is checked, and locks the
   * account on the attempt that reaches `max`. Because the check and the
   * increment are one statement, fifty requests fired at once still get
   * `max` guesses between them, not fifty: once one of them sets the lock the
   * rest match zero rows. False means the account is locked right now.
   *
   * MySQL evaluates single-table SET assignments left to right, so the IF
   * sees the incremented count. A correct code resets both through
   * recordSuccessfulLogin.
   */
  async reserveSignInAttempt(adminId: number, max: number, lockUntil: Date, exec: Executor = controlPlane): Promise<boolean> {
    const result = await execute(
      `UPDATE admin_users
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = IF(failed_login_attempts >= ?, ?, locked_until)
        WHERE id = ? AND (locked_until IS NULL OR locked_until <= NOW())`,
      [max, lockUntil, adminId],
      exec,
    );
    return result.affectedRows === 1;
  },

  async markSessionMfaSatisfied(sessionId: number, exec: Executor = controlPlane): Promise<void> {
    await execute(`UPDATE admin_sessions SET mfa_satisfied_at = NOW() WHERE id = ?`, [sessionId], exec);
  },
};
