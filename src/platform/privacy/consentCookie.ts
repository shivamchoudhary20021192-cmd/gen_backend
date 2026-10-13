import crypto from 'node:crypto';

/**
 * The visitor's consent, kept where they keep it: the `_tracking_consent`
 * cookie (Shopify's name, so theme and app code that looks for it finds it).
 *
 *   {"v":1,"id":"<uuid>","ts":<unix seconds>,"p":{"a":1,"m":0,"p":1,"s":1},"pv":3,"src":"custom","gpc":0}
 *
 *   a m p s   analytics, marketing, preferences, sale of data (1 yes, 0 no)
 *   pv        the privacy policy version it was given under — a new version
 *             asks again, when the store says so
 *   id        the random id the proof-of-consent record is filed under
 *
 * Storing a consent choice is strictly necessary — it is how the choice is
 * respected — so this cookie needs no consent of its own. It is readable by
 * scripts (the Customer Privacy API reads it) and says nothing about who the
 * visitor is.
 */

export const CONSENT_COOKIE = '_tracking_consent';

export type ConsentMethod = 'accept_all' | 'reject_all' | 'custom' | 'opt_out_page' | 'gpc' | 'api' | 'account';

export interface ConsentPurposes {
  analytics: boolean;
  marketing: boolean;
  preferences: boolean;
  sale_of_data: boolean;
}

export interface TrackingConsent {
  id: string;
  /** When it was given, in unix seconds. */
  ts: number;
  purposes: ConsentPurposes;
  policyVersion: number;
  method: ConsentMethod;
  gpc: boolean;
}

const METHODS: readonly ConsentMethod[] = ['accept_all', 'reject_all', 'custom', 'opt_out_page', 'gpc', 'api', 'account'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newConsentId(): string {
  return crypto.randomUUID();
}

export function serializeConsent(consent: TrackingConsent): string {
  const bit = (value: boolean) => (value ? 1 : 0);
  return encodeURIComponent(
    JSON.stringify({
      v: 1,
      id: consent.id,
      ts: consent.ts,
      p: {
        a: bit(consent.purposes.analytics),
        m: bit(consent.purposes.marketing),
        p: bit(consent.purposes.preferences),
        s: bit(consent.purposes.sale_of_data),
      },
      pv: consent.policyVersion,
      src: consent.method,
      gpc: bit(consent.gpc),
    }),
  );
}

/** The cookie's consent, or null when it is missing, malformed or from a future format. */
export function parseConsent(raw: string | null | undefined): TrackingConsent | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(decodeURIComponent(raw)) as Record<string, any>;
    if (data?.v !== 1 || typeof data.id !== 'string' || !UUID.test(data.id)) return null;
    const p = data.p ?? {};
    const flag = (value: unknown) => value === 1 || value === true;
    return {
      id: data.id.toLowerCase(),
      ts: Number.isFinite(Number(data.ts)) ? Number(data.ts) : 0,
      purposes: { analytics: flag(p.a), marketing: flag(p.m), preferences: flag(p.p), sale_of_data: flag(p.s) },
      policyVersion: Number.isInteger(Number(data.pv)) ? Number(data.pv) : 0,
      method: METHODS.includes(data.src) ? data.src : 'api',
      gpc: flag(data.gpc),
    };
  } catch {
    return null;
  }
}

/** Whether a stored consent still stands: not older than the store keeps them, not given under an older privacy policy it re-asks after. */
export function consentStillValid(
  consent: TrackingConsent,
  rules: { maxAgeDays: number; policyVersion: number; repromptOnPolicyChange: boolean },
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (nowSeconds - consent.ts > rules.maxAgeDays * 86_400) return false;
  if (rules.repromptOnPolicyChange && rules.policyVersion > 0 && consent.policyVersion < rules.policyVersion) return false;
  return true;
}
