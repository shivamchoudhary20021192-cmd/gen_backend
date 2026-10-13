import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { hashToken } from '../../core/crypto';
import { matchTotp, normaliseRecoveryCode } from '../../core/totp';
import { vault } from '../../platform/security/vault';
import { authRepository, type AdminRow } from './auth.repository';

/**
 * The second factor's primitives, shared by sign-in (auth.service) and the
 * security settings (mfa.service). Nothing here opens a session.
 */

export type SecondFactor = 'totp' | 'recovery_code';

/** How long the gap between the password and the code may be. */
export const MFA_CHALLENGE_SECONDS = 300;

const CHALLENGE_AUDIENCE = 'veylog-admin-mfa';

interface ChallengePayload {
  sub: string;
  typ: 'mfa_challenge';
  /**
   * When the password last changed, so a challenge earned with a password
   * dies the moment that password is reset — not five minutes later.
   */
  pwd: number;
}

/**
 * Challenged only with a secret to check against. A row with the flag but no
 * secret was set before the step existed, and could never be satisfied.
 */
export function mfaActive(admin: AdminRow): boolean {
  return admin.mfa_enabled === 1 && Boolean(admin.mfa_secret);
}

/** Sealed to the person: a secret copied onto another row will not open. */
function secretContext(admin: Pick<AdminRow, 'public_id'>): string {
  return `admin_mfa:${admin.public_id}`;
}

export function sealSecret(admin: Pick<AdminRow, 'public_id'>, secret: string): string {
  return vault.seal(secret, secretContext(admin));
}

export function openSecret(admin: AdminRow): string {
  if (!admin.mfa_secret) throw ApiError.conflict('Two-step sign-in is not set up.', 'MFA_SETUP_REQUIRED');
  return vault.open(admin.mfa_secret, secretContext(admin));
}

export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map((code) => hashToken(code));
}

function passwordStamp(admin: AdminRow): number {
  return admin.password_changed_at ? admin.password_changed_at.getTime() : 0;
}

export function signChallenge(admin: AdminRow): string {
  const payload: ChallengePayload = { sub: String(admin.id), typ: 'mfa_challenge', pwd: passwordStamp(admin) };
  return jwt.sign(payload, env.auth.jwtSecret, {
    expiresIn: MFA_CHALLENGE_SECONDS,
    issuer: 'veylog-admin-api',
    audience: CHALLENGE_AUDIENCE,
  });
}

/**
 * The admin a challenge was issued to. The audience keeps a challenge from
 * ever being accepted as an access token, and an access token from being
 * accepted here.
 */
export async function adminForChallenge(token: string): Promise<AdminRow> {
  let payload: ChallengePayload;
  try {
    payload = jwt.verify(token, env.auth.jwtSecret, {
      issuer: 'veylog-admin-api',
      audience: CHALLENGE_AUDIENCE,
    }) as ChallengePayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthenticated('The sign-in attempt expired. Enter your password again.', 'MFA_CHALLENGE_INVALID');
    }
    throw ApiError.unauthenticated('The sign-in attempt is not valid. Enter your password again.', 'MFA_CHALLENGE_INVALID');
  }
  if (payload.typ !== 'mfa_challenge') {
    throw ApiError.unauthenticated('The sign-in attempt is not valid. Enter your password again.', 'MFA_CHALLENGE_INVALID');
  }

  const admin = await authRepository.findById(Number(payload.sub));
  if (!admin || passwordStamp(admin) !== payload.pwd || !mfaActive(admin)) {
    throw ApiError.unauthenticated('The sign-in attempt is no longer valid. Enter your password again.', 'MFA_CHALLENGE_INVALID');
  }
  return admin;
}

/**
 * Checks a code from the authenticator app (six digits) or a recovery code
 * (5-5), and burns it: a TOTP step can be used once, a recovery code once
 * ever. Returns which factor was used, or null when the code is wrong,
 * already used, or not a code at all.
 */
export async function consumeSecondFactor(admin: AdminRow, code: string, now = Date.now()): Promise<SecondFactor | null> {
  const trimmed = code.trim();
  if (/^\d{3}\s?\d{3}$/.test(trimmed)) {
    const step = matchTotp(openSecret(admin), trimmed, now);
    if (step === null) return null;
    return (await authRepository.consumeTotpStep(admin.id, step)) ? 'totp' : null;
  }

  const recovery = normaliseRecoveryCode(trimmed);
  if (!recovery) return null;
  return (await authRepository.consumeRecoveryCode(admin.id, hashToken(recovery))) ? 'recovery_code' : null;
}
