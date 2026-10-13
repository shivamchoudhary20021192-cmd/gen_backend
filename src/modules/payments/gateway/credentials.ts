import { logger } from '../../../core/logger';
import { tenancy } from '../../../platform/tenancy/context';
import { paymentsRepository } from '../payments.repository';

/**
 * Where the Razorpay keys come from.
 *
 * Environment first, the `settings` table second. The standing rule on this
 * project is that secrets live in environment variables, and a live key sitting
 * in a table that half the admin screens can read is exactly the thing that
 * rule is about. The settings fallback is kept because the Payment settings
 * screen already writes there and a small team will reasonably start that way —
 * but when both are present the environment wins, so a compromised admin
 * account cannot repoint payments at someone else's Razorpay account.
 *
 * Nothing here logs a secret. The only thing ever logged is which source won.
 */

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
  /** Empty when no webhook secret is configured — webhooks are then refused. */
  webhookSecret: string;
  source: 'env' | 'settings' | 'mixed';
  testMode: boolean;
}

const SETTING_KEYS = {
  keyId: 'payment.razorpay_key_id',
  keySecret: 'payment.razorpay_key_secret',
  webhookSecret: 'payment.razorpay_webhook_secret',
  testMode: 'payment.test_mode',
  captureMode: 'payment.capture_mode',
  codEnabled: 'payment.cod_enabled',
} as const;

/**
 * Cached briefly, per shop.
 *
 * Every checkout and every webhook reads these, and they change about once a
 * year. Thirty seconds is short enough that rotating a key in the admin screen
 * takes effect while the person is still looking at the screen. Keyed by shop,
 * because one shop's keys answering for another is money in the wrong account.
 */
const CACHE_MS = 30_000;
const cache = new Map<number, { at: number; value: RazorpayCredentials | null }>();

export function clearCredentialsCache(): void {
  cache.clear();
}

/**
 * Which shop the RAZORPAY_* environment variables belong to.
 *
 * Before the platform hosted many shops, the environment WAS the shop's
 * configuration. It still is for that one shop — the founding shop, id 1 unless
 * LEGACY_PAYMENT_ENV_SHOP_ID says otherwise — and for no other: a shop that has
 * not connected a gateway must not quietly take payments into the operator's
 * Razorpay account. Every other shop connects its own keys under Integrations.
 */
function envCredentialsApplyTo(shopId: number): boolean {
  const owner = Number(process.env.LEGACY_PAYMENT_ENV_SHOP_ID ?? 1);
  return shopId === owner;
}

function envValue(name: string): string {
  return (process.env[name] ?? '').trim();
}

export async function loadRazorpayCredentials(): Promise<RazorpayCredentials | null> {
  const shopId = tenancy.current().id;
  const hit = cache.get(shopId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const rows = await paymentsRepository.getPaymentSettings();
  const settings: Record<string, string> = {};
  for (const row of rows) {
    if (row.value !== null) settings[row.setting_key] = row.value;
  }

  const useEnv = envCredentialsApplyTo(shopId);
  const envKeyId = useEnv ? envValue('RAZORPAY_KEY_ID') : '';
  const envKeySecret = useEnv ? envValue('RAZORPAY_KEY_SECRET') : '';
  const envWebhookSecret = useEnv ? envValue('RAZORPAY_WEBHOOK_SECRET') : '';

  const keyId = envKeyId || (settings[SETTING_KEYS.keyId] ?? '').trim();
  const keySecret = envKeySecret || (settings[SETTING_KEYS.keySecret] ?? '').trim();
  const webhookSecret = envWebhookSecret || (settings[SETTING_KEYS.webhookSecret] ?? '').trim();

  if (!keyId || !keySecret) {
    cache.set(shopId, { at: Date.now(), value: null });
    return null;
  }

  const fromEnv = Boolean(envKeyId && envKeySecret);
  const anyFromEnv = Boolean(envKeyId || envKeySecret || envWebhookSecret);

  const value: RazorpayCredentials = {
    keyId,
    keySecret,
    webhookSecret,
    source: fromEnv && envWebhookSecret ? 'env' : anyFromEnv ? 'mixed' : 'settings',
    // Razorpay's own test keys are prefixed rzp_test_; the stored flag is a
    // display preference and the key prefix is the truth.
    testMode: keyId.startsWith('rzp_test_') || settings[SETTING_KEYS.testMode] === '1',
  };

  cache.set(shopId, { at: Date.now(), value });
  return value;
}

/** Whether a captured payment should be taken automatically or left authorised. */
export async function captureMode(): Promise<'automatic' | 'manual'> {
  const rows = await paymentsRepository.getPaymentSettings();
  const row = rows.find((entry) => entry.setting_key === SETTING_KEYS.captureMode);
  return row?.value === 'manual' ? 'manual' : 'automatic';
}

export function warnIfLiveKeysAreInTheDatabase(credentials: RazorpayCredentials): void {
  if (credentials.source === 'settings' && !credentials.testMode) {
    logger.warn('payments.live_keys_in_database', {
      message:
        'Live Razorpay keys are being read from the settings table. Move them to RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET in the API environment.',
    });
  }
}
