# Veylog — MySQL 8 Database Schema

Phase 1 deliverable: **table schemas only**. No application code.

Target: **MySQL 8.0**, InnoDB, `utf8mb4_0900_ai_ci`. No Prisma — plain SQL DDL.
`D:\VEYLOR_FINAL_ECOMMERCE-main` was read as a **UI reference only**; none of its
Prisma/Postgres schema carries over.

**Verified:** all 15 files were executed against MySQL 8.0.46. 139 tables,
278 foreign keys, seed data loaded, and an end-to-end flow (media upload →
product → variant → inventory → guest cart → OTP login → order → Razorpay
payment → webhook → stock movement → verified review) was inserted and queried
successfully. Webhook replay, invalid rating, duplicate phone and zero-quantity
cart line were all correctly rejected by constraints.

---

## Run order

```bash
mysql -u root -p < 00_database.sql
mysql -u root -p < 01_admin_rbac.sql
mysql -u root -p < 02_media.sql
mysql -u root -p < 03_taxonomy.sql
mysql -u root -p < 04_catalog.sql
mysql -u root -p < 05_inventory.sql
mysql -u root -p < 06_cms.sql
mysql -u root -p < 07_customers.sql
mysql -u root -p < 08_cart_orders.sql
mysql -u root -p < 09_payments_shipping.sql
mysql -u root -p < 10_marketing.sql
mysql -u root -p < 11_reviews.sql
mysql -u root -p < 12_support_ops.sql
mysql -u root -p < 13_system.sql
mysql -u root -p < 99_seed_reference.sql
```

`schema_all.sql` is the same thing concatenated, if you prefer one file.
Order matters — foreign keys are declared as they become resolvable, with a few
deliberate `ALTER TABLE ... ADD CONSTRAINT` statements at the end of later files
to close circular references (media ↔ admin_users, carts ↔ orders,
orders ↔ coupons).

| File | Tables | What it covers |
|---|---|---|
| 01 | 10 | Admin accounts, roles, permissions, sessions, invites, audit log |
| 02 | 7 | Media library, variants, polymorphic attachments, migration log |
| 03 | 12 | Brands, categories, collections, skin types/concerns, tags, GST classes |
| 04 | 24 | Products, variants, options, ingredients, claims, bundles, routines, quiz |
| 05 | 5 | Locations, stock levels, movement ledger, reservations, batches |
| 06 | 18 | CMS: pages, sections, blocks, revisions, blog, menus, banners, FAQs, redirects, SEO, metafields, custom entry types |
| 07 | 12 | Customers, addresses, OTP, throttling, sessions, consents, wishlist |
| 08 | 11 | Carts, orders, order items, addresses, status history, invoices, returns |
| 09 | 10 | Razorpay payments, webhooks, refunds, carriers, shipments, pincodes, COD |
| 10 | 13 | Coupons, loyalty, newsletter, notification templates and logs |
| 11 | 5 | Reviews, votes, replies, reports, invitations |
| 12 | 5 | Support tickets, messages, adverse events, tracking lookups, macros |
| 13 | 9 | Settings, search, rate limits, import/export jobs, feature flags |

---

## The three decisions that shape everything

### 1. Images — addressed by `disk` + `storage_key`, never by URL

You store locally now and move to S3 later. The schema is built so that move is
a file copy plus one `UPDATE`, not a data migration.

```
media.disk          'local'
media.storage_key   'media/2026/09/{uuid}/original.jpg'
```

The public URL is **composed at read time** as `{base_url_for_disk} + storage_key`.
The base URL lives in `settings` (`media.local_base_url`, `media.s3_base_url`).
No product row, CMS block, or `<img>` tag ever contains a hostname — so nothing
breaks when the host changes.

Recommended on-disk layout while `disk = 'local'`:

```
/storage/media/2026/09/{uuid}/original.jpg
/storage/media/2026/09/{uuid}/lg.webp
/storage/media/2026/09/{uuid}/lg.avif
```

Sharded by year/month — a single directory stays under a few thousand entries,
which matters once you are in the tens of thousands of product and UGC images.
Keep it **outside the web root**, served through a route that can 404, authorise
and set immutable cache headers.

Three tables carry the weight:

- **`media`** — one row per real file. Holds `checksum_sha256` (indexed, for
  dedupe on upload), `focal_x`/`focal_y` (so one master crops correctly at 4:5
  on mobile and 16:9 on desktop), `blurhash` (kills layout shift → CLS budget),
  `usage_count` (orphan sweep), and `usage_rights` + `rights_expires_at` for
  licensed stock and permissioned UGC.
- **`media_variants`** — one row per size × format. The `srcset` is built from
  this table, so the front end never guesses a URL that doesn't exist. Adding
  AVIF next year is new rows, not a schema change.
- **`media_attachments`** — polymorphic: `(attachable_type, attachable_id,
  collection, sort_order, is_primary)`. One image can be a PDP gallery shot, a
  collection banner and an OG image with three different alt texts and **zero
  duplicate files**. Reordering a gallery is one cheap `UPDATE`.

`media_migrations` tracks the eventual local → S3 run with a resume cursor, so a
failed batch resumes instead of restarting.

### 2. CMS — Shopify's model, table for table

| Shopify | Here |
|---|---|
| Pages | `cms_pages` |
| Theme sections & blocks | `cms_page_sections` + `cms_section_blocks` |
| Blogs / Articles | `cms_blogs` + `cms_articles` |
| Navigation menus | `cms_menus` + `cms_menu_items` |
| Metafields | `metafield_definitions` + `metafields` |
| Metaobjects | `cms_entry_types` + `cms_entries` |
| URL redirects | `cms_redirects` |
| SEO on every resource | `seo_meta` (polymorphic) |
| Files | `media` |
| Theme settings | `settings` |

The section/block model is the important part. A homepage is not a blob of HTML —
it's an ordered list of typed sections, each with JSON settings and its own
ordered blocks. That's what lets the content team reorder the homepage modules
(hero → trust strip → routine → ingredient story → texture → evidence → reviews →
education → founder note → opt-in) without a deploy, and lets a developer add a
section type by shipping one React component plus a settings schema.

Menu items store `link_type` + `link_ref_id` rather than a hardcoded URL, so
renaming a product slug never leaves a dead nav item — and `cms_redirects`
auto-catches the old path.

`metafields` is the escape hatch that means marketing inventing a new field
("SPF rating", "clinical report PDF", "vegan") is a row, not a migration. Typed
value columns rather than one JSON blob, so `veylor.spf_rating >= 50` is still
an indexed query.

Every content entity supports `draft → in_review → scheduled → published →
archived`, with `cms_revisions` snapshots for rollback and
`requires_legal_review` + `reviewed_by_admin_id` gating claims-sensitive pages.

### 3. Auth — two separate identity tables

- **Customers**: `(country_code, phone)` is the unique identity. Email is
  optional throughout. No password column exists. OTP codes are stored only as
  `sha256(otp + pepper)` in `otp_requests`, with `otp_throttle` enforcing the
  per-phone/per-IP send limits durably (SMS costs money).
- **Admins**: email + `password_hash` + TOTP MFA, with `roles` /
  `permissions` / `admin_user_permissions` (a per-user `deny` always beats a
  role `allow`, so you can take refund rights off one agent without inventing a
  role).

Refresh tokens rotate: `customer_sessions.rotated_from_session_id` chains the
family, so replaying an old token revokes the whole chain. That's the mitigation
for the localStorage/XSS risk in the original brief.

---

## Other structural choices worth knowing

**Everything sellable is a variant.** Carts, inventory, order lines and bundles
all reference `product_variants.id`, never `products.id` — even for a
single-size serum. That removes the whole class of bugs where cart, stock and
orders disagree about what a "product" is.

**Money is `DECIMAL`, never `FLOAT`.** `DECIMAL(10,2)` for unit prices,
`DECIMAL(12,2)` for totals. Razorpay works in paise — multiply by 100 at the API
boundary only.

**Orders carry three status columns**, not one: `order_status`,
`payment_status`, `fulfillment_status`. A single column cannot express
"delivered but partially refunded". Every transition writes to
`order_status_history`.

**Order lines are fully snapshotted** — name, SKU, image URL, MRP, price, HSN,
tax split. Renaming a product or changing its price never alters a historical
invoice.

**Webhook replay is handled by a UNIQUE constraint**, not by hopeful application
logic: `payment_webhook_events (gateway, event_id)`. Same idea for
`payments.idempotency_key` (double-submitted checkout) and
`coupon_redemptions (coupon_id, order_id)` (double-click coupon abuse).

**Stock has one source of truth.** `inventory_items.quantity_available` is a
STORED generated column (`on_hand - reserved`), so "is it in stock" is an
indexed read that can never drift. `inventory_movements` is an append-only
ledger; `inventory_reservations` hold stock between checkout start and payment
capture, swept on expiry.

**GST is per-state, not a flat 18%.** `orders.place_of_supply_state_code`
decides CGST+SGST vs IGST; `tax_rates` holds the split with effective dates.
`invoices` are immutable once issued — a correction is a new credit note row.

**Compliance is in the schema, not in a doc.** `claims` + `claim_evidence` +
`product_claims` are the claims matrix (claim → evidence → permitted placement →
footnote → approver) that the BRD makes a launch gate. `customer_consents` is
append-only with `notice_version` — withdrawal is a new row, never an update.
`adverse_events` is a separate table from support tickets because it has its own
retention rule, permission, SLA and possible regulatory reporting.
`export_jobs` records who exported which columns and why.

**Polymorphic tables carry no FK** — MySQL cannot express them. That applies to
`media_attachments`, `metafields`, `seo_meta`, `taggables`, `cms_faqs` and
`audit_logs`. Integrity is enforced in the application layer plus a nightly
orphan sweep. This is a deliberate trade: the alternative is ~20 near-identical
join tables.

---

## What is NOT in here yet

- **Subscriptions / replenishment** (BRD P2) — would add `subscription_plans`,
  `subscriptions`, `subscription_items`, `payment_mandates`.
- **Referral ledger** — `customers.referred_by_customer_id` exists; the reward
  ledger does not.
- **A/B testing / experiments** — `feature_flags` is the primitive; no
  experiment assignment table.
- **Multi-currency / international** — `currency` columns exist and default to
  INR, but there is no FX table.
- **Analytics events** — deliberately left to GA4. Only commercially meaningful
  events (`search_queries`, `product_views`, banner impressions) are stored.

## Suggested next steps

1. Confirm GST rate and HSN codes with your CA — `99_seed_reference.sql` assumes
   18% / HSN 3304.
2. Load `pincode_serviceability` from whichever courier aggregator you pick
   (~19,000 rows).
3. Decide the variant width/format set — currently seeded as
   `thumb 160 / sm 400 / md 800 / lg 1200 / xl 1800` in webp + avif.
4. Then migrate the hardcoded catalog from `lib/data/products.ts`,
   `ingredients.ts`, `blog.ts` and `bundles.ts` into these tables — the field
   shapes were designed to map onto them directly.
