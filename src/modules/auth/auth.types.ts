import type { ShopContext } from '../../platform/tenancy/context';

export type PlatformRole = 'none' | 'support' | 'admin';

/**
 * Who is acting, in which shop, with what authority.
 *
 * Two kinds of principal reach the Admin API: a staff member signed in to the
 * admin, and an installed app presenting its access token. Both resolve to
 * this shape, so a route written once — `requirePermission('products.update')`
 * — works for both. An app's granted scopes are compiled into `permissions`.
 */
export interface AuthenticatedAdmin {
  kind: 'staff' | 'app';
  /** admin_users.id — for an app, its bot identity in this shop. */
  id: number;
  publicId: string;
  email: string;
  firstName: string;
  lastName: string | null;
  /**
   * Every permission in the CURRENT shop without listing them: the owner, staff
   * granted full access, or a platform admin. Named for what the existing
   * permission checks already call it.
   */
  isSuperAdmin: boolean;
  isShopOwner: boolean;
  platformRole: PlatformRole;
  /** admin_sessions.id; 0 for an app token. */
  sessionId: number;
  /** Fully resolved permission slugs. Empty when isSuperAdmin (who bypasses). */
  permissions: Set<string>;
  shop: ShopContext;
  /** Set when kind === 'app'. */
  app?: {
    appId: number;
    installationId: number;
    name: string;
    scopes: string[];
  };
}

/** A signed-in person before a shop has been chosen. */
export interface AuthenticatedIdentity {
  id: number;
  publicId: string;
  email: string;
  firstName: string;
  lastName: string | null;
  platformRole: PlatformRole;
  sessionId: number;
  activeShopId: number | null;
}

export interface AccessTokenPayload {
  /** admin_users.id */
  sub: string;
  /**
   * admin_sessions.id. Not a secret — the JWT signature is what makes it
   * unforgeable — which is exactly why refreshing does NOT change it. Rotating
   * the session identifier would 401 every access token already in flight.
   */
  sid: string;
  typ: 'access';
}

export interface ShopMembership {
  shop_id: number;
  handle: string;
  name: string;
  status: string;
  primary_domain: string | null;
  is_owner: boolean;
  has_full_access: boolean;
  member_status: 'invited' | 'active' | 'suspended';
}

export interface LoginResult {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  admin: PublicAdmin;
  permissions: string[];
  must_change_password: boolean;
  /** Every shop this person may open; the admin shows a switcher when > 1. */
  shops: ShopMembership[];
  /** The shop requests go to when they do not name one. */
  active_shop: ShopMembership | null;
}

export interface PublicAdmin {
  id: number;
  public_id: string;
  email: string;
  first_name: string;
  last_name: string | null;
  phone: string | null;
  job_title: string | null;
  status: 'invited' | 'active' | 'suspended' | 'disabled';
  /** Full access in the active shop (see AuthenticatedAdmin.isSuperAdmin). */
  is_super_admin: boolean;
  platform_role: PlatformRole;
  mfa_enabled: boolean;
  avatar_media_id: number | null;
  avatar_url?: string | null;
  timezone: string;
  last_login_at: string | null;
  created_at: string;
  roles?: { id: number; slug: string; name: string }[];
}
