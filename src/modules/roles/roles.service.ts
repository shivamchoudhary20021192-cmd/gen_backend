import { ApiError } from '../../core/ApiError';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import { invalidatePermissionCache } from '../auth/auth.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { rolesRepository, type PermissionRow, type RoleRow } from './roles.repository';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

function presentRole(row: RoleRow, permissions?: PermissionRow[]) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    is_system: row.is_system === 1,
    level: row.level,
    permission_count: Number(row.permission_count ?? 0),
    admin_count: Number(row.admin_count ?? 0),
    ...(permissions ? { permissions: permissions.map((p) => ({ id: p.id, slug: p.slug, name: p.name, module: p.module })) } : {}),
  };
}

export const rolesService = {
  async list() {
    const roles = await rolesRepository.list();
    return { roles: roles.map((r) => presentRole(r)) };
  },

  async get(id: number) {
    const role = await rolesRepository.findById(id);
    if (!role) throw ApiError.notFound('Role');
    const permissions = await rolesRepository.permissionsForRole(id);
    return { role: presentRole(role, permissions) };
  },

  /** Grouped by module, which is how the permission matrix is rendered. */
  async listPermissions() {
    const permissions = await rolesRepository.allPermissions();
    const grouped: Record<string, unknown[]> = {};
    for (const p of permissions) {
      (grouped[p.module] ??= []).push({
        id: p.id,
        slug: p.slug,
        action: p.action,
        name: p.name,
        description: p.description,
        is_dangerous: p.is_dangerous === 1,
      });
    }
    return { permissions: grouped, total: permissions.length };
  },

  async create(
    input: { slug: string; name: string; description?: string | null; level: number; permission_ids: number[] },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const valid = await rolesRepository.validatePermissionIds(input.permission_ids);
    const unknown = input.permission_ids.filter((id) => !valid.includes(id));
    if (unknown.length > 0) {
      throw ApiError.validation({ 'role.permission_ids': [`Unknown permission id(s): ${unknown.join(', ')}`] });
    }

    const id = await withTransaction(async (tx) => {
      const roleId = await rolesRepository.create(
        { slug: input.slug, name: input.name, description: input.description ?? null, level: input.level },
        tx,
      );
      await rolesRepository.setPermissions(roleId, valid, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'role.created',
          entityType: 'role',
          entityId: roleId,
          summary: `Created role ${input.slug}`,
          changes: { permissions: { from: null, to: valid } },
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return roleId;
    });

    return this.get(id);
  },

  async update(
    id: number,
    input: { name?: string; description?: string | null; level?: number; permission_ids?: number[] },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const role = await rolesRepository.findById(id);
    if (!role) throw ApiError.notFound('Role');

    // System roles are renameable but their identity (slug) is fixed, because
    // code and seed data reference them by slug.
    const fields: Record<string, unknown> = {};
    if (input.name !== undefined) fields.name = input.name;
    if (input.description !== undefined) fields.description = input.description;
    if (input.level !== undefined) fields.level = input.level;

    let permissionIds: number[] | undefined;
    if (input.permission_ids) {
      const valid = await rolesRepository.validatePermissionIds(input.permission_ids);
      const unknown = input.permission_ids.filter((pid) => !valid.includes(pid));
      if (unknown.length > 0) {
        throw ApiError.validation({ 'role.permission_ids': [`Unknown permission id(s): ${unknown.join(', ')}`] });
      }
      permissionIds = valid;
    }

    await withTransaction(async (tx) => {
      if (Object.keys(fields).length > 0) await rolesRepository.update(id, fields, tx);
      if (permissionIds) await rolesRepository.setPermissions(id, permissionIds, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'role.updated',
          entityType: 'role',
          entityId: id,
          summary: `Updated role ${role.slug}`,
          changes: {
            ...(auditService.diff(role as unknown as Record<string, unknown>, fields) ?? {}),
            ...(permissionIds ? { permissions: { to: permissionIds } } : {}),
          },
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    // Anyone holding this role now has a different permission set.
    invalidatePermissionCache();
    return this.get(id);
  },

  async remove(id: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<void> {
    const role = await rolesRepository.findById(id);
    if (!role) throw ApiError.notFound('Role');
    if (role.is_system === 1) throw ApiError.conflict('System roles cannot be deleted.');
    if (Number(role.admin_count) > 0) {
      throw ApiError.conflict(
        `This role is assigned to ${role.admin_count} admin(s). Reassign them first.`,
        'IN_USE',
      );
    }

    await withTransaction(async (tx) => {
      await rolesRepository.remove(id, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'role.deleted',
          entityType: 'role',
          entityId: id,
          summary: `Deleted role ${role.slug}`,
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    invalidatePermissionCache();
  },
};
