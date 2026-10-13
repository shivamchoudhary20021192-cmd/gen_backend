import type { Diagnosis } from './dns/inspect';
import type { EdgeHostnameState } from './edge/edgeProvider';

/**
 * A custom domain's lifecycle, decided in one pure function so it can be
 * tested exhaustively and reasoned about in one place.
 *
 *   pending_dns       the records are not in place (or ownership not proven)
 *   provisioning_ssl  traffic reaches the edge; the certificate is being issued
 *   active            serving over HTTPS
 *   misconfigured     it was working, and DNS no longer points at the store
 *   ssl_failed        the certificate could not be issued (CAA, a proxy, a timeout)
 *   expired           no DNS after 14 days: checks stop until the merchant asks again
 *
 * Nothing here talks to DNS or the edge: the caller gathers both, this
 * decides, the caller applies. The schedule backs off — a domain added a
 * minute ago is checked every minute or two, one live for months every few
 * hours — and is jittered, so a million domains never come due in one tick.
 */

export type DomainStatus = 'pending_dns' | 'provisioning_ssl' | 'active' | 'misconfigured' | 'ssl_failed' | 'expired';

export interface LifecycleInput {
  status: DomainStatus;
  createdAt: Date;
  /** When the status last changed. */
  since: Date;
  attempts: number;
  /** Proven before this check (a sibling, the registrar, a transfer, an earlier TXT). */
  ownershipProven: boolean;
  diagnosis: Diagnosis;
  /** The edge's view; null when it was not asked (DNS not ready). */
  certificate: EdgeHostnameState | null;
  now: Date;
  /** For tests: a fixed jitter in [-1, 1]; otherwise random. */
  jitter?: number;
}

export type DomainNotice = 'connected' | 'restored' | 'misconfigured' | 'ssl_failed' | 'expired';

export interface LifecycleOutcome {
  status: DomainStatus;
  ownershipProven: boolean;
  /** Register the hostname with the edge (DNS is ready, the edge does not know it yet). */
  attach: boolean;
  /** When to look again; null stops checking. */
  nextCheckMs: number | null;
  notify: DomainNotice | null;
  reason: string | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const PENDING_GIVE_UP_MS = 14 * DAY;
export const SSL_GIVE_UP_MS = 24 * HOUR;

/** Early checks come quickly; a merchant who just changed DNS wants to know soon. */
const PENDING_STEPS = [1, 2, 3, 5, 10, 15, 30].map((minutes) => minutes * MINUTE);

function jittered(ms: number, jitter: number): number {
  return Math.max(30_000, Math.round(ms * (1 + 0.2 * jitter)));
}

export function schedule(status: DomainStatus, input: { attempts: number; age: number; inStatus: number; certificateExpiresInMs?: number | null }, jitter = 0): number | null {
  switch (status) {
    case 'pending_dns':
      if (input.attempts < PENDING_STEPS.length) return jittered(PENDING_STEPS[input.attempts], jitter);
      return jittered(input.age < 3 * DAY ? HOUR : 6 * HOUR, jitter);
    case 'provisioning_ssl':
      return jittered(input.inStatus < 30 * MINUTE ? MINUTE : input.inStatus < 6 * HOUR ? 5 * MINUTE : 30 * MINUTE, jitter);
    case 'active':
      // A certificate close to expiry is watched hourly: renewal is the edge's job, noticing it failed is ours.
      if (input.certificateExpiresInMs !== undefined && input.certificateExpiresInMs !== null && input.certificateExpiresInMs < 14 * DAY) return jittered(HOUR, jitter);
      return jittered(6 * HOUR, jitter);
    case 'misconfigured':
      return jittered(input.inStatus < DAY ? HOUR : 6 * HOUR, jitter);
    case 'ssl_failed':
      return jittered(HOUR, jitter);
    case 'expired':
      return null;
  }
}

export function nextState(input: LifecycleInput): LifecycleOutcome {
  const { diagnosis, certificate, now } = input;
  const jitter = input.jitter ?? Math.random() * 2 - 1;
  const age = now.getTime() - input.createdAt.getTime();
  const inStatus = now.getTime() - input.since.getTime();
  const ownershipProven = input.ownershipProven || diagnosis.ownership !== null;
  const firstError = diagnosis.problems.find((problem) => problem.severity === 'error')?.message ?? diagnosis.problems[0]?.message ?? null;
  const done = (status: DomainStatus, extra: Partial<LifecycleOutcome> = {}): LifecycleOutcome => {
    const changed = status !== input.status;
    const expiresIn = certificate?.expiresAt ? certificate.expiresAt.getTime() - now.getTime() : null;
    return {
      status,
      ownershipProven,
      attach: false,
      nextCheckMs: schedule(status, { attempts: changed ? 0 : input.attempts + 1, age, inStatus: changed ? 0 : inStatus, certificateExpiresInMs: expiresIn }, jitter),
      notify: null,
      reason: null,
      ...extra,
    };
  };

  // DNS is not (or no longer) sending visitors to the store.
  if (!diagnosis.routed || !ownershipProven) {
    if (input.status === 'active' || input.status === 'provisioning_ssl' || input.status === 'ssl_failed') {
      return done('misconfigured', { notify: input.status === 'active' ? 'misconfigured' : null, reason: firstError });
    }
    if (input.status === 'misconfigured') return done('misconfigured', { reason: firstError });
    if (age > PENDING_GIVE_UP_MS) return done('expired', { notify: input.status === 'expired' ? null : 'expired', reason: firstError });
    return done('pending_dns', { reason: firstError });
  }

  // It points here and is theirs. The certificate decides the rest.
  if (!certificate || certificate.certificate === 'none') {
    return done('provisioning_ssl', { attach: true, reason: 'Issuing the certificate.' });
  }
  if (certificate.certificate === 'active') {
    const notify: DomainNotice | null = input.status === 'active' ? null : input.status === 'misconfigured' || input.status === 'ssl_failed' ? 'restored' : 'connected';
    return done('active', { notify });
  }
  if (diagnosis.caaBlocks) {
    const failed = input.status === 'ssl_failed' || (input.status === 'provisioning_ssl' && inStatus > SSL_GIVE_UP_MS);
    return done(failed ? 'ssl_failed' : 'provisioning_ssl', { notify: failed && input.status !== 'ssl_failed' ? 'ssl_failed' : null, reason: firstError });
  }
  if (certificate.certificate === 'failed') {
    return done('ssl_failed', { notify: input.status === 'ssl_failed' ? null : 'ssl_failed', reason: `The certificate could not be issued (${certificate.detail ?? 'unknown reason'}).` });
  }
  // Pending at the edge.
  if (input.status === 'provisioning_ssl' && inStatus > SSL_GIVE_UP_MS) {
    return done('ssl_failed', { notify: 'ssl_failed', reason: `The certificate has not been issued after a day (${certificate.detail ?? 'pending'}).` });
  }
  if (input.status === 'ssl_failed') return done('ssl_failed', { reason: `Still waiting for the certificate (${certificate.detail ?? 'pending'}).` });
  return done('provisioning_ssl', { reason: 'Issuing the certificate — usually a few minutes.' });
}
