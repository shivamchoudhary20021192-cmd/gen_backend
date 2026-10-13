# Veylog Admin API

Backend for the Veylor admin portal. Node 22 · TypeScript · Express · MySQL 8 ·
no ORM.

> **Now a multi-tenant commerce platform.** Any number of independent stores —
> each with its own catalogue, customers, orders, theme, staff, payment
> gateways, messaging providers and couriers — on shared infrastructure, with
> Admin, Storefront and Platform APIs. Start with **[docs/PLATFORM.md](docs/PLATFORM.md)**
> for the architecture, the upgrade path for the existing database, and how to
> run and verify it.

**Verified:** compiles clean under `tsc --strict`, boots, and passes an
**88-assertion end-to-end smoke test** twice in a row against a live MySQL 8.0.46
with the schema from `database/`. The run exercises login → RBAC denial →
image upload with variant generation → Shopify-shaped product create → publish
gate → variants → collections with rule evaluation → bulk actions → duplicate →
suspension, and writes 126 audit rows doing it.

---

## Quick start

```bash
cp .env.example .env          # then edit DB creds + JWT_SECRET
npm install

# 1. load the schema (from the sibling database/ folder)
mysql -u root -p < ../database/schema_all.sql

# 2. create the first super administrator
npm run db:seed

# 3. run
npm run dev                   # tsx watch, port 4000
```

Then:

```bash
curl -X POST http://localhost:4000/admin/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@veylor.com","password":"ChangeMe!2026"}'
```

To verify the whole surface: `npm run dev` in one shell, `npm run smoke` in
another.

| Script | What it does |
|---|---|
| `npm run dev` | tsx watch mode |
| `npm run build` / `npm start` | compile to `dist/`, run compiled |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:seed` | create/update the super admin (idempotent) |
| `npm run smoke` | 88-assertion end-to-end test against a running server |

---

## The design pattern

Five layers, each knowing only the one beneath it. Full write-up in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

```
route → middleware → controller → service → repository → mysql2 pool
        (auth, rbac,  (HTTP only)  (rules,   (SQL only)
         validate)                 txns,
                                   audit)
```

Four rules keep it honest:

1. **Controllers never import `db`.** If one does, the boundary has leaked.
2. **Repositories never throw `ApiError`.** They return `null`/`[]`; deciding
   that a missing product is a 404 is a service decision.
3. **Every repository method takes `exec: Executor = pool` last.** That one
   convention lets a service compose eight writes into one transaction without
   repositories knowing transactions exist.
4. **Only services open transactions**, via `withTransaction`.

Why no ORM: the schema has generated columns (`inventory_items.quantity_available`),
polymorphic tables with no foreign keys (`media_attachments`, `metafields`,
`seo_meta`), and joins that decide money. An ORM hides those and quietly
produces an N+1 on the product list — the one endpoint an admin hits constantly.

Adding a module (orders, customers, coupons) is one folder plus one line in
`app.ts`. Nothing already written changes.

---

## Shopify conventions, followed and diverged from

| Shopify | Here |
|---|---|
| `/admin/api/<version>/<resource>` | `/admin/api/v1/products` |
| Singular envelope on write | `{ "product": { … } }` in **and** out |
| Plural envelope + meta on read | `{ "products": [ … ], "pagination": { … } }` |
| Nested sub-resources | `/products/:id/variants/:variantId` |
| Actions as POST, not PATCH | `POST /products/:id/publish` |
| `Idempotency-Key` on POST | honoured; replays the first response |
| 422 with per-field errors | `{ error: { code, message, request_id, details } }` |

**Deliberate divergence:** Shopify's `variants[].option1/option2/option3`
positional columns are replaced by a real `product_options` /
`product_option_values` / `variant_option_values` model. Three fixed columns is
a limitation, not a design.

### Error contract — identical at every status code

```json
{
  "error": {
    "code": "SKU_TAKEN",
    "message": "SKU \"VEY-SER-30\" is already in use.",
    "request_id": "0f8b…",
    "details": { "product.variants": ["…"] }
  }
}
```

`ApiError` is the only error a service throws. The global handler maps MySQL
errors onto the contract — `ER_DUP_ENTRY` on a slug key becomes
`409 SLUG_TAKEN`, on an email key `409 EMAIL_TAKEN` — and turns anything
unrecognised into a 500 with the stack logged, never returned.

---

## Auth

```
POST /auth/login  →  { access_token (15 min JWT), refresh_token (30 d opaque),
                       admin, permissions, must_change_password }
```

- **Access token** is a short JWT carrying `sub` (admin id) and `sid` (session
  id). Permissions are deliberately **not** in the token: a role change must
  take effect immediately, not in fifteen minutes.
- **Refresh token** is opaque; only its SHA-256 (peppered) is stored.
  `POST /auth/refresh` rotates it in the same `UPDATE` that issues the new one,
  so a replayed token matches zero rows → the session is revoked as compromised.
- **Rotation does not change the session id.** An earlier version rotated it and
  killed every access token still in flight; the smoke test caught it. The JWT
  signature is the security boundary, so the session id is not a secret.
- **Revocation** is checked on every request (30 s in-process cache), so a
  suspended admin loses access within 30 seconds rather than at token expiry.
- **Lockout** after 5 failed attempts for 15 minutes; login is rate-limited per
  email *and* per IP, because limiting only one of those leaves the other open.

## Authorisation — deny wins

```
  (permissions from any assigned role)
∪ (direct grants where effect='allow' and not expired)
∖ (direct grants where effect='deny')
```

`is_super_admin = 1` short-circuits to everything. A per-user `deny` beats a
role `allow`, which is how you take `orders.refund` off one support agent
without inventing a seventh role. Resolution is cached 60 s and busted
explicitly when roles change.

Six seeded roles (Founder, Content, Operations, Support, Growth, Developer) over
50 permissions. Only a super admin can create another super admin, and the last
active one cannot be deleted, demoted or suspended.

---

## Media — local now, S3 later, without a refactor

A file's address is always two columns, never a stored URL:

```
media.disk         'local'
media.storage_key  'media/2026/09/{uuid}/original.jpg'
```

The public URL is composed at read time from `disk` + `storage_key`. Switching
to S3 is a copy job plus `UPDATE media SET disk='s3'` — no product HTML to
rewrite, no broken `<img>` tags.

`StorageDriver` is the seam:

```ts
interface StorageDriver {
  put(key, body, contentType): Promise<void>;
  get(key): Promise<Buffer>;
  delete(key): Promise<void>;
  exists(key): Promise<boolean>;
  publicUrl(key): string;
}
```

`LocalDiskDriver` is the only implementation today; it refuses any key that
resolves outside the storage root (the smoke test fires a traversal attempt at
it). Adding `S3Driver` is a new file and a config change — no call site moves.

Upload pipeline per file: sha256 → **dedupe against `media.checksum_sha256`** →
sharp metadata → dominant colour + 20px base64 LQIP → write original → respond.
Variants (webp + avif at 160/400/800/1200/1800) generate **after** the response,
with `status` going `processing → ready`, so uploading twelve 2000×2500 pack
shots doesn't hold the request open for forty seconds.

Files are served by a route, not `express.static`, so the path is validated, an
unknown key 404s cleanly, and the cache header is ours (`immutable` — storage
keys embed a UUID, so a key's bytes never change).

Media still attached to something cannot be deleted (`409 IN_USE`);
`usage_count` is maintained on attach/detach.

---

## Products

One `POST /products` writes the whole graph in a single transaction: product,
options, option values, variants, variant↔option links, initial inventory plus
its ledger movement, image attachments, benefits, usage steps, skin types,
concerns, ingredients, tags, SEO row — and the audit entry. Any failure rolls
back all of it.

```jsonc
POST /admin/api/v1/products
{
  "product": {
    "name": "Rhodo Cica 5D Bright Serum",
    "category_id": 1,
    "status": "draft",
    "short_description": "…",
    "full_inci": "Aqua, Niacinamide (10%), …",
    "options": [{ "name": "Size", "values": ["30ml", "50ml"] }],
    "variants": [
      { "sku": "VEY-SER-30", "mrp": 799, "price": 699,
        "inventory_quantity": 120, "option_values": ["30ml"], "is_default": true },
      { "sku": "VEY-SER-50", "mrp": 1199, "price": 1049,
        "inventory_quantity": 40, "option_values": ["50ml"] }
    ],
    "images": [{ "media_id": 12, "alt": "Front of pack", "is_primary": true }],
    "benefits": [{ "benefit": "Visibly reduces dark spots in 28 days" }],
    "usage_steps": [{ "instruction": "Apply to clean, dry skin.", "amount": "3-4 drops" }],
    "tags": ["brightening", "niacinamide"],
    "seo": { "meta_title": "…", "meta_description": "…" }
  }
}
```

Notable behaviour:

- **Publish is gated.** `POST /products/:id/publish` refuses with a 422 listing
  what's missing unless there's an active variant, a short description, the full
  INCI, and a manufacturer or marketer name — the declarations the BRD makes a
  launch requirement. Draft stays permissive so work in progress can be saved.
- **Derived fields are recomputed, never trusted from input**: `min_price`,
  `max_price` and `in_stock` come from the variants and the inventory ledger.
- **Discounts are honest.** A variant's `discount_active` is true only inside its
  `sale_starts_at`/`sale_ends_at` window, so the storefront cannot show a
  permanent strike-through against a fictional MRP.
- **Child collections are replace-on-write.** Sending `benefits` replaces the
  list; omitting it leaves the rows alone. Predictable PATCH semantics without a
  per-item diff protocol.
- **References are checked before the FK fires**, so an unknown `concern_id` is a
  readable 422, not a MySQL error.
- **Bulk publish is per-item**: products failing the gate come back in `skipped`
  with a reason rather than failing the whole batch.
- **Duplicate** copies the graph into a new draft, suffixes SKUs, and starts at
  zero stock.

Automatic collections compile their rules into a **parameterised** WHERE
fragment. Both field and operator are looked up in fixed maps; the only thing
reaching SQL from the request is a bound `?`. A feature whose entire purpose is
"let admins write query conditions" is otherwise an injection hole — the smoke
test fires `name); DROP TABLE products; --` at it and gets a 422.

---

## Endpoints

```
AUTH        POST   /auth/login | /auth/refresh | /auth/logout
            GET    /auth/me | /auth/sessions
            POST   /auth/change-password
            DELETE /auth/sessions/:id

ADMINS      GET    /admin-users              list, filter, search
            POST   /admin-users              create (active or invited)
            GET    /admin-users/:id
            PATCH  /admin-users/:id
            DELETE /admin-users/:id
            POST   /admin-users/:id/roles | /suspend | /activate | /reset-password
            GET    /admin-users/:id/permissions

ROLES       GET    /roles · POST /roles · PATCH|DELETE /roles/:id
            GET    /permissions             grouped by module

MEDIA       POST   /media                   multipart, ≤20 files
            GET    /media · GET /media/:id · PATCH /media/:id · DELETE /media/:id
            GET|POST /media/folders

CATEGORIES  GET    /categories?tree=true
            POST   /categories · PATCH|DELETE /categories/:id · POST /categories/reorder

COLLECTIONS GET|POST /collections · GET|PATCH|DELETE /collections/:id
            POST   /collections/:id/recalculate
            POST   /collections/:id/products · DELETE /collections/:id/products/:pid
            POST   /collections/:id/reorder

PRODUCTS    GET    /products                status, category, collection, concern,
                                            skin_type, tag, q, in_stock, sort, page
            POST   /products · GET|PATCH|DELETE /products/:id
            POST   /products/:id/publish | /unpublish | /archive | /duplicate
            POST   /products/bulk
            GET|POST /products/:id/variants
            PATCH|DELETE /products/:id/variants/:variantId
            POST   /products/:id/images
            PATCH  /products/:id/images/reorder
            DELETE /products/:id/images/:mediaId
            GET|PUT /products/:id/discounts   attach/detach from the product side

DISCOUNTS   GET    /discounts               q, state, discount_type, sort, page
            POST   /discounts · GET|PATCH|DELETE /discounts/:id
            GET    /discounts/options       active only — feeds the dropdown
            PUT    /discounts/:id/products  set the covered products

ORDERS      GET    /orders                  q, order_status, payment_status,
                                            fulfillment_status, payment_method,
                                            customer_id, placed_from/to, unfulfilled
            GET    /orders/counts           per-status totals for list tabs
            GET    /orders/:id              items, addresses, payments, refunds,
                                            shipments and the full timeline
            PATCH  /orders/:id/note         internal note
            POST   /orders/:id/status       {status, note, notify_customer}
            POST   /orders/:id/ship         whole order, or per-line quantities
            POST   /orders/:id/cancel       {reason, restock}
            POST   /orders/:id/refund       {amount?, reason, restock}

CUSTOMERS   GET    /customers               q, status, cod_blocked, marketing,
                                            has_orders, sort, page
            GET|PATCH /customers/:id
            POST   /customers/:id/block | /unblock
            GET|POST /customers/:id/notes · DELETE /customers/:id/notes/:noteId
            DELETE /customers/:id           soft delete

NAVIGATION  GET    /menu-navigation         the sidebar, scoped to the caller
            GET    /menu-items              super admin — every row, incl. hidden
            PATCH  /menu-items/:id          rename, re-icon, re-permission, hide
            POST   /menu-items/reorder
```

---

## Navigation — the sidebar is data, not code

`GET /menu-navigation` returns the menu **already filtered for the caller**, so
the frontend never decides what a role may see:

```json
{
  "sections": [
    { "section": "Commerce", "items": [
      { "id": 4, "key": "products", "title": "Products", "icon": "products",
        "route": "/products", "active_match": ["/products", "/categories"],
        "badge": { "key": "inventory.low", "count": 3, "variant": "warning" },
        "status": "available", "children": [ … ] }
    ]}
  ],
  "flat": [ { "key": "products", "route": "/products", "status": "available" } ],
  "generated_at": "2026-09-05T12:00:00.000Z"
}
```

Three rules decide visibility, evaluated per row:

1. `requires_super_admin = 1` → super admins only.
2. No rows in `menu_item_permissions` → visible to every signed-in admin.
3. Otherwise the admin must hold **any one** of the linked permission slugs.

Group headers whose children all fail are pruned; a child whose parent was
pruned is promoted to top level rather than disappearing.

`icon` is a **logical name** (`products`, `orders`, `discounts`), mapped to a
component in the frontend. The database never stores a component name or an
import path, so re-theming the icon set is a frontend-only change.

`status` separates *listed* from *reachable*: `available` renders a link,
`coming_soon` renders greyed out with a "Soon" chip, `hidden` is never returned.
The frontend keeps its own registry of route keys it can render, and degrades an
`available` row it has no screen for to disabled — so flipping a row in the
database can never produce a 404.

> Hiding a menu item is presentation only. It does not protect the endpoint
> behind it — `requirePermission` does that, independently.

Badge counts are computed only for the badge keys actually present in the
caller's menu: one small `COUNT(*)` per badge, skipped entirely for rows the
caller cannot see.

---

## Discounts

Discounts are the existing `coupons` tables with an admin surface, not a new
model: `coupons`, `coupon_products`, `coupon_categories`, `coupon_collections`,
`coupon_redemptions`. A discount reaches a product four ways, and the API tags
which one:

| `source`       | meaning                                  | editable from the product form |
|----------------|------------------------------------------|--------------------------------|
| `product`      | row in `coupon_products`                 | yes                            |
| `collection`   | the product is in a covered collection   | no                             |
| `category`     | the product's category is covered        | no                             |
| `all_products` | `applies_to = 'all'`                     | no                             |

`state` is derived on read, never stored — `disabled`, `scheduled`, `expired`,
`exhausted`, `active` — so a discount cannot drift out of sync with the clock.

Both doors write the same rows: `PUT /discounts/:id/products` from the Discounts
page and `PUT /products/:id/discounts` from the product form. Attaching a
product to a discount whose `applies_to` is still `all` narrows it to
`products`, which is the only way that flag could otherwise become a lie.

---

## Orders — a state machine, not a status column

`order_status` moves along a graph declared once, in `orders.service.ts`:

```
pending          → confirmed, cancelled
confirmed        → processing, packed, cancelled
processing       → packed, cancelled
packed           → shipped, cancelled
shipped          → out_for_delivery, delivered, rto
out_for_delivery → delivered, rto
delivered        → returned
cancelled | returned | rto → (terminal)
```

An illegal move returns **409 `INVALID_TRANSITION`** with the list of what is
actually allowed. Every order response carries `next_statuses`, so a client
renders the right buttons instead of guessing and catching the error.

Nothing leads back out of `delivered`, `cancelled`, `returned` or `rto`. A
mistake there is corrected with a refund or a return — both of which leave their
own record — not by editing the status back to something convenient.

### What each transition also does

| Transition | Side effects |
|---|---|
| → `confirmed` / `packed` / `shipped` | stamps the matching timestamp |
| → `delivered` | marks shipments delivered; for **COD**, collects the money: `payment_status = cod_collected`, `amount_paid = grand_total`, `amount_due = 0` |
| → `cancelled` | restocks (see below), clears a pending COD balance, records reason and actor |
| ship | creates a `shipments` row + `shipment_items`, raises `fulfilled_quantity`, then re-reads the items to decide `fulfilled` vs `partially_fulfilled` |
| refund | writes a **pending** refund row, updates `amount_refunded` and `payment_status` |

Every one of them writes an `order_status_history` row (with
`is_customer_visible`, so the storefront timeline can be a filtered view of the
same table) **and** an `audit_logs` row, in the same transaction as the change.

### Stock comes back exactly once

Cancelling restocks only when the order had actually taken stock — the statuses
in `STOCK_COMMITTED`. Cancelling a `pending` order that never reserved anything
must not invent inventory. Each restock writes an `inventory_movements` row
(`movement_type = 'cancellation'` or `'return_restock'`) carrying the order id
and the reason, so a puzzling stock level can always be traced back.

`inventory_items.quantity_available` is a generated column
(`on_hand − reserved`), so only `quantity_on_hand` is ever written.

### Refunds do not move money

`POST /orders/:id/refund` writes a refund row with status **`pending`** and
updates the order's refunded total. It does **not** call Razorpay — that call
belongs with the payment integration and its webhook, which flips the row to
`processed`. Recording it as processed here would tell a customer their money is
back before it has moved.

The arithmetic is guarded: a refund cannot exceed `amount_paid − already
refunded`, an order with nothing paid refuses outright, and every order's
`totals.refundable` says exactly what is left. Ship and refund both accept an
`Idempotency-Key`, so a double-clicked button cannot produce two AWBs or pay
twice.

---

## Customers

`GET /customers` **masks** phone numbers and emails; `GET /customers/:id` does
not. A staff member scanning a list does not need every number in full, and an
admin screen is exactly the sort of place a screenshot leaks from — the detail
view is one deliberate click.

Search matches a partial phone, because customers read out the last four digits
far more often than a full number.

`orders_count`, `total_spent`, `average_order_value`, `last_order_at` and
`rto_count` are denormalised onto the row so the list can sort by spend without
joining every order — and every order write that could change them calls
`refreshStats`, because a cache nothing refreshes is a lie with an index on it.

Blocking is an action, not a field: it revokes the customer's sessions as a side
effect, which would be invisible as a PATCH. Deletion is **soft only** — a hard
delete would orphan orders and break the invoice trail GST rules require you to
keep.

---

## Audit trail

Every mutation writes to `audit_logs` **inside the same transaction** as the
change it describes — an audit log that can disagree with reality is worse than
none. Rows carry actor, action, entity, a `{field: {from, to}}` diff, IP, user
agent and the `X-Request-Id`, so a line in the trail ties back to the exact HTTP
call.

---

## Before production

1. Set a real `JWT_SECRET` and `TOKEN_PEPPER` (64 random bytes each). The app
   refuses to start in production without `JWT_SECRET`.
2. Change `SUPERADMIN_PASSWORD`; the seed script refuses the default in prod.
3. Put the media root on a mounted volume, or implement `S3Driver` and flip
   `STORAGE_DRIVER`.
4. Move the idempotency cache out of process if you run more than one node
   (Redis, or a small `idempotency_keys` table) — the interface doesn't change.
5. Schedule the housekeeping jobs: `purgeExpiredRateLimits`, expired-session
   sweep, orphan-media sweep (`usage_count = 0` for 30+ days), automatic
   collection recalculation.
6. Wire TOTP verification — the schema, the login response shape and the
   `mfa_satisfied_at` column are already in place.

## Not in this phase

**Returns** (`return_requests` / `return_items` are schema-ready), the Razorpay
call behind a refund, shipment webhooks from the courier, and manual order
creation. Reviews and support are still schema-only.
