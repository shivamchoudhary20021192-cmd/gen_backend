import { sanitizeMerchantHtml } from '../../core/merchantHtml';

/**
 * The value types a merchant's own fields can hold — product and variant
 * custom fields (metafields) and the fields of metaobject types.
 *
 * Named and shaped as Shopify names and shapes them
 * (shopify.dev/docs/apps/build/metafields/list-of-data-types), so a theme or an
 * app written against Shopify's documentation reads them unchanged:
 *
 *   text        single_line_text_field (a dropdown when it has `choices`),
 *               multi_line_text_field, rich_text_field
 *   number      number_integer, number_decimal
 *   date        date, date_time
 *   measurement weight, volume, dimension — {value, unit}
 *   reference   product_reference, variant_reference, collection_reference,
 *               file_reference, metaobject_reference, page_reference
 *   other       boolean, color, url, link, money, rating, json
 *
 * and `list.<type>` for every type that can repeat.
 *
 * Everything here is pure: checking a value against its definition,
 * normalising it, and laying it out across the typed columns of `metafields`
 * (and back). Existence of referenced records is the service's job.
 */

export const MEASUREMENTS = {
  weight: { base: 'g', units: { mg: 0.001, g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 } },
  volume: { base: 'ml', units: { ml: 1, cl: 10, l: 1000, m3: 1_000_000, fl_oz: 29.5735295625, gal: 3785.411784 } },
  dimension: { base: 'mm', units: { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, yd: 914.4 } },
} as const;

export type MeasurementType = keyof typeof MEASUREMENTS;

export const REFERENCE_KINDS = {
  product_reference: 'product',
  variant_reference: 'variant',
  collection_reference: 'collection',
  file_reference: 'file',
  metaobject_reference: 'metaobject',
  page_reference: 'page',
} as const;

export type ReferenceType = keyof typeof REFERENCE_KINDS;
export type ReferenceKind = (typeof REFERENCE_KINDS)[ReferenceType];

export type FieldGroup = 'text' | 'number' | 'date' | 'measurement' | 'reference' | 'other';

interface TypeInfo {
  label: string;
  group: FieldGroup;
  listable: boolean;
  /** Which validation options a definition of this type may set. */
  validations: readonly ValidationKey[];
}

export type ValidationKey =
  | 'min'
  | 'max'
  | 'regex'
  | 'choices'
  | 'max_precision'
  | 'allowed_domains'
  | 'file_types'
  | 'metaobject_type'
  | 'scale_min'
  | 'scale_max'
  | 'currency_code';

const LIST_VALIDATIONS = ['list_min', 'list_max'] as const;

export const FIELD_TYPES = {
  single_line_text_field: { label: 'Single line text', group: 'text', listable: true, validations: ['min', 'max', 'regex', 'choices'] },
  multi_line_text_field: { label: 'Multi-line text', group: 'text', listable: false, validations: ['min', 'max', 'regex'] },
  rich_text_field: { label: 'Rich text', group: 'text', listable: false, validations: [] },
  number_integer: { label: 'Integer', group: 'number', listable: true, validations: ['min', 'max'] },
  number_decimal: { label: 'Decimal', group: 'number', listable: true, validations: ['min', 'max', 'max_precision'] },
  date: { label: 'Date', group: 'date', listable: true, validations: ['min', 'max'] },
  date_time: { label: 'Date and time', group: 'date', listable: true, validations: ['min', 'max'] },
  weight: { label: 'Weight', group: 'measurement', listable: true, validations: ['min', 'max'] },
  volume: { label: 'Volume', group: 'measurement', listable: true, validations: ['min', 'max'] },
  dimension: { label: 'Dimension', group: 'measurement', listable: true, validations: ['min', 'max'] },
  product_reference: { label: 'Product', group: 'reference', listable: true, validations: [] },
  variant_reference: { label: 'Product variant', group: 'reference', listable: true, validations: [] },
  collection_reference: { label: 'Collection', group: 'reference', listable: true, validations: [] },
  file_reference: { label: 'File', group: 'reference', listable: true, validations: ['file_types'] },
  metaobject_reference: { label: 'Metaobject', group: 'reference', listable: true, validations: ['metaobject_type'] },
  page_reference: { label: 'Page', group: 'reference', listable: true, validations: [] },
  boolean: { label: 'True or false', group: 'other', listable: false, validations: [] },
  color: { label: 'Colour', group: 'other', listable: true, validations: [] },
  url: { label: 'URL', group: 'other', listable: true, validations: ['allowed_domains'] },
  link: { label: 'Link', group: 'other', listable: true, validations: [] },
  money: { label: 'Money', group: 'other', listable: false, validations: ['min', 'max', 'currency_code'] },
  rating: { label: 'Rating', group: 'other', listable: true, validations: ['scale_min', 'scale_max'] },
  json: { label: 'JSON', group: 'other', listable: false, validations: [] },
} as const satisfies Record<string, TypeInfo>;

export type BaseType = keyof typeof FIELD_TYPES;

export interface Validations {
  min?: number | string | { value: number; unit: string } | null;
  max?: number | string | { value: number; unit: string } | null;
  regex?: string | null;
  choices?: string[] | null;
  max_precision?: number | null;
  allowed_domains?: string[] | null;
  file_types?: FileKind[] | null;
  metaobject_type?: string | null;
  scale_min?: number | null;
  scale_max?: number | null;
  currency_code?: string | null;
  list_min?: number | null;
  list_max?: number | null;
}

export type FileKind = 'image' | 'video' | 'document';

export const LIMITS = {
  singleLine: 5_000,
  multiLine: 65_535,
  richText: 100_000,
  json: 65_536,
  choices: 128,
  choiceLength: 255,
  listItems: 128,
  regex: 200,
  integer: 1e14,
} as const;

export interface ParsedType {
  base: BaseType;
  list: boolean;
}

export function parseType(type: string): ParsedType | null {
  const list = type.startsWith('list.');
  const base = (list ? type.slice(5) : type) as BaseType;
  if (!Object.prototype.hasOwnProperty.call(FIELD_TYPES, base)) return null;
  if (list && !FIELD_TYPES[base].listable) return null;
  return { base, list };
}

export function isFieldType(type: string): boolean {
  return parseType(type) !== null;
}

/** Every type a definition may be created with, for the admin's picker. */
export function typeCatalog() {
  return (Object.keys(FIELD_TYPES) as BaseType[]).map((base) => ({
    type: base,
    label: FIELD_TYPES[base].label,
    group: FIELD_TYPES[base].group,
    listable: FIELD_TYPES[base].listable,
    validations: [...FIELD_TYPES[base].validations, ...(FIELD_TYPES[base].listable ? LIST_VALIDATIONS : [])],
  }));
}

export type Checked = { ok: true; value: unknown } | { ok: false; error: string };

const ok = (value: unknown): Checked => ({ ok: true, value });
const fail = (error: string): Checked => ({ ok: false, error });

function isBlank(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0);
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '' && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw.trim())) return Number(raw.trim());
  return null;
}

function decimals(raw: unknown): number {
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  const dot = text.indexOf('.');
  return dot === -1 || /e/i.test(text) ? 0 : text.length - dot - 1;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(text: string): boolean {
  const match = DATE_RE.exec(text);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

const URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:']);

function checkUrl(raw: unknown, validations: Validations): Checked {
  if (typeof raw !== 'string') return fail('Enter a URL.');
  const text = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return fail('Enter a full URL, starting with https://.');
  }
  if (!URL_SCHEMES.has(parsed.protocol)) return fail('Only http, https, mailto, tel and sms links are allowed.');
  if (text.length > 2048) return fail('URLs can be at most 2,048 characters.');
  const domains = validations.allowed_domains ?? [];
  if (domains.length > 0 && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    const host = parsed.hostname.toLowerCase();
    if (!domains.some((domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`))) {
      return fail(`Links must go to ${domains.join(', ')}.`);
    }
  }
  return ok(text);
}

/** A measurement in its base unit (g, ml, mm), for comparing and sorting across units. */
export function inBaseUnit(type: MeasurementType, value: { value: number; unit: string }): number | null {
  const factor = (MEASUREMENTS[type].units as Record<string, number>)[value.unit];
  return factor === undefined ? null : value.value * factor;
}

function checkMeasurement(type: MeasurementType, raw: unknown, validations: Validations): Checked {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Enter an amount and a unit.');
  const input = raw as { value?: unknown; unit?: unknown };
  const value = toNumber(input.value);
  const unit = typeof input.unit === 'string' ? input.unit.trim().toLowerCase() : '';
  if (value === null) return fail('Enter an amount.');
  if (!(unit in MEASUREMENTS[type].units)) return fail(`Choose a unit: ${Object.keys(MEASUREMENTS[type].units).join(', ')}.`);
  if (value < 0) return fail('The amount cannot be negative.');
  const normalised = { value: Math.round(value * 1e6) / 1e6, unit };
  const base = inBaseUnit(type, normalised)!;
  for (const bound of ['min', 'max'] as const) {
    const limit = validations[bound];
    if (!limit || typeof limit !== 'object') continue;
    const limitBase = inBaseUnit(type, limit);
    if (limitBase === null) continue;
    if (bound === 'min' && base < limitBase - 1e-9) return fail(`Must be at least ${limit.value} ${limit.unit}.`);
    if (bound === 'max' && base > limitBase + 1e-9) return fail(`Must be at most ${limit.value} ${limit.unit}.`);
  }
  return ok(normalised);
}

function checkReference(raw: unknown): Checked {
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : typeof raw === 'object' && raw && 'id' in raw ? Number((raw as { id: unknown }).id) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) return fail('Choose an item.');
  return ok(id);
}

function checkText(base: 'single_line_text_field' | 'multi_line_text_field', raw: unknown, validations: Validations): Checked {
  if (typeof raw !== 'string' && typeof raw !== 'number') return fail('Enter text.');
  let text = String(raw);
  if (base === 'single_line_text_field') text = text.replace(/[\r\n]+/g, ' ').trim();
  else text = text.replace(/\r\n?/g, '\n').trim();
  const cap = base === 'single_line_text_field' ? LIMITS.singleLine : LIMITS.multiLine;
  if (text.length > cap) return fail(`Can be at most ${cap.toLocaleString('en-IN')} characters.`);
  const choices = base === 'single_line_text_field' ? (validations.choices ?? []) : [];
  if (choices.length > 0) {
    const match = choices.find((choice) => choice.toLowerCase() === text.toLowerCase());
    if (!match) return fail(`Choose one of: ${choices.slice(0, 8).join(', ')}${choices.length > 8 ? '…' : ''}.`);
    return ok(match);
  }
  const min = typeof validations.min === 'number' ? validations.min : null;
  const max = typeof validations.max === 'number' ? validations.max : null;
  if (min !== null && text.length < min) return fail(`Must be at least ${min} characters.`);
  if (max !== null && text.length > max) return fail(`Can be at most ${max} characters.`);
  if (validations.regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(`^(?:${validations.regex})$`, 'u');
    } catch {
      return ok(text);
    }
    if (!pattern.test(text)) return fail('Does not match the required format.');
  }
  return ok(text);
}

function checkNumber(base: 'number_integer' | 'number_decimal', raw: unknown, validations: Validations): Checked {
  const value = toNumber(raw);
  if (value === null) return fail('Enter a number.');
  if (base === 'number_integer' && !Number.isInteger(value)) return fail('Enter a whole number.');
  if (Math.abs(value) >= LIMITS.integer) return fail('That number is too large.');
  if (base === 'number_decimal') {
    const precision = validations.max_precision ?? 6;
    if (decimals(raw) > Math.min(precision, 6)) return fail(`Use at most ${Math.min(precision, 6)} decimal places.`);
  }
  const min = toNumber(validations.min);
  const max = toNumber(validations.max);
  if (min !== null && value < min) return fail(`Must be at least ${min}.`);
  if (max !== null && value > max) return fail(`Must be at most ${max}.`);
  return ok(base === 'number_integer' ? value : Math.round(value * 1e6) / 1e6);
}

function checkDate(base: 'date' | 'date_time', raw: unknown, validations: Validations): Checked {
  if (typeof raw !== 'string') return fail(base === 'date' ? 'Enter a date.' : 'Enter a date and time.');
  const text = raw.trim();
  let normalised: string;
  if (base === 'date') {
    if (!validDate(text)) return fail('Enter a date as YYYY-MM-DD.');
    normalised = text;
  } else {
    const parsed = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`);
    if (Number.isNaN(parsed.getTime())) return fail('Enter a date and time.');
    normalised = parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  const bound = (limit: unknown) => (typeof limit === 'string' && limit ? (base === 'date' ? limit : new Date(limit).toISOString().replace(/\.\d{3}Z$/, 'Z')) : null);
  const min = bound(validations.min);
  const max = bound(validations.max);
  if (min && normalised < min) return fail(`Must be on or after ${validations.min}.`);
  if (max && normalised > max) return fail(`Must be on or before ${validations.max}.`);
  return ok(normalised);
}

function checkMoney(raw: unknown, validations: Validations): Checked {
  if (!raw || typeof raw !== 'object') return fail('Enter an amount.');
  const input = raw as { amount?: unknown; currency_code?: unknown };
  const amount = toNumber(input.amount);
  if (amount === null) return fail('Enter an amount.');
  if (decimals(input.amount) > 2) return fail('Use at most two decimal places.');
  const currency = String(input.currency_code ?? validations.currency_code ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return fail('Choose a currency.');
  if (validations.currency_code && currency !== validations.currency_code.toUpperCase()) return fail(`Must be in ${validations.currency_code}.`);
  const min = toNumber(validations.min);
  const max = toNumber(validations.max);
  if (min !== null && amount < min) return fail(`Must be at least ${min}.`);
  if (max !== null && amount > max) return fail(`Must be at most ${max}.`);
  return ok({ amount: amount.toFixed(2), currency_code: currency });
}

export function ratingScale(validations: Validations): { min: number; max: number } {
  return { min: validations.scale_min ?? 0, max: validations.scale_max ?? 5 };
}

function checkRating(raw: unknown, validations: Validations): Checked {
  const value = toNumber(typeof raw === 'object' && raw !== null ? (raw as { value?: unknown }).value : raw);
  if (value === null) return fail('Enter a rating.');
  const scale = ratingScale(validations);
  if (value < scale.min || value > scale.max) return fail(`Must be between ${scale.min} and ${scale.max}.`);
  return ok({ value: Math.round(value * 100) / 100, scale_min: scale.min, scale_max: scale.max });
}

function checkLink(raw: unknown, validations: Validations): Checked {
  if (!raw || typeof raw !== 'object') return fail('Enter a link.');
  const input = raw as { text?: unknown; url?: unknown };
  const url = checkUrl(input.url, validations);
  if (!url.ok) return url;
  const text = typeof input.text === 'string' ? input.text.trim().slice(0, 255) : '';
  return ok({ text, url: url.value });
}

function checkOne(base: BaseType, raw: unknown, validations: Validations): Checked {
  switch (base) {
    case 'single_line_text_field':
    case 'multi_line_text_field':
      return checkText(base, raw, validations);
    case 'rich_text_field': {
      if (typeof raw !== 'string') return fail('Enter text.');
      const html = sanitizeMerchantHtml(raw);
      if (html.length > LIMITS.richText) return fail('This text is too long.');
      return ok(html);
    }
    case 'number_integer':
    case 'number_decimal':
      return checkNumber(base, raw, validations);
    case 'date':
    case 'date_time':
      return checkDate(base, raw, validations);
    case 'weight':
    case 'volume':
    case 'dimension':
      return checkMeasurement(base, raw, validations);
    case 'product_reference':
    case 'variant_reference':
    case 'collection_reference':
    case 'file_reference':
    case 'metaobject_reference':
    case 'page_reference':
      return checkReference(raw);
    case 'boolean':
      if (typeof raw === 'boolean') return ok(raw);
      if (raw === 'true' || raw === 1 || raw === '1') return ok(true);
      if (raw === 'false' || raw === 0 || raw === '0') return ok(false);
      return fail('Choose true or false.');
    case 'color': {
      const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
      const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
      if (short) return ok(`#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`);
      if (/^#[0-9a-f]{6}$/.test(text)) return ok(text);
      return fail('Enter a colour as #RRGGBB.');
    }
    case 'url':
      return checkUrl(raw, validations);
    case 'link':
      return checkLink(raw, validations);
    case 'money':
      return checkMoney(raw, validations);
    case 'rating':
      return checkRating(raw, validations);
    case 'json': {
      let value = raw;
      if (typeof raw === 'string') {
        try {
          value = JSON.parse(raw);
        } catch {
          return fail('This is not valid JSON.');
        }
      }
      if (JSON.stringify(value).length > LIMITS.json) return fail('This JSON is too large.');
      return ok(value);
    }
  }
}

/**
 * Checks and normalises one value for a field of `type`. An empty value
 * (null, '', []) comes back as null: it clears the field. Whether a field may
 * be empty is the caller's call (the definition's `is_required`).
 */
export function checkValue(type: string, validations: Validations | null | undefined, raw: unknown): Checked {
  const parsed = parseType(type);
  if (!parsed) return fail(`Unknown type ${type}.`);
  const rules = validations ?? {};
  if (isBlank(raw)) return ok(null);
  if (!parsed.list) return checkOne(parsed.base, raw, rules);

  const items = Array.isArray(raw) ? raw : typeof raw === 'string' && parsed.base === 'single_line_text_field' ? raw.split('\n') : [raw];
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (isBlank(item)) continue;
    const checked = checkOne(parsed.base, item, rules);
    if (!checked.ok) return fail(`Item ${index + 1}: ${checked.error}`);
    const key = JSON.stringify(checked.value);
    if (parsed.base in REFERENCE_KINDS && seen.has(key)) continue;
    seen.add(key);
    out.push(checked.value);
  }
  if (out.length === 0) return ok(null);
  if (out.length > LIMITS.listItems) return fail(`A list can hold at most ${LIMITS.listItems} items.`);
  if (rules.list_min !== null && rules.list_min !== undefined && out.length < rules.list_min) return fail(`Add at least ${rules.list_min} items.`);
  if (rules.list_max !== null && rules.list_max !== undefined && out.length > rules.list_max) return fail(`Add at most ${rules.list_max} items.`);
  return ok(out);
}

/**
 * Checks a definition's validation options for its type, and returns only the
 * ones that apply — so a definition can never carry a rule its values ignore.
 */
export function checkValidations(type: string, raw: unknown): { ok: true; validations: Validations } | { ok: false; errors: Record<string, string> } {
  const parsed = parseType(type);
  if (!parsed) return { ok: false, errors: { type: `Unknown type ${type}.` } };
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const allowed = new Set<string>([...FIELD_TYPES[parsed.base].validations, ...(parsed.list ? LIST_VALIDATIONS : [])]);
  const errors: Record<string, string> = {};
  const out: Validations = {};
  const present = (key: string) => allowed.has(key) && input[key] !== undefined && input[key] !== null && input[key] !== '';

  if (present('choices')) {
    const choices = Array.isArray(input.choices) ? input.choices.map((choice) => String(choice).trim()).filter(Boolean) : [];
    const unique = [...new Map(choices.map((choice) => [choice.toLowerCase(), choice])).values()];
    if (unique.length > LIMITS.choices) errors.choices = `At most ${LIMITS.choices} choices.`;
    else if (unique.some((choice) => choice.length > LIMITS.choiceLength)) errors.choices = `A choice can be at most ${LIMITS.choiceLength} characters.`;
    else if (unique.length > 0) out.choices = unique;
  }
  if (present('regex')) {
    const pattern = String(input.regex);
    if (pattern.length > LIMITS.regex) errors.regex = `At most ${LIMITS.regex} characters.`;
    else {
      try {
        new RegExp(pattern, 'u');
        out.regex = pattern;
      } catch {
        errors.regex = 'This is not a valid regular expression.';
      }
    }
  }
  for (const key of ['min', 'max'] as const) {
    if (!present(key)) continue;
    const value = input[key];
    if (parsed.base === 'date' || parsed.base === 'date_time') {
      const checked = checkDate(parsed.base, value, {});
      if (checked.ok) out[key] = String(value).trim();
      else errors[key] = checked.error;
    } else if (parsed.base === 'weight' || parsed.base === 'volume' || parsed.base === 'dimension') {
      const checked = checkMeasurement(parsed.base, value, {});
      if (checked.ok) out[key] = checked.value as { value: number; unit: string };
      else errors[key] = checked.error;
    } else {
      const number = toNumber(value);
      if (number === null) errors[key] = 'Enter a number.';
      else if ((parsed.base === 'single_line_text_field' || parsed.base === 'multi_line_text_field') && (!Number.isInteger(number) || number < 0)) errors[key] = 'Enter a whole number of characters.';
      else out[key] = number;
    }
  }
  if (typeof out.min === 'number' && typeof out.max === 'number' && out.min > out.max) errors.max = 'The maximum is below the minimum.';
  if (present('max_precision')) {
    const precision = toNumber(input.max_precision);
    if (precision === null || !Number.isInteger(precision) || precision < 0 || precision > 6) errors.max_precision = 'Between 0 and 6 decimal places.';
    else out.max_precision = precision;
  }
  if (present('allowed_domains')) {
    const domains = (Array.isArray(input.allowed_domains) ? input.allowed_domains : String(input.allowed_domains).split(','))
      .map((domain) => String(domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);
    if (domains.some((domain) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain))) errors.allowed_domains = 'Enter domains like example.com.';
    else if (domains.length > 0) out.allowed_domains = [...new Set(domains)];
  }
  if (present('file_types')) {
    const kinds = (Array.isArray(input.file_types) ? input.file_types : []).map(String);
    if (kinds.some((kind) => !['image', 'video', 'document'].includes(kind))) errors.file_types = 'Choose image, video or document.';
    else if (kinds.length > 0) out.file_types = [...new Set(kinds)] as FileKind[];
  }
  if (allowed.has('metaobject_type')) {
    const kind = typeof input.metaobject_type === 'string' ? input.metaobject_type.trim() : '';
    if (!kind) errors.metaobject_type = 'Choose which metaobject type it points to.';
    else out.metaobject_type = kind;
  }
  for (const key of ['scale_min', 'scale_max'] as const) {
    if (!present(key)) continue;
    const value = toNumber(input[key]);
    if (value === null) errors[key] = 'Enter a number.';
    else out[key] = value;
  }
  if (parsed.base === 'rating') {
    const scale = ratingScale(out);
    if (scale.min >= scale.max) errors.scale_max = 'The top of the scale must be above the bottom.';
  }
  if (present('currency_code')) {
    const code = String(input.currency_code).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) errors.currency_code = 'Enter a currency code like INR.';
    else out.currency_code = code;
  }
  for (const key of LIST_VALIDATIONS) {
    if (!present(key)) continue;
    const value = toNumber(input[key]);
    if (value === null || !Number.isInteger(value) || value < 0 || value > LIMITS.listItems) errors[key] = `Between 0 and ${LIMITS.listItems}.`;
    else out[key] = value;
  }
  if (typeof out.list_min === 'number' && typeof out.list_max === 'number' && out.list_min > out.list_max) errors.list_max = 'The maximum is below the minimum.';
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, validations: out };
}

// ── storage ──────────────────────────────────────────────────────────────────

export interface StoredValue {
  value_type: string;
  value_text: string | null;
  value_number: number | null;
  value_boolean: number | null;
  value_datetime: string | null;
  value_json: string | null;
  value_media_id: number | null;
  value_ref: number | null;
  value_index: string | null;
}

const INDEX_LENGTH = 191;

function indexOf(text: string): string {
  return text.trim().toLowerCase().slice(0, INDEX_LENGTH);
}

function mysqlDateTime(iso: string): string {
  return iso.replace('T', ' ').replace(/Z$/, '').slice(0, 19);
}

/**
 * Lays a checked value out across the typed columns: text for text, a number
 * for numbers (measurements in their base unit, so 1 kg sorts above 900 g),
 * a reference id, JSON for composite values and lists — and `value_index`, a
 * lower-cased form for exact-match filters and "unique values".
 */
export function toStored(type: string, value: unknown): StoredValue {
  const parsed = parseType(type)!;
  const stored: StoredValue = {
    value_type: type,
    value_text: null,
    value_number: null,
    value_boolean: null,
    value_datetime: null,
    value_json: null,
    value_media_id: null,
    value_ref: null,
    value_index: null,
  };
  if (parsed.list) {
    stored.value_json = JSON.stringify(value);
    return stored;
  }
  switch (parsed.base) {
    case 'single_line_text_field':
    case 'url':
    case 'color':
      stored.value_text = String(value);
      stored.value_index = indexOf(String(value));
      break;
    case 'multi_line_text_field':
    case 'rich_text_field':
      stored.value_text = String(value);
      break;
    case 'number_integer':
    case 'number_decimal':
      stored.value_number = Number(value);
      stored.value_index = String(value);
      break;
    case 'boolean':
      stored.value_boolean = value ? 1 : 0;
      stored.value_index = value ? 'true' : 'false';
      break;
    case 'date':
      stored.value_text = String(value);
      stored.value_datetime = `${String(value)} 00:00:00`;
      break;
    case 'date_time':
      stored.value_text = String(value);
      stored.value_datetime = mysqlDateTime(String(value));
      break;
    case 'weight':
    case 'volume':
    case 'dimension':
      stored.value_json = JSON.stringify(value);
      stored.value_number = inBaseUnit(parsed.base, value as { value: number; unit: string });
      break;
    case 'money':
      stored.value_json = JSON.stringify(value);
      stored.value_number = Number((value as { amount: string }).amount);
      break;
    case 'rating':
      stored.value_json = JSON.stringify(value);
      stored.value_number = (value as { value: number }).value;
      break;
    case 'link':
      stored.value_json = JSON.stringify(value);
      stored.value_text = (value as { url: string }).url;
      break;
    case 'json':
      stored.value_json = JSON.stringify(value);
      break;
    case 'file_reference':
      stored.value_ref = Number(value);
      stored.value_media_id = Number(value);
      break;
    case 'product_reference':
    case 'variant_reference':
    case 'collection_reference':
    case 'metaobject_reference':
    case 'page_reference':
      stored.value_ref = Number(value);
      break;
  }
  return stored;
}

export interface StoredRow {
  value_type?: string | null;
  value_text: string | null;
  value_number: string | number | null;
  value_boolean: number | null;
  value_datetime: Date | string | null;
  value_json: unknown;
  value_media_id: number | string | null;
  value_ref?: number | string | null;
}

function jsonOf(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw ?? null;
}

/** Reads a stored value back as the API and Liquid see it. */
export function fromStored(type: string, row: StoredRow): unknown {
  const parsed = parseType(type);
  if (!parsed) return row.value_text ?? jsonOf(row.value_json);
  if (parsed.list) return jsonOf(row.value_json);
  switch (parsed.base) {
    case 'single_line_text_field':
    case 'multi_line_text_field':
    case 'rich_text_field':
    case 'url':
    case 'color':
    case 'date':
      return row.value_text;
    case 'date_time':
      return row.value_text ?? (row.value_datetime ? new Date(row.value_datetime).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);
    case 'number_integer':
      return row.value_number === null ? null : Math.round(Number(row.value_number));
    case 'number_decimal':
      return row.value_number === null ? null : Number(row.value_number);
    case 'boolean':
      return row.value_boolean === null ? null : Number(row.value_boolean) === 1;
    case 'weight':
    case 'volume':
    case 'dimension':
    case 'money':
    case 'rating':
    case 'link':
    case 'json':
      return jsonOf(row.value_json);
    case 'file_reference':
      return row.value_media_id === null && (row.value_ref === null || row.value_ref === undefined) ? null : Number(row.value_media_id ?? row.value_ref);
    default:
      return row.value_ref === null || row.value_ref === undefined ? null : Number(row.value_ref);
  }
}

/** The records a value points at, so the service can check they exist. */
export function referencesOf(type: string, value: unknown): { kind: ReferenceKind; ids: number[] } | null {
  const parsed = parseType(type);
  if (!parsed || !(parsed.base in REFERENCE_KINDS) || value === null || value === undefined) return null;
  const ids = (parsed.list ? (value as unknown[]) : [value]).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
  return { kind: REFERENCE_KINDS[parsed.base as ReferenceType], ids };
}

const UNIT_LABEL: Record<string, string> = { fl_oz: 'fl oz', m3: 'm³' };

/** Plain text for a value — what `{{ product.metafields.ns.key }}` prints, and the admin's list previews. */
export function displayText(type: string, value: unknown): string {
  const parsed = parseType(type);
  if (value === null || value === undefined || !parsed) return '';
  if (parsed.list) return (value as unknown[]).map((item) => displayText(parsed.base, item)).join(', ');
  switch (parsed.base) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'weight':
    case 'volume':
    case 'dimension': {
      const measure = value as { value: number; unit: string };
      return `${measure.value} ${UNIT_LABEL[measure.unit] ?? measure.unit}`;
    }
    case 'money': {
      const money = value as { amount: string; currency_code: string };
      return `${money.amount} ${money.currency_code}`;
    }
    case 'rating': {
      const rating = value as { value: number; scale_max: number };
      return `${rating.value}/${rating.scale_max}`;
    }
    case 'link':
      return (value as { text: string; url: string }).text || (value as { url: string }).url;
    case 'json':
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/** Types that can promise "no two products share this value". */
export const UNIQUE_CAPABLE = new Set<BaseType>(['single_line_text_field', 'url', 'number_integer', 'number_decimal']);

/** Types a storefront filter can offer (a choice list, a yes/no, a number range). */
export function filterable(type: string): boolean {
  const parsed = parseType(type);
  if (!parsed) return false;
  return ['single_line_text_field', 'boolean', 'number_integer', 'number_decimal', 'weight', 'volume', 'dimension', 'rating', 'color', 'metaobject_reference', 'product_reference'].includes(parsed.base);
}
