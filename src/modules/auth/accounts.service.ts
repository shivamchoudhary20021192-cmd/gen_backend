import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { controlPlane } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { platformMail } from '../../platform/mail/mailer';
import { adminUrl } from '../../platform/mail/templates';
import { shopsRepository } from '../../platform/shops/shops.repository';
import { auditService } from '../../shared/audit.service';
import { accountsRepository } from './accounts.repository';
import { authRepository } from './auth.repository';
import { invalidateSessionCache } from './auth.service';

/**
 * Getting into an account without a password: "forgot password" and
 * "accept an invitation".
 *
 * Both hand out a random token by email and keep only its SHA-256, so a
 * database read does not yield working links. Both links work once and
 * expire. "Forgot password" answers the same way whether or not the address
 * has an account, so it cannot be used to find out who is a merchant here.
 */

const RESET_MINUTES = 60;
export const INVITE_DAYS = 7;

interface Meta {
  ip: string | null;
  userAgent: string | null;
}

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const INVALID_LINK = 'This link is no longer valid. Ask for a new one.';

export const accountsService = {
  newToken,

  async requestPasswordReset(email: string, meta: Meta): Promise<void> {
    const admin = await authRepository.findByEmail(email.trim().toLowerCase());
    // Only people who can sign in get a link: not app identities, not
    // disabled accounts, not invitations still waiting for a first password.
    if (!admin || admin.account_type !== 'human' || !admin.password_hash || admin.status !== 'active') {
      logger.info('auth.password_reset_ignored', { reason: admin ? 'not_eligible' : 'no_account' });
      return;
    }
    const { token, hash } = newToken();
    await withTransaction(async (tx) => {
      await accountsRepository.replacePasswordReset(
        { adminId: admin.id, tokenHash: hash, ip: meta.ip, expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000) },
        tx,
      );
      await platformMail.send(
        { to: admin.email, template: 'auth.password_reset', data: { resetUrl: adminUrl(`/reset-password?token=${token}`), expiresMinutes: RESET_MINUTES } },
        tx,
      );
    }, controlPlane);
    await auditService.log({ actorId: admin.id, actorLabel: admin.email, action: 'admin.password_reset_requested', entityType: 'admin_user', entityId: admin.id, summary: `Password reset requested for ${admin.email}`, ip: meta.ip, userAgent: meta.userAgent });
  },

  async resetPassword(token: string, password: string, meta: Meta): Promise<void> {
    const passwordHash = await bcrypt.hash(password, env.auth.bcryptRounds);
    const admin = await withTransaction(async (tx) => {
      const reset = await accountsRepository.passwordResetForUpdate(hashToken(token), tx);
      if (!reset || reset.used_at || reset.expires_at.getTime() < Date.now()) throw ApiError.badRequest(INVALID_LINK);
      const found = await authRepository.findById(reset.admin_user_id, tx);
      if (!found || found.status !== 'active') throw ApiError.badRequest(INVALID_LINK);
      await authRepository.updatePassword(found.id, passwordHash, tx);
      await accountsRepository.markPasswordResetUsed(reset.id, tx);
      // Whoever knew the old password is signed out everywhere.
      await authRepository.revokeAllForAdmin(found.id, 'password_reset', undefined, tx);
      await platformMail.send({ to: found.email, template: 'auth.password_changed', data: { at: new Date() } }, tx);
      return found;
    }, controlPlane);
    invalidateSessionCache();
    await auditService.log({ actorId: admin.id, actorLabel: admin.email, action: 'admin.password_reset', entityType: 'admin_user', entityId: admin.id, summary: `${admin.email} reset their password`, ip: meta.ip, userAgent: meta.userAgent });
  },

  /** What an invitation link is for, so the page can say "join Lotus Botanics". */
  async describeInvitation(token: string) {
    const invite = await accountsRepository.inviteByToken(hashToken(token));
    if (!invite || invite.accepted_at || invite.revoked_at || invite.expires_at.getTime() < Date.now()) throw ApiError.badRequest(INVALID_LINK);
    const shop = await shopsRepository.byId(invite.shop_id);
    const person = await authRepository.findByEmail(invite.email);
    return {
      email: invite.email,
      shop: shop ? { name: shop.name, handle: shop.handle } : null,
      // An existing account signs in; a new one chooses a password here.
      needs_password: !person?.password_hash,
    };
  },

  /**
   * Accepts an invitation: a new person chooses a password (and their name),
   * and their place on the store's staff becomes active.
   */
  async acceptInvitation(input: { token: string; password?: string | null; first_name?: string | null; last_name?: string | null }, meta: Meta) {
    const invite = await accountsRepository.inviteByToken(hashToken(input.token));
    if (!invite || invite.accepted_at || invite.revoked_at || invite.expires_at.getTime() < Date.now()) throw ApiError.badRequest(INVALID_LINK);
    const person = await authRepository.findByEmail(invite.email);
    if (!person || person.account_type !== 'human' || person.status === 'disabled' || person.status === 'suspended') throw ApiError.badRequest(INVALID_LINK);

    const needsPassword = !person.password_hash;
    if (needsPassword && !input.password) throw ApiError.validation({ password: ['Choose a password.'] });
    const passwordHash = needsPassword ? await bcrypt.hash(input.password!, env.auth.bcryptRounds) : null;

    await withTransaction(async (tx) => {
      if (passwordHash) {
        await accountsRepository.activateIdentity(person.id, { passwordHash, firstName: input.first_name ?? null, lastName: input.last_name ?? null }, tx);
      }
      await accountsRepository.activateMembership(invite.shop_id, person.id, tx);
    }, controlPlane);
    await accountsRepository.markInviteAccepted(invite.id, invite.shop_id);

    const shop = await shopsRepository.byId(invite.shop_id);
    await auditService.log({ actorId: person.id, actorLabel: person.email, action: 'admin.invitation_accepted', entityType: 'admin_user', entityId: person.id, summary: `${person.email} joined ${shop?.name ?? `shop ${invite.shop_id}`}`, ip: meta.ip, userAgent: meta.userAgent });
    return { accepted: true, email: person.email, shop: shop ? { name: shop.name, handle: shop.handle } : null };
  },
};
