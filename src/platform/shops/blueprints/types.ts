/**
 * Blueprints: what a new shop starts with.
 *
 * A shop is provisioned from three layers, applied in order:
 *
 *   base     — what every shop needs to work at all: staff roles, the settings
 *              catalogue, number sequences, notification templates, default
 *              senders, customer segments, menus, a blog, a home page.
 *   region   — what its country needs: currency, timezone, tax classes (GST,
 *              VAT, sales tax), shipping rates, cash on delivery, couriers.
 *   vertical — what it sells: product attributes (sizes and colours for
 *              fashion, specs and warranty for electronics, allergens for
 *              food), a starter category tree, collections, search synonyms,
 *              and the theme it opens with.
 *
 * Blueprints are data in code, reviewed like code, and versioned with it. A
 * provisioning step reads the blueprint and writes rows; it never decides
 * anything a blueprint could have said.
 */

export interface ProvisionInput {
  shopName: string;
  handle: string;
  vertical: string;
  countryCode: string;
  currency: string;
  timezone: string;
  locale: string;
  email: string | null;
  phone: string | null;
}

export interface RoleSeed {
  slug: string;
  name: string;
  description: string;
  level: number;
  /** Permission slugs, or '*' for every permission that exists. */
  permissions: string[] | '*';
}

export interface SettingSeed {
  group: string;
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'json' | 'media' | 'html' | 'secret';
  value: string | null;
  defaultValue?: string | null;
  description?: string;
  isPublic?: boolean;
  sortOrder?: number;
}

/**
 * The icons a promise can carry: exactly the set the storefront's section
 * renderer draws and the admin's section editor offers. Anything else shows as
 * a leaf on the storefront and an empty select in the admin.
 */
export type PromiseIcon = 'leaf' | 'flask' | 'shield' | 'truck' | 'star' | 'check';

export interface LookupSeed {
  code: string;
  name: string;
  description?: string;
  allowCustom?: boolean;
  values: { code: string; label: string }[];
}

/** Shopify's field type names, as catalog/fieldTypes.ts knows them. */
export type MetafieldType =
  | 'single_line_text_field'
  | 'multi_line_text_field'
  | 'rich_text_field'
  | 'number_integer'
  | 'number_decimal'
  | 'boolean'
  | 'date'
  | 'url'
  | 'color'
  | 'file_reference'
  | 'json';

export interface MetafieldSeed {
  ownerType: 'product' | 'variant' | 'collection' | 'customer' | 'cms_page';
  key: string;
  name: string;
  type: MetafieldType;
  description?: string;
  filterable?: boolean;
}

export interface CategorySeed {
  name: string;
  slug: string;
  description?: string;
  children?: CategorySeed[];
}

export interface CollectionSeed {
  slug: string;
  title: string;
  subtitle?: string;
  sortType: 'manual' | 'best_selling' | 'newest' | 'price_asc' | 'price_desc';
  showInMenu?: boolean;
}

export interface NotificationTemplateSeed {
  eventKey: string;
  channel: 'email' | 'sms' | 'whatsapp';
  category: 'transactional' | 'utility' | 'marketing' | 'authentication';
  name: string;
  subject?: string;
  body: string;
}

export interface SectionSeed {
  key: string;
  name: string;
  settings: Record<string, unknown>;
  blocks?: { type: string; heading?: string; body?: string; ctaLabel?: string; linkUrl?: string; settings?: Record<string, unknown> }[];
}

export interface TaxClassSeed {
  code: string;
  name: string;
  rate: number;
  hsnCode?: string;
  inclusive: boolean;
  isDefault?: boolean;
}

export interface ShippingRateSeed {
  name: string;
  method: 'standard' | 'express' | 'pickup';
  rate: number;
  freeAbove: number | null;
  etaMinDays: number;
  etaMaxDays: number;
  priority: number;
}

export interface ShippingZoneSeed {
  name: string;
  regions?: string[];
  postalPrefixes?: string[];
  rates: ShippingRateSeed[];
}

export interface CarrierSeed {
  code: string;
  name: string;
  trackingUrlTemplate: string | null;
  apiProvider: 'dummy' | 'manual' | string;
  supportsCod: boolean;
  supportsReversePickup: boolean;
  priority: number;
}

export interface CodRuleSeed {
  name: string;
  minOrder: number;
  maxOrder: number | null;
  fee: number;
  prepaidDiscount: number;
  requiresOtp: boolean;
}

export interface RegionProfile {
  countries: string[];
  name: string;
  currency: string;
  timezone: string;
  locale: string;
  weightUnit: 'g' | 'kg' | 'lb' | 'oz';
  /** in_gst | eu_vat | uk_vat | us_sales_tax | manual — read by the tax layer. */
  taxEngine: string;
  taxClasses: TaxClassSeed[];
  shippingRates: ShippingRateSeed[];
  /** Places that ship differently, each with its own rates (none: the everywhere rates cover the country). */
  shippingZones?: ShippingZoneSeed[];
  carriers: CarrierSeed[];
  cod: CodRuleSeed | null;
  /** Payment providers suggested first on the Integrations screen. */
  suggestedPayments: string[];
  settings: Partial<Record<string, string>>;
}

export interface VerticalBlueprint {
  key: string;
  name: string;
  description: string;
  /** theme_library handle the shop opens with. */
  theme: string;
  lookups: LookupSeed[];
  metafields: MetafieldSeed[];
  categories: CategorySeed[];
  collections: CollectionSeed[];
  searchSynonyms: { term: string; synonyms: string[] }[];
  /** Words for the starter home page. */
  hero: { heading: string; body: string; cta: string };
  promises: { icon: PromiseIcon; title: string; body: string }[];
}
