# Announcement bar

**Content → Announcement bar** in the admin: the strip above the storefront's
header. What the market's announcement bars do — Shopify's theme slideshow and
the apps merchants add on top of it (tickers, countdowns, free-shipping bars,
targeting) — in one place, drawn by the theme, cached with the page.

## What a merchant can set

**The bar** (`announcement_settings`, one row per shop)

| | |
|---|---|
| Motion | Rotating lines — fade, slide across, slide up, typewriter, or instant — moving on by themselves every N seconds or only with the arrows; or a **scrolling ticker** (marquee) with speed (px/s), direction and a separator |
| Size | **Same height for every line** (as tall as the longest; the page never jumps), **fixed height** (desktop and phone px; longer text clamped to 1–3 lines), or **fit each line** |
| Text | Size on desktop and on phones, weight, capitals, alignment |
| Colours | Background (optionally a gradient) and text, or the theme's colour scheme |
| Devices | The whole bar on desktop and phones, desktop only or phones only; previous/next arrows and the arrow after a link each on both, desktop only, phones only, or hidden |
| Closing | Whether shoppers can close it, and for how many days it stays closed (0: until the browser closes). A bar whose lines change shows again |
| Pause | Pause on hover; moving bars always get a pause button (WCAG 2.2.2) and stop for `prefers-reduced-motion` |

**Each line** (`announcements`)

| | |
|---|---|
| Kind | A message, or **free-shipping progress**: "Spend `{amount}` more for free delivery", recomputed from the cart as it changes, with a progress bar and a success message |
| Offer | A discount code (drawn as a chip to copy; the line disappears when the code stops being valid), a link with optional wording |
| Time | Start and end; a **countdown** to the end ("Ends in 2d 04:05:06"), after which the line leaves the rotation |
| Look | Its own background and text colours (the bar changes colour with it; in a ticker, a pill), with a contrast check |
| Who / where | Desktop only or phones only; which pages (home, product, collection, cart, search, pages, blog, articles, policies); guests or signed-in customers; the countries shoppers buy in |
| Results | Views and clicks per day, counted only with the shopper's analytics consent; the admin shows 30 days and click-through |

## How it fits together

```
admin (Content → Announcement bar)        storefront (Liquid)
  PATCH /content/announcements/settings      renderer: announcement_bar global
  POST/PATCH /content/announcements   ─────▶   = announcementsService.forStorefront(
                                                   template, signed in?, market country)
                                              sections/announcement-bar.liquid
                                                + snippets/announcement-line.liquid
                                              assets/theme.js  initAnnouncementBar()
                                              assets/base.css  .vl-ab…
                                              POST /announcements/track (views, clicks)
```

- **Server decides what, browser decides how.** Which lines a page gets —
  schedule, live codes, page type, guest or customer, country — is resolved on
  the server (`storefrontLines()`, a pure function). Devices, motion,
  countdowns, the free-shipping arithmetic and "closed" are the browser's,
  because the same cached page serves every device and every cart.
- **Cache-safe.** Page type is in the URL, market country and privacy class are
  in the page-cache key, signed-in customers bypass the cache. Every edit bumps
  the shop's content version, so the next page view has it; the lines and
  settings themselves are held per shop for 10 s (`ShopScopedCache`), cleared
  on this process at once. View and click counts (`announcement_stats`) are a
  neutral table: counting never invalidates a page.
- **No layout shift.** Heights are CSS: every line in one grid cell for "same
  height", a fixed box for "fixed". A closed bar is hidden by a two-line script
  right after it, before it is painted.
- **The theme owns the look.** The section reads `announcement_bar` and the
  admin's settings; the markup is plain server-rendered HTML with data
  attributes, so it works without JavaScript and in the theme editor. With
  **Lines: blocks in this section** (or no live lines in the admin) the section's
  own blocks are used, with the same styling.
- **Headless.** `GET /api/v1/content/announcements` still returns the old
  fields and adds the new ones (`settings`, and per line `kind`,
  `countdown_ends_at`, colours, `visibility`); lines targeted at particular
  pages, shoppers or countries are left out there, since that API cannot tell.

## For theme developers

```liquid
{%- for line in announcement_bar.lines -%}
  {{ line.message }} {{ line.href }} {{ line.code }} {{ line.countdown_ends_at }}
  {{ line.background }} {{ line.text_color }} {{ line.visibility }}
  {{ line.kind }} {{ line.threshold_cents | money }} {{ line.success_message }}
{%- endfor -%}
{{ announcement_bar.settings.display_mode }} {{ announcement_bar.version }}
```

Every setting is on `announcement_bar.settings` (the admin's names:
`transition`, `height_mode`, `arrows_visibility`, …). The theme script dispatches
`cart:updated` on `document` after every cart change.

## Schema

Migration `135_announcement_bar_advanced.sql`: the bar's settings columns, the
lines' `kind`, `success_message`, `free_shipping_threshold`, `show_countdown`,
colours, `visibility`, `show_on`, `audience`, `countries`; `message` grows to
255 characters; `announcement_stats (shop_id, announcement_id, day, views, clicks)`.
