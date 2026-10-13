import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../core/ApiError';

/**
 * Route-level authorisation gate.
 *
 *   router.post('/', authenticate, requirePermission('products.create'), ...)
 *
 * A super admin bypasses the check entirely. Passing several slugs means ANY
 * of them is sufficient; use requireAllPermissions when every one is needed.
 */
export function requirePermission(...slugs: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const admin = req.admin;
    if (!admin) {
      next(ApiError.unauthenticated());
      return;
    }
    if (admin.isSuperAdmin) {
      next();
      return;
    }
    const granted = slugs.some((slug) => admin.permissions.has(slug));
    if (!granted) {
      next(
        ApiError.forbidden('You do not have permission to perform this action.', {
          required: slugs,
        }),
      );
      return;
    }
    next();
  };
}

export function requireAllPermissions(...slugs: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const admin = req.admin;
    if (!admin) {
      next(ApiError.unauthenticated());
      return;
    }
    if (admin.isSuperAdmin) {
      next();
      return;
    }
    const missing = slugs.filter((slug) => !admin.permissions.has(slug));
    if (missing.length > 0) {
      next(ApiError.forbidden('You do not have permission to perform this action.', { missing }));
      return;
    }
    next();
  };
}

/** For the handful of operations only someone with full access to the shop may perform. */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.admin) {
    next(ApiError.unauthenticated());
    return;
  }
  if (!req.admin.isSuperAdmin) {
    next(ApiError.forbidden('This action is restricted to staff with full access to the store.'));
    return;
  }
  next();
}

/** Only the shop's owner: closing the store, transferring it, changing the plan. */
export function requireShopOwner(req: Request, _res: Response, next: NextFunction): void {
  if (!req.admin) {
    next(ApiError.unauthenticated());
    return;
  }
  if (!req.admin.isShopOwner && req.admin.platformRole !== 'admin') {
    next(ApiError.forbidden('Only the store owner can do this.'));
    return;
  }
  next();
}

/** A person, not an app token. Consent screens, staff management, security settings. */
export function requireStaff(req: Request, _res: Response, next: NextFunction): void {
  if (!req.admin && !req.identity) {
    next(ApiError.unauthenticated());
    return;
  }
  if (req.admin?.kind === 'app') {
    next(ApiError.forbidden('Apps cannot perform this action.'));
    return;
  }
  next();
}

/** An installed app acting on itself (its own scopes, its own uninstall). */
export function requireApp(req: Request, _res: Response, next: NextFunction): void {
  if (req.admin?.kind !== 'app') {
    next(ApiError.forbidden('This endpoint is for app access tokens.'));
    return;
  }
  next();
}

/**
 * Staff need the permission; apps are let through because the service scopes
 * what they touch to their own resources (an app manages its own webhook
 * subscriptions, never the shop's or another app's).
 */
export function requireStaffPermissionOrApp(...slugs: string[]) {
  const staffCheck = requirePermission(...slugs);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.admin?.kind === 'app') {
      next();
      return;
    }
    staffCheck(req, res, next);
  };
}

/** Operators of the platform itself — not merchants, however senior. */
export function requirePlatformRole(...roles: ('admin' | 'support')[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const role = req.identity?.platformRole ?? req.admin?.platformRole ?? 'none';
    if (req.admin?.kind === 'app' || !roles.includes(role as 'admin' | 'support')) {
      next(ApiError.forbidden('This action is restricted to platform staff.'));
      return;
    }
    next();
  };
}

export const requirePlatformAdmin = requirePlatformRole('admin');
