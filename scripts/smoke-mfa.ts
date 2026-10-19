/**
 * End-to-end check of two-step sign-in (TOTP) for staff, against a running API.
 *
 *   npm run dev          # in one shell
 *   npm run smoke:mfa    # in another
 *
 * Uses a throwaway staff account, never the super admin, so a failure half
 * way cannot leave the account every other suite signs in with behind a
 * code nobody has. Codes are computed here from the secret the API hands
 * back at setup — exactly what an authenticator app does.
 *
 * What it is written to catch:
 *
 *   - the password alone no longer opens a session once MFA is on, and the
 *     challenge it returns is not usable as an access token
 *   - a code works once: replaying it inside its 30-second window fails
 *   - a recovery code works once ever, and regenerating kills the old set
 *   - turning MFA on signs out sessions opened with a password alone
 *   - wrong codes lock the account exactly like wrong passwords do
 *   - an operator can reset someone else's MFA, never their own
 */
import { env } from '../src/config/env';
import { totp } from '../src/core/totp';
import { closePool, execute } from '../src/db/pool';

const ROOT = `http://127.0.0.1:${env.port}`;
const BASE = `${ROOT}${env.apiPrefix}`;

let passed = 0;
let failed = 0;

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  ✗ ${label}\n`);
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail).slice(0, 500)}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

async function call(path: string, options: { method?: string; body?: unknown; token?: string; base?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${options.base ?? BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** A code for the step after the current one: inside the accepted window, and always later than the last code used. */
const nextCode = (secret: string) => totp(secret, Date.now() + 30_000);

async function main(): Promise<void> {
  process.stdout.write('\nVeylog Admin API — two-step sign-in\n');
  await execute("DELETE FROM rate_limits WHERE bucket_key LIKE 'admin.%'");

  section('Setup');
  const admin = await call('/auth/login', { method: 'POST', body: { email: env.superAdmin.email, password: env.superAdmin.password } });
  ok('super admin signs in with a password alone', admin.status === 200 && Boolean(admin.body?.access_token), admin.body);
  const adminToken: string = admin.body?.access_token;

  const roles = await call('/roles', { token: adminToken });
  const contentRole = roles.body?.roles?.find((r: { slug: string }) => r.slug === 'content');
  const email = `mfa.${Date.now()}@veylor.test`;
  const password = 'TwoStepTeam2026!';
  const created = await call('/admin-users', {
    method: 'POST',
    token: adminToken,
    body: { admin_user: { email, password, first_name: 'Two', last_name: 'Step', role_ids: [contentRole?.id], must_change_password: false } },
  });
  ok('a staff account to test with', created.status === 201, created.body);
  const staffId: number = created.body?.admin_user?.id;

  const first = await call('/auth/login', { method: 'POST', body: { email, password } });
  const second = await call('/auth/login', { method: 'POST', body: { email, password } });
  ok('without MFA, the password opens a session', Boolean(first.body?.access_token) && first.body?.mfa_required === undefined, first.body);
  const token: string = first.body?.access_token;
  const otherDevice: string = second.body?.access_token;

  const before = await call('/auth/mfa', { token });
  ok('status starts off', before.status === 200 && before.body?.mfa?.enabled === false && before.body?.mfa?.pending_setup === false, before.body);

  section('Enrolment');
  const wrongPassword = await call('/auth/mfa/setup', { method: 'POST', token, body: { password: 'not-my-password' } });
  ok('setup asks for the password again → 401', wrongPassword.status === 401, wrongPassword.body);

  const enableTooEarly = await call('/auth/mfa/enable', { method: 'POST', token, body: { code: '123456' } });
  ok('enable before setup → 409 MFA_SETUP_REQUIRED', enableTooEarly.status === 409 && enableTooEarly.body?.error?.code === 'MFA_SETUP_REQUIRED', enableTooEarly.body);

  const setup = await call('/auth/mfa/setup', { method: 'POST', token, body: { password } });
  const secret: string = setup.body?.secret;
  ok('setup returns a base32 secret and an otpauth:// URI', setup.status === 200 && /^[A-Z2-7]{32}$/.test(secret ?? '') && String(setup.body?.otpauth_url).startsWith('otpauth://totp/'), setup.body);

  const stored = await call('/auth/mfa', { token });
  ok('pending, not yet on', stored.body?.mfa?.pending_setup === true && stored.body?.mfa?.enabled === false, stored.body);

  const pendingLogin = await call('/auth/login', { method: 'POST', body: { email, password } });
  ok('a pending setup does not challenge sign-in', Boolean(pendingLogin.body?.access_token), pendingLogin.body);

  const wrongCode = await call('/auth/mfa/enable', { method: 'POST', token, body: { code: '000000' } });
  ok('a wrong first code → 422 INVALID_MFA_CODE', wrongCode.status === 422 && wrongCode.body?.error?.code === 'INVALID_MFA_CODE', wrongCode.body);

  const enrolCode = totp(secret, Date.now());
  const enabled = await call('/auth/mfa/enable', { method: 'POST', token, body: { code: enrolCode } });
  const recovery: string[] = enabled.body?.recovery_codes ?? [];
  ok('the first code turns it on and shows ten recovery codes once', enabled.status === 200 && enabled.body?.mfa?.enabled === true && recovery.length === 10, enabled.body);
  ok('other sessions were signed out', (enabled.body?.other_sessions_signed_out ?? 0) >= 2, enabled.body);

  const stillIn = await call('/auth/me', { token });
  ok('the session that turned it on stays signed in', stillIn.status === 200, stillIn.body);
  const kicked = await call('/auth/me', { token: otherDevice });
  ok('a session opened with the password alone is gone → 401', kicked.status === 401, kicked.body);

  const again = await call('/auth/mfa/setup', { method: 'POST', token, body: { password } });
  ok('setup while on → 409 MFA_ALREADY_ENABLED', again.status === 409 && again.body?.error?.code === 'MFA_ALREADY_ENABLED', again.body);

  section('Signing in');
  const challenge = await call('/auth/login', { method: 'POST', body: { email, password } });
  const mfaToken: string = challenge.body?.mfa_token;
  ok('the password now returns a challenge, no tokens', challenge.status === 200 && challenge.body?.mfa_required === true && !challenge.body?.access_token && Boolean(mfaToken), challenge.body);
  ok('the challenge offers both methods', JSON.stringify(challenge.body?.mfa_methods) === '["totp","recovery_code"]', challenge.body);

  const asBearer = await call('/auth/me', { token: mfaToken });
  ok('the challenge is not an access token → 401', asBearer.status === 401, asBearer.body);

  const forged = await call('/auth/login/mfa', { method: 'POST', body: { mfa_token: token, code: nextCode(secret) } });
  ok('an access token is not a challenge → 401 MFA_CHALLENGE_INVALID', forged.status === 401 && forged.body?.error?.code === 'MFA_CHALLENGE_INVALID', forged.body);

  const bad = await call('/auth/login/mfa', { method: 'POST', body: { mfa_token: mfaToken, code: '999999' } });
  ok('a wrong code → 401 INVALID_MFA_CODE', bad.status === 401 && bad.body?.error?.code === 'INVALID_MFA_CODE', bad.body);

  const replay = await call('/auth/login/mfa', { method: 'POST', body: { mfa_token: mfaToken, code: enrolCode } });
  ok('the code used to enrol cannot be replayed → 401', replay.status === 401, replay.body);

  const code = nextCode(secret);
  const signedIn = await call('/auth/login/mfa', { method: 'POST', body: { mfa_token: mfaToken, code } });
  ok('challenge + a fresh code → a session', signedIn.status === 200 && Boolean(signedIn.body?.access_token) && Boolean(signedIn.body?.refresh_token), signedIn.body);
  const mfaSession: string = signedIn.body?.access_token;

  const sameCode = await call('/auth/login/mfa', { method: 'POST', body: { mfa_token: mfaToken, code } });
  ok('the same code a second time → 401', sameCode.status === 401, sameCode.body);

  const [recoveryA, recoveryB, recoveryC] = recovery;
  const byRecovery = await call('/auth/login/mfa', { method: 'POST', body: { mfa_token: mfaToken, code: recoveryA.toUpperCase().replace('-', ' ') } });
  ok('a recovery code signs in, however it is typed', byRecovery.status === 200 && Boolean(byRecovery.body?.access_token), byRecovery.body);
  ok('…and says how many are left', byRecovery.body?.recovery_codes_remaining === 9, byRecovery.body);

  const recoveryTwice = await call('/auth/login/mfa', { method: 'POST', body: { mfa_token: mfaToken, code: recoveryA } });
  ok('a recovery code works once → 401 the second time', recoveryTwice.status === 401, recoveryTwice.body);

  const refreshed = await call('/auth/refresh', { method: 'POST', body: { refresh_token: signedIn.body?.refresh_token } });
  ok('refreshing an MFA session needs no code', refreshed.status === 200 && Boolean(refreshed.body?.access_token), refreshed.body);

  section('Recovery codes');
  const regenerated = await call('/auth/mfa/recovery-codes', { method: 'POST', token: mfaSession, body: { code: recoveryB } });
  ok('a new set, confirmed with a recovery code', regenerated.status === 200 && regenerated.body?.recovery_codes?.length === 10, regenerated.body);
  const oldCode = await call('/auth/login/mfa', { method: 'POST', body: { mfa_token: mfaToken, code: recoveryC } });
  ok('the old set stops working', oldCode.status === 401, oldCode.body);
  const status = await call('/auth/mfa', { token: mfaSession });
  ok('status counts the new set', status.body?.mfa?.recovery_codes_remaining === 10, status.body);

  section('Turning it off');
  const offNoCode = await call('/auth/mfa/disable', { method: 'POST', token: mfaSession, body: { password, code: '000000' } });
  ok('turning off needs a valid code → 422', offNoCode.status === 422, offNoCode.body);
  const offBadPassword = await call('/auth/mfa/disable', { method: 'POST', token: mfaSession, body: { password: 'wrong', code: regenerated.body?.recovery_codes?.[0] } });
  ok('…and the password → 401', offBadPassword.status === 401, offBadPassword.body);
  const off = await call('/auth/mfa/disable', { method: 'POST', token: mfaSession, body: { password, code: regenerated.body?.recovery_codes?.[1] } });
  ok('password + code turns it off', off.status === 200 && off.body?.mfa?.enabled === false, off.body);
  const plain = await call('/auth/login', { method: 'POST', body: { email, password } });
  ok('the password alone opens a session again', Boolean(plain.body?.access_token), plain.body);
  const plainToken: string = plain.body?.access_token;

  section('Lockout');
  // Ten settings changes per person per 15 minutes; this run has used them.
  const limited = await call('/auth/mfa/setup', { method: 'POST', token: plainToken, body: { password } });
  ok('changes to MFA settings are rate limited per person → 429', limited.status === 429, limited.body);
  await execute("DELETE FROM rate_limits WHERE bucket_key = 'admin.mfa_settings'");

  const secondSetup = await call('/auth/mfa/setup', { method: 'POST', token: plainToken, body: { password } });
  const secret2: string = secondSetup.body?.secret;
  const reEnabled = await call('/auth/mfa/enable', { method: 'POST', token: plainToken, body: { code: totp(secret2, Date.now()) } });
  ok('enrolled again with a new secret', reEnabled.status === 200 && secret2 !== secret, reEnabled.body);

  const lockChallenge = await call('/auth/login', { method: 'POST', body: { email, password } });
  const lockToken: string = lockChallenge.body?.mfa_token;
  // Fired all at once: the lockout must hold under concurrency, not just in sequence.
  await execute("DELETE FROM rate_limits WHERE bucket_key = 'admin.login_mfa.ip'");
  const max = env.auth.maxLoginAttempts;
  const burst = await Promise.all(
    Array.from({ length: max * 3 }, () => call('/auth/login/mfa', { method: 'POST', body: { mfa_token: lockToken, code: '111111' } })),
  );
  const judged = burst.filter((r) => r.status === 401).length;
  const refused = burst.filter((r) => r.status === 403 && r.body?.error?.code === 'ACCOUNT_LOCKED').length;
  ok(`${max * 3} wrong codes at once: exactly ${max} are checked, the rest refused as locked`, judged === max && refused === max * 2, { judged, refused });
  const locked = await call('/auth/login/mfa', { method: 'POST', body: { mfa_token: lockToken, code: nextCode(secret2) } });
  ok('then even the right code → 403 ACCOUNT_LOCKED', locked.status === 403 && locked.body?.error?.code === 'ACCOUNT_LOCKED', locked.body);
  const lockedPassword = await call('/auth/login', { method: 'POST', body: { email, password } });
  ok('and so does the password', lockedPassword.status === 403 && lockedPassword.body?.error?.code === 'ACCOUNT_LOCKED', lockedPassword.body);

  section('Operator reset');
  const self = await call(`/people/${admin.body?.admin?.id}/mfa/reset`, { method: 'POST', base: `${ROOT}/platform/api/v1`, token: adminToken, body: { reason: 'testing self reset' } });
  ok('an operator cannot reset their own → 403', self.status === 403, self.body);
  const reset = await call(`/people/${staffId}/mfa/reset`, { method: 'POST', base: `${ROOT}/platform/api/v1`, token: adminToken, body: { reason: 'Lost phone and codes; identity checked on a call' } });
  ok('a platform admin resets it for someone else', reset.status === 200 && reset.body?.mfa?.enabled === false, reset.body);
  const afterReset = await call('/auth/me', { token: plainToken });
  ok('every session the person had is signed out', afterReset.status === 401, afterReset.body);

  // The reset does not lift the lockout; that expires on its own. Lift it so
  // the last check can sign in.
  await execute('UPDATE admin_users SET locked_until = NULL, failed_login_attempts = 0 WHERE id = ?', [staffId]);
  const fresh = await call('/auth/login', { method: 'POST', body: { email, password } });
  ok('after the reset the password alone signs in', Boolean(fresh.body?.access_token) && fresh.body?.mfa_required === undefined, fresh.body);

  await call(`/admin-users/${staffId}`, { method: 'DELETE', token: adminToken });

  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  await closePool();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  process.stderr.write(`Smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  await closePool().catch(() => undefined);
  process.exit(1);
});
