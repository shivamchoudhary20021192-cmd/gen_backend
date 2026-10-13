import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface RoleRow extends RowDataPacket {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  is_system: number;
  level: number;
  permission_count: number;
  admin_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface PermissionRow extends RowDataPacket {
  id: number;
  slug: string;
  module: string;
  action: string;
  name: string;
  description: string | null;
  is_dangerous: number;
  sort_order: number;
}

export const rolesRepository = {
  async list(exec: Executor = pool): Promise<RoleRow[]> {
    return query<RoleRow>(
      `SELECT r.*,
              (SELECT COUNT(*) FROM role_permissions rp WHERE rp.shop_id = r.shop_id AND rp.role_id = r.id) AS permission_count,
              (SELECT COUNT(*) FROM admin_user_roles aur
                 JOIN admin_users a ON a.id = aur.admin_user_id AND a.deleted_at IS NULL
                WHERE aur.shop_id = r.shop_id AND aur.role_id = r.id) AS admin_count
         FROM roles r
        WHERE r.shop_id = ?
        ORDER BY r.level ASC, r.name ASC`,
      [shopId()],
      exec,
    );
  },

  async findById(id: number, exec: Executor = pool): Promise<RoleRow | null> {
    return queryOne<RoleRow>(
      `SELECT r.*,
              (SELECT COUNT(*) FROM role_permissions rp WHERE rp.shop_id = r.shop_id AND rp.role_id = r.id) AS permission_count,
              (SELECT COUNT(*) FROM admin_user_roles aur WHERE aur.shop_id = r.shop_id AND aur.role_id = r.id) AS admin_count
         FROM roles r WHERE r.shop_id = ? AND r.id = ? LIMIT 1`,
      [shopId(), id],
      exec,
    );
  },

  async permissionsForRole(roleId: number, exec: Executor = pool): Promise<PermissionRow[]> {
    return query<PermissionRow>(
      `SELECT p.* FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
        WHERE rp.shop_id = ? AND rp.role_id = ?
        ORDER BY p.module, p.sort_order, p.slug`,
      [shopId(), roleId],
      exec,
    );
  },

  async allPermissions(exec: Executor = pool): Promise<PermissionRow[]> {
    return query<PermissionRow>(
      'SELECT * FROM permissions ORDER BY module, sort_order, slug',
      [],
      exec,
    );
  },

  async validatePermissionIds(ids: number[], exec: Executor = pool): Promise<number[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = await query<RowDataPacket & { id: number }>(
      `SELECT id FROM permissions WHERE id IN (${placeholders})`,
      ids,
      exec,
    );
    return rows.map((r) => r.id);
  },

  async create(
    data: { slug: string; name: string; description: string | null; level: number },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      'INSERT INTO roles (shop_id, slug, name, description, is_system, level) VALUES (?, ?, ?, ?, 0, ?)',
      [shopId(), data.slug, data.name, data.description, data.level],
      exec,
    );
  },

  async update(id: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `\`${k}\` = ?`).join(', ');
    await execute(`UPDATE roles SET ${assignments} WHERE shop_id = ? AND id = ?`, [...Object.values(fields), shopId(), id], exec);
  },

  async setPermissions(roleId: number, permissionIds: number[], exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM role_permissions WHERE shop_id = ? AND role_id = ?', [shopId(), roleId], exec);
    if (permissionIds.length === 0) return;
    const values = permissionIds.map(() => '(?, ?, ?)').join(', ');
    const params = permissionIds.flatMap((pid) => [shopId(), roleId, pid]);
    await execute(`INSERT INTO role_permissions (shop_id, role_id, permission_id) VALUES ${values}`, params, exec);
  },

  async remove(id: number, exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM roles WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },
};
