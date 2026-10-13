/**
 * Which privacy rules apply to a visitor, from the country they are in.
 *
 * Two independent questions, as on Shopify:
 *
 *   consent required  Non-essential cookies (analytics, marketing,
 *                     preferences) wait for an opt-in: the banner shows, and
 *                     nothing non-essential runs until the visitor chooses.
 *                     The ePrivacy Directive with GDPR in the EU/EEA, UK GDPR
 *                     and PECR, Switzerland's FADP, India's DPDP Act 2023
 *                     (consent must be free, specific, informed and given by
 *                     a clear affirmative action — s.6), and Brazil's LGPD.
 *
 *   sale opt-out      Tracking runs by default, but the visitor may opt out of
 *                     the sale or sharing of their personal data: CCPA/CPRA
 *                     and the other US state laws. A "Your privacy choices"
 *                     link and page, and the Global Privacy Control signal
 *                     honoured as an opt-out.
 *
 * Countries, not states: the edge reports a country. A merchant who wants
 * the banner everywhere picks "all".
 */

/** EU member states, plus Iceland, Liechtenstein and Norway (the EEA). */
export const EEA = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
] as const;

/** Where the law asks for opt-in consent before non-essential cookies. */
export const CONSENT_REQUIRED_COUNTRIES: readonly string[] = [...EEA, 'GB', 'CH', 'IN', 'BR'];

/** Where shoppers may opt out of the sale or sharing of their data. */
export const DEFAULT_SALE_OPT_OUT_COUNTRIES: readonly string[] = ['US'];

export interface RegionRules {
  banner_enabled: boolean;
  banner_regions: 'required' | 'all' | 'custom';
  banner_countries: string[];
  sale_opt_out_enabled: boolean;
  sale_opt_out_countries: string[];
}

export interface PrivacyRegion {
  /** ISO 3166-1 alpha-2, or null when nothing said where the visitor is. */
  country: string | null;
  /** The banner shows and non-essential tracking waits for a yes. */
  consentRequired: boolean;
  /** "Your privacy choices" applies: the sale or sharing of data can be refused. */
  saleOptOut: boolean;
  /** The two answers as a cache-key part: pages differ by it, not by country. */
  key: string;
}

export function normaliseCountry(value: unknown): string | null {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  // XX and T1 are Cloudflare's "unknown" and "Tor".
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : null;
}

export function classifyRegion(country: string | null, rules: RegionRules): PrivacyRegion {
  const bannerList = rules.banner_regions === 'custom' ? rules.banner_countries : CONSENT_REQUIRED_COUNTRIES;
  const consentRequired =
    rules.banner_enabled &&
    (rules.banner_regions === 'all' || (country !== null && bannerList.includes(country)));
  const optOutList = rules.sale_opt_out_countries.length ? rules.sale_opt_out_countries : DEFAULT_SALE_OPT_OUT_COUNTRIES;
  const saleOptOut = rules.sale_opt_out_enabled && country !== null && optOutList.includes(country);
  return { country, consentRequired, saleOptOut, key: `c${consentRequired ? 1 : 0}s${saleOptOut ? 1 : 0}` };
}

/**
 * The country a request comes from: the edge's geolocation header when one is
 * present (Cloudflare, Vercel, CloudFront, or GEO_COUNTRY_HEADER), else null.
 *
 * A visitor can forge these headers, but only to change their own banner:
 * pages are keyed by the rules the country leads to, so a forged header only
 * ever fetches the page every visitor from that country gets.
 */
export function countryFromHeaders(header: (name: string) => string | undefined): string | null {
  const configured = process.env.GEO_COUNTRY_HEADER?.trim().toLowerCase();
  for (const name of [configured, 'cf-ipcountry', 'x-vercel-ip-country', 'cloudfront-viewer-country', 'x-country-code']) {
    if (!name) continue;
    const country = normaliseCountry(header(name));
    if (country) return country;
  }
  return null;
}

/** An IP address with the host part dropped: /24 for IPv4, /48 for IPv6. Where from, never who. */
export function ipPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const address = ip.replace(/^::ffff:/i, '');
  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (address.includes(':')) {
    const [head] = address.split('::');
    const groups = head.split(':').filter(Boolean).slice(0, 3);
    while (groups.length < 3) groups.push('0');
    return `${groups.join(':')}::/48`;
  }
  return null;
}
