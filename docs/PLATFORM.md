# Veylog commerce platform

This backend began as the API for one store (Veylor). It is now a multi-tenant
commerce platform in the Shopify mould: any number of independent stores —
fashion, beauty, electronics, grocery, anything — each with its own catalogue,
customers, orders, theme, staff, payment gateways, messaging providers and
couriers, on shared infrastructure, with no store able to see another's data.

This document is the map. The code comments carry the detail; follow the file
references.

---

## 1. The shape of it

```
                ┌────────────────────────── API process ──────────────────────────┐
  merchants ──▶ │ /admin/api/:version   Admin API   (staff JWT or app token)      │
  storefronts ─▶│ /api/v1               Storefront API (shop resolved from host)  │
  operators ──▶ │ /platform/api/v1      Platform API (signup, operators)          │
  providers ──▶ │ /integrations/inbound Provider webhooks (raw body, signed)      │
  app servers ─▶│ /admin/oauth          OAuth token exchange                      │
                │                                                                 │
                │  every request runs inside tenancy.run(shop) ─▶ tenant guard     │
                └───────────────┬─────────────────────────────────────────────────┘
                                │ writes rows + events (same transaction)
                 ┌──────────────▼──────────────┐       ┌────────────────────────┐
                 │ control plane DB            │       │ pod DBs (1..n)         │
                 │ shops, domains, plans,      │       │ every shop-owned table │
                 │ identities, staff, apps,    │       │ (shop_id on each row)  │
                 │ jobs, theme library         │       │ + events outbox        │
                 └──────────────▲──────────────┘       └───────────▲────────────┘
                                │                                  │
                ┌───────────────┴──── worker (embedded or separate) ┴─────────────┐
                │ event dispatcher ─▶ jobs ─▶ webhooks to apps, notifications,     │
                │ provisioning, inbound webhook processing, campaigns, maintenance │
                └──────────────────────────────────────────────────────────────────┘
```

Layers inside the API are unchanged from the original codebase: route →
controller → service → repository, `mysql2` with no ORM, `zod` at the edges.
Platform concerns live in `src/platform/`; the commerce domain in `src/modules/`.

---

## 2. Tenancy

**Model.** Shared tables, a `shop_id` on every shop-owned row (migration 102
added it to 150+ tables, prefixed every unique key, and made foreign keys
tenant-consistent: `(shop_id, x_id) → parent(shop_id, id)`, migration 103).
Control-plane tables (shops, domains, plans, identities, staff memberships,
apps, jobs, theme library) have no `shop_id` and live on the control-plane
database. The frozen list is `src/platform/tenancy/tables.ts`.

**Context.** `tenancy.run(shop, fn)` (AsyncLocalStorage) carries the current
shop through a request or job; `shopId()` reads it and throws outside a shop.
The Admin API sets it from the signed-in staff member's active shop (or the
app token's shop), the Storefront API from the host, and jobs from the shop
they were enqueued for. Cross-shop work is explicit and labelled:
`tenancy.unscoped('reason', fn)`.

**Guard.** Every query on every pool passes through `src/platform/tenancy/guard.ts`.
With `TENANT_GUARD=enforce`, a statement that touches a shop-owned table and
does not mention `shop_id` throws; so does one whose `shop_id = ?` parameter is
bound to a different shop than the current one (the swapped-parameter bug).
`npm run check:tenancy` is the static half: it walks the TypeScript AST and
reports unscoped statements before they run. Both report zero today.

**Pods.** `PODS` adds databases; each shop has a `pod_id`. The `pool` export
routes to the current shop's pod, so repositories never name one. New shops go
to the least-full pod that accepts them.

**Caches.** Anything cached in-process is partitioned by shop
(`src/platform/cache/shopCache.ts`) — a global `Map` keyed by `page:home` would
serve one shop's home page to another.

---

## 3. The three APIs

| API | Mount | Who | Notes |
|---|---|---|---|
| Admin | `/admin/api/:version` | staff (JWT), installed apps (`vlat_` token) | Date-versioned (`2026-10`); `v1` aliases it for the existing admin frontend. `X-Veylog-Shop` picks a shop for multi-store staff. |
| Storefront | `/api/v1` | shoppers, headless storefronts (`vlst_` token) | Shop resolved from storefront token → `X-Veylog-Shop-Domain` → Host → `DEFAULT_SHOP` → the only shop. Password gate when a store is "opening soon". |
| Platform | `/platform/api/v1` | anyone (signup), platform operators | Signup, handle availability; operators: shops, plans, pods, jobs, app store. |

New Admin API resources: `/shop` (details, setup guide, pause, close, ownership),
`/shops` (open another store), `/domains`, `/billing`, `/themes`,
`/integrations`, `/webhooks`, `/notifications/preferences`, `/apps`,
`/storefront_access_tokens`.

---

## 4. A shop's life

1. **Signup** (`POST /platform/api/v1/signup`) creates the identity and the
   first store together and signs the person in. Signed-in people open more
   stores with `POST /admin/api/v1/shops`.
2. **Provisioning** (`src/platform/shops/provisioning.ts`) writes the shop row,
   its `handle.myveylog.com` domain, a trial subscription and the owner on the
   control plane, then seeds the pod from three **blueprints**:
   * `base` — staff roles, the settings catalogue, number sequences,
     notification templates, default senders, segments, menus, blog, FAQs;
   * `region` (`blueprints/regions.ts`) — currency, timezone, tax classes
     (GST/VAT/sales tax), shipping rates, couriers, cash on delivery;
   * `vertical` (`blueprints/verticals.ts`) — twelve verticals, each with its
     attributes (sizes, skin types, specs, allergens…), metafields, category
     tree, collections, search synonyms and theme.

   Each step is idempotent and recorded in `shop_setup_tasks`; a failed run is
   retried by the `shops.provision` job and resumes where it stopped. Stores
   that predate provisioning are **adopted** once at boot (theme, setup guide,
   missing templates) without generic defaults overwriting their data.
3. **Statuses**: `provisioning → active ⇄ paused` (owner; catalogue up, no
   checkout) `⇄ frozen / suspended` (operators) `→ closed` (owner; apps receive
   `shop/redact`).
4. **Plans** (`plans` table) carry limits and features; `entitlements` enforces
   them (`402 FEATURE_NOT_IN_PLAN`, `PLAN_LIMIT_REACHED`). Downgrades are refused
   while usage exceeds the new plan.
5. **Custom domains** are verified by a TXT record and routed by a CNAME (or A
   records to `PLATFORM_EDGE_IPS`); a sweep re-checks pending domains. TLS is the
   edge's job (e.g. Caddy on-demand TLS or Cloudflare for SaaS).

---

## 5. Events, webhooks, jobs

* **Events** are written to the `events` outbox in the transaction that made
  the change, so an event exists if and only if the change committed. Most are
  derived automatically from the audit trail (`src/platform/events/auditEvents.ts`)
  with a resource snapshot taken inside the transaction; checkout, payments,
  shipments and reviews publish theirs explicitly. Topics follow Shopify's
  `resource/action` names (`src/platform/events/topics.ts`).
* The **dispatcher** turns events into jobs: one per app webhook subscription
  and one per in-process subscriber.
* **Webhooks** to apps and merchant endpoints are signed
  (`X-Veylog-Hmac-Sha256`, base64 HMAC-SHA256 of the raw body), retried with
  backoff for ~48 hours, SSRF-guarded, and disabled after persistent failure.
* **Jobs** live in MySQL (`jobs`), claimed with `FOR UPDATE SKIP LOCKED`, with
  leases, retries, dead-lettering and slot-deduplicated schedules. Run them in
  the API (`WORKER_EMBEDDED=true`) or as a separate `worker` process — same
  code (`src/platform/runtime.ts` is the manifest of every job type).

---

## 6. Integrations

`src/platform/integrations/` — a merchant connects a provider under
Settings → Integrations; credentials are verified against the provider, then
sealed with the vault (AES-256-GCM, bound to shop and connection).

| Category | Providers |
|---|---|
| Payments | Razorpay, Stripe (PaymentIntents), PayPal (Orders v2) |
| SMS / WhatsApp | Twilio (both), WhatsApp Cloud API (Meta) |
| Email | SendGrid, Postmark |
| Shipping | Shiprocket (book, track, cancel, returns) |

Each provider is one manifest file: credential fields, a `verify` call, an
adapter for its category's interface (`PaymentGateway`, `MessageProvider`,
`CourierProvider`), and an inbound verifier. Every connection gets its own
webhook URL, `…/integrations/inbound/{shop}/{connection}`; deliveries are
signature-checked over the raw bytes, stored once per provider event id, and
processed by a job. Handlers subscribe to platform event types
(`payment.captured`, `message.status`, `shipment.status`…), so one handler
serves every provider. **Adding a provider** is a manifest and a line in
`providers/index.ts`.

Storage is a platform concern, not a merchant integration: `STORAGE_DRIVER=s3`
works with any S3-compatible store (Signature V4, no SDK), and every shop's
files live under `shops/{shop public id}/`.

---

## 7. Commerce behaviour that became per-shop

* **Pricing** (`src/platform/commerce/shopPricing.ts`): delivery from the
  shop's shipping rates, cash on delivery from its COD rules — no compiled-in
  constants.
* **The cart quote** (`src/modules/storefront/cartQuote.ts`) prices a basket
  once, in till order, for both the bag and checkout: discounts → delivery →
  cash on delivery → tax on the discounted line amounts.
  * *Discounts* (`src/modules/discounts/discountEngine.ts`): one code the
    shopper entered plus the shop's automatic offers; percentage, fixed,
    free delivery, buy-X-get-Y and free gift; minimum spend and quantity,
    product/collection/category targeting, new/returning/named customers,
    overall and per-customer limits. One non-stackable discount, any number
    of stackable ones on what is left. Amounts are allocated onto lines, so
    tax, invoices, refunds and returns all work from the price paid.
  * *Delivery* (`src/modules/shipping/shippingQuote.ts`): the shop's rate
    table by method (standard, express, pickup), order-value band and weight
    band, with free-above thresholds judged on the discounted value.
    **Zones** (`/admin/api/:v/shipping/zones`) are named sets of states and
    postcode prefixes; an address is in the most specific zone covering it
    (prefix over state, longer prefix over shorter, state + prefix over
    prefix) and is offered that zone's rates only — a zone with no express
    rate has no express. Addresses in no zone get the everywhere rates. US
    stores open with an Alaska, Hawaii & territories zone, Canadian ones
    with the northern territories. `POST /shipping/quote-preview` shows what
    an address would be offered. For Indian stores, postcodes mapped in
    `pincode_serviceability` still set named zones and can refuse delivery,
    COD or express.
    **Carrier-calculated rates**: a rate row with `rate_type: "carrier"` and a
    `carrier_id` matches like any other, but charges the courier's live quote
    for the parcel (`carrier_markup_percent`, then `carrier_markup_amount`, on
    top) — the cheapest surface service for standard, air or express for
    express — and its own `rate` when the courier cannot answer within
    `SHIPPING_QUOTE_TIMEOUT_MS` (3 s), does not serve the address, or no
    postcode is known. Quotes are cached ten minutes per basket and address,
    so the bag and checkout agree; a failing courier is left alone for 30 s.
    Options say where their price came from (`rateSource`: `table`,
    `carrier`, `carrier_fallback`). Couriers quote through the optional
    `CourierProvider.quoteRates`: the stand-in prices from the table it books
    at; Shiprocket asks its serviceability API (built to its documentation,
    not yet run against a live account).
  * *Checkout* re-quotes inside its transaction once the customer is known —
    the only point "first order only" and "once per customer" can be decided —
    and counts each discount with a guarded increment on the coupon row, so
    concurrent shoppers cannot exceed a usage limit (four simultaneous
    checkouts for a single-use code: one order, three `409
    DISCOUNT_NOT_APPLICABLE`). A code that stopped applying is refused rather
    than silently dropped.
  * Storefront API: `POST|DELETE /api/v1/cart/:token/discount`,
    `PUT /api/v1/cart/:token/delivery` (postcode),
    `GET /api/v1/cart/:token?shipping_method=&payment_method=` (preview), and
    `shipping_method` / `discount_code` on checkout.
* **Tax** (`src/platform/tax/taxService.ts`), by regime:
  * *Class-rate* (GST, VAT): each product's tax class rate, wherever it goes.
    Inclusive prices have tax extracted; Indian GST splits CGST/SGST or IGST by
    place of supply.
  * *Destination* (US sales tax, Canada): the rate of the delivery address,
    only where the shop is registered to collect (`tax_registrations`, the
    state or province over the whole country), added on top, and on delivery
    where the registration says delivery is taxable. A store registered
    nowhere collects nothing — that is its nexus, not a bug. Products in an
    exempt class are not taxed. A connected tax service (TaxJar, category
    `tax`) answers first, with city and district rates; if it fails, the
    registrations answer and the fallback is logged. Completed sales (on
    fulfilment) and refunds are reported to the tax service for filing,
    each once (`tax_reports`, `src/platform/tax/taxReporting.ts`).
  * The bag, the order (`orders.tax_lines`, `shipping_tax`), the admin order,
    the `orders/*` webhook payload (`tax_lines`) and the invoice all carry the
    named taxes ("CGST 9%", "California sales tax 7.25%"). With only a ZIP,
    the bag says tax is calculated at checkout; checkout needs a state it can
    recognise (`src/platform/geo/regions.ts`, by name or code).
  * Admin: `/admin/api/:version/tax` — overview, `POST|PATCH /classes`,
    `POST|PATCH|DELETE /registrations`, and `POST /preview` (what a customer
    at an address would pay).
* **Payments** (`src/modules/payments/onlinePayments.service.ts`): any
  connected gateway. The browser's "I paid" is proven by the gateway adapter
  (signature or server-side read), the amount is checked against the order,
  and settlement is idempotent across callback and webhook. Refunds go back
  through the connection that took the money.
* **Money, phones, postcodes, dates** are formatted and validated for the
  shop's country and currency (`src/platform/geo`, `src/platform/money`,
  `src/platform/shops/format.ts`).
* **Notifications** (`src/platform/notifications`): order events become
  customer messages on the channels the shop enabled, through its connected
  providers, using its templates.
* **Apps** are metered: a leaky bucket per shop and app sized by the plan,
  reported in `X-Veylog-Shop-Api-Call-Limit`. Buckets live in MySQL
  (`api_rate_buckets`, one atomic statement per call), so the limit holds
  across every API node: sixty simultaneous calls against a bucket of ten
  admit exactly ten.

---

## 8. Themes

`src/platform/themes/`, `src/platform/onlineStore/`, `themes/` — Shopify's
Online Store 2.0 model, described in full in [ONLINE_STORE.md](ONLINE_STORE.md).
A theme is a bundle of files (Liquid layouts, sections with `{% schema %}`,
snippets, JSON templates, assets, `settings_schema.json` /
`settings_data.json`, locales). Nine built-in themes are built from one kit and
synced into `theme_library` / `theme_library_files` at boot (migration 123). A
shop holds several installed themes (plan limit) — its own copy of the files —
with exactly one `main`. Merchants customise in the theme editor (sections,
blocks, theme settings, live preview, drafts) or the code editor (validated
saves, 20 versions per file), preview, publish, duplicate, download/upload zips
and take updates as new copies with their customisations. The store's domain
is served by the server-side Liquid renderer; checkout is the platform's,
branded by the theme. A headless storefront still reads the live theme's
design tokens from `GET /api/v1/theme`.

---

## 8a. Platform billing

`src/platform/billing/` — the platform charging its merchants, on Shopify's
model. Tables (control plane, migration 112): `plan_prices` (a plan's price
per currency, so a US store pays in dollars), `billing_accounts` (card on
file), `platform_invoices` and `platform_invoice_lines`.

* **What is billed.** The plan in advance, one period at a time, from the end
  of the trial (no trial: from signup). Transaction fees in arrears: the
  plan's basis points of online-gateway sales in the ended period (cash on
  delivery carries none). A plan change bills the new plan from today, credits
  the unused part of the old one if it was billed, and settles the old plan's
  fees so far; a net credit is carried to the next bill.
* **How.** `billing.tick` runs every 15 minutes: it opens ended periods (one
  invoice per subscription period, keyed so a double run bills once), retries
  failed charges after 1, 3 and 5 days, and freezes stores whose bill is still
  unpaid `BILLING_GRACE_DAYS` (7) after its first failure. Frozen: admin
  read-only except Billing, storefront unavailable. Paying — or saving a card,
  which retries every unpaid bill at once — unfreezes the store.
* **Processors** (`PLATFORM_BILLING_PROVIDER`): `stripe` (the platform's own
  account: SetupIntent + off-session PaymentIntents; a bank that wants 3-D
  Secure makes the charge `requires_action`, completed from Billing with the
  returned client secret and `/confirm`), `simulator` (development default;
  cards `sim_card_visa` and `sim_card_declined`), `manual` (bills stay open
  until an operator marks them paid; the production default). A subscription
  whose provider is `manual` or `internal` (the founding store) is never
  charged or frozen; adding a card moves a `manual` store onto card billing.
* **Tax on the platform's bills** (`platformTax.ts`, migration 131). With
  `PLATFORM_TAX_COUNTRY` (+ `_REGION`, `_RATE`, `_NAME`, `_ID`) set, a bill to
  a store in the same country carries the platform's tax as `tax` lines — in
  India CGST + SGST when the store is in the platform's state, IGST
  otherwise — with `subtotal`, `tax_total` and the store's tax ID on the bill;
  a store abroad buys an export of services (no tax, and the bill says so).
  The store's legal name, GSTIN/tax ID and state are set in Settings →
  Billing (`PATCH /billing/details`, a GSTIN is checked); without a state the
  store's main stock location decides. Unset: no tax, as before.
* **Processor events.** `POST /platform/api/v1/billing/webhooks/stripe`
  (point the platform account's webhook here; `PLATFORM_STRIPE_WEBHOOK_SECRET`)
  verifies `Stripe-Signature` (five minutes' tolerance), records each event
  once (`billing_provider_events`) and settles or fails the bill: a 3-D Secure
  check completed in another tab or a payment that settles later now marks
  the bill paid (and unfreezes the store) without anyone pressing Pay again.
  Charges carry `metadata[invoice_id]` so an event always finds its bill; a
  failure the platform already recorded is not counted twice; disputes are
  logged and counted (`platform_billing_disputes_total`).
* **Admin API** (`/admin/api/:version/billing`): `GET /` (card, outstanding
  bills, pending credits, billing details), `PATCH /details`, `GET /invoices`,
  `GET /invoices/:id`, `POST /invoices/:id/pay`, `POST /invoices/:id/confirm`,
  `POST /payment-method`, `POST /payment-method/confirm`, plus the existing
  `/plans` and `/subscription`.
* **Operators** (`/platform/api/v1/billing`): `GET /invoices`,
  `POST /invoices/:id/mark-paid`, `POST /invoices/:id/void`, and
  `POST /run` — which outside production accepts `now` and `shop`, a test
  clock: `smoke:platform` walks a store through trial end, a failed bill, a
  card, an upgrade, a decline, a freeze and recovery in a few seconds.

---

## 8a2. Markets: selling abroad

`src/platform/markets/` — Shopify's Markets. A **market** is a group of
countries a store sells to, with a currency, a price adjustment (+10% for
freight or positioning) and a rounding rule (whole units, or up to .99). Every
store has a primary market — its own country in its own currency — so a store
that never adds one behaves exactly as before.

* **Exchange rates** (`exchange_rates`, units per US dollar) come from the
  ECB's daily reference rates (refreshed every six hours and at boot) or are
  set by an operator (`PUT /platform/api/v1/exchange-rates/:currency`) for
  currencies the ECB does not publish; an operator's rate is kept until
  cleared. Nothing is invented: a currency with no rate cannot be sold in.
* **Storefront.** `GET /api/v1/markets` is the country picker. A request with
  `X-Veylog-Country` (or `?country=`) sees catalogue prices in that market;
  a country not sold to sees the store's prices with
  `X-Veylog-Market: unavailable`. `PUT /cart/:token/market {country}` prices
  the bag in the market's currency from then on.
* **Cart and checkout** work in the market's currency: prices are converted
  and rounded, the store's fixed discounts and thresholds converted, delivery
  quoted from the store's rates for the destination country and converted. A
  sale outside the store's country is an **export**: no domestic sales tax,
  GST or VAT (a tax-inclusive price drops its tax), no cash on delivery, and
  delivery only where a shipping zone covers the country (`areas: [{country:
  'CA'}]`). Import duties are the buyer's, on delivery. Phone and postcode
  are validated for the delivery country.
* **Orders** are charged in the market's currency and record `market_id`,
  `shop_currency` and `exchange_rate` (store units per unit paid). Dashboards,
  customer lifetime spend and platform transaction fees convert with it; the
  order webhook payload carries `presentment_currency`, `shop_currency` and
  `exchange_rate`.
* Admin: `/admin/api/:version/markets` (the primary market can gain countries
  but not be deleted, switched off, or change currency).

---

## 8b. Platform email and account recovery

`src/platform/mail/` — email from the platform itself, as opposed to a shop's
customer email (which goes through the shop's own connection). Every email is
written to the `platform_emails` outbox, in the transaction of whatever caused
it, and delivered by the `platform.email_send` job with retries; delivery
reuses the Postmark and SendGrid adapters with the platform's key
(`PLATFORM_EMAIL_PROVIDER`; `log`, the development default, sends nothing and
leaves the message in the outbox). `dedupe_key` makes "once" enforceable.
Emails carrying a secret (reset and invitation links) lose their body once
delivered, and operators see those bodies only in `log` mode.

* **Billing** sends a trial-ending reminder (three days before, once), a
  receipt for every paid bill, a notice for each failed attempt with the next
  retry date, and store frozen / reopened notices — to the billing email, else
  the store's, else the owner's.
* **Staff invitations**: creating staff without a password sends an
  invitation link (7 days, single use, SHA-256 of the token stored);
  `GET /admin/api/:v/auth/invitations/:token` says which store, and
  `POST /auth/invitations/accept` sets the password and activates the
  membership. Someone who already has an account is told they were added.
  `POST /admin-users/:id/resend-invitation` replaces the link.
* **Forgot password**: `POST /auth/password/forgot` always answers 202 with
  the same message (no account enumeration) and emails a 60-minute
  single-use link; `POST /auth/password/reset` sets the password, signs out
  every session and emails a "password changed" notice.
* Operators read the outbox at `GET /platform/api/v1/emails`.

## 8c. The frontends

Both frontends talk only to the APIs above; nothing platform-specific is
hard-coded in them.

**Admin** (`veylog-fronend-admin`). A `ShopProvider` loads `GET /shop` and
`GET /auth/shops`; the store name in the top bar is the switcher (`POST
/auth/switch-shop`, then a full reload so nothing of the old store stays on
screen) and money formats in the store's currency. Signed-out pages:
`/signup` (store + owner in one form, `POST /platform/api/v1/signup`),
`/forgot-password`, `/reset-password?token=`, `/accept-invite?token=` — the
last two are what `PLATFORM_ADMIN_URL` links in emails open. Screens, each at
the menu route migration 119 seeds:

| Route | What it does |
|---|---|
| `/settings/store` | profile, defaults (country/currency lock after the first order), storefront password, owner actions (pause, transfer, close) |
| `/settings/billing` | plan and usage meters, plan change (limit conflicts listed), card (Stripe Elements, or the simulator's test cards), bills, pay now incl. 3-D Secure |
| `/settings/markets` | markets with countries, currency, adjustment and rounding, with a live price preview (`GET /markets/currencies`) |
| `/settings/taxes` | tax classes, registrations (destination regimes), connected tax service, rate check |
| `/settings/domains` | platform address, custom domains with the DNS records to add, verify, primary |
| `/settings/integrations` | catalogue by category; connect forms generated from each provider's manifest; test, default, on/off, webhooks log |
| `/settings/notifications` | automatic messages per channel; staff alert recipients |
| `/settings/apps` | installed apps, app store, custom apps (scopes → token shown once), Storefront API tokens |
| `/settings/shipping` → Zones | shipping zones and a "what would a customer see" quote; rates pick a zone |
| `/merchandising/themes`, `/merchandising/themes/:id` | live theme, theme library, explore; the editor is generated from the settings schema with a live preview |
| `/apps/authorize?client_id=…` | the install (OAuth consent) screen an app sends a merchant to |
| `/stores/new` | another store for a signed-in person |

Store details also carries the **Brand** card (`GET/PUT /shop/brand`,
migration 120's `shop_brand`): logo, square logo, slogan, a short
description and social links. It is kept apart from themes, so a theme
change never loses it, and `GET /api/v1/storefront/shop` serves it to
storefronts (with the store's email and phone), cached five minutes and
dropped on save.

**Operators' console** (`/console`, for identities with a platform role;
`support` sees everything read-only, `admin` can act). Reached from the store
menu ("Platform console"); it sits outside any one store.

| Route | What it does |
|---|---|
| `/console` | live, paying and trialing stores; monthly recurring revenue and outstanding bills per currency; sign-ups over 30 days; newest stores; queue health |
| `/console/stores`, `/console/stores/:id` | every store, searchable by name, address or owner and filtered by status and plan; a store's staff, domains, subscription and bills; move plan, freeze, suspend, reactivate (with a reason, audited); open its admin |
| `/console/plans` | create and edit plans: price, currency, interval, trial, transaction fee, every limit (or unlimited) and feature, public or private, retire and reactivate |
| `/console/billing` | platform bills across stores; mark a bank transfer paid, void; run the billing cycle now (in development "as of" a date, for one store) |
| `/console/exchange-rates` | the rates markets convert with, against any base; pin a rate, hand it back to the ECB, fetch now |
| `/console/apps` | the app store: register a public app, publish or delist, rotate its secret; custom apps for support |
| `/console/jobs` | queue depth per queue, dead jobs with their errors, retry |
| `/console/emails` | the platform's outbox (the development mailbox with `PLATFORM_EMAIL_PROVIDER=log`) |

The operator API gained what the console needed: `GET /overview` now
reports revenue, outstanding bills, sign-ups and the newest stores;
`POST /plans` creates a plan (every limit and feature written out, private
until made public); `PATCH /plans/:handle` edits any plan, including a
retired one, and currency, interval and sort order; `GET /shops/:id` adds
the plan row and the store's recent bills.

The dashboard carries the setup guide (`POST /shop/setup/:task`); discounts
gained Buy X get Y and free-gift fields; order pages format in the order's
currency (`presentment` gives the store-currency value of an order paid
abroad) and list named tax lines.

**Storefront** (`veylor_webapp`). Every request carries, when known,
`X-Veylog-Shop-Domain` (`VITE_SHOP_DOMAIN`, or `?shop=<handle>` for the tab —
on the store's own host the API needs neither), `X-Veylog-Country` (the
shopper's pick) and `X-Veylog-Storefront-Unlock`. Prices format in the
currency the API reports (`X-Veylog-Currency`). A locked store renders only
its password page. The header's country picker (shown when the store sells
to more than one country) moves the bag to that market. The bag and checkout
show discount codes, automatic offers, a free gift, delivery options for the
address, cash-on-delivery availability and fee, and tax as the market
requires (inside the price, added as named lines, or "calculated at
checkout"); checkout re-prices on the server for the chosen delivery option
and payment method. The bundled design stays the look unless
`VITE_STOREFRONT_THEME=platform`; a theme-editor preview (`?preview_theme=`)
always applies the theme, under a "previewing" bar.

The storefront draws the store's own brand: the wordmark (its logo, or its
name over its slogan), footer description, social links and contact, the
copyright, page titles, the favicon (square logo) and the name in the
payment window all come from the brand. The bundle's hand-written voice —
Veylor's copy, shelf links and "Complimentary delivery…" strip — belongs to
the store it was designed for (`VITE_BRAND_SHOP`, default `veylor`); every
other store gets neutral wording, its own top categories in the footer, and
no announcement strip until it publishes one. When one origin serves
several stores (`?shop=`, `VITE_SHOP_DOMAIN`), the bag, sign-in, country,
store-password token and dismissed announcements are kept per store.

UI checks: `npm run smoke:platform` in each frontend (Playwright;
`PW_CHANNEL=chrome` uses an installed Chrome) — 63 admin checks (including
the console), 26 storefront checks (including a second store's brand); the
storefront one creates and removes its own market, code, password and
brand.

---

## 9. Running it

```bash
npm run db:migrate            # new database: everything
npm run db:seed               # platform administrator (+ membership of the first store)
npm run dev                   # API with embedded worker
npm run worker                # a separate worker, when WORKER_EMBEDDED=false
```

`docker compose up --build` runs MySQL, a one-shot migrator, the API and a
worker. The image runs as any of the three by command (see `Dockerfile`).

Health: `/health/live`, `/health/ready` (every pod answers), `/health`.
Metrics: `/metrics` (Prometheus; requires `METRICS_TOKEN` in production) —
HTTP latency by route template, job queue depth and age, provider calls,
webhook outcomes, notifications, throttled app calls.

**Environment**: see `.env.example`. Production needs `JWT_SECRET`,
`VAULT_KEYS`, `PUBLIC_API_URL`, `PLATFORM_STOREFRONT_DOMAIN`, and
`TENANT_GUARD=enforce`.

### Upgrading the existing single-store database

Take a backup first. Then:

```bash
npm run db:migrate -- baseline   # record the legacy SQL files as already applied
npm run db:migrate               # 100–118: control plane, tenancy, apps, events, integrations, billing, tax, email, zones, markets…
npm run db:fix-timestamps        # report: which stored times are in the server's local zone
npm run db:fix-timestamps -- --apply
npm run db:seed                  # the administrator becomes a platform admin
```

**Times are UTC.** Every pooled connection pins `time_zone = '+00:00'`, so
`NOW()` and the driver agree. Before that, sessions ran in the MySQL server's
own zone: on a UTC server (managed MySQL, containers) nothing changes, but a
database run on a +05:30 machine has 5½-hour-ahead values from
`DEFAULT CURRENT_TIMESTAMP` and `NOW()`, and the job queue ignored retry
backoffs (it wrote `run_at` in UTC and compared it with local `NOW()`).
`db:fix-timestamps` moves the columns only the database clock writes — it
reads the application's SQL to decide, lists the columns it leaves alone
(written from JavaScript too, or by runtime-built statements), refuses to run
twice, and does nothing on a UTC server. Run it with the API stopped.

The existing store becomes shop 1 (`veylor`), keeps all its data, and is
adopted (theme, setup guide) on first boot. Until the storefront is served on
the shop's own host, set `DEFAULT_SHOP=veylor` so the existing frontend keeps
resolving it. This path was rehearsed on a copy of the development database.

---

## 10. Verifying changes

```bash
npm run verify           # typecheck, unit tests, INSERT arity check, tenancy check
npm run smoke:platform   # two stores end to end against a running API (scratch DB)
npm run smoke:commerce   # and the other pre-existing smoke suites
```

`npm run check:sql` exists because a payment upsert once had one more
placeholder than columns (and it now also catches an unquoted reserved word
as a column, after `sensitive` broke the email outbox); `npm run
check:tenancy` because a query that forgets `shop_id` is a data leak.

---

## 11. Known gaps

Honest list of what is not done, roughly in priority order:

* **Legacy timestamps in "mixed" columns** (listed by `db:fix-timestamps`,
  e.g. `products.published_at`, `orders.packed_at`) keep whatever zone they
  were written in on a non-UTC server: a row cannot say which writer set it.
* **Shipping**: carrier-calculated rates are quoted for prepaid parcels
  (a COD surcharge stays the shop's own fee), and the Shiprocket quote has
  not been run against a live account.
* **Tax, what is missing**: Avalara is not integrated; there is no
  cross-border tax (EU OSS, import duties — see Markets); registration rates are one combined rate per state, not
  per county or city (the tax service gives that).
* **Platform billing, what is missing**: transaction fees are skipped, with a
  warning, when a store sells in a currency it is not billed in (no exchange
  rates); app charges (apps billing merchants through the platform) are not
  modelled; tax on platform bills is one registration (no EU OSS / VAT
  reverse charge per buyer country), and bills are not issued as GST e-invoices
  (IRN).
* **Markets, what is missing**: intra-EU sales by EU stores are treated as
  exports, where EU rules (OSS) charge the buyer's country's VAT; duties and
  import taxes are not collected at checkout (the buyer pays on delivery);
  prices are always converted, never set by hand per market; a gateway must
  support the market's currency.
* **Frontends, what is missing**: the storefront's layout and product page
  were designed for a skincare catalogue (ingredient, texture and skin-type
  panels show only when a product has that data, but a very different
  vertical would want its own templates — the Liquid Online Store is the
  answer to that); the legacy React storefront's footer newsletter form is
  not wired to anything; the console cannot impersonate a customer.
* The Docker image has not been built in this environment.
