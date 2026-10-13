import { tenancy } from '../../platform/tenancy/context';
import { platformMail } from '../../platform/mail/mailer';
import { adminUrl } from '../../platform/mail/templates';
import { accountsService, INVITE_DAYS } from '../auth/accounts.service';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination, parseSort, type PaginationMeta } from '../../core/pagination';
import { controlPlane } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { entitlements } from '../../platform/plans/entitlements';
import { auditService } from '../../shared/audit.service';
import { authRepository } from '../auth/auth.repository';
import { invalidatePermissionCache, invalidateSessionCache, toPublicAdmin } from '../auth/auth.service';
import type { AuthenticatedAdmin, PublicAdmin } from '../auth/auth.types';
import { adminUsersRepository, type AdminListRow } from './adminUsers.repository';

/**
 * Staff management for the current shop.
 *
 * The routes keep their old names (/admin-users) so the admin frontend did not
 * have to change, but what they manage is now a MEMBERSHIP: this person's
 * standing in this shop. The person themselves — their login, password, email —
 * may also belong to other shops, and this shop may change them only when it is
 * the only shop they belong to. Otherwise one merchant could reset the password
 * of an account that also runs someone else's store.
 */

const SORTABLE: Record<string, string> = {
  created_at: 'a.created_at',
  email: 'a.email',
  first_name: 'a.first_name',
  last_login_at: 'a.last_login_at',
  status: 'ss.status',
};

/** Identity columns the API may write — only for someone who belongs to this shop alone. */
const IDENTITY_FIELDS: Record<string, string> = {
  email: 'email',
  first_name: 'first_name',
  last_name: 'last_name',
  phone: 'phone',
  timezone: 'timezone',
  avatar_media_id: 'avatar_media_id',
};

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

function present(row: AdminListRow): PublicAdmin & { is_shop_owner: boolean; belongs_to_other_shops: boolean } {
  const fullAccess = row.has_full_access === 1 || row.is_owner === 1;
  const base = toPublicAdmin(row, fullAccess);
  const ids = row.role_ids ? row.role_ids.split(',') : [];
  const slugs = row.role_slugs ? row.role_slugs.split(',') : [];
  const names = row.role_names ? row.role_names.split('|') : [];
  base.roles = ids.map((id, i) => ({ id: Number(id), slug: slugs[i] ?? '', name: names[i] ?? '' }));
  // The person's standing HERE. An identity disabled platform-wide overrides it.
  if (row.status !== 'disabled') base.status = row.member_status;
  base.job_title = row.member_job_title ?? row.job_title;
  return { ...base, is_shop_owner: row.is_owner === 1, belongs_to_other_shops: Number(row.other_shop_count) > 0 };
}

async function load(id: number): Promise<AdminListRow> {
  const row = await adminUsersRepository.findById(id);
  if (!row || row.deleted_at) throw ApiError.notFound('Staff member');
  return row;
}

function assertNotOwner(row: AdminListRow, action: string): void {
  if (row.is_owner === 1) {
    throw ApiError.conflict(`The store owner cannot be ${action}. Transfer ownership first.`);
  }
}

function assertIdentityIsOurs(row: AdminListRow, actor: AuthenticatedAdmin, what: string): void {
  if (Number(row.other_shop_count) > 0 && actor.platformRole !== 'admin') {
    throw ApiError.forbidden(
      `${row.email} also works in another store, so their ${what} belongs to them. They can change it from their own account.`,
    );
  }
}

export const adminUsersService = {
  async list(queryParams: Record<string, unknown>): Promise<{ admin_users: PublicAdmin[]; pagination: PaginationMeta }> {
    const page = parsePagination(queryParams);
    const orderBy = parseSort(queryParams.sort, SORTABLE, 'a.created_at DESC');
    const filters = {
      search: queryParams.q as string | undefined,
      status: queryParams.status as string | undefined,
      roleId: queryParams.role_id as number | undefined,
      includeDeleted: queryParams.include_deleted === true,
    };

    const [rows, total] = await Promise.all([
      adminUsersRepository.list(filters, orderBy, page.limit, page.offset),
      adminUsersRepository.count(filters),
    ]);

    return { admin_users: rows.map(present), pagination: buildMeta(total, page) };
  },

  async get(id: number): Promise<PublicAdmin> {
    return present(await load(id));
  },

  /**
   * Adds someone to this shop's staff. A new email creates an account; an
   * email that already has one (they work in another store) just gains a
   * membership here — their password and profile are theirs and untouched.
   */
  async create(
    input: {
      email: string;
      password?: string;
      first_name: string;
      last_name?: string | null;
      phone?: string | null;
      job_title?: string | null;
      timezone?: string;
      role_ids: number[];
      is_super_admin: boolean;
      must_change_password: boolean;
    },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ): Promise<PublicAdmin & { existing_account?: boolean }> {
    // Only someone with full access can grant it — otherwise any account with
    // admins.manage could quietly promote itself past every restriction.
    if (input.is_super_admin && !actor.isSuperAdmin) {
      throw ApiError.forbidden('Only staff with full access can grant full access.');
    }

    const validRoleIds = await adminUsersRepository.validateRoleIds(input.role_ids);
    const unknownRoles = input.role_ids.filter((id) => !validRoleIds.includes(id));
    if (unknownRoles.length > 0) {
      throw ApiError.validation({ 'admin_user.role_ids': [`Unknown role id(s): ${unknownRoles.join(', ')}`] });
    }
    if (validRoleIds.length === 0 && !input.is_super_admin) {
      throw ApiError.validation({ 'admin_user.role_ids': ['Assign at least one role, or give the account full access.'] });
    }

    await entitlements.assertWithinLimit('staff_accounts', await adminUsersRepository.countSeats());

    const existing = await adminUsersRepository.findIdentityByEmail(input.email);
    if (existing && existing.account_type !== 'human') {
      throw ApiError.conflict('That email address is reserved.', 'EMAIL_TAKEN');
    }
    if (existing && (await adminUsersRepository.findMembership(existing.id))) {
      throw ApiError.conflict(`${input.email} is already on this store's staff.`, 'EMAIL_TAKEN');
    }

    let adminId: number;
    let membershipStatus: 'invited' | 'active';
    if (existing) {
      adminId = existing.id;
      // They already sign in; the only question is whether they may yet.
      membershipStatus = existing.status === 'active' ? 'active' : 'invited';
    } else {
      const passwordHash = input.password ? await bcrypt.hash(input.password, env.auth.bcryptRounds) : null;
      membershipStatus = passwordHash ? 'active' : 'invited';
      adminId = await withTransaction(
        (tx) =>
          adminUsersRepository.createIdentity(
            {
              email: input.email,
              passwordHash,
              firstName: input.first_name,
              lastName: input.last_name ?? null,
              phone: input.phone ?? null,
              jobTitle: input.job_title ?? null,
              // No password yet means the account is an invitation, not a login.
              status: membershipStatus,
              mustChangePassword: Boolean(passwordHash) && input.must_change_password,
              timezone: input.timezone ?? tenancy.current().timezone,
              createdByAdminId: actor.id,
            },
            tx,
          ),
        controlPlane,
      );
    }

    await adminUsersRepository.createMembership({
      adminUserId: adminId,
      status: membershipStatus,
      fullAccess: input.is_super_admin,
      jobTitle: input.job_title ?? null,
      invitedBy: actor.id,
    });

    await withTransaction(async (tx) => {
      await adminUsersRepository.setRoles(adminId, validRoleIds, actor.id, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'admin_user.created',
          entityType: 'admin_user',
          entityId: adminId,
          summary: `${existing ? 'Added existing account' : 'Created staff account'} ${input.email}`,
          changes: {
            email: { from: null, to: input.email },
            roles: { from: null, to: validRoleIds },
            full_access: { from: null, to: input.is_super_admin },
          },
          context: { request_id: meta.requestId, existing_account: Boolean(existing) },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    invalidatePermissionCache(adminId);
    // Tell them: an invitation carries the link to choose a password; someone
    // who already signs in is told where to find the store.
    await this.notifyNewStaff(input.email, membershipStatus, validRoleIds[0] ?? null, actor);
    return { ...(await this.get(adminId)), ...(existing ? { existing_account: true } : {}) };
  },

  async notifyNewStaff(email: string, membershipStatus: 'invited' | 'active', roleId: number | null, actor: AuthenticatedAdmin): Promise<void> {
    const shop = tenancy.current();
    const inviterName = [actor.firstName, actor.lastName].filter(Boolean).join(' ') || actor.email;
    if (membershipStatus === 'active') {
      await platformMail.send({ to: email, template: 'staff.added', data: { shopName: shop.name, inviterName, loginUrl: adminUrl('/login') }, shopId: shop.id });
      return;
    }
    const { token, hash } = accountsService.newToken();
    await adminUsersRepository.revokeInvites(email);
    await adminUsersRepository.createInvite({ email, roleId, tokenHash: hash, invitedBy: actor.id, expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) });
    await platformMail.send({
      to: email,
      template: 'staff.invitation',
      data: { shopName: shop.name, inviterName, acceptUrl: adminUrl(`/accept-invite?token=${token}`), expiresDays: INVITE_DAYS },
      shopId: shop.id,
    });
  },

  /** A new invitation link for someone who has not accepted yet; the old one stops working. */
  async resendInvitation(id: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<{ sent: true }> {
    const membership = await adminUsersRepository.findMembership(id);
    if (!membership) throw ApiError.notFound('Staff member');
    if (membership.status !== 'invited') throw ApiError.conflict('This person has already accepted their invitation.', 'INVALID_TRANSITION');
    const person = await adminUsersRepository.findById(id);
    if (!person) throw ApiError.notFound('Staff member');
    await this.notifyNewStaff(person.email, 'invited', null, actor);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'admin_user.invitation_resent',
      entityType: 'admin_user',
      entityId: id,
      summary: `Invitation sent again to ${person.email}`,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { sent: true };
  },

  async update(
    id: number,
    input: Record<string, unknown>,
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ): Promise<PublicAdmin> {
    const existing = await load(id);

    if ('is_super_admin' in input) {
      if (!actor.isSuperAdmin) throw ApiError.forbidden('Only staff with full access can change full access.');
      if (input.is_super_admin === false) assertNotOwner(existing, 'limited');
    }

    const identityFields: Record<string, unknown> = {};
    for (const [apiKey, column] of Object.entries(IDENTITY_FIELDS)) {
      if (apiKey in input) identityFields[column] = input[apiKey] ?? null;
    }
    if (Object.keys(identityFields).length > 0) {
      assertIdentityIsOurs(existing, actor, 'profile');
      if (typeof identityFields.email === 'string' && (await adminUsersRepository.emailExists(identityFields.email, id))) {
        throw ApiError.conflict('That email address is already registered.', 'EMAIL_TAKEN');
      }
    }

    const membershipFields: { has_full_access?: number; job_title?: string | null } = {};
    if ('is_super_admin' in input) membershipFields.has_full_access = input.is_super_admin ? 1 : 0;
    if ('job_title' in input) membershipFields.job_title = (input.job_title as string | null) ?? null;

    if (Object.keys(identityFields).length === 0 && Object.keys(membershipFields).length === 0) return present(existing);

    const before: Record<string, unknown> = {};
    for (const key of Object.keys(identityFields)) before[key] = (existing as unknown as Record<string, unknown>)[key];
    if ('has_full_access' in membershipFields) before.has_full_access = existing.has_full_access;
    if ('job_title' in membershipFields) before.job_title = existing.member_job_title;

    await adminUsersRepository.updateIdentity(id, identityFields);
    await adminUsersRepository.updateMembership(id, membershipFields);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'admin_user.updated',
      entityType: 'admin_user',
      entityId: id,
      summary: `Updated staff ${existing.email}`,
      changes: auditService.diff(before, { ...identityFields, ...membershipFields }),
      context: { request_id: meta.requestId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    invalidatePermissionCache(id);
    return this.get(id);
  },

  async setRoles(id: number, roleIds: number[], actor: AuthenticatedAdmin, meta: ActorMeta): Promise<PublicAdmin> {
    const existing = await load(id);

    const valid = await adminUsersRepository.validateRoleIds(roleIds);
    const unknown = roleIds.filter((rid) => !valid.includes(rid));
    if (unknown.length > 0) {
      throw ApiError.validation({ role_ids: [`Unknown role id(s): ${unknown.join(', ')}`] });
    }

    const previous = existing.role_ids ? existing.role_ids.split(',').map(Number) : [];

    await withTransaction(async (tx) => {
      await adminUsersRepository.setRoles(id, valid, actor.id, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'admin_user.roles_changed',
          entityType: 'admin_user',
          entityId: id,
          summary: `Changed roles for ${existing.email}`,
          changes: { roles: { from: previous, to: valid } },
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    // Roles just changed — the cached permission set is now a lie.
    invalidatePermissionCache(id);
    return this.get(id);
  },

  /**
   * Suspends or reinstates someone IN THIS SHOP. Their account, and their
   * access to any other store, is untouched — suspending a contractor here must
   * not lock them out of the client they also work for.
   */
  async setStatus(
    id: number,
    status: 'active' | 'suspended' | 'disabled',
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ): Promise<PublicAdmin> {
    const existing = await load(id);

    if (id === actor.id && status !== 'active') {
      throw ApiError.conflict('You cannot suspend your own access.');
    }
    if (status !== 'active') assertNotOwner(existing, 'suspended');

    const membershipStatus = status === 'active' ? 'active' : 'suspended';
    await adminUsersRepository.updateMembership(id, { status: membershipStatus });
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: `admin_user.${status === 'active' ? 'activated' : 'suspended'}`,
      entityType: 'admin_user',
      entityId: id,
      summary: `${existing.email} set to ${membershipStatus} in this store`,
      changes: { status: { from: existing.member_status, to: membershipStatus } },
      context: { request_id: meta.requestId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    invalidatePermissionCache(id);
    return this.get(id);
  },

  async resetPassword(
    id: number,
    newPassword: string,
    options: { mustChange: boolean; revokeSessions: boolean },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ): Promise<void> {
    const existing = await load(id);
    assertIdentityIsOurs(existing, actor, 'password');

    const hash = await bcrypt.hash(newPassword, env.auth.bcryptRounds);

    await withTransaction(async (tx) => {
      await authRepository.updatePassword(id, hash, tx);
      await adminUsersRepository.updateIdentity(
        id,
        {
          must_change_password: options.mustChange ? 1 : 0,
          // An invited account becomes usable the moment it has a password.
          ...(existing.status === 'invited' ? { status: 'active' } : {}),
        },
        tx,
      );
      if (options.revokeSessions) {
        await authRepository.revokeAllForAdmin(id, 'password_reset_by_admin', undefined, tx);
      }
    }, controlPlane);

    if (existing.member_status === 'invited') await adminUsersRepository.updateMembership(id, { status: 'active' });

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'admin_user.password_reset',
      entityType: 'admin_user',
      entityId: id,
      summary: `Password reset for ${existing.email}`,
      context: { request_id: meta.requestId, revoked_sessions: options.revokeSessions },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    invalidateSessionCache();
  },

  /**
   * Removes someone from this shop's staff. When this was their only store and
   * they are not platform staff, the account itself goes too — the behaviour
   * a single-store installation always had.
   */
  async remove(id: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<void> {
    const existing = await load(id);
    if (id === actor.id) throw ApiError.conflict('You cannot remove yourself.');
    assertNotOwner(existing, 'removed');

    await withTransaction((tx) => adminUsersRepository.clearGrants(id, tx));
    await adminUsersRepository.removeMembership(id);

    const remaining = await adminUsersRepository.membershipCount(id);
    const identityRemoved = remaining === 0 && existing.platform_role === 'none';
    if (identityRemoved) {
      await withTransaction(async (tx) => {
        await adminUsersRepository.softDeleteIdentity(id, tx);
        await authRepository.revokeAllForAdmin(id, 'account_deleted', undefined, tx);
      }, controlPlane);
    }

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'admin_user.deleted',
      entityType: 'admin_user',
      entityId: id,
      summary: `Removed ${existing.email} from staff`,
      context: { request_id: meta.requestId, account_deleted: identityRemoved },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    invalidateSessionCache();
    invalidatePermissionCache(id);
  },

  /** Resolved permissions with their source, for the "why can they do that" view. */
  async permissions(id: number): Promise<{ is_super_admin: boolean; permissions: string[]; roles: unknown[] }> {
    const row = await load(id);
    const fullAccess = row.has_full_access === 1 || row.is_owner === 1;
    const roles = await adminUsersRepository.getRoles(id);
    const permissions = fullAccess ? ['*'] : await authRepository.resolvePermissions(id);
    return {
      is_super_admin: fullAccess,
      permissions,
      roles: roles.map((r) => ({ id: r.id, slug: r.slug, name: r.name, level: r.level })),
    };
  },
};
