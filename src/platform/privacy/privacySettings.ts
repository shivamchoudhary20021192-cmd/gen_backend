import { execute, queryOne, type RowDataPacket } from '../../db/pool';
import { auditService } from '../../shared/audit.service';
import { ShopScopedCache } from '../cache/shopCache';
import { shopId } from '../tenancy/context';
import { EDITABLE_BANNER_COPY, PRIVACY_COPY_LOCALES, privacyCopy, type BannerCopyOverride } from './privacyCopy';
import { CONSENT_REQUIRED_COUNTRIES, DEFAULT_SALE_OPT_OUT_COUNTRIES, normaliseCountry, type RegionRules } from './regions';

/**
 * A shop's privacy settings (Settings → Customer privacy). A shop that never
 * saved them has the defaults, which are the compliant ones: the banner on
 * where consent is required, the US opt-out on, Global Privacy Control
 * honoured, requests answered within 30 days.
 */

export interface BannerColors {
  background: string;
  text: string;
  button: string;
  button_text: string;
}

export interface PrivacySettings extends RegionRules {
  banner_position: 'bottom' | 'bottom_left' | 'bottom_right' | 'center';
  banner_colors: BannerColors;
  banner_copy: Record<string, BannerCopyOverride>;
  consent_max_age_days: number;
  reprompt_on_policy_change: boolean;
  honor_gpc: boolean;
  request_form_enabled: boolean;
  request_response_days: number;
  erasure_grace_days: number;
  erasure_order_hold_days: number;
  privacy_email: string | null;
  grievance_officer_name: string | null;
  grievance_officer_email: string | null;
  grievance_officer_phone: string | null;
  updated_at: string | null;
}

export const DEFAULT_BANNER_COLORS: BannerColors = { background: '#ffffff', text: '#1a1a1a', button: '#1a1a1a', button_text: '#ffffff' };

export const DEFAULT_PRIVACY_SETTINGS: PrivacySettings = {
  banner_enabled: true,
  banner_regions: 'required',
  banner_countries: [],
  banner_position: 'bottom',
  banner_colors: DEFAULT_BANNER_COLORS,
  banner_copy: {},
  consent_max_age_days: 365,
  reprompt_on_policy_change: true,
  sale_opt_out_enabled: true,
  sale_opt_out_countries: [...DEFAULT_SALE_OPT_OUT_COUNTRIES],
  honor_gpc: true,
  request_form_enabled: true,
  request_response_days: 30,
  erasure_grace_days: 10,
  erasure_order_hold_days: 180,
  privacy_email: null,
  grievance_officer_name: null,
  grievance_officer_email: null,
  grievance_officer_phone: null,
  updated_at: null,
};

interface SettingsRow extends RowDataPacket {
  banner_enabled: number;
  banner_regions: PrivacySettings['banner_regions'];
  banner_countries: unknown;
  banner_position: PrivacySettings['banner_position'];
  banner_colors: unknown;
  banner_copy: unknown;
  consent_max_age_days: number;
  reprompt_on_policy_change: number;
  sale_opt_out_enabled: number;
  sale_opt_out_countries: unknown;
  honor_gpc: number;
  request_form_enabled: number;
  request_response_days: number;
  erasure_grace_days: number;
  erasure_order_hold_days: number;
  privacy_email: string | null;
  grievance_officer_name: string | null;
  grievance_officer_email: string | null;
  grievance_officer_phone: string | null;
  updated_at: Date | null;
}

function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

const COLOR = /^#[0-9a-f]{6}$/i;

function countries(value: unknown): string[] {
  return [...new Set((Array.isArray(value) ? value : []).map(normaliseCountry).filter((code): code is string => code !== null))];
}

function colors(value: unknown): BannerColors {
  const given = json<Partial<BannerColors>>(value, {});
  const pick = (key: keyof BannerColors) => (typeof given[key] === 'string' && COLOR.test(given[key]!) ? given[key]!.toLowerCase() : DEFAULT_BANNER_COLORS[key]);
  return { background: pick('background'), text: pick('text'), button: pick('button'), button_text: pick('button_text') };
}

function copy(value: unknown): Record<string, BannerCopyOverride> {
  const given = json<Record<string, Record<string, unknown>>>(value, {});
  const out: Record<string, BannerCopyOverride> = {};
  for (const [locale, entry] of Object.entries(given ?? {})) {
    if (!/^[a-z]{2}(-[a-z]{2,4})?$/.test(locale) || !entry || typeof entry !== 'object') continue;
    const cleaned: BannerCopyOverride = {};
    for (const key of EDITABLE_BANNER_COPY) {
      const text = entry[key];
      if (typeof text === 'string' && text.trim()) cleaned[key] = text.trim().slice(0, key === 'message' ? 1000 : 120);
    }
    if (Object.keys(cleaned).length) out[locale] = cleaned;
  }
  return out;
}

function fromRow(row: SettingsRow): PrivacySettings {
  return {
    banner_enabled: row.banner_enabled === 1,
    banner_regions: row.banner_regions,
    banner_countries: countries(json(row.banner_countries, [])),
    banner_position: row.banner_position,
    banner_colors: colors(row.banner_colors),
    banner_copy: copy(row.banner_copy),
    consent_max_age_days: Number(row.consent_max_age_days),
    reprompt_on_policy_change: row.reprompt_on_policy_change === 1,
    sale_opt_out_enabled: row.sale_opt_out_enabled === 1,
    sale_opt_out_countries: countries(json(row.sale_opt_out_countries, [])),
    honor_gpc: row.honor_gpc === 1,
    request_form_enabled: row.request_form_enabled === 1,
    request_response_days: Number(row.request_response_days),
    erasure_grace_days: Number(row.erasure_grace_days),
    erasure_order_hold_days: Number(row.erasure_order_hold_days),
    privacy_email: row.privacy_email,
    grievance_officer_name: row.grievance_officer_name,
    grievance_officer_email: row.grievance_officer_email,
    grievance_officer_phone: row.grievance_officer_phone,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

const cache = new ShopScopedCache<PrivacySettings>(15_000);

export type PrivacySettingsInput = Partial<Omit<PrivacySettings, 'updated_at'>>;

export const privacySettings = {
  async get(): Promise<PrivacySettings> {
    return cache.get('settings', async () => {
      const row = await queryOne<SettingsRow>('SELECT * FROM shop_privacy_settings WHERE shop_id = ?', [shopId()]);
      if (!row) return { ...DEFAULT_PRIVACY_SETTINGS, sale_opt_out_countries: [...DEFAULT_PRIVACY_SETTINGS.sale_opt_out_countries] };
      const settings = fromRow(row);
      if (!settings.sale_opt_out_countries.length) settings.sale_opt_out_countries = [...DEFAULT_SALE_OPT_OUT_COUNTRIES];
      return settings;
    });
  },

  async update(input: PrivacySettingsInput, actor: { id: number | null; label: string | null }): Promise<PrivacySettings> {
    const next: PrivacySettings = { ...(await this.get()), ...input } as PrivacySettings;
    next.banner_countries = countries(next.banner_countries);
    next.sale_opt_out_countries = countries(next.sale_opt_out_countries);
    if (!next.sale_opt_out_countries.length) next.sale_opt_out_countries = [...DEFAULT_SALE_OPT_OUT_COUNTRIES];
    next.banner_colors = colors(next.banner_colors);
    next.banner_copy = copy(next.banner_copy);
    await execute(
      `INSERT INTO shop_privacy_settings
         (shop_id, banner_enabled, banner_regions, banner_countries, banner_position, banner_colors, banner_copy,
          consent_max_age_days, reprompt_on_policy_change, sale_opt_out_enabled, sale_opt_out_countries, honor_gpc,
          request_form_enabled, request_response_days, erasure_grace_days, erasure_order_hold_days,
          privacy_email, grievance_officer_name, grievance_officer_email, grievance_officer_phone, updated_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         banner_enabled = VALUES(banner_enabled), banner_regions = VALUES(banner_regions),
         banner_countries = VALUES(banner_countries), banner_position = VALUES(banner_position),
         banner_colors = VALUES(banner_colors), banner_copy = VALUES(banner_copy),
         consent_max_age_days = VALUES(consent_max_age_days), reprompt_on_policy_change = VALUES(reprompt_on_policy_change),
         sale_opt_out_enabled = VALUES(sale_opt_out_enabled), sale_opt_out_countries = VALUES(sale_opt_out_countries),
         honor_gpc = VALUES(honor_gpc), request_form_enabled = VALUES(request_form_enabled),
         request_response_days = VALUES(request_response_days), erasure_grace_days = VALUES(erasure_grace_days),
         erasure_order_hold_days = VALUES(erasure_order_hold_days), privacy_email = VALUES(privacy_email),
         grievance_officer_name = VALUES(grievance_officer_name), grievance_officer_email = VALUES(grievance_officer_email),
         grievance_officer_phone = VALUES(grievance_officer_phone), updated_by_admin_id = VALUES(updated_by_admin_id)`,
      [
        shopId(),
        next.banner_enabled ? 1 : 0,
        next.banner_regions,
        JSON.stringify(next.banner_countries),
        next.banner_position,
        JSON.stringify(next.banner_colors),
        JSON.stringify(next.banner_copy),
        next.consent_max_age_days,
        next.reprompt_on_policy_change ? 1 : 0,
        next.sale_opt_out_enabled ? 1 : 0,
        JSON.stringify(next.sale_opt_out_countries),
        next.honor_gpc ? 1 : 0,
        next.request_form_enabled ? 1 : 0,
        next.request_response_days,
        next.erasure_grace_days,
        next.erasure_order_hold_days,
        next.privacy_email,
        next.grievance_officer_name,
        next.grievance_officer_email,
        next.grievance_officer_phone,
        actor.id,
      ],
    );
    cache.clear();
    const changed = Object.keys(input).join(', ');
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'privacy.settings_updated', entityType: 'shop', entityId: shopId(), summary: `Changed customer privacy settings (${changed})` });
    return this.get();
  },

  /** What the admin shows next to the settings: the built-in wording and the regions behind "required". */
  defaults() {
    return {
      required_countries: CONSENT_REQUIRED_COUNTRIES,
      sale_opt_out_countries: DEFAULT_SALE_OPT_OUT_COUNTRIES,
      banner_colors: DEFAULT_BANNER_COLORS,
      banner_copy: Object.fromEntries(
        PRIVACY_COPY_LOCALES.map((locale) => {
          const words = privacyCopy(locale);
          return [locale, Object.fromEntries(EDITABLE_BANNER_COPY.map((key) => [key, words[key]]))];
        }),
      ),
    };
  },
};
