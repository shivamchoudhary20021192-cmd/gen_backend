import { controlPlane, execute, insert, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { tenancy } from '../../platform/tenancy/context';

/**
 * The rows behind "forgot password" and "accept invitation": both are reached
 * with nothing but a token from an email, before anyone is signed in or any
 * shop is in context.
 */

export interface PasswordResetRow extends RowDataPacket {
  id: number;
  admin_user_id: number;
  expires_at: Date;
  used_at: Date | null;
}

export interface InviteRow extends RowDataPacket {
  id: number;
  shop_id: number;
  email: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

export const accountsRepository = {
  /** Any earlier unused link stops working when a new one is sent. */
  async replacePasswordReset(data: { adminId: number; tokenHash: string; ip: string | null; expiresAt: Date }, exec: Executor): Promise<number> {
    await execute('UPDATE admin_password_resets SET used_at = UTC_TIMESTAMP() WHERE admin_user_id = ? AND used_at IS NULL', [data.adminId], exec);
    return insert(
      `INSERT INTO admin_password_resets (admin_user_id, token_hash, ip, expires_at)
       VALUES (?, ?, ${data.ip ? 'INET6_ATON(?)' : 'NULL'}, ?)`,
      data.ip ? [data.adminId, data.tokenHash, data.ip, data.expiresAt] : [data.adminId, data.tokenHash, data.expiresAt],
      exec,
    );
  },

  async passwordResetForUpdate(tokenHash: string, exec: Executor): Promise<PasswordResetRow | null> {
    return queryOne<PasswordResetRow>(
      'SELECT id, admin_user_id, expires_at, used_at FROM admin_password_resets WHERE token_hash = ? LIMIT 1 FOR UPDATE',
      [tokenHash],
      exec,
    );
  },

  async markPasswordResetUsed(id: number, exec: Executor): Promise<void> {
    await execute('UPDATE admin_password_resets SET used_at = UTC_TIMESTAMP() WHERE id = ?', [id], exec);
  },

  /**
   * An invitation by its token. Invitations belong to a shop, and the shop is
   * exactly what the token is for finding out.
   */
  async inviteByToken(tokenHash: string): Promise<InviteRow | null> {
    return tenancy.unscoped('accepting a staff invitation: the token names the shop', () =>
      queryOne<InviteRow>(
        'SELECT id, shop_id, email, expires_at, accepted_at, revoked_at FROM admin_invites WHERE token_hash = ? LIMIT 1',
        [tokenHash],
      ),
    );
  },

  async markInviteAccepted(id: number, shopId: number): Promise<void> {
    await tenancy.unscoped('accepting a staff invitation: the token names the shop', () =>
      execute('UPDATE admin_invites SET accepted_at = UTC_TIMESTAMP() WHERE shop_id = ? AND id = ? AND accepted_at IS NULL', [shopId, id]),
    );
  },

  /** An invited identity choosing its password: it can now sign in. */
  async activateIdentity(adminId: number, data: { passwordHash: string; firstName: string | null; lastName: string | null }, exec: Executor): Promise<void> {
    await execute(
      `UPDATE admin_users
          SET password_hash = ?, password_changed_at = UTC_TIMESTAMP(), must_change_password = 0, status = 'active',
              first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name),
              failed_login_attempts = 0, locked_until = NULL
        WHERE id = ? AND deleted_at IS NULL`,
      [data.passwordHash, data.firstName, data.lastName, adminId],
      exec,
    );
  },

  async activateMembership(shopId: number, adminId: number, exec: Executor = controlPlane): Promise<void> {
    await execute(
      "UPDATE shop_staff SET status = 'active', joined_at = COALESCE(joined_at, UTC_TIMESTAMP()) WHERE shop_id = ? AND admin_user_id = ? AND status = 'invited'",
      [shopId, adminId],
      exec,
    );
  },
};
