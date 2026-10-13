import { controlPlane, execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';
import type { AdminRow } from '../auth/auth.repository';

/**
 * Staff of the current shop.
 *
 * A staff member is two things: an identity (admin_users — one person, one
 * login, shared by every shop they work in) and a membership (shop_staff —
 * their standing in THIS shop). Roles hang off the membership: the same person
 * can be Operations here and Support next door. Reads join all three; writes
 * say which of the two they change, because changing an identity reaches every
 * shop the person belongs to.
 */

export interface AdminListRow extends AdminRow {
  role_slugs: string | null;
  role_names: string | null;
  role_ids: string | null;
  member_status: 'invited' | 'active' | 'suspended';
  is_owner: number;
  has_full_access: number;
  member_job_title: string | null;
  joined_at: Date | null;
  /** Other shops this identity belongs to — decides whether identity edits are ours to make. */
  other_shop_count: number;
}

export interface CountRow extends RowDataPacket {
  total: number;
}

export interface RoleRow extends RowDataPacket {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  is_system: number;
  level: number;
  permission_count?: number;
}

export interface ListFilters {
  search?: string;
  status?: string;
  roleId?: number;
  includeDeleted?: boolean;
}

// Opens with `ss.shop_id = ?`; every caller binds the shop first.
const BASE_SELECT = `
  SELECT a.*,
         ss.status AS member_status, ss.is_owner, ss.has_full_access,
         ss.job_title AS member_job_title, ss.joined_at,
         (SELECT COUNT(*) FROM shop_staff o WHERE o.admin_user_id = a.id AND o.shop_id <> ss.shop_id) AS other_shop_count,
         GROUP_CONCAT(DISTINCT r.id   ORDER BY r.level SEPARATOR ',') AS role_ids,
         GROUP_CONCAT(DISTINCT r.slug ORDER BY r.level SEPARATOR ',') AS role_slugs,
         GROUP_CONCAT(DISTINCT r.name ORDER BY r.level SEPARATOR '|') AS role_names
    FROM shop_staff ss
    JOIN admin_users a             ON a.id = ss.admin_user_id AND a.account_type = 'human'
    LEFT JOIN admin_user_roles aur ON aur.admin_user_id = a.id AND aur.shop_id = ss.shop_id
    LEFT JOIN roles r              ON r.id = aur.role_id AND r.shop_id = aur.shop_id
   WHERE ss.shop_id = ?`;

/**
 * Roles are aggregated with GROUP_CONCAT rather than fetched per row. On a
 * fifty-row admin list that is the difference between one query and fifty-one.
 */
function buildWhere(filters: ListFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [shopId()];

  if (!filters.includeDeleted) conditions.push('a.deleted_at IS NULL');
  if (filters.status) {
    // Status is the membership's: suspended here says nothing about elsewhere.
    conditions.push('ss.status = ?');
    params.push(filters.status);
  }
  if (filters.search) {
    conditions.push('(a.email LIKE ? OR a.first_name LIKE ? OR a.last_name LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  if (filters.roleId) {
    conditions.push(
      'EXISTS (SELECT 1 FROM admin_user_roles x WHERE x.shop_id = ss.shop_id AND x.admin_user_id = a.id AND x.role_id = ?)',
    );
    params.push(filters.roleId);
  }

  return { clause: conditions.length > 0 ? ` AND ${conditions.join(' AND ')}` : '', params };
}

export const adminUsersRepository = {
  async list(
    filters: ListFilters,
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<AdminListRow[]> {
    const { clause, params } = buildWhere(filters);
    return query<AdminListRow>(
      `${BASE_SELECT}${clause} GROUP BY a.id, ss.id ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async count(filters: ListFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<CountRow>(
      `SELECT COUNT(DISTINCT a.id) AS total
         FROM shop_staff ss
         JOIN admin_users a ON a.id = ss.admin_user_id AND a.account_type = 'human'
        WHERE ss.shop_id = ?${clause}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  /** Seats used: everyone active or invited. Suspended staff do not hold a seat. */
  async countSeats(exec: Executor = controlPlane): Promise<number> {
    const row = await queryOne<CountRow>(
      `SELECT COUNT(*) AS total FROM shop_staff ss
         JOIN admin_users a ON a.id = ss.admin_user_id AND a.account_type = 'human' AND a.deleted_at IS NULL
        WHERE ss.shop_id = ? AND ss.status IN ('active','invited')`,
      [shopId()],
      exec,
    );
    return row?.total ?? 0;
  },

  async findById(id: number, exec: Executor = pool): Promise<AdminListRow | null> {
    return queryOne<AdminListRow>(`${BASE_SELECT} AND a.id = ? GROUP BY a.id, ss.id LIMIT 1`, [shopId(), id], exec);
  },

  // ── identity (control plane) ─────────────────────────────────────────────

  async findIdentityByEmail(email: string, exec: Executor = controlPlane): Promise<AdminRow | null> {
    return queryOne<AdminRow>('SELECT * FROM admin_users WHERE email = ? AND deleted_at IS NULL LIMIT 1', [email], exec);
  },

  async emailExists(email: string, excludeId?: number, exec: Executor = controlPlane): Promise<boolean> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      excludeId
        ? 'SELECT id FROM admin_users WHERE email = ? AND id <> ? LIMIT 1'
        : 'SELECT id FROM admin_users WHERE email = ? LIMIT 1',
      excludeId ? [email, excludeId] : [email],
      exec,
    );
    return row !== null;
  },

  async createIdentity(
    data: {
      email: string;
      passwordHash: string | null;
      firstName: string;
      lastName: string | null;
      phone: string | null;
      jobTitle: string | null;
      status: 'invited' | 'active';
      mustChangePassword: boolean;
      timezone: string;
      createdByAdminId: number | null;
    },
    exec: Executor = controlPlane,
  ): Promise<number> {
    // is_super_admin stays 0: authority lives on the membership now.
    return insert(
      `INSERT INTO admin_users
         (email, password_hash, first_name, last_name, phone, job_title, status,
          is_super_admin, must_change_password, password_changed_at, timezone, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ${data.passwordHash ? 'NOW()' : 'NULL'}, ?, ?)`,
      [
        data.email,
        data.passwordHash,
        data.firstName,
        data.lastName,
        data.phone,
        data.jobTitle,
        data.status,
        data.mustChangePassword ? 1 : 0,
        data.timezone,
        data.createdByAdminId,
      ],
      exec,
    );
  },

  async updateIdentity(id: number, fields: Record<string, unknown>, exec: Executor = controlPlane): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    // Column names come from a fixed map in the service, never from the request.
    const assignments = keys.map((k) => `\`${k}\` = ?`).join(', ');
    await execute(`UPDATE admin_users SET ${assignments} WHERE id = ?`, [...Object.values(fields), id], exec);
  },

  async softDeleteIdentity(id: number, exec: Executor = controlPlane): Promise<void> {
    // The email is released on delete (prefixed and timestamped) so the same
    // person can be re-invited later without colliding with their old row.
    await execute(
      `UPDATE admin_users
          SET deleted_at = NOW(),
              status = 'disabled',
              email = CONCAT('deleted+', id, '+', UNIX_TIMESTAMP(), '@deleted.invalid')
        WHERE id = ? AND deleted_at IS NULL`,
      [id],
      exec,
    );
  },

  async membershipCount(adminId: number, exec: Executor = controlPlane): Promise<number> {
    const row = await queryOne<CountRow>('SELECT COUNT(*) AS total FROM shop_staff WHERE admin_user_id = ?', [adminId], exec);
    return row?.total ?? 0;
  },

  // ── membership (control plane) ───────────────────────────────────────────

  async findMembership(adminId: number, exec: Executor = controlPlane) {
    return queryOne<RowDataPacket & { id: number; status: string; is_owner: number; has_full_access: number }>(
      'SELECT id, status, is_owner, has_full_access FROM shop_staff WHERE shop_id = ? AND admin_user_id = ?',
      [shopId(), adminId],
      exec,
    );
  },

  async createMembership(
    data: { adminUserId: number; status: 'invited' | 'active'; fullAccess: boolean; jobTitle: string | null; invitedBy: number },
    exec: Executor = controlPlane,
  ): Promise<void> {
    await execute(
      `INSERT INTO shop_staff (shop_id, admin_user_id, is_owner, has_full_access, status, job_title, invited_by_admin_id, joined_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, IF(? = 'active', NOW(), NULL))`,
      [shopId(), data.adminUserId, data.fullAccess ? 1 : 0, data.status, data.jobTitle, data.invitedBy, data.status],
      exec,
    );
  },

  async updateMembership(
    adminId: number,
    fields: { status?: 'invited' | 'active' | 'suspended'; has_full_access?: number; job_title?: string | null },
    exec: Executor = controlPlane,
  ): Promise<void> {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([key]) => `\`${key}\` = ?`);
    if (fields.status === 'active') sets.push('joined_at = COALESCE(joined_at, NOW())');
    await execute(
      `UPDATE shop_staff SET ${sets.join(', ')} WHERE shop_id = ? AND admin_user_id = ?`,
      [...entries.map(([, value]) => value), shopId(), adminId],
      exec,
    );
  },

  async removeMembership(adminId: number, exec: Executor = controlPlane): Promise<void> {
    await execute('DELETE FROM shop_staff WHERE shop_id = ? AND admin_user_id = ? AND is_owner = 0', [shopId(), adminId], exec);
  },

  // ── roles in this shop (tenant) ──────────────────────────────────────────

  async setRoles(adminId: number, roleIds: number[], assignedBy: number | null, exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM admin_user_roles WHERE shop_id = ? AND admin_user_id = ?', [shopId(), adminId], exec);
    if (roleIds.length === 0) return;
    const values = roleIds.map(() => '(?, ?, ?, ?)').join(', ');
    const params = roleIds.flatMap((roleId) => [shopId(), adminId, roleId, assignedBy]);
    await execute(
      `INSERT INTO admin_user_roles (shop_id, admin_user_id, role_id, assigned_by_admin_id) VALUES ${values}`,
      params,
      exec,
    );
  },

  async clearGrants(adminId: number, exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM admin_user_roles WHERE shop_id = ? AND admin_user_id = ?', [shopId(), adminId], exec);
    await execute('DELETE FROM admin_user_permissions WHERE shop_id = ? AND admin_user_id = ?', [shopId(), adminId], exec);
  },

  async getRoles(adminId: number, exec: Executor = pool): Promise<RoleRow[]> {
    return query<RoleRow>(
      `SELECT r.* FROM roles r
         JOIN admin_user_roles aur ON aur.role_id = r.id AND aur.shop_id = r.shop_id
        WHERE aur.shop_id = ? AND aur.admin_user_id = ?
        ORDER BY r.level`,
      [shopId(), adminId],
      exec,
    );
  },

  /** The ids a request named that are roles IN THIS SHOP. */
  async validateRoleIds(roleIds: number[], exec: Executor = pool): Promise<number[]> {
    if (roleIds.length === 0) return [];
    const placeholders = roleIds.map(() => '?').join(',');
    const rows = await query<RowDataPacket & { id: number }>(
      `SELECT id FROM roles WHERE shop_id = ? AND id IN (${placeholders})`,
      [shopId(), ...roleIds],
      exec,
    );
    return rows.map((r) => r.id);
  },

  /** Withdraws outstanding invitations for an address, so only the newest link works. */
  async revokeInvites(email: string, exec: Executor = pool): Promise<void> {
    await execute(
      'UPDATE admin_invites SET revoked_at = UTC_TIMESTAMP() WHERE shop_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL',
      [shopId(), email],
      exec,
    );
  },

  async createInvite(
    data: { email: string; roleId: number | null; tokenHash: string; invitedBy: number; expiresAt: Date },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO admin_invites (shop_id, email, role_id, token_hash, invited_by_admin_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [shopId(), data.email, data.roleId, data.tokenHash, data.invitedBy, data.expiresAt],
      exec,
    );
  },
};
