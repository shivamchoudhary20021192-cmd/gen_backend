import { query, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { ShopScopedCache } from '../../platform/cache/shopCache';
import { shopId, tenancy } from '../../platform/tenancy/context';
import { callingCodeFor } from '../../platform/geo/phone';

/**
 * The knobs the messaging rules are read against.
 *
 * Every one of these lives in `settings` rather than in this file, because each
 * is a number somebody will need to change without a deploy: the promotional
 * window moves with the regulator, the frequency cap moves with how often the
 * shop wants to be heard from, and the DLT requirement has to be switchable off
 * for a test gateway.
 *
 * Cached for a minute. These are read once per recipient in a campaign of forty
 * thousand people, and a settings query per recipient would be the slowest thing
 * in the system by an order of magnitude.
 */

export interface MessagingSettings {
  timezone: string;
  /** Minutes after midnight, in `timezone`. */
  marketingWindowStart: number;
  marketingWindowEnd: number;
  frequencyCapHours: number;
  enforceDlt: boolean;
  requireOptOut: boolean;
  optOutTextSms: string;
  defaultCountryCode: string;
  campaignBatchSize: number;
  simulatorDeliveryRate: number;
}

const DEFAULTS: MessagingSettings = {
  timezone: 'Asia/Kolkata',
  marketingWindowStart: 10 * 60,
  marketingWindowEnd: 21 * 60,
  frequencyCapHours: 72,
  enforceDlt: true,
  requireOptOut: true,
  optOutTextSms: 'To stop, reply STOP',
  defaultCountryCode: '91',
  campaignBatchSize: 200,
  simulatorDeliveryRate: 94,
};

const CACHE_MS = 60_000;
/** One entry per shop: every shop has its own window, cap and gateway rules. */
const cache = new ShopScopedCache<MessagingSettings>(CACHE_MS);

/** "21:00" → 1260. Anything unparseable falls back rather than throwing. */
function minutesOfDay(value: string | undefined, fallback: number): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return hours * 60 + minutes;
}

function boolish(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function numberish(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function messagingSettings(exec: Executor = pool): Promise<MessagingSettings> {
  return cache.get('messaging', () => loadMessagingSettings(exec));
}

async function loadMessagingSettings(exec: Executor): Promise<MessagingSettings> {
  const rows = await query<RowDataPacket & { setting_key: string; value: string | null; default_value: string | null }>(
    "SELECT setting_key, value, default_value FROM settings WHERE shop_id = ? AND group_key = 'messaging'",
    [shopId()],
    exec,
  );
  // A shop that never set a messaging timezone gets its own, not India's.
  const shopTimezone = tenancy.currentOrNull()?.timezone || DEFAULTS.timezone;

  const raw = new Map<string, string>();
  for (const row of rows) {
    const value = (row.value ?? row.default_value ?? '').toString();
    if (value !== '') raw.set(row.setting_key, value);
  }

  const value: MessagingSettings = {
    timezone: raw.get('messaging.timezone') ?? shopTimezone,
    marketingWindowStart: minutesOfDay(raw.get('messaging.marketing_window_start'), DEFAULTS.marketingWindowStart),
    marketingWindowEnd: minutesOfDay(raw.get('messaging.marketing_window_end'), DEFAULTS.marketingWindowEnd),
    frequencyCapHours: numberish(raw.get('messaging.frequency_cap_hours'), DEFAULTS.frequencyCapHours),
    enforceDlt: boolish(raw.get('messaging.enforce_dlt'), DEFAULTS.enforceDlt),
    requireOptOut: boolish(raw.get('messaging.require_opt_out'), DEFAULTS.requireOptOut),
    optOutTextSms: raw.get('messaging.opt_out_text_sms') ?? DEFAULTS.optOutTextSms,
    defaultCountryCode:
      raw.get('messaging.default_country_code') ??
      callingCodeFor(tenancy.currentOrNull()?.countryCode) ??
      DEFAULTS.defaultCountryCode,
    campaignBatchSize: numberish(raw.get('messaging.campaign_batch_size'), DEFAULTS.campaignBatchSize),
    simulatorDeliveryRate: numberish(raw.get('messaging.simulator_delivery_rate'), DEFAULTS.simulatorDeliveryRate),
  };

  return value;
}

/** Called when the settings screen saves, so the next read is not a minute old. */
export function clearMessagingSettingsCache(): void {
  cache.clear();
}

/**
 * What time it is where the recipients are.
 *
 * The server may be in UTC and the customers are not; a promotional window
 * measured in server time is either an hour of illegal sending or an hour of
 * refusing legal sends. `Intl` is used rather than an offset constant because
 * the setting is a zone name and zones have rules.
 */
export function minutesOfDayIn(timezone: string, when: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(when);

  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
