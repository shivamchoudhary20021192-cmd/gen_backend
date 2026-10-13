# Veylog Admin API — Architecture

Node 22 · TypeScript · Express 4 · MySQL 8 (`mysql2/promise`) · no ORM.

---

## 1. The pattern: layered architecture with a repository boundary

Every request travels the same five layers, and each layer is only allowed to
know about the one directly beneath it.

```
HTTP request
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ ROUTE            path + verb, wires middleware in order      │
│                  src/modules/<x>/<x>.routes.ts               │
└─────────────────────────────────────────────────────────────┘
    │  requestId → rateLimit → authenticate → requirePermission → validate
    ▼
┌─────────────────────────────────────────────────────────────┐
│ CONTROLLER       HTTP only. Reads req, calls one service     │
│                  method, shapes the response envelope.       │
│                  Zero business logic. Zero SQL.              │
└─────────────────────────────────────────────────────────────┘
    ▼
┌─────────────────────────────────────────────────────────────┐
│ SERVICE          Business rules, invariants, orchestration,  │
│                  transaction boundaries, audit writes.       │
│                  Throws ApiError. Knows nothing about HTTP.  │
└─────────────────────────────────────────────────────────────┘
    ▼
┌─────────────────────────────────────────────────────────────┐
│ REPOSITORY       Parameterised SQL and row→entity mapping.   │
│                  One repository per aggregate. No business   │
│                  rules, no throwing of HTTP-shaped errors.   │
└─────────────────────────────────────────────────────────────┘
    ▼
              mysql2 connection pool
```

**Why this and not an ORM.** The schema has generated columns
(`inventory_items.quantity_available`), polymorphic tables with no foreign keys
(`media_attachments`, `metafields`, `seo_meta`), and joins that decide money.
An ORM hides those behind conventions and silently produces N+1 queries on
exactly the endpoint that matters most — the product list. Repositories keep the
SQL visible, reviewable and indexable, while still giving the service layer a
clean object to work with.

### The rules that make it hold

1. **Controllers never touch `db`.** If a controller imports the pool, the
   boundary has leaked.
2. **Repositories never throw `ApiError`.** They return `null` or `[]`. Deciding
   that a missing product is a 404 is a service decision.
3. **Every repository method takes an optional `Executor`** — either the pool or
   an open transaction connection. That is how a service composes eight writes
   into one atomic unit without repositories knowing transactions exist.
4. **Services are the only place a transaction begins.**
5. **Nothing below the controller reads `req` or writes `res`.**

### Transactions — the unit of work

```ts
await withTransaction(async (tx) => {
  const productId = await productRepo.insert(data, tx);
  await optionRepo.insertMany(productId, options, tx);
  await variantRepo.insertMany(productId, variants, tx);
  await inventoryRepo.initialise(variantIds, tx);
  await auditRepo.log({ action: 'product.created', ... }, tx);
  return productId;
});
```

The audit row is written **inside** the transaction. If the product write rolls
back, so does the claim that it happened.

---

## 2. Shopify Admin API conventions, and where we follow them

| Shopify convention | Here | Note |
|---|---|---|
| `/admin/api/<version>/<resource>` | `/admin/api/v1/products` | Version in the path so v2 can ship alongside |
| Singular envelope on write | `{ "product": { … } }` in and out | Body and response both wrapped |
| Plural envelope on read | `{ "products": [ … ] }` | Plus a `pagination` object |
| Nested sub-resources | `/products/:id/variants/:variantId` | Variants, images, metafields |
| Action endpoints as POST | `POST /products/:id/publish` | State transitions are not PATCHes |
| `?fields=` sparse fieldsets | supported on show + list | Cheaper product-list payloads |
| `?limit=` + cursor pagination | `page_info` cursor **and** `page`/`limit` | Cursor is stable under writes; offset is what an admin table needs |
| `X-Request-Id` | echoed on every response | Correlates the audit log to the request |
| `Idempotency-Key` | honoured on POST | Prevents a double-click creating two products |
| 422 on validation | `422` with a per-field `errors` object | Shopify returns `{errors:{title:["can't be blank"]}}` |

Where we deliberately diverge: Shopify's `variants[].option1/option2/option3`
positional columns are replaced by a real `options` / `option_values` /
`variant_option_values` model, because three fixed columns is a limitation, not
a design.

---

## 3. Response contract

**Success — single resource**

```json
{ "product": { "id": 12, "slug": "rhodo-cica-5d-bright-serum", "...": "..." } }
```

**Success — collection**

```json
{
  "products": [ … ],
  "pagination": { "total": 218, "page": 1, "limit": 50, "pages": 5, "next_page_info": "eyJpZCI6NTB9" }
}
```

**Error — always this shape, at every status code**

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The request body is invalid.",
    "request_id": "0f8b…",
    "details": { "slug": ["Slug is already taken"] }
  }
}
```

| Status | `code` examples | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST`, `MALFORMED_JSON` | Client sent nonsense |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `SESSION_REVOKED` | No / bad / killed credentials |
| 403 | `FORBIDDEN`, `MFA_REQUIRED` | Authenticated but not permitted |
| 404 | `NOT_FOUND` | Resource absent or soft-deleted |
| 409 | `CONFLICT`, `SLUG_TAKEN`, `SKU_TAKEN` | Uniqueness or state conflict |
| 422 | `VALIDATION_FAILED` | Shape is right, values are wrong |
| 429 | `RATE_LIMITED` | With `Retry-After` |
| 500 | `INTERNAL_ERROR` | Never leaks a stack or a SQL string |

`ApiError` is the only error a service throws. The global error handler
translates a MySQL `ER_DUP_ENTRY` into a 409 and anything unrecognised into a
500 with the stack logged, never returned.

---

## 4. Authentication

Two token types, deliberately asymmetric.

```
POST /auth/login  { email, password }
        │
        ├─ bcrypt.compare, constant-time
        ├─ locked_until / status check
        ├─ create admin_sessions row
        │     session_token_hash = sha256(sid)         ← sid is random, goes in the JWT
        │     refresh_token_hash = sha256(refreshToken) ← returned once, never stored raw
        ▼
   { access_token (15 min JWT), refresh_token (30 d opaque), admin, permissions }
```

- **Access token** — a short-lived JWT carrying `sub` (admin id), `sid` (session
  id) and nothing else authorisation-related. Permissions are **not** in the
  token: a role change must take effect immediately, not in fifteen minutes.
- **Refresh token** — an opaque 48-byte random string. Only its SHA-256 lives in
  the database. `POST /auth/refresh` **rotates it**: the old hash is overwritten
  in the same statement that issues the new one, so a replayed refresh token
  finds nothing and the session is revoked.
- **Revocation** — every authenticated request checks `admin_sessions.revoked_at`
  and `expires_at`. That lookup is cached in-process for 30 seconds, so a
  revoked session dies within 30 s rather than at token expiry.
- **Lockout** — 5 failed attempts sets `locked_until = now + 15 min`.
- **MFA** — the schema and the login response support it
  (`{ mfa_required: true, mfa_token }`); the TOTP verification step is stubbed
  behind a flag for phase 2.

---

## 5. Authorisation — deny wins

Permission for an admin is resolved as:

```
   ( permissions granted by any of their roles )
 ∪ ( direct grants where effect = 'allow' and not expired )
 ∖ ( direct grants where effect = 'deny' )
```

`is_super_admin = 1` short-circuits to "everything". A per-user `deny` beats a
role `allow`, which is how you remove `orders.refund` from one support agent
without inventing a seventh role.

Routes declare what they need:

```ts
router.post('/', authenticate, requirePermission('products.create'), validate(createProductSchema), ctrl.create);
```

Resolution is cached per admin for 60 seconds and busted explicitly when roles
change.

---

## 6. Media — a driver interface, not a hardcoded folder

```ts
interface StorageDriver {
  readonly name: 'local' | 's3';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  publicUrl(key: string): string;
}
```

`LocalDiskDriver` is the only implementation today. Adding `S3Driver` later is a
new file plus a config change — no call site moves, because nothing above the
driver ever builds a path or a URL by hand.

Upload pipeline, per file:

```
multer memory buffer
   → sha256  → already in `media`? return the existing row (dedupe)
   → sharp metadata (width, height, alpha)
   → dominant colour + 20px blur placeholder
   → driver.put(original)
   → for each width × format: sharp resize → driver.put → media_variants row
   → media.status = 'ready'
```

Variant generation runs **after** the response in a fire-and-forget task, with
`media.status` going `processing → ready`, so an admin uploading twelve
2000×2500 pack shots is not staring at a spinner for forty seconds.

---

## 7. Folder layout

```
src/
├── config/env.ts               typed, validated environment
├── db/
│   ├── pool.ts                 mysql2 pool + Executor type
│   └── transaction.ts          withTransaction()
├── core/
│   ├── ApiError.ts             the only thrown error type
│   ├── asyncHandler.ts         async route wrapper
│   ├── logger.ts               structured JSON logging
│   ├── pagination.ts           limit/page/cursor parsing
│   └── slug.ts                 slugify + uniqueness helper
├── middleware/
│   ├── requestContext.ts       X-Request-Id, request-scoped store
│   ├── authenticate.ts         JWT → req.admin
│   ├── requirePermission.ts    RBAC gate
│   ├── validate.ts             Zod → 422
│   ├── idempotency.ts          Idempotency-Key replay guard
│   ├── rateLimit.ts            durable, backed by `rate_limits`
│   ├── upload.ts               multer memory storage
│   └── errorHandler.ts         the single exit for every failure
├── modules/
│   └── <resource>/
│       ├── <resource>.routes.ts
│       ├── <resource>.controller.ts
│       ├── <resource>.service.ts
│       ├── <resource>.repository.ts
│       ├── <resource>.schemas.ts     Zod
│       └── <resource>.types.ts
├── shared/
│   ├── audit.service.ts
│   └── utils/
├── app.ts                      express wiring
└── server.ts                   process lifecycle, graceful shutdown
```

A module is a vertical slice. Adding "orders" means adding one folder and one
line in `app.ts` — nothing else changes.

---

## 8. Endpoint map (this phase)

```
AUTH
  POST   /admin/api/v1/auth/login
  POST   /admin/api/v1/auth/refresh
  POST   /admin/api/v1/auth/logout
  GET    /admin/api/v1/auth/me
  POST   /admin/api/v1/auth/change-password
  GET    /admin/api/v1/auth/sessions
  DELETE /admin/api/v1/auth/sessions/:id

ADMIN USERS                                    requires admins.*
  GET    /admin-users            list, filter by role/status, search
  POST   /admin-users            create (invited or active)
  GET    /admin-users/:id
  PATCH  /admin-users/:id
  DELETE /admin-users/:id        soft delete
  POST   /admin-users/:id/roles  replace role set
  POST   /admin-users/:id/suspend | /activate | /reset-password
  GET    /admin-users/:id/permissions   resolved, with source

ROLES
  GET    /roles                  with permission counts
  POST   /roles
  PATCH  /roles/:id
  DELETE /roles/:id              blocked for is_system
  GET    /permissions            grouped by module

MEDIA
  POST   /media                  multipart, up to 20 files
  GET    /media                  filter by folder/type/status, search
  GET    /media/:id              with variants
  PATCH  /media/:id              alt, title, folder, focal point
  DELETE /media/:id              refuses while usage_count > 0
  GET    /media/folders
  POST   /media/folders

CATEGORIES
  GET    /categories             ?tree=true for nested
  POST   /categories
  GET    /categories/:id
  PATCH  /categories/:id
  DELETE /categories/:id
  POST   /categories/reorder

COLLECTIONS
  GET    /collections
  POST   /collections            manual or automatic (with rules)
  GET    /collections/:id
  PATCH  /collections/:id
  DELETE /collections/:id
  POST   /collections/:id/products         add
  DELETE /collections/:id/products/:pid    remove
  POST   /collections/:id/reorder
  POST   /collections/:id/recalculate      re-run automatic rules

PRODUCTS
  GET    /products               status, category, collection, q, tags, sort, paginate
  POST   /products               product + options + variants + images + SEO, atomic
  GET    /products/:id           full graph
  PATCH  /products/:id
  DELETE /products/:id           soft
  POST   /products/:id/publish | /unpublish | /archive | /duplicate
  POST   /products/bulk          status / category / delete across many ids
  GET    /products/:id/variants
  POST   /products/:id/variants
  PATCH  /products/:id/variants/:variantId
  DELETE /products/:id/variants/:variantId
  POST   /products/:id/images    attach media, set position
  PATCH  /products/:id/images/reorder
  DELETE /products/:id/images/:mediaId
```

---

## 9. What is deliberately not here yet

Orders, customers, coupons, reviews and support are all schema-ready but not
implemented in this phase. Each is a new folder under `modules/` following the
same five-layer shape — the point of the pattern is that adding one does not
require touching anything already written.
