# Veylor Admin — Frontend

React 19 · TypeScript · MUI v9 · Vite 8 · React Router 7 · TanStack Query 5.

**Verified:** typechecks under `tsc -b`, builds (209 KB gzipped), and passes a
**16-assertion headless click-through** against the live API — sign in, open the
picker, upload through it, select, create a product, publish, and confirm the
thumbnail renders in the list. Zero console errors on the happy path.

---

## Running it

```bash
npm install          # adds react-router-dom + @tanstack/react-query
npm run dev          # http://localhost:5173
```

The API must be running on port 4000 (`npm run dev` in `veylog-backend`).

**You do not need to touch `CORS_ORIGINS` in the backend.** Vite proxies
`/admin/api`, `/media` and `/health` to `127.0.0.1:4000`, so the browser only
ever sees one origin. The proxy also strips the `Origin` header — Chrome
attaches one to every POST, including same-origin ones, and the API's CORS check
would otherwise reject it before the request reached a route. That cost me a
debugging round; it's now handled in `vite.config.ts`.

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server with the API proxy |
| `npm run build` | Typecheck + production build |
| `npm run typecheck` | `tsc -b --noEmit` |
| `npm run smoke` | Headless UI test (needs `npm run dev` running in another shell) |

---

## The media picker

`MediaPicker` is the piece you asked for, modelled on Shopify's.

```tsx
<MediaPicker
  open={open}
  onClose={() => setOpen(false)}
  onSelect={(media) => { /* Media[] */ }}
  multiple
  maxSelection={20}
  initialSelectedIds={[12, 44]}   // pre-ticks what's already attached
  title="Add product images"
  confirmLabel="Add"
/>
```

**Two tabs, because they're two different jobs.** "Find the pack shot I uploaded
last week" and "put this new photo in" don't belong on one screen. Uploading
auto-selects the result and drops you back into Library, so both routes end in
the same place.

**Library tab** — debounced search over filename and alt text, folder and type
filters, paginated grid, and a details panel on the right.

**Upload tab** — drag-and-drop or browse, with real progress. Progress comes
from `XMLHttpRequest`, not `fetch`, because fetch still has no upload-progress
event and a dead spinner while 20 MB of pack shots crawl over hotel wifi reads
as broken rather than slow.

**Selection** — checkboxes stay hidden until a tile is hovered or selected.
Visible checkboxes on every tile make a wall of product shots read as a form
instead of a gallery. Selection survives pagination; it resets per *opening*
rather than per mount, so last time's picks never leak into a different product.

**Alt text is edited in the dialog**, at the moment someone is choosing the
image. That's the only point it reliably gets written — nobody comes back to a
media library later to fix accessibility. Tiles without alt text carry a visible
amber flag.

**Processing state is honest.** The API generates renditions *after* the upload
response, so a fresh tile arrives as `processing`. The grid polls at 1.5 s while
anything is in flight and stops the moment nothing is — an idle library doesn't
sit there refetching.

### `ProductMediaCard` — the other half

The form-side counterpart: a thumbnail grid you reorder by dragging, where
position 0 *is* the featured image (one concept, not two that can disagree).
Hover reveals "make featured" and "remove". Reorder uses native HTML5 drag
events rather than pulling in a drag library.

---

## Structure

```
src/
├── api/
│   ├── client.ts        fetch wrapper, token store, refresh, XHR upload
│   └── types.ts         API response shapes
├── auth/
│   ├── AuthProvider.tsx session state, login/logout, permissions
│   ├── useAuth.ts
│   └── RequireAuth.tsx  route guard
├── components/
│   ├── AppLayout.tsx    sidebar + topbar, permission-filtered nav
│   └── PageHeader.tsx
├── features/
│   ├── auth/            LoginPage
│   ├── media/           MediaPicker, MediaThumb, MediaUploadZone,
│   │                    MediaDetailsPanel, MediaLibraryPage, useMedia
│   ├── products/        list, form, ProductMediaCard, VariantsCard, useProducts
│   ├── categories/      CategoriesPage
│   ├── collections/     CollectionsPage
│   └── staff/           StaffPage
├── lib/                 format helpers, media URL/srcset helpers
├── theme.ts             Veylor tokens from the BRD
├── App.tsx              routes
└── main.tsx             providers
```

## Details worth knowing

**Token refresh is deduplicated.** If six queries 401 at once, one refresh runs
and all six await it. Without that, five would replay an already-rotated refresh
token — which the backend correctly treats as theft and kills the whole session.

**Permissions come from `/auth/me`, not the JWT.** A role change takes effect on
the next page load rather than in fifteen minutes. The sidebar only renders what
the account can reach; a nav item that 403s on click is worse than one that
isn't there.

**Errors map to the API contract.** `ApiError.fieldErrors()` turns the 422
`details` object into per-field messages. The publish gate's 422 is rendered
verbatim — when the server says "cannot publish without the full INCI list",
that's more useful than anything the UI could invent.

**Creates carry an `Idempotency-Key`.** A slow save plus an impatient second
click can't produce two products.

**Bulk publish shows what was skipped.** The server publishes per-item and
returns the failures; the list surfaces them rather than silently doing less
than you asked.

**Images use the rendition the API actually generated.** `thumbUrl()` picks the
smallest variant that covers the rendered size and falls back to the original if
variants are still processing — the browser is never sent a URL that 404s. The
base64 LQIP paints as a background so a scrolling grid doesn't flash white, and
the focal point drives `object-position` so a square crop doesn't decapitate the
bottle.

---

## Two things to tidy up

**1. You have two MUI style engines installed.** `@emotion/react` +
`@emotion/styled` *and* `styled-components` + `@mui/styled-engine-sc` +
`react-is`. That's from following both branches of the MUI install page. Nothing
aliases `@mui/styled-engine` in `vite.config.ts`, so MUI is using **emotion**
and the styled-components trio is dead weight in your bundle:

```bash
npm uninstall styled-components @mui/styled-engine-sc react-is
```

Only do the opposite (keep styled-components, drop emotion, add the alias) if
you specifically want styled-components elsewhere in the app.

**2. Scaffold leftovers.** `src/App.css` and `src/assets/` are no longer
imported by anything and can go.

## Not built yet

Editing collections (the page is read-only plus recalculate), creating and
editing staff accounts, the role/permission matrix, and product options/variant
combinations beyond the flat variant table. Each follows the same shape: a
`features/<thing>/` folder with a hooks file and its pages.
