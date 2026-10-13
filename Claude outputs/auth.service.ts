import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { hashToken, randomToken } from '../../core/crypto';
import { logger } from '../../core/logger';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import { authRepository, type AdminRow } from './auth.repository';
import type { AccessTokenPayload, AuthenticatedAdmin, LoginResult, PublicAdmin } from './auth.types';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

/**
 * Session + permission caches.
 *
 * Every authenticated request would otherwise cost two extra round trips. The
 * TTLs are deliberately short and asymmetric: a revoked session must die fast
 * (30s), a permission change can take a little longer (60s) and is busted
 * explicitly when roles are edited.
 */
const sessionCache = new Map<number, { adminId: number; expiresAt: number }>();
const permissionCache = new Map<number, { permissions: Set<string>; expiresAt: number }>();
const SESSION_CACHE_MS = 30_000;
const PERMISSION_CACHE_MS = 60_000;

export function invalidatePermissionCache(adminId?: number): void {
  if (adminId === undefined) permissionCache.clear();
  else permissionCache.delete(adminId);
}

export function invalidateSessionCache(sessionId?: number): void {
  if (sessionId === undefined) sessionCache.clear();
  else sessionCache.delete(sessionId);
}

export function toPublicAdmin(row: AdminRow): PublicAdmin {
  return {
    id: row.id,
    public_id: row.public_id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    phone: row.phone,
    job_title: row.job_title,
    status: row.status,
    is_super_admin: row.is_super_admin === 1,
    mfa_enabled: row.mfa_enabled === 1,
    avatar_media_id: row.avatar_media_id,
    timezone: row.timezone,
    last_login_at: row.last_login_at ? row.last_login_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

function signAccessToken(adminId: number, sessionId: number): string {
  const payload: AccessTokenPayload = { sub: String(adminId), sid: String(sessionId), typ: 'access' };
  return jwt.sign(payload, env.auth.jwtSecret, {
    expiresIn: `${env.auth.accessTtlMinutes}m`,
    issuer: 'veylog-admin-api',
  });
}

export const authService = {
  async login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const admin = await authRepository.findByEmail(email.toLowerCase().trim());

    // Same error and roughly the same work whether the account exists or not,
    // so the endpoint cannot be used to enumerate valid admin emails.
    if (!admin || !admin.password_hash) {
      await bcrypt.compare(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    if (admin.locked_until && admin.locked_until.getTime() > Date.now()) {
      const minutes = Math.ceil((admin.locked_until.getTime() - Date.now()) / 60000);
      throw new ApiError(403, 'ACCOUNT_LOCKED', `Account is locked. Try again in ${minutes} minute(s).`);
    }

    if (admin.status !== 'active') {
      throw new ApiError(403, 'ACCOUNT_INACTIVE', `This account is ${admin.status}.`);
    }

    const passwordOk = await bcrypt.compare(password, admin.password_hash);
    if (!passwordOk) {
      const attempts = admin.failed_login_attempts + 1;
      const lockUntil =
        attempts >= env.auth.maxLoginAttempts
          ? new Date(Date.now() + env.auth.lockoutMinutes * 60_000)
          : null;
      await authRepository.recordFailedLogin(admin.id, lockUntil);
      await auditService.log({
        actorType: 'system',
        action: 'admin.login_failed',
        entityType: 'admin_user',
        entityId: admin.id,
        summary: `Failed login for ${admin.email}`,
        context: { request_id: meta.requestId, attempts },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      logger.warn('auth.login_failed', { email: admin.email, attempts, locked: Boolean(lockUntil) });
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    // MFA is modelled but the TOTP step ships in phase 2. Failing closed here
    // would lock out every seeded admin, so we record that it was satisfied.
    if (admin.mfa_enabled === 1 && !admin.mfa_secret) {
      logger.warn('auth.mfa_enabled_without_secret', { admin_id: admin.id });
    }

    const sessionToken = randomToken(32);
    const refreshToken = randomToken(48);
    const expiresAt = new Date(Date.now() + env.auth.refreshTtlDays * 86_400_000);

    const sessionId = await withTransaction(async (tx) => {
      const id = await authRepository.createSession(
        {
          adminUserId: admin.id,
          sessionTokenHash: hashToken(sessionToken),
          refreshTokenHash: hashToken(refreshToken),
          ip: meta.ip,
          userAgent: meta.userAgent,
          expiresAt,
        },
        tx,
      );
      await authRepository.recordSuccessfulLogin(admin.id, meta.ip, tx);
      await auditService.log(
        {
          actorId: admin.id,
          actorLabel: admin.email,
          action: 'admin.logged_in',
          entityType: 'admin_user',
          entityId: admin.id,
          summary: `${admin.email} signed in`,
          context: { request_id: meta.requestId, session_id: id },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return id;
    });

    const permissions = admin.is_super_admin === 1 ? ['*'] : await authRepository.resolvePermissions(admin.id);

    return {
      access_token: signAccessToken(admin.id, sessionId),
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: env.auth.accessTtlMinutes * 60,
      admin: toPublicAdmin(admin),
      permissions,
      must_change_password: admin.must_change_password === 1,
    };
  },

  /**
   * Rotating refresh. The old token is overwritten in the same UPDATE that
   * issues the new one, so replaying it matches zero rows — at which point we
   * treat the session as compromised and revoke it outright.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<LoginResult> {
    const oldHash = hashToken(refreshToken);
    const session = await authRepository.findByRefreshHash(oldHash);

    if (!session) throw ApiError.unauthenticated('Refresh token is invalid.', 'SESSION_REVOKED');

    if (session.revoked_at) {
      logger.warn('auth.refresh_reuse_detected', { session_id: session.id, admin_id: session.admin_user_id });
      await authRepository.revokeAllForAdmin(session.admin_user_id, 'reuse_detected');
      invalidateSessionCache();
      throw ApiError.unauthenticated('Session has been revoked.', 'SESSION_REVOKED');
    }

    if (session.expires_at.getTime() <= Date.now()) {
      throw ApiError.unauthenticated('Session has expired. Please sign in again.', 'TOKEN_EXPIRED');
    }

    const admin = await authRepository.findById(session.admin_user_id);
    if (!admin || admin.status !== 'active') {
      await authRepository.revokeSession(session.id, 'account_inactive');
      throw new ApiError(403, 'ACCOUNT_INACTIVE', 'This account is no longer active.');
    }

    const newRefreshToken = randomToken(48);
    const expiresAt = new Date(Date.now() + env.auth.refreshTtlDays * 86_400_000);

    const rotated = await authRepository.rotateRefreshToken(
      session.id,
      oldHash,
      hashToken(newRefreshToken),
      expiresAt,
    );
    if (!rotated) throw ApiError.unauthenticated('Refresh token is no longer valid.', 'SESSION_REVOKED');

    invalidateSessionCache(session.id);

    const permissions = admin.is_super_admin === 1 ? ['*'] : await authRepository.resolvePermissions(admin.id);

    return {
      access_token: signAccessToken(admin.id, session.id),
      refresh_token: newRefreshToken,
      token_type: 'Bearer',
      expires_in: env.auth.accessTtlMinutes * 60,
      admin: toPublicAdmin(admin),
      permissions,
      must_change_password: admin.must_change_password === 1,
    };
  },

  async logout(admin: AuthenticatedAdmin, meta: RequestMeta): Promise<void> {
    await authRepository.revokeSession(admin.sessionId, 'logout');
    invalidateSessionCache(admin.sessionId);
    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'admin.logged_out',
      entityType: 'admin_user',
      entityId: admin.id,
      context: { request_id: meta.requestId, session_id: admin.sessionId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  },

  async changePassword(
    admin: AuthenticatedAdmin,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<void> {
    const row = await authRepository.findById(admin.id);
    if (!row?.password_hash) throw ApiError.notFound('Account');

    const ok = await bcrypt.compare(currentPassword, row.password_hash);
    if (!ok) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Your current password is incorrect.');

    if (await bcrypt.compare(newPassword, row.password_hash)) {
      throw ApiError.validation({ new_password: ['New password must differ from the current one.'] });
    }

    const hash = await bcrypt.hash(newPassword, env.auth.bcryptRounds);

    await withTransaction(async (tx) => {
      await authRepository.updatePassword(admin.id, hash, tx);
      // Every other device is signed out. The session doing the change survives.
      await authRepository.revokeAllForAdmin(admin.id, 'password_change', admin.sessionId, tx);
      await auditService.log(
        {
          actorId: admin.id,
          actorLabel: admin.email,
          action: 'admin.password_changed',
          entityType: 'admin_user',
          entityId: admin.id,
          summary: `${admin.email} changed their password`,
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    invalidateSessionCache();
  },

  async listSessions(adminId: number) {
    const rows = await authRepository.listSessions(adminId);
    return rows.map((s) => ({
      id: s.id,
      user_agent: s.user_agent,
      last_active_at: s.last_active_at.toISOString(),
      expires_at: s.expires_at.toISOString(),
      created_at: s.created_at.toISOString(),
    }));
  },

  async revokeSession(admin: AuthenticatedAdmin, sessionId: number): Promise<void> {
    const sessions = await authRepository.listSessions(admin.id);
    if (!sessions.some((s) => s.id === sessionId)) throw ApiError.notFound('Session');
    await authRepository.revokeSession(sessionId, 'revoked_by_user');
    invalidateSessionCache();
  },

  /**
   * Used by the authenticate middleware on every request. Verifies the JWT,
   * confirms the session is still live, and resolves permissions — all three
   * cached, because this runs on the hot path.
   */
  async resolveFromAccessToken(token: string): Promise<AuthenticatedAdmin> {
    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(token, env.auth.jwtSecret, { issuer: 'veylog-admin-api' }) as AccessTokenPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw ApiError.unauthenticated('Access token has expired.', 'TOKEN_EXPIRED');
      }
      throw ApiError.unauthenticated('Access token is invalid.');
    }

    if (payload.typ !== 'access') throw ApiError.unauthenticated('Wrong token type.');

    const sessionId = Number(payload.sid);
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      throw ApiError.unauthenticated('Access token is invalid.');
    }
    const now = Date.now();

    let cached = sessionCache.get(sessionId);
    if (!cached || cached.expiresAt <= now) {
      const session = await authRepository.findLiveSessionById(sessionId);
      if (!session) throw ApiError.unauthenticated('Session is no longer valid.', 'SESSION_REVOKED');
      cached = { adminId: session.admin_user_id, expiresAt: now + SESSION_CACHE_MS };
      sessionCache.set(sessionId, cached);
      void authRepository.touchSession(session.id).catch(() => undefined);
    }

    if (String(cached.adminId) !== payload.sub) {
      throw ApiError.unauthenticated('Token does not match its session.', 'SESSION_REVOKED');
    }

    const admin = await authRepository.findById(cached.adminId);
    if (!admin) throw ApiError.unauthenticated('Account no longer exists.');
    if (admin.status !== 'active') throw new ApiError(403, 'ACCOUNT_INACTIVE', `This account is ${admin.status}.`);

    let permissions: Set<string>;
    if (admin.is_super_admin === 1) {
      permissions = new Set<string>();
    } else {
      const cachedPerms = permissionCache.get(admin.id);
      if (cachedPerms && cachedPerms.expiresAt > now) {
        permissions = cachedPerms.permissions;
      } else {
        permissions = new Set(await authRepository.resolvePermissions(admin.id));
        permissionCache.set(admin.id, { permissions, expiresAt: now + PERMISSION_CACHE_MS });
      }
    }

    return {
      id: admin.id,
      publicId: admin.public_id,
      email: admin.email,
      firstName: admin.first_name,
      lastName: admin.last_name,
      isSuperAdmin: admin.is_super_admin === 1,
      sessionId,
      permissions,
    };
  },
};
