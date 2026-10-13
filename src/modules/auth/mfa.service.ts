import bcrypt from 'bcryptjs';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { generateRecoveryCodes, generateTotpSecret, matchTotp, otpauthUrl } from '../../core/totp';
import { withTransaction } from '../../db/transaction';
import { controlPlane } from '../../db/pool';
import { auditService } from '../../shared/audit.service';
import { authRepository, type AdminRow } from './auth.repository';
import { invalidateSessionCache, type SessionActor } from './auth.service';
import { consumeSecondFactor, hashRecoveryCodes, mfaActive, openSecret, sealSecret } from './mfa';

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

async function person(id: number): Promise<AdminRow> {
  const row = await authRepository.findById(id);
  if (!row) throw ApiError.notFound('Account');
  return row;
}

/** Changing how you sign in asks for the password again, whoever holds the session. */
async function confirmPassword(admin: AdminRow, password: string): Promise<void> {
  if (!admin.password_hash || !(await bcrypt.compare(password, admin.password_hash))) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Your password is incorrect.');
  }
}

async function requireCode(admin: AdminRow, code: string): Promise<void> {
  if (!(await consumeSecondFactor(admin, code))) {
    throw new ApiError(422, 'INVALID_MFA_CODE', 'That code is not right, or has already been used.');
  }
}

function describe(admin: AdminRow) {
  const active = mfaActive(admin);
  return {
    enabled: active,
    enabled_at: active && admin.mfa_enabled_at ? admin.mfa_enabled_at.toISOString() : null,
    pending_setup: admin.mfa_enabled === 0 && Boolean(admin.mfa_secret),
    recovery_codes_remaining: active ? (admin.mfa_recovery_codes?.length ?? 0) : 0,
  };
}

/**
 * Two-step sign-in, from the person's own security page. MFA belongs to the
 * person, not to a shop membership, so all of this is on the control plane
 * and works before they belong to any shop.
 */
export const mfaService = {
  async status(adminId: number) {
    return describe(await person(adminId));
  },

  /**
   * Step one of enrolment: a fresh secret, shown once. It is stored sealed
   * but not switched on until a code from it is confirmed — someone who
   * closes the page half way has not locked themselves out.
   */
  async beginSetup(actor: SessionActor, password: string) {
    const admin = await person(actor.id);
    await confirmPassword(admin, password);
    if (mfaActive(admin)) {
      throw ApiError.conflict('Two-step sign-in is already on. Turn it off first to move it to a new device.', 'MFA_ALREADY_ENABLED');
    }

    const secret = generateTotpSecret();
    const stored = await authRepository.setPendingMfaSecret(admin.id, sealSecret(admin, secret));
    if (!stored) throw ApiError.conflict('Two-step sign-in is already on.', 'MFA_ALREADY_ENABLED');

    return {
      secret,
      otpauth_url: otpauthUrl(env.platform.name, admin.email, secret),
      issuer: env.platform.name,
      account: admin.email,
    };
  },

  /**
   * Step two: the first code proves the app has the secret. Turning it on
   * signs out every other session — they were opened with a password alone,
   * which is exactly what this person just decided is not enough — and hands
   * back the recovery codes, the only time they are ever shown.
   */
  async enable(actor: SessionActor, code: string, meta: RequestMeta) {
    const admin = await person(actor.id);
    if (mfaActive(admin)) throw ApiError.conflict('Two-step sign-in is already on.', 'MFA_ALREADY_ENABLED');
    if (!admin.mfa_secret) {
      throw ApiError.conflict('Start setup first: POST /auth/mfa/setup.', 'MFA_SETUP_REQUIRED');
    }

    const step = matchTotp(openSecret(admin), code, Date.now());
    if (step === null) {
      throw new ApiError(422, 'INVALID_MFA_CODE', 'That code is not right. Check the time on your phone is set automatically.');
    }

    const recoveryCodes = generateRecoveryCodes();
    const signedOut = await withTransaction(async (tx) => {
      const enabled = await authRepository.enableMfa(admin.id, hashRecoveryCodes(recoveryCodes), step, tx);
      if (!enabled) throw ApiError.conflict('Two-step sign-in is already on.', 'MFA_ALREADY_ENABLED');
      await authRepository.markSessionMfaSatisfied(actor.sessionId, tx);
      return authRepository.revokeAllForAdmin(admin.id, 'mfa_enabled', actor.sessionId, tx);
    }, controlPlane);
    invalidateSessionCache();

    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'admin.mfa_enabled',
      entityType: 'admin_user',
      entityId: admin.id,
      summary: `${admin.email} turned on two-step sign-in`,
      context: { request_id: meta.requestId, other_sessions_signed_out: signedOut },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { mfa: describe(await person(admin.id)), recovery_codes: recoveryCodes, other_sessions_signed_out: signedOut };
  },

  /** Needs the password AND a code: a borrowed laptop is not enough to turn it off. */
  async disable(actor: SessionActor, password: string, code: string, meta: RequestMeta) {
    const admin = await person(actor.id);
    await confirmPassword(admin, password);
    if (!mfaActive(admin)) {
      if (!admin.mfa_secret) throw ApiError.conflict('Two-step sign-in is not on.', 'MFA_NOT_ENABLED');
      // Setup was started and never confirmed: cancelling it needs no code.
      await authRepository.disableMfa(admin.id);
      return describe(await person(admin.id));
    }
    await requireCode(admin, code);
    await authRepository.disableMfa(admin.id);

    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'admin.mfa_disabled',
      entityType: 'admin_user',
      entityId: admin.id,
      summary: `${admin.email} turned off two-step sign-in`,
      context: { request_id: meta.requestId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return describe(await person(admin.id));
  },

  /** A new set replaces the old one entirely; the old codes stop working. */
  async regenerateRecoveryCodes(actor: SessionActor, code: string, meta: RequestMeta) {
    const admin = await person(actor.id);
    if (!mfaActive(admin)) throw ApiError.conflict('Two-step sign-in is not on.', 'MFA_NOT_ENABLED');
    await requireCode(admin, code);

    const recoveryCodes = generateRecoveryCodes();
    await authRepository.replaceRecoveryCodes(admin.id, hashRecoveryCodes(recoveryCodes));

    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'admin.mfa_recovery_codes_regenerated',
      entityType: 'admin_user',
      entityId: admin.id,
      summary: `${admin.email} generated new recovery codes`,
      context: { request_id: meta.requestId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { recovery_codes: recoveryCodes };
  },

  /**
   * The way back for someone who lost both their phone and their recovery
   * codes: a platform administrator turns it off after checking who is
   * asking. Every session the person has is signed out, since the lost phone
   * may be in someone else's hands. Never for yourself — that would let a
   * hijacked operator session strip its own second factor without a code.
   */
  async operatorReset(operator: { id: number; email: string }, targetId: number, reason: string, meta: RequestMeta) {
    if (operator.id === targetId) {
      throw ApiError.forbidden('Turn off your own two-step sign-in from your security settings.');
    }
    const target = await person(targetId);
    if (target.account_type !== 'human') throw ApiError.notFound('Account');
    if (!mfaActive(target) && !target.mfa_secret) {
      throw ApiError.conflict(`${target.email} does not have two-step sign-in on.`, 'MFA_NOT_ENABLED');
    }

    const signedOut = await withTransaction(async (tx) => {
      await authRepository.disableMfa(target.id, tx);
      return authRepository.revokeAllForAdmin(target.id, 'mfa_reset', undefined, tx);
    }, controlPlane);
    invalidateSessionCache();

    await auditService.log({
      actorId: operator.id,
      actorLabel: operator.email,
      action: 'platform.admin_mfa_reset',
      entityType: 'admin_user',
      entityId: target.id,
      summary: `Two-step sign-in reset for ${target.email}: ${reason}`,
      context: { request_id: meta.requestId, reason, sessions_signed_out: signedOut },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { id: target.id, email: target.email, mfa: describe(await person(target.id)), sessions_signed_out: signedOut };
  },
};
