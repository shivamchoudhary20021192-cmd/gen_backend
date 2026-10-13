import type { CarrierSeed, RegionProfile } from './types';

/**
 * Regional defaults: money, time, tax, shipping, and how people pay.
 *
 * Tax rates here are starting points a merchant reviews, not tax advice: the
 * standard rate of each regime, a reduced and a zero class where the regime
 * has them, prices tax-inclusive where that is the consumer norm (India, the
 * UK, the EU, Australia) and exclusive where it is not (the US, Canada).
 */

const MANUAL: CarrierSeed = {
  code: 'manual',
  name: 'Manual / self-ship',
  trackingUrlTemplate: null,
  apiProvider: 'manual',
  supportsCod: true,
  supportsReversePickup: false,
  priority: 90,
};

function carrier(code: string, name: string, trackingUrlTemplate: string | null, priority: number, apiProvider = 'dummy'): CarrierSeed {
  return { code, name, trackingUrlTemplate, apiProvider, supportsCod: false, supportsReversePickup: true, priority };
}

const INDIA: RegionProfile = {
  countries: ['IN'],
  name: 'India',
  currency: 'INR',
  timezone: 'Asia/Kolkata',
  locale: 'en-IN',
  weightUnit: 'g',
  taxEngine: 'in_gst',
  taxClasses: [
    { code: 'GST_18', name: 'GST 18%', rate: 18, inclusive: true, isDefault: true },
    { code: 'GST_12', name: 'GST 12%', rate: 12, inclusive: true },
    { code: 'GST_5', name: 'GST 5%', rate: 5, inclusive: true },
    { code: 'GST_0', name: 'Exempt', rate: 0, inclusive: true },
  ],
  shippingRates: [
    { name: 'Standard delivery', method: 'standard', rate: 99, freeAbove: 499, etaMinDays: 3, etaMaxDays: 7, priority: 0 },
    { name: 'Express delivery', method: 'express', rate: 199, freeAbove: null, etaMinDays: 1, etaMaxDays: 3, priority: 10 },
  ],
  carriers: [
    { ...carrier('shiprocket', 'Shiprocket', 'https://shiprocket.co/tracking/{awb}', 10), supportsCod: true },
    { ...carrier('delhivery', 'Delhivery', 'https://www.delhivery.com/track/package/{awb}', 20), supportsCod: true },
    { ...carrier('bluedart', 'Blue Dart', 'https://www.bluedart.com/tracking?trackFor=0&trackNo={awb}', 30), supportsCod: true },
    MANUAL,
  ],
  cod: { name: 'Cash on delivery', minOrder: 299, maxOrder: 5000, fee: 49, prepaidDiscount: 0, requiresOtp: true },
  suggestedPayments: ['razorpay', 'paypal'],
  settings: {
    'messaging.marketing_window_start': '10:00',
    'messaging.marketing_window_end': '21:00',
    'otp.default_channel': 'whatsapp',
    'payment.enabled_methods': '["upi","card","netbanking","wallet"]',
  },
};

const UNITED_STATES: RegionProfile = {
  countries: ['US'],
  name: 'United States',
  currency: 'USD',
  timezone: 'America/New_York',
  locale: 'en-US',
  weightUnit: 'lb',
  taxEngine: 'us_sales_tax',
  taxClasses: [
    { code: 'TAXABLE', name: 'Taxable goods', rate: 0, inclusive: false, isDefault: true },
    { code: 'EXEMPT', name: 'Tax exempt', rate: 0, inclusive: false },
  ],
  shippingRates: [
    { name: 'Standard shipping', method: 'standard', rate: 7.99, freeAbove: 75, etaMinDays: 3, etaMaxDays: 7, priority: 0 },
    { name: 'Express shipping', method: 'express', rate: 19.99, freeAbove: null, etaMinDays: 1, etaMaxDays: 2, priority: 10 },
  ],
  // Outside the contiguous states parcels go by air and take longer; no free
  // shipping and no express until the merchant says otherwise.
  shippingZones: [
    {
      name: 'Alaska, Hawaii & territories',
      regions: ['AK', 'HI', 'PR', 'GU', 'VI', 'AS', 'MP'],
      rates: [{ name: 'Standard shipping', method: 'standard', rate: 19.99, freeAbove: null, etaMinDays: 5, etaMaxDays: 12, priority: 0 }],
    },
  ],
  carriers: [
    carrier('usps', 'USPS', 'https://tools.usps.com/go/TrackConfirmAction?tLabels={awb}', 10),
    carrier('ups', 'UPS', 'https://www.ups.com/track?tracknum={awb}', 20),
    carrier('fedex', 'FedEx', 'https://www.fedex.com/fedextrack/?trknbr={awb}', 30),
    MANUAL,
  ],
  cod: null,
  suggestedPayments: ['stripe', 'paypal'],
  settings: {
    'messaging.marketing_window_start': '08:00',
    'messaging.marketing_window_end': '21:00',
    'otp.default_channel': 'sms',
    'payment.enabled_methods': '["card","wallet"]',
  },
};

const UNITED_KINGDOM: RegionProfile = {
  countries: ['GB'],
  name: 'United Kingdom',
  currency: 'GBP',
  timezone: 'Europe/London',
  locale: 'en-GB',
  weightUnit: 'kg',
  taxEngine: 'uk_vat',
  taxClasses: [
    { code: 'VAT_STANDARD', name: 'VAT 20%', rate: 20, inclusive: true, isDefault: true },
    { code: 'VAT_REDUCED', name: 'VAT 5%', rate: 5, inclusive: true },
    { code: 'VAT_ZERO', name: 'Zero rated', rate: 0, inclusive: true },
  ],
  shippingRates: [
    { name: 'Standard delivery', method: 'standard', rate: 3.99, freeAbove: 50, etaMinDays: 2, etaMaxDays: 4, priority: 0 },
    { name: 'Next-day delivery', method: 'express', rate: 7.99, freeAbove: null, etaMinDays: 1, etaMaxDays: 1, priority: 10 },
  ],
  carriers: [
    carrier('royal_mail', 'Royal Mail', 'https://www.royalmail.com/track-your-item#/tracking-results/{awb}', 10),
    carrier('dpd', 'DPD', 'https://track.dpd.co.uk/parcels/{awb}', 20),
    carrier('evri', 'Evri', 'https://www.evri.com/track/parcel/{awb}', 30),
    MANUAL,
  ],
  cod: null,
  suggestedPayments: ['stripe', 'paypal'],
  settings: {
    'messaging.marketing_window_start': '08:00',
    'messaging.marketing_window_end': '20:00',
    'otp.default_channel': 'sms',
    'payment.enabled_methods': '["card","wallet"]',
  },
};

/** Standard VAT rates for euro-area countries the EU profile covers. */
const EU_VAT: Record<string, { rate: number; reduced: number; timezone: string; locale: string }> = {
  DE: { rate: 19, reduced: 7, timezone: 'Europe/Berlin', locale: 'de-DE' },
  FR: { rate: 20, reduced: 5.5, timezone: 'Europe/Paris', locale: 'fr-FR' },
  NL: { rate: 21, reduced: 9, timezone: 'Europe/Amsterdam', locale: 'nl-NL' },
  ES: { rate: 21, reduced: 10, timezone: 'Europe/Madrid', locale: 'es-ES' },
  IT: { rate: 22, reduced: 10, timezone: 'Europe/Rome', locale: 'it-IT' },
  IE: { rate: 23, reduced: 13.5, timezone: 'Europe/Dublin', locale: 'en-IE' },
  BE: { rate: 21, reduced: 6, timezone: 'Europe/Brussels', locale: 'nl-BE' },
  AT: { rate: 20, reduced: 10, timezone: 'Europe/Vienna', locale: 'de-AT' },
  PT: { rate: 23, reduced: 6, timezone: 'Europe/Lisbon', locale: 'pt-PT' },
  FI: { rate: 25.5, reduced: 14, timezone: 'Europe/Helsinki', locale: 'fi-FI' },
};

function euro(country: string): RegionProfile {
  const vat = EU_VAT[country];
  return {
    countries: [country],
    name: 'European Union',
    currency: 'EUR',
    timezone: vat.timezone,
    locale: vat.locale,
    weightUnit: 'kg',
    taxEngine: 'eu_vat',
    taxClasses: [
      { code: 'VAT_STANDARD', name: `VAT ${vat.rate}%`, rate: vat.rate, inclusive: true, isDefault: true },
      { code: 'VAT_REDUCED', name: `VAT ${vat.reduced}%`, rate: vat.reduced, inclusive: true },
      { code: 'VAT_ZERO', name: 'Zero rated', rate: 0, inclusive: true },
    ],
    shippingRates: [
      { name: 'Standard shipping', method: 'standard', rate: 4.95, freeAbove: 60, etaMinDays: 2, etaMaxDays: 5, priority: 0 },
      { name: 'Express shipping', method: 'express', rate: 9.95, freeAbove: null, etaMinDays: 1, etaMaxDays: 2, priority: 10 },
    ],
    carriers: [
      carrier('dhl', 'DHL', 'https://www.dhl.com/global-en/home/tracking.html?tracking-id={awb}', 10),
      carrier('dpd', 'DPD', 'https://tracking.dpd.de/status/en_US/parcel/{awb}', 20),
      carrier('gls', 'GLS', 'https://gls-group.com/track/{awb}', 30),
      MANUAL,
    ],
    cod: null,
    suggestedPayments: ['stripe', 'paypal'],
    settings: {
      'messaging.marketing_window_start': '09:00',
      'messaging.marketing_window_end': '20:00',
      'otp.default_channel': 'sms',
      'payment.enabled_methods': '["card","wallet","bank_transfer"]',
    },
  };
}

const AUSTRALIA: RegionProfile = {
  countries: ['AU'],
  name: 'Australia',
  currency: 'AUD',
  timezone: 'Australia/Sydney',
  locale: 'en-AU',
  weightUnit: 'kg',
  taxEngine: 'au_gst',
  taxClasses: [
    { code: 'GST', name: 'GST 10%', rate: 10, inclusive: true, isDefault: true },
    { code: 'GST_FREE', name: 'GST free', rate: 0, inclusive: true },
  ],
  shippingRates: [
    { name: 'Standard shipping', method: 'standard', rate: 9.95, freeAbove: 100, etaMinDays: 2, etaMaxDays: 6, priority: 0 },
    { name: 'Express shipping', method: 'express', rate: 14.95, freeAbove: null, etaMinDays: 1, etaMaxDays: 3, priority: 10 },
  ],
  carriers: [
    carrier('auspost', 'Australia Post', 'https://auspost.com.au/mypost/track/#/details/{awb}', 10),
    carrier('sendle', 'Sendle', 'https://track.sendle.com/tracking?ref={awb}', 20),
    MANUAL,
  ],
  cod: null,
  suggestedPayments: ['stripe', 'paypal'],
  settings: { 'otp.default_channel': 'sms', 'payment.enabled_methods': '["card","wallet"]' },
};

const CANADA: RegionProfile = {
  countries: ['CA'],
  name: 'Canada',
  currency: 'CAD',
  timezone: 'America/Toronto',
  locale: 'en-CA',
  weightUnit: 'kg',
  taxEngine: 'ca_gst',
  taxClasses: [
    { code: 'GST_HST', name: 'GST/HST', rate: 13, inclusive: false, isDefault: true },
    { code: 'ZERO', name: 'Zero rated', rate: 0, inclusive: false },
  ],
  shippingRates: [
    { name: 'Standard shipping', method: 'standard', rate: 9.99, freeAbove: 100, etaMinDays: 3, etaMaxDays: 8, priority: 0 },
    { name: 'Expedited shipping', method: 'express', rate: 19.99, freeAbove: null, etaMinDays: 1, etaMaxDays: 3, priority: 10 },
  ],
  shippingZones: [
    {
      name: 'Northern territories',
      regions: ['NT', 'NU', 'YT'],
      rates: [{ name: 'Standard shipping', method: 'standard', rate: 24.99, freeAbove: null, etaMinDays: 7, etaMaxDays: 14, priority: 0 }],
    },
  ],
  carriers: [
    carrier('canada_post', 'Canada Post', 'https://www.canadapost-postescanada.ca/track-reperage/en#/details/{awb}', 10),
    carrier('purolator', 'Purolator', 'https://www.purolator.com/en/shipping/tracker?pin={awb}', 20),
    MANUAL,
  ],
  cod: null,
  suggestedPayments: ['stripe', 'paypal'],
  settings: { 'otp.default_channel': 'sms', 'payment.enabled_methods': '["card","wallet"]' },
};

const UAE: RegionProfile = {
  countries: ['AE'],
  name: 'United Arab Emirates',
  currency: 'AED',
  timezone: 'Asia/Dubai',
  locale: 'en-AE',
  weightUnit: 'kg',
  taxEngine: 'ae_vat',
  taxClasses: [
    { code: 'VAT_5', name: 'VAT 5%', rate: 5, inclusive: true, isDefault: true },
    { code: 'VAT_ZERO', name: 'Zero rated', rate: 0, inclusive: true },
  ],
  shippingRates: [
    { name: 'Standard delivery', method: 'standard', rate: 15, freeAbove: 200, etaMinDays: 1, etaMaxDays: 3, priority: 0 },
    { name: 'Same-day delivery', method: 'express', rate: 30, freeAbove: null, etaMinDays: 0, etaMaxDays: 1, priority: 10 },
  ],
  carriers: [
    { ...carrier('aramex', 'Aramex', 'https://www.aramex.com/us/en/track/results?ShipmentNumber={awb}', 10), supportsCod: true },
    MANUAL,
  ],
  cod: { name: 'Cash on delivery', minOrder: 0, maxOrder: 3000, fee: 10, prepaidDiscount: 0, requiresOtp: false },
  suggestedPayments: ['stripe', 'paypal'],
  settings: { 'otp.default_channel': 'whatsapp', 'payment.enabled_methods': '["card","wallet"]' },
};

const SINGAPORE: RegionProfile = {
  countries: ['SG'],
  name: 'Singapore',
  currency: 'SGD',
  timezone: 'Asia/Singapore',
  locale: 'en-SG',
  weightUnit: 'kg',
  taxEngine: 'sg_gst',
  taxClasses: [
    { code: 'GST_9', name: 'GST 9%', rate: 9, inclusive: true, isDefault: true },
    { code: 'GST_ZERO', name: 'Zero rated', rate: 0, inclusive: true },
  ],
  shippingRates: [
    { name: 'Standard delivery', method: 'standard', rate: 4, freeAbove: 60, etaMinDays: 1, etaMaxDays: 3, priority: 0 },
    { name: 'Express delivery', method: 'express', rate: 10, freeAbove: null, etaMinDays: 0, etaMaxDays: 1, priority: 10 },
  ],
  carriers: [
    carrier('singpost', 'SingPost', 'https://www.singpost.com/track-items?trackingid={awb}', 10),
    carrier('ninja_van', 'Ninja Van', 'https://www.ninjavan.co/en-sg/tracking?id={awb}', 20),
    MANUAL,
  ],
  cod: null,
  suggestedPayments: ['stripe', 'paypal'],
  settings: { 'otp.default_channel': 'sms', 'payment.enabled_methods': '["card","wallet"]' },
};

/** Anywhere without a specific profile: no tax configured, flat shipping, self-ship. */
function generic(country: string, currency: string, timezone: string, locale: string): RegionProfile {
  return {
    countries: [country],
    name: 'International',
    currency,
    timezone,
    locale,
    weightUnit: 'kg',
    taxEngine: 'manual',
    taxClasses: [{ code: 'STANDARD', name: 'Standard', rate: 0, inclusive: true, isDefault: true }],
    shippingRates: [{ name: 'Standard shipping', method: 'standard', rate: 0, freeAbove: null, etaMinDays: 3, etaMaxDays: 10, priority: 0 }],
    carriers: [MANUAL],
    cod: null,
    suggestedPayments: ['stripe', 'paypal'],
    settings: { 'otp.default_channel': 'sms', 'payment.enabled_methods': '["card","wallet"]' },
  };
}

const PROFILES: RegionProfile[] = [INDIA, UNITED_STATES, UNITED_KINGDOM, AUSTRALIA, CANADA, UAE, SINGAPORE];

/**
 * The profile for a country. The merchant's own currency and timezone, when
 * they chose them at signup, win over the profile's; everything else (tax,
 * shipping, carriers) comes from the country.
 */
export function regionFor(
  countryCode: string,
  overrides: { currency?: string | null; timezone?: string | null; locale?: string | null } = {},
): RegionProfile {
  const country = countryCode.toUpperCase();
  const base =
    PROFILES.find((profile) => profile.countries.includes(country)) ??
    (EU_VAT[country] ? euro(country) : generic(country, overrides.currency ?? 'USD', overrides.timezone ?? 'UTC', overrides.locale ?? 'en'));
  return {
    ...base,
    currency: overrides.currency ?? base.currency,
    timezone: overrides.timezone ?? base.timezone,
    locale: overrides.locale ?? base.locale,
  };
}

export const SUPPORTED_REGION_COUNTRIES = [...PROFILES.flatMap((profile) => profile.countries), ...Object.keys(EU_VAT)];
