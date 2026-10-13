import { stateCodeFor as indianStateCode } from '../../core/india';

/**
 * States and provinces by name, for the countries whose tax depends on them.
 *
 * Checkout forms send a state *name* ("California") and, sometimes, a code.
 * Destination-based tax needs the code, so this turns either into the postal
 * abbreviation. India delegates to its GST state table.
 */

const US: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'puerto rico': 'PR', guam: 'GU', 'us virgin islands': 'VI', 'american samoa': 'AS', 'northern mariana islands': 'MP',
};

const CA: Record<string, string> = {
  alberta: 'AB', 'british columbia': 'BC', manitoba: 'MB', 'new brunswick': 'NB', 'newfoundland and labrador': 'NL',
  'nova scotia': 'NS', ontario: 'ON', 'prince edward island': 'PE', quebec: 'QC', québec: 'QC', saskatchewan: 'SK',
  'northwest territories': 'NT', nunavut: 'NU', yukon: 'YT',
};

const TABLES: Record<string, Record<string, string>> = { US, CA };

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/&/g, 'and').replace(/[.]/g, '').replace(/\s+/g, ' ');
}

/** The region code for a state or province given by name or code; null if unknown. */
export function regionCodeFor(country: string, value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null;
  const upperCountry = country.toUpperCase();
  if (upperCountry === 'IN') return indianStateCode(value);
  const table = TABLES[upperCountry];
  if (!table) return null;
  const candidate = value.trim().toUpperCase();
  if (Object.values(table).includes(candidate)) return candidate;
  return table[normalise(value)] ?? null;
}

/** Whether a country's regions are known here (and so can be required at checkout). */
export function knowsRegionsOf(country: string): boolean {
  return country.toUpperCase() in TABLES || country.toUpperCase() === 'IN';
}
