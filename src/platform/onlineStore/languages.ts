import { execute, query, type RowDataPacket } from '../../db/pool';
import { ApiError } from '../../core/ApiError';
import { ShopScopedCache } from '../cache/shopCache';
import { shopId, tenancy } from '../tenancy/context';

/**
 * The languages a store sells in — Shopify's Settings → Languages.
 *
 * The primary language is the shop's own locale and is served at the root
 * (/products/…). Every other language the merchant adds, once published, is
 * served under its code (/hi/products/…, /fr/products/…), with the theme's
 * strings from locales/<code>.json and the merchant's translated content from
 * `translations`. An unpublished language can be previewed and translated but
 * is not reachable by shoppers.
 */

export interface LanguageInfo {
  code: string;
  name: string;
  endonym: string;
  rtl: boolean;
}

/** The languages a store can add. The themes ship strings for the ones marked `theme`. */
export const SUPPORTED_LANGUAGES: (LanguageInfo & { theme: boolean })[] = [
  { code: 'en', name: 'English', endonym: 'English', rtl: false, theme: true },
  { code: 'hi', name: 'Hindi', endonym: 'हिन्दी', rtl: false, theme: true },
  { code: 'bn', name: 'Bengali', endonym: 'বাংলা', rtl: false, theme: false },
  { code: 'ta', name: 'Tamil', endonym: 'தமிழ்', rtl: false, theme: false },
  { code: 'te', name: 'Telugu', endonym: 'తెలుగు', rtl: false, theme: false },
  { code: 'mr', name: 'Marathi', endonym: 'मराठी', rtl: false, theme: false },
  { code: 'gu', name: 'Gujarati', endonym: 'ગુજરાતી', rtl: false, theme: false },
  { code: 'kn', name: 'Kannada', endonym: 'ಕನ್ನಡ', rtl: false, theme: false },
  { code: 'ml', name: 'Malayalam', endonym: 'മലയാളം', rtl: false, theme: false },
  { code: 'pa', name: 'Punjabi', endonym: 'ਪੰਜਾਬੀ', rtl: false, theme: false },
  { code: 'fr', name: 'French', endonym: 'Français', rtl: false, theme: true },
  { code: 'es', name: 'Spanish', endonym: 'Español', rtl: false, theme: true },
  { code: 'de', name: 'German', endonym: 'Deutsch', rtl: false, theme: true },
  { code: 'it', name: 'Italian', endonym: 'Italiano', rtl: false, theme: false },
  { code: 'pt-br', name: 'Portuguese (Brazil)', endonym: 'Português (Brasil)', rtl: false, theme: false },
  { code: 'nl', name: 'Dutch', endonym: 'Nederlands', rtl: false, theme: false },
  { code: 'ar', name: 'Arabic', endonym: 'العربية', rtl: true, theme: false },
  { code: 'ja', name: 'Japanese', endonym: '日本語', rtl: false, theme: false },
  { code: 'zh-cn', name: 'Chinese (Simplified)', endonym: '简体中文', rtl: false, theme: false },
];

const BY_CODE = new Map(SUPPORTED_LANGUAGES.map((language) => [language.code, language]));

export function languageInfo(code: string): LanguageInfo {
  const known = BY_CODE.get(code.toLowerCase());
  if (known) return known;
  return { code, name: code, endonym: code, rtl: false };
}

export interface ShopLanguage extends LanguageInfo {
  primary: boolean;
  published: boolean;
  /** Where the storefront serves it: '/' for the primary language, '/hi/' otherwise. */
  root_url: string;
}

export interface ShopLanguages {
  primary: ShopLanguage;
  /** Every language, primary first. */
  all: ShopLanguage[];
  /** What shoppers can switch to: the primary language and the published ones. */
  published: ShopLanguage[];
}

/** The shop's primary language: its locale's language ('en-IN' → 'en'). */
export function primaryCode(): string {
  const locale = (tenancy.current().locale || 'en').toLowerCase();
  const base = locale.split(/[-_]/)[0];
  return BY_CODE.has(locale) ? locale : base;
}

const cache = new ShopScopedCache<ShopLanguages>(30_000);

interface LanguageRow extends RowDataPacket {
  locale: string;
  published: number;
}

export const shopLanguages = {
  async get(): Promise<ShopLanguages> {
    return cache.get('languages', async () => {
      const primaryLocale = primaryCode();
      const rows = await query<LanguageRow>('SELECT locale, published FROM shop_languages WHERE shop_id = ? ORDER BY created_at, id', [shopId()]);
      const primary: ShopLanguage = { ...languageInfo(primaryLocale), primary: true, published: true, root_url: '/' };
      const others = rows
        .filter((row) => row.locale !== primaryLocale)
        .map((row): ShopLanguage => ({ ...languageInfo(row.locale), primary: false, published: row.published === 1, root_url: `/${row.locale}` }));
      const all = [primary, ...others];
      return { primary, all, published: all.filter((language) => language.published) };
    });
  },

  async add(code: string): Promise<ShopLanguages> {
    const locale = code.toLowerCase();
    if (!BY_CODE.has(locale)) throw ApiError.validation({ locale: ['That language is not available yet.'] });
    if (locale === primaryCode()) throw ApiError.validation({ locale: ['That is already the store’s primary language.'] });
    await execute('INSERT IGNORE INTO shop_languages (shop_id, locale, published) VALUES (?, ?, 0)', [shopId(), locale]);
    cache.clear();
    return this.get();
  },

  async setPublished(code: string, published: boolean): Promise<ShopLanguages> {
    const result = await execute('UPDATE shop_languages SET published = ? WHERE shop_id = ? AND locale = ?', [published ? 1 : 0, shopId(), code.toLowerCase()]);
    if (result.affectedRows === 0) throw ApiError.notFound('Language');
    cache.clear();
    return this.get();
  },

  /** Removes a language; its translations are kept, so adding it back restores them. */
  async remove(code: string): Promise<ShopLanguages> {
    const result = await execute('DELETE FROM shop_languages WHERE shop_id = ? AND locale = ?', [shopId(), code.toLowerCase()]);
    if (result.affectedRows === 0) throw ApiError.notFound('Language');
    cache.clear();
    return this.get();
  },

  clearCache(): void {
    cache.clear();
  },
};
