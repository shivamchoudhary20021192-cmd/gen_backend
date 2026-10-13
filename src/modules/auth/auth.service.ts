import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { hashToken, randomToken } from '../../core/crypto';
import { logger } from '../../core/logger';
import { withTransaction } from '../../db/transaction';
import { controlPlane } from '../../db/pool';
import { shopDirectory } from '../../platform/shops/shopDirectory';
import { tenancy, type ShopContext } from '../../platform/tenancy/context';
import { auditService } from '../../shared/audit.service';
import { authRepository, type AdminRow } from './auth.repository';
import type {
  AccessTokenPayload,
  AuthenticatedAdmin,
  LoginResult,
  PlatformRole,
  PublicAdmin,
  ShopMembership,
} from './auth.types';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

/** What session operations need: a person and their session, shop optional. */
export interface SessionActor {
  id: number;
  email: string;
  sessionId: number;
  shop?: ShopContext;
}

/**
 * Session, membership and permission caches.
 *
 * Every authenticated request would otherwise cost several extra round trips.
 * The TTLs are deliberately short and asymmetric: a revoked session must die
 * fast (30s), a permission change can take a little longer (60s) and is busted
 * explicitly when roles are edited. Membership and permissions are keyed by
 * shop as well as person, because the same person has different authority in
 * each shop they belong to.
 */
interface CachedSession {
  adminId: number;
  activeShopId: number | null;
  expiresAt: number;
}
interface CachedAuthority {
  isOwner: boolean;
  fullAccess: boolean;
  permissions: Set<string>;
  expiresAt: number;
}

const sessionCache = new Map<number, CachedSession>();
const authorityCache = new Map<string, CachedAuthority>();
const SESSION_CACHE_MS = 30_000;
const PERMISSION_CACHE_MS = 60_000;

const authorityKey = (shopId: number, adminId: number) => `${shopId}:${adminId}`;

/** "Last used" on a membership is for the shop switcher, not an audit trail. */
const lastTouched = new Map<string, number>();
const TOUCH_EVERY_MS = 5 * 60_000;

export function invalidatePermissionCache(adminId?: number): void {
  if (adminId === undefined) {
    authorityCache.clear();
    return;
  }
  for (const key of authorityCache.keys()) {
    if (key.endsWith(`:${adminId}`)) authorityCache.delete(key);
  }
}

export function invalidateSessionCache(sessionId?: number): void {
  if (sessionId === undefined) sessionCache.clear();
  else sessionCache.delete(sessionId);
}

export function toPublicAdmin(row: AdminRow, fullAccessInShop = false): PublicAdmin {
  return {
    id: row.id,
    public_id: row.public_id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    phone: row.phone,
    job_title: row.job_title,
    status: row.status,
    is_super_admin: fullAccessInShop,
    platform_role: row.platform_role ?? 'none',
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

/** Shops a person may actually open right now. */
function openable(memberships: ShopMembership[]): ShopMembership[] {
  return memberships.filter((m) => m.member_status === 'active');
}

/**
 * Authority of one person in one shop. Membership first; platform staff who
 * are not members get support access — full for platform admins, read-only
 * for support — which is how the operator investigates a merchant's issue
 * without being added to their staff.
 */
async function authorityIn(shop: ShopContext, admin: AdminRow): Promise<CachedAuthority> {
  const key = authorityKey(shop.id, admin.id);
  const now = Date.now();
  const cached = authorityCache.get(key);
  if (cached && cached.expiresAt > now) return cached;

  const membership = await authRepository.findMembership(shop.id, admin.id);
  let authority: CachedAuthority;

  if (membership) {
    if (membership.status !== 'active') {
      throw new ApiError(403, 'NOT_A_MEMBER', `Your access to ${shop.name} is ${membership.status}.`);
    }
    const fullAccess = membership.has_full_access === 1 || membership.is_owner === 1;
    authority = {
      isOwner: membership.is_owner === 1,
      fullAccess,
      permissions: fullAccess
        ? new Set<string>()
        : new Set(await tenancy.run(shop, () => authRepository.resolvePermissions(admin.id))),
      expiresAt: now + PERMISSION_CACHE_MS,
    };
  } else if (admin.platform_role === 'admin') {
    authority = { isOwner: false, fullAccess: true, permissions: new Set(), expiresAt: now + PERMISSION_CACHE_MS };
  } else if (admin.platform_role === 'support') {
    authority = {
      isOwner: false,
      fullAccess: false,
      permissions: new Set(await authRepository.viewPermissions()),
      expiresAt: now + PERMISSION_CACHE_MS,
    };
  } else {
    throw new ApiError(403, 'NOT_A_MEMBER', `You are not a member of ${shop.name}.`);
  }

  authorityCache.set(key, authority);
  return authority;
}

/** Which shop a request is for, when it did not say. */
async function defaultShopFor(adminId: number, activeShopId: number | null): Promise<ShopContext | null> {
  if (activeShopId) {
    const shop = await shopDirectory.byId(activeShopId);
    if (shop) return shop;
  }
  const memberships = openable(await authRepository.listMemberships(adminId));
  return memberships.length > 0 ? shopDirectory.byId(memberships[0].shop_id) : null;
}

/**
 * The admin keeps working while a shop is frozen for non-payment or suspended
 * — but only to look, and to fix the reason. A closed shop is gone.
 */
function assertAdminCanUse(shop: ShopContext, platformRole: PlatformRole, method: string, path: string): void {
  if (shop.status === 'closed' && platformRole === 'none') {
    throw ApiError.shopUnavailable(`${shop.name} has been closed.`, { status: shop.status });
  }
  if ((shop.status === 'frozen' || shop.status === 'suspended') && platformRole === 'none') {
    const readOnly = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const allowed = /\/(billing|auth|shop)(\/|$)/.test(path);
    if (!readOnly && !allowed) {
      throw ApiError.shopUnavailable(
        shop.status === 'frozen'
          ? `${shop.name} is frozen until the outstanding bill is paid. You can still view everything and settle it under Billing.`
          : `${shop.name} is suspended. Contact support.`,
        { status: shop.status },
      );
    }
  }
}

async function loginPayload(admin: AdminRow, sessionId: number, refreshToken: string, activeShopId: number | null): Promise<LoginResult> {
  const memberships = await authRepository.listMemberships(admin.id);
  const active = memberships.find((m) => m.shop_id === activeShopId) ?? null;

  let permissions: string[] = [];
  let fullAccess = false;
  if (active) {
    const shop = await shopDirectory.byId(active.shop_id);
    if (shop) {
      const authority = await authorityIn(shop, admin);
      fullAccess = authority.fullAccess;
      permissions = fullAccess ? ['*'] : [...authority.permissions];
    }
  }

  return {
    access_token: signAccessToken(admin.id, sessionId),
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: env.auth.accessTtlMinutes * 60,
    admin: toPublicAdmin(admin, fullAccess),
    permissions,
    must_change_password: admin.must_change_password === 1,
    shops: memberships,
    active_shop: active,
  };
}

export const authService = {
  async login(email: string, password: string, meta: RequestMeta): Promise<LoginResult> {
    const admin = await authRepository.findByEmail(email.toLowerCase().trim());

    // Same error and roughly the same work whether the account exists or not,
    // so the endpoint cannot be used to enumerate valid admin emails. App bot
    // identities have no password and can never sign in here.
    if (!admin || !admin.password_hash || admin.account_type !== 'human') {
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

    // The shop they last worked in, so signing in lands where they left off.
    const memberships = openable(await authRepository.listMemberships(admin.id));
    const activeShopId = memberships[0]?.shop_id ?? null;

    const sessionToken = randomToken(32);
    const refreshToken = randomToken(48);
    const expiresAt = new Date(Date.now() + env.auth.refreshTtlDays * 86_400_000);

    const sessionId = await withTransaction(async (tx) => {
      const id = await authRepository.createSession(
        {
          adminUserId: admin.id,
          activeShopId,
          sessionTokenHash: hashToken(sessionToken),
          refreshTokenHash: hashToken(refreshToken),
          ip: meta.ip,
          userAgent: meta.userAgent,
          expiresAt,
        },
        tx,
      );
      await authRepository.recordSuccessfulLogin(admin.id, meta.ip, tx);
      return id;
    }, controlPlane);

    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'admin.logged_in',
      entityType: 'admin_user',
      entityId: admin.id,
      summary: `${admin.email} signed in`,
      context: { request_id: meta.requestId, session_id: sessionId, active_shop_id: activeShopId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return loginPayload(admin, sessionId, refreshToken, activeShopId);
  },

  /**
   * Rotating refresh. The old token is overwritten in the same UPDATE that
   * issues the new one, so replaying it matches zero rows — at which point we
   * treat the session as compromised and revoke it outright.
   */
  async refresh(refreshToken: string, _meta: RequestMeta): Promise<LoginResult> {
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
    return loginPayload(admin, session.id, newRefreshToken, session.active_shop_id);
  },

  async logout(admin: SessionActor, meta: RequestMeta): Promise<void> {
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

  /**
   * Makes another shop the one this session's requests go to by default.
   * Tabs can still address any shop per request with X-Veylog-Shop; this is
   * what a request that does not say gets.
   */
  async switchShop(admin: SessionActor, reference: string, meta: RequestMeta) {
    const shop = await shopDirectory.byReference(reference);
    if (!shop) throw ApiError.shopNotFound('That shop does not exist.');
    const row = await authRepository.findById(admin.id);
    if (!row) throw ApiError.notFound('Account');

    const authority = await authorityIn(shop, row);
    await authRepository.setActiveShop(admin.sessionId, shop.id);
    invalidateSessionCache(admin.sessionId);

    await tenancy.run(shop, () =>
      auditService.log({
        actorId: admin.id,
        actorLabel: admin.email,
        action: 'admin.shop_switched',
        entityType: 'shop',
        entityId: shop.id,
        summary: `${admin.email} switched to ${shop.name}`,
        context: { request_id: meta.requestId, session_id: admin.sessionId, from_shop_id: admin.shop?.id ?? null },
        ip: meta.ip,
        userAgent: meta.userAgent,
      }),
    );

    const memberships = await authRepository.listMemberships(admin.id);
    return {
      active_shop: memberships.find((m) => m.shop_id === shop.id) ?? {
        shop_id: shop.id,
        handle: shop.handle,
        name: shop.name,
        status: shop.status,
        primary_domain: shop.primaryDomain,
        is_owner: false,
        has_full_access: authority.fullAccess,
        member_status: 'active' as const,
      },
      permissions: authority.fullAccess ? ['*'] : [...authority.permissions],
      is_super_admin: authority.fullAccess,
    };
  },

  async listShops(adminId: number): Promise<ShopMembership[]> {
    return authRepository.listMemberships(adminId);
  },

  async changePassword(
    admin: SessionActor,
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
    }, controlPlane);

    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'admin.password_changed',
      entityType: 'admin_user',
      entityId: admin.id,
      summary: `${admin.email} changed their password`,
      context: { request_id: meta.requestId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    invalidateSessionCache();
  },

  async listSessions(adminId: number) {
    const rows = await authRepository.listSessions(adminId);
    return rows.map((s) => ({
      id: s.id,
      user_agent: s.user_agent,
      active_shop_id: s.active_shop_id,
      last_active_at: s.last_active_at.toISOString(),
      expires_at: s.expires_at.toISOString(),
      created_at: s.created_at.toISOString(),
    }));
  },

  async revokeSession(admin: SessionActor, sessionId: number): Promise<void> {
    const sessions = await authRepository.listSessions(admin.id);
    if (!sessions.some((s) => s.id === sessionId)) throw ApiError.notFound('Session');
    await authRepository.revokeSession(sessionId, 'revoked_by_user');
    invalidateSessionCache();
  },

  /**
   * Used by the authenticate middleware on every request. Verifies the JWT,
   * confirms the session is still live, picks the shop, and resolves this
   * person's authority in it — all cached, because this runs on the hot path.
   *
   * `requestedShop` is the X-Veylog-Shop header when the client sent one.
   * Returns null for the shop when the person has none to open, which only
   * the routes that manage identity itself accept.
   */
  async resolveFromAccessToken(
    token: string,
    request: { requestedShop?: string | null; method: string; path: string },
  ): Promise<{ admin: AuthenticatedAdmin | null; identity: AdminRow; sessionId: number; shop: ShopContext | null }> {
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
      cached = { adminId: session.admin_user_id, activeShopId: session.active_shop_id, expiresAt: now + SESSION_CACHE_MS };
      sessionCache.set(sessionId, cached);
      void authRepository.touchSession(session.id).catch(() => undefined);
    }

    if (String(cached.adminId) !== payload.sub) {
      throw ApiError.unauthenticated('Token does not match its session.', 'SESSION_REVOKED');
    }

    const admin = await authRepository.findById(cached.adminId);
    if (!admin) throw ApiError.unauthenticated('Account no longer exists.');
    if (admin.status !== 'active') throw new ApiError(403, 'ACCOUNT_INACTIVE', `This account is ${admin.status}.`);

    let shop: ShopContext | null;
    if (request.requestedShop) {
      shop = await shopDirectory.byReference(request.requestedShop);
      if (!shop) throw ApiError.shopNotFound('The shop named in X-Veylog-Shop does not exist.');
    } else {
      shop = await defaultShopFor(admin.id, cached.activeShopId);
    }

    if (!shop) return { admin: null, identity: admin, sessionId, shop: null };

    const platformRole = admin.platform_role ?? 'none';
    assertAdminCanUse(shop, platformRole, request.method, request.path);
    const authority = await authorityIn(shop, admin);
    if (cached.activeShopId !== shop.id && !request.requestedShop) {
      // The session's shop was gone or never set; remember what we fell back to.
      void authRepository.setActiveShop(sessionId, shop.id).catch(() => undefined);
      cached.activeShopId = shop.id;
    }
    const touchKey = authorityKey(shop.id, admin.id);
    if ((lastTouched.get(touchKey) ?? 0) < now - TOUCH_EVERY_MS) {
      lastTouched.set(touchKey, now);
      void authRepository.touchMembership(shop.id, admin.id).catch(() => undefined);
    }

    return {
      identity: admin,
      sessionId,
      shop,
      admin: {
        kind: 'staff',
        id: admin.id,
        publicId: admin.public_id,
        email: admin.email,
        firstName: admin.first_name,
        lastName: admin.last_name,
        isSuperAdmin: authority.fullAccess,
        isShopOwner: authority.isOwner,
        platformRole,
        sessionId,
        permissions: authority.permissions,
        shop,
      },
    };
  },
};
