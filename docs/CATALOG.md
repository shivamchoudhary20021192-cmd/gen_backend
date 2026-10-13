# Products (new) — the generic catalog

Products (classic) was drawn for a beauty store: INCI lists, skin types,
coverage, pH, period-after-opening — as columns on `products`. A shoe shop, a
bakery or an electronics store cannot use them, and every new kind of detail
meant a migration and a release. **Products (new)** is the generic model,
shaped like Shopify's, and runs **beside** the classic one until it can replace
it. Nothing in the classic tables or screens was removed.

## What a product is

| Table | Holds |
| --- | --- |
| `catalog_products` | title, description, summary, status (`draft` / `active` / `unlisted` / `archived`), vendor, product type, standard category, SEO, template suffix, gift-card flag, `version` (optimistic lock), `origin` (`native` / `classic`) |
| `catalog_product_options` | up to 3 options (Size, Colour…) with a display style (buttons, dropdown, swatches) and optionally a metaobject type behind their values |
| `catalog_option_values` | each option's values: a name, a swatch colour or image, or a metaobject entry |
| `catalog_variants` | every combination sold: SKU, barcode, price, compare-at, cost, tax, HSN, weight and dimensions with units, customs (origin, HS code), unit price ("₹120 / 100 ml"), inventory tracking and policy, image, max per order |
| `catalog_variant_options` | which value of each option a variant is |
| `catalog_product_media`, `catalog_product_tags` | gallery (ordered, per-product alt) and free tags |
| `product_taxonomy_categories` | a standard category tree shared by every shop (Shopify's top level; codes are paths and never change) |

**Custom data** is the merchant's own fields, typed as Shopify types them
(`src/modules/catalog/fieldTypes.ts`): single/multi-line and rich text (text
with `choices` is a dropdown), integer, decimal, date, date-time, weight,
volume, dimension, money, rating, colour, URL, link, JSON, true/false, and
references to products, variants, collections, pages, files and metaobject
entries — plus `list.<type>` for every type that repeats. Definitions
(`metafield_definitions`) carry the validations and the product types they
show for; values (`metafields`) are laid out across typed, indexed columns so
they can be filtered and kept unique. **Metaobjects** (`metaobject_definitions`,
`metaobjects`) are structured types of the merchant's own ("Ingredient",
"Size chart") whose entries fields and options point at.

## How a save works

`catalogService.save` takes the state the editor wants (Shopify's `productSet`)
and works out what changed:

* Options, values and variants keep their ids — matched by id, then by name or
  combination. Renaming "Red" to "Crimson" keeps the variant, its stock, orders
  and reviews.
* A variant no longer sent is retired (soft-deleted), never removed.
* A save names the `version` it edited; if someone saved in between, it is
  refused with `409 VERSION_CONFLICT`.
* Blank SKUs are filled in (`HANDLE-VALUE-VALUE`), description HTML is
  sanitised, and stock set in the editor is written as stock-take movements.
* Everything — product, variants, custom fields, stock, collections, the
  classic twin and the audit entry — commits in one transaction.

## Living beside the classic catalog: the projection

Storefront, Liquid, search, collections, cart, checkout, orders, inventory,
reviews, wishlists and price lists all read `products` and `product_variants`.
Rather than teach thirty readers a second catalog at once, every catalog
product keeps a **classic twin with the same ids** (`catalog/projection.ts`):

* During the transition the classic tables allocate ids (a new catalog row
  inserts its classic row first and takes that id), so the two never collide.
* Each save rewrites only the twin's `OWNED_*` columns from the catalog. The
  classic-only columns (beauty fields, ratings, sales counts) are left alone.
* The classic API and editor refuse to change a catalog product
  (`409 CATALOG_MANAGED`) and show it read-only with a link to Products (new).

## Moving classic products

`POST /catalog/classic/adopt` (the admin's "Move from classic") copies a classic
product into the catalog **keeping every id**, so orders, stock, reviews,
collections and custom-field values stay attached with no rows rewritten, then
runs the projection so both sides agree. Classic variants that differed only
by their title (no option rows) become the values of one option, "Variant",
which the merchant can rename. A product with more than three options, a
variant missing a value, or two identical combinations is refused with the
reason. Moving cannot be undone.

## API — `/admin/api/v1/catalog`

| | |
| --- | --- |
| `GET /products`, `POST /products`, `GET/PATCH/DELETE /products/:id` | list (status, search incl. SKU/barcode, vendor, type, tag, category, collection; cursor paging; status counts), create, read with the fields that apply, save, delete |
| `GET /products/new` | the fields and locations for an empty editor |
| `POST /products/:id/duplicate`, `PATCH /products/:id/variants`, `POST /products/bulk` | Shopify's duplicate; change some variants without resending the product; status/tags/vendor/type/category/delete for many |
| `GET /taxonomy`, `/suggestions`, `/field-types`, `/references/:kind` | lookups for the editor |
| `GET /classic`, `POST /classic/adopt` | classic products not yet moved; move them |
| `/definitions` (+ `PUT /definitions/pinned`) | custom fields — `custom_data.manage` to change |
| `/metaobject-definitions`, `/metaobjects/:type[/:id]` | metaobject types (`custom_data.manage`) and entries (`metaobjects.manage`) |

Permissions reuse `products.view|create|update|delete`; migration 136 adds
`custom_data.manage` (given to roles with `settings.manage`) and
`metaobjects.manage` (given to roles with `products.update`), and the admin
menu **Products (new)** with All products, Custom fields and Metaobjects.

## Cutover (later)

1. Move every classic product (the admin shows how many remain).
2. Point the readers (storefront drops, search, cart, orders…) at the catalog
   tables one at a time; the ids already match, so foreign keys move without
   rewriting rows.
3. Carry the beauty columns still wanted over as custom fields (a backfill per
   column into `metafields`).
4. Drop the projection, the classic editor and menu, then the classic tables.

## Checks

* `npm test` — `test/unit/catalog.test.ts` covers option/variant planning and
  field-value rules.
* `npm run smoke:catalog` (a running server, a scratch database) — creates
  fields, a metaobject type, a product with options; renames keeping ids;
  version conflicts; the classic twin and its refusal; duplicate and bulk;
  moving a classic product.
* Admin: `scripts/ui-smoke-catalog.mjs` drives the screens in a browser.
