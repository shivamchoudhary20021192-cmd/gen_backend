# Customer privacy

Consents, the cookie banner, the "Do not sell or share" opt-out, policies and
privacy requests — Shopify's **Settings → Customer privacy**, **Settings →
Policies** and the customer data-request workflow, built for a platform whose
stores sell mostly from India, often abroad.

> The platform gives a store the machinery compliance needs. It is not legal
> advice, and a store's obligations depend on what it does with data. The
> policy templates say so where they are offered.

## What the law asks, and where it is answered

| Requirement | Law | Where |
|---|---|---|
| Opt-in before non-essential cookies; refusing as easy as accepting; nothing pre-ticked; granular choice | ePrivacy Directive + GDPR (EU/EEA), UK GDPR/PECR, Swiss FADP, **DPDP Act 2023 s.6** (India), LGPD (Brazil) | Cookie banner: equal-weight *Accept all* / *Reject all* on the first layer, *Manage preferences*; scripts parked until allowed |
| Withdraw consent as easily as it was given | GDPR Art. 7(3), DPDP s.6(4) | "Cookie preferences" link on every page (footer, or a floating button on themes without one); account page |
| Prove consent was given | GDPR Art. 7(1), DPDP s.6(10) | `customer_tracking_consents` (append-only): when, what, region, method, privacy-policy version, IP to the /24 |
| A notice before consent, in plain language; tell people when it changes | GDPR Arts. 12–14, DPDP s.5 | Policies (versioned, old text kept); banner links the privacy policy; changing it re-asks, if the store chooses |
| Opt out of sale / sharing, "Your privacy choices" link, honour Global Privacy Control | CCPA/CPRA and other US state laws | `/pages/data-sharing-opt-out`, footer link for US visitors, GPC read in the browser and from `Sec-GPC` |
| Access, portability, correction, erasure, withdraw consent, grievance | GDPR Arts. 15–21, CCPA, DPDP ss.11–13 | Privacy requests: storefront form, account page, staff; JSON export; scheduled erasure |
| Verify who is asking | GDPR Art. 12(6), CCPA regs | Email link (48 h) for storefront requests; signed-in accounts and staff-entered requests are verified |
| Respond in time | GDPR: one month; CCPA: 45 days | Deadline per request (default 30 days), overdue flagged, staff emailed |
| Keep what the law requires | CGST Act s.36 (72 months) | Erasure keeps orders, invoices, returns — without tracking data |
| Name a grievance officer; acknowledge in 48 h, resolve in a month | Consumer Protection (E-Commerce) Rules 2020; DPDP s.8(10) | Settings → Customer privacy → Privacy contacts; on the request page and in the templates |
| Tell apps | (Shopify's contract) | `customers/data_request`, `customers/redact` webhooks (compliance topics) |

## Regions

`src/platform/privacy/regions.ts`. Two independent questions per visitor:

- **Consent required** — the banner shows, and analytics / marketing /
  preferences wait for a yes. Default list: the EEA, the UK, Switzerland,
  India, Brazil. A store can choose *everywhere* or its own list.
- **Sale opt-out** — tracking runs by default, but the sale or sharing of data
  can be refused. Default: the US.

The visitor's country comes from the edge (`CF-IPCountry`, Vercel, CloudFront,
or `GEO_COUNTRY_HEADER`), falling back to the market they chose, then the
store's own country. A forged header only changes the forger's own banner.

### Caching

Pages are the same for every visitor with the same *rules*, so the full-page
cache keys by the two answers (`c1s0`, `c0s1`…) rather than by country — one
cache entry serves all of the EEA. The edge worker keys by the visitor's
country (each Cloudflare location sees few), which implies the same thing. The
visitor's own choice is never in the HTML: the browser reads it from the
cookie. Settings and policy changes bump the store's content version, so the
next page reflects them at once; consent writes do not (the table is under the
cache's `customer_` rule).

## The consent cookie

`_tracking_consent` (Shopify's name), readable by scripts, `SameSite=Lax`:

```json
{"v":1,"id":"<uuid>","ts":1760000000,"p":{"a":1,"m":0,"p":1,"s":1},"pv":3,"src":"custom","gpc":0}
```

`a m p s` — analytics, marketing, preferences, sale of data. `pv` — the privacy
policy version it was given under. `id` — the record the proof is filed under;
random, set only when the visitor chooses. It lasts `consent_max_age_days`
(365); a new privacy-policy version asks again when `reprompt_on_policy_change`.

## In the browser

`src/platform/privacy/privacyRuntime.ts`. A small script in `content_for_header`
(not in the theme editor) and, where the banner may show, `/cdn/privacy/<hash>/banner.js`.

### The Customer Privacy API

Shopify's, so theme and app code written for Shopify works unchanged:

```js
Shopify.loadFeatures([{ name: 'consent-tracking-api', version: '0.1' }], () => {
  const privacy = Shopify.customerPrivacy
  privacy.currentVisitorConsent()        // { analytics: 'yes'|'no'|'', marketing, preferences, sale_of_data }
  privacy.analyticsProcessingAllowed()   // also marketingAllowed(), preferencesProcessingAllowed(), saleOfDataAllowed()
  privacy.shouldShowBanner()             // consent required here, and none given yet
  privacy.saleOfDataRegion()             // the US opt-out applies
  privacy.getRegion()
  privacy.setTrackingConsent({ analytics: true, marketing: false, preferences: true, sale_of_data: false }, () => {})
})
document.addEventListener('visitorConsentCollected', (event) => event.detail.analyticsAllowed)
window.privacyBanner.showPreferences()   // open the preferences dialog
```

Before a choice, where consent is required, nothing non-essential is allowed.
Elsewhere everything is, except that a Global Privacy Control signal (or an
opt-out) turns `sale_of_data` off. Marketing that shares data with third
parties needs both `marketing` and `sale_of_data`.

### Parking scripts until they are allowed

```html
<script type="text/plain" data-consent="analytics" src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script>
<script type="text/plain" data-consent="marketing">fbq('init', '…')</script>
```

The browser does not run `text/plain`; the runtime swaps each one for a real
script once every purpose named in `data-consent` is allowed (`analytics`,
`marketing`, `preferences`, `sale_of_data`), on load and whenever the choice
changes.

### Theme hooks

```liquid
<a href="#" data-privacy-preferences hidden>{{ 'general.privacy.cookie_preferences' | t }}</a>
<a href="/pages/data-sharing-opt-out" data-privacy-choices hidden>{{ 'general.privacy.choices' | t }}</a>
{%- for policy in shop.policies -%}<a href="{{ policy.url }}">{{ policy.title }}</a>{%- endfor -%}
```

The runtime shows the first everywhere and the second where the sale opt-out
applies. The kit footer (themes 2.2.0) has all three; a theme without the
preferences link gets a small floating button once a choice is made.
`shop.privacy_policy`, `shop.refund_policy`, `shop.shipping_policy`,
`shop.terms_of_service`, `shop.contact_information` and `shop.legal_notice`
are policy objects (`title`, `body`, `url`, `handle`) or nil.

## Storefront routes

| Route | |
|---|---|
| `POST /privacy/consent` | JSON only, same origin only (a cross-site page cannot choose for a visitor); records, sets the cookie |
| `GET /policies/:handle` | `privacy-policy`, `terms-of-service`, `refund-policy`, `shipping-policy`, `contact-information`, `legal-notice`, in the theme layout |
| `GET /pages/data-sharing-opt-out` | "Your privacy choices"; `POST /privacy/opt-out` for browsers without JavaScript |
| `GET/POST /privacy/request` | The request form (honeypot, rate-limited, the same answer whether or not the address is a customer's) |
| `GET /privacy/request/verify?token=` | Confirms a request; single use, 48 hours |
| `GET /privacy/exports/:token` | The requester's data file; 7 days |
| `POST /account/privacy` | From the account page: download my data, stop marketing, delete my account |

## Privacy requests

`src/platform/privacy/privacyRequests.ts`, table `data_requests`.

```
verifying ──link──▶ received ──▶ in_progress ──▶ completed
                       │                     └──▶ rejected (with a reason, emailed)
                       └── erasure ──▶ scheduled ──sweep──▶ completed
                                          └── cancel ──▶ received
unconfirmed for 7 days ──▶ cancelled
```

- **Access / portability** — *Export their data* builds a JSON file of every
  table that holds the person (profile, addresses, orders and their lines and
  addresses, returns, marketing and cookie consents, newsletter, reviews,
  comments, wishlists, back-in-stock, gift cards, loyalty, quiz answers,
  contact messages, tickets, messages sent, staff notes, earlier requests);
  secrets (hashes, tokens) are never included. *Send to requester* emails a
  7-day link and completes the request. Apps get `customers/data_request`.
- **Erasure** — runs after `erasure_grace_days` (10) and
  `erasure_order_hold_days` (180) after their last order, whichever is later.
  The `privacy.sweep` job (every 15 minutes) queues due ones; `privacy.erase`
  runs each, in one transaction, then sends `customers/redact`.
- **Withdraw consent** — records a withdrawal for email, SMS and WhatsApp
  marketing (append-only `customer_consents`), clears the flags, unsubscribes.
- **Correction / grievance** — handled by staff, completed with a note.

### What erasure does

| Deleted | Anonymised | Kept |
|---|---|---|
| addresses, sessions, staff notes, segment and tag memberships, customer coupons, wishlists, back-in-stock requests, newsletter subscriptions, quiz answers, product views, review invitations and votes, one-time codes, campaign sends, contact messages, order-tracking lookups, data exports | the customer (name, email, phone → a placeholder no code can reach, marketing flags off, status `deleted`); reviews and comments (author "Anonymous"); gift-card recipient details; message logs; support tickets; consent records (identifiers and IP removed) | orders, invoices and returns (tax law), with IP, browser and UTM data removed; the consent record itself (proof) |

## Admin

- **Customers → Consents & privacy** (`/privacy`, `privacy.view`): open and
  overdue requests, cookie-choice rates, a compliance checklist; the request
  list and drawer (`data_requests.manage` to act); the consent record.
- **Settings → Customer privacy** (`privacy.settings`): banner regions,
  position, colours, wording per language, consent lifetime; the sale
  opt-out and GPC; request deadlines and erasure timing; privacy email and
  grievance officer.
- **Settings → Policies** (`privacy.settings`): six policies, *Create from
  template* (filled from Store details), visual or HTML editing, version history.

API: `src/platform/privacy/privacy.routes.ts` (`/admin/api/v1/privacy/*`).

## Schema

Migration `134_customer_privacy.sql`: `shop_policies`, `shop_policy_versions`,
`shop_privacy_settings` (no row → the defaults), `customer_tracking_consents`,
`customer_data_exports`, and `data_requests` gains `source`,
`requester_country`, verification, `scheduled_for`, `processed_at`,
`updated_at` and the `scheduled` / `verifying` / `cancelled` statuses.
Permissions `privacy.view`, `privacy.settings`; notification templates
`privacy.request_verify`, `privacy.request_received`,
`privacy.request_completed`, `staff.privacy_request`.

## Not yet

- The headless Storefront API (`/api/v1`) has no consent endpoint; the React
  storefront would call `POST /privacy/consent` on the Online Store host.
- Regions are by country: US states and Canadian provinces (Quebec's Law 25)
  are covered by listing the country.
- Consent records are kept indefinitely (they are the proof); a retention
  period can be added to the sweep.
