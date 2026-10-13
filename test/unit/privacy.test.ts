import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bypassReason, pageKey } from '../../src/platform/onlineStore/pageCache';
import { consentStillValid, parseConsent, serializeConsent, type TrackingConsent } from '../../src/platform/privacy/consentCookie';
import { kindForHandle, sanitizePolicyHtml } from '../../src/platform/privacy/policies';
import { policyTemplate, type PolicyContext } from '../../src/platform/privacy/policyTemplates';
import { privacyCopy } from '../../src/platform/privacy/privacyCopy';
import { bannerVersion, privacyClientConfig, privacyHead } from '../../src/platform/privacy/privacyRuntime';
import { DEFAULT_PRIVACY_SETTINGS } from '../../src/platform/privacy/privacySettings';
import { classifyRegion, countryFromHeaders, ipPrefix, normaliseCountry, type RegionRules } from '../../src/platform/privacy/regions';

// Pure helpers only: nothing here touches a database.

const rules: RegionRules = {
  banner_enabled: true,
  banner_regions: 'required',
  banner_countries: [],
  sale_opt_out_enabled: true,
  sale_opt_out_countries: ['US'],
};

describe('privacy regions', () => {
  it('asks for consent where the law requires opt-in: the EEA, the UK, Switzerland, India, Brazil', () => {
    for (const country of ['DE', 'FR', 'IE', 'NO', 'IS', 'GB', 'CH', 'IN', 'BR']) {
      assert.equal(classifyRegion(country, rules).consentRequired, true, country);
    }
    for (const country of ['US', 'AE', 'SG', 'AU']) assert.equal(classifyRegion(country, rules).consentRequired, false, country);
  });

  it('offers the sale opt-out in the US, and keys pages by the two answers, not the country', () => {
    const us = classifyRegion('US', rules);
    assert.deepEqual([us.consentRequired, us.saleOptOut, us.key], [false, true, 'c0s1']);
    assert.equal(classifyRegion('DE', rules).key, 'c1s0');
    assert.equal(classifyRegion('FR', rules).key, classifyRegion('DE', rules).key);
    assert.equal(classifyRegion('SG', rules).key, 'c0s0');
  });

  it('follows the store: everywhere, a custom list, or off', () => {
    assert.equal(classifyRegion('US', { ...rules, banner_regions: 'all' }).consentRequired, true);
    assert.equal(classifyRegion(null, { ...rules, banner_regions: 'all' }).consentRequired, true);
    const custom = { ...rules, banner_regions: 'custom' as const, banner_countries: ['CA'] };
    assert.equal(classifyRegion('CA', custom).consentRequired, true);
    assert.equal(classifyRegion('DE', custom).consentRequired, false);
    assert.equal(classifyRegion('DE', { ...rules, banner_enabled: false }).consentRequired, false);
    assert.equal(classifyRegion('US', { ...rules, sale_opt_out_enabled: false }).saleOptOut, false);
  });

  it('reads the country from the edge, ignoring unknown and Tor', () => {
    const headers = (map: Record<string, string>) => (name: string) => map[name];
    assert.equal(countryFromHeaders(headers({ 'cf-ipcountry': 'de' })), 'DE');
    assert.equal(countryFromHeaders(headers({ 'x-vercel-ip-country': 'IN' })), 'IN');
    assert.equal(countryFromHeaders(headers({ 'cf-ipcountry': 'XX' })), null);
    assert.equal(countryFromHeaders(headers({ 'cf-ipcountry': 'T1' })), null);
    assert.equal(normaliseCountry('usa'), null);
  });

  it('keeps where from, never who: /24 and /48', () => {
    assert.equal(ipPrefix('203.0.113.77'), '203.0.113.0/24');
    assert.equal(ipPrefix('::ffff:198.51.100.9'), '198.51.100.0/24');
    assert.equal(ipPrefix('2001:db8:85a3:8d3:1319:8a2e:370:7348'), '2001:db8:85a3::/48');
    assert.equal(ipPrefix('2001:db8::1'), '2001:db8:0::/48');
    assert.equal(ipPrefix(null), null);
  });
});

describe('the consent cookie', () => {
  const consent: TrackingConsent = {
    id: '3b2d0f8e-6a1c-4e57-9f0d-2c7b8a1e4d55',
    ts: 1_760_000_000,
    purposes: { analytics: true, marketing: false, preferences: true, sale_of_data: false },
    policyVersion: 3,
    method: 'custom',
    gpc: true,
  };

  it('round-trips, in the format the browser script reads', () => {
    const raw = serializeConsent(consent);
    assert.deepEqual(parseConsent(raw), consent);
    const json = JSON.parse(decodeURIComponent(raw));
    assert.deepEqual(json.p, { a: 1, m: 0, p: 1, s: 0 });
    assert.equal(json.v, 1);
  });

  it('refuses anything malformed rather than guessing', () => {
    assert.equal(parseConsent('not json'), null);
    assert.equal(parseConsent(encodeURIComponent(JSON.stringify({ v: 2, id: consent.id, p: {} }))), null);
    assert.equal(parseConsent(encodeURIComponent(JSON.stringify({ v: 1, id: 'nope', p: {} }))), null);
    assert.equal(parseConsent(undefined), null);
  });

  it('expires, and asks again after the privacy policy changes if the store says so', () => {
    const now = consent.ts + 10 * 86_400;
    assert.equal(consentStillValid(consent, { maxAgeDays: 365, policyVersion: 3, repromptOnPolicyChange: true }, now), true);
    assert.equal(consentStillValid(consent, { maxAgeDays: 5, policyVersion: 3, repromptOnPolicyChange: true }, now), false);
    assert.equal(consentStillValid(consent, { maxAgeDays: 365, policyVersion: 4, repromptOnPolicyChange: true }, now), false);
    assert.equal(consentStillValid(consent, { maxAgeDays: 365, policyVersion: 4, repromptOnPolicyChange: false }, now), true);
  });
});

describe('policies', () => {
  it('maps Shopify’s policy URLs', () => {
    assert.equal(kindForHandle('privacy-policy'), 'privacy');
    assert.equal(kindForHandle('terms-of-service'), 'terms');
    assert.equal(kindForHandle('contact-information'), 'contact');
    assert.equal(kindForHandle('cookie-policy'), null);
  });

  it('takes out what could run, and keeps what a policy needs', () => {
    const dirty =
      '<h2>Rights</h2><p onclick="steal()">Text <a href="javascript:alert(1)">x</a> <a href="/policies/terms-of-service">terms</a></p>' +
      '<script>alert(1)</script><iframe src="https://evil.example"></iframe><img src=x onerror=alert(1)><table><tr><td>ok</td></tr></table>';
    const clean = sanitizePolicyHtml(dirty);
    assert.doesNotMatch(clean, /<script|<iframe|onclick|onerror|javascript:/i);
    assert.match(clean, /<h2>Rights<\/h2>/);
    assert.match(clean, /href="\/policies\/terms-of-service"/);
    assert.match(clean, /<table>/);
  });

  const context: PolicyContext = {
    shopName: 'Veylor',
    legalName: 'Veylor Labs Private Limited',
    address: '100 Ft Road, Bengaluru 560038',
    gstin: '29ABCDE1234F1Z5',
    email: 'care@veylor.example',
    phone: '+91 80 1234 5678',
    supportHours: 'Mon–Sat',
    countryCode: 'IN',
    storeUrl: 'https://veylor.example',
    privacyEmail: 'privacy@veylor.example',
    grievanceName: 'A. Sharma, Grievance Officer',
    grievanceEmail: 'grievance@veylor.example',
    grievancePhone: null,
    responseDays: 30,
    requestUrl: 'https://veylor.example/privacy/request',
    choicesUrl: 'https://veylor.example/pages/data-sharing-opt-out',
    today: '2026-09-30',
  };

  it('drafts a privacy policy that covers the DPDP Act, the GDPR and US state law', () => {
    const html = policyTemplate('privacy', context);
    for (const needle of ['Data Fiduciary', 'Data Protection Board of India', 'nominate', 'Grievance Officer', 'A. Sharma', 'withdraw your consent', 'CGST Act s.36', 'Global Privacy Control', 'privacy request form', 'within 30 days', 'data controller']) {
      assert.ok(html.includes(needle), needle);
    }
    assert.ok(!html.includes('<script'));
  });

  it('fills in store details, and leaves a placeholder for what it does not know', () => {
    const contact = policyTemplate('contact', { ...context, gstin: null, grievancePhone: null, phone: null });
    assert.match(contact, /Veylor Labs Private Limited/);
    assert.match(contact, /\[GSTIN\]/);
    assert.match(contact, /within 48 hours/);
    const escaped = policyTemplate('terms', { ...context, legalName: 'A <b>bold</b> & co' });
    assert.match(escaped, /A &lt;b&gt;bold&lt;\/b&gt; &amp; co/);
  });
});

describe('the banner', () => {
  it('speaks the storefront’s language, with the merchant’s rewording on top', () => {
    assert.equal(privacyCopy('hi').accept, 'सभी स्वीकार करें');
    assert.equal(privacyCopy('pt-br').accept, 'Accept all');
    assert.equal(privacyCopy('fr-ca').decline, 'Tout refuser');
    const custom = privacyCopy('en', { en: { title: 'Cookies at Veylor', message: '  ' } });
    assert.equal(custom.title, 'Cookies at Veylor');
    assert.equal(custom.message, privacyCopy('en').message);
  });

  it('puts the config and the Customer Privacy API in <head>, safe to inline', () => {
    const config = privacyClientConfig({
      region: classifyRegion('DE', rules),
      settings: { ...DEFAULT_PRIVACY_SETTINGS, banner_copy: { en: { title: '</script><script>alert(1)</script>' } } },
      policyVersion: 2,
      copy: privacyCopy('en', { en: { title: '</script><script>alert(1)</script>' } }),
      root: '/hi',
      privacyPolicyUrl: '/policies/privacy-policy',
    });
    assert.equal(config.consentRequired, true);
    assert.equal(config.links.privacyPolicy, '/hi/policies/privacy-policy');
    assert.equal(config.links.choices, null);
    assert.equal(config.bannerSrc, `/cdn/privacy/${bannerVersion}/banner.js`);
    const head = privacyHead(config);
    assert.doesNotMatch(head.split('<script>window.Shopify')[0], /<\/script><script>alert/);
    assert.match(head, /customerPrivacy/);
    assert.match(head, /visitorConsentCollected/);
  });
});

describe('the page cache and privacy', () => {
  it('keys pages by the visitor’s privacy rules', () => {
    const base = { shopId: 1, version: 3, theme: '7.1', scheme: 'https', host: 'veylor.example', market: '1.IN.INR.1', url: '/' };
    assert.notEqual(pageKey({ ...base, privacy: 'c1s0' }), pageKey({ ...base, privacy: 'c0s1' }));
    assert.equal(pageKey({ ...base, privacy: 'c1s0' }), pageKey({ ...base, privacy: 'c1s0' }));
  });

  it('caches policies like pages, and never the request form or its links', () => {
    const request = { method: 'GET', query: [] as string[], previewing: false, design: false, customer: false, cart: false, authorization: false };
    assert.equal(bypassReason({ ...request, path: '/policies/privacy-policy' }), null);
    assert.equal(bypassReason({ ...request, path: '/pages/data-sharing-opt-out' }), null);
    assert.equal(bypassReason({ ...request, path: '/privacy/request' }), 'path');
    assert.equal(bypassReason({ ...request, path: '/privacy/request/verify' }), 'path');
  });
});
