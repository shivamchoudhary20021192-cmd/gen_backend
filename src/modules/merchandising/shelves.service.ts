import { ApiError } from '../../core/ApiError';
import { withTransaction } from '../../db/transaction';
import { cardsWithVariants } from '../storefront/storefront.service';
import { storefrontRepository } from '../storefront/storefront.repository';
import {
  FALLBACK_ORDER,
  SHELF_LAYOUTS,
  SHELF_PLACEMENTS,
  SHELF_RULES,
  isShelfSource,
  shelfSourceCatalogue,
} from './shelfRules';
import { shelvesRepository, type ShelfRow } from './shelves.repository';
import { ShopScopedCache } from '../../platform/cache/shopCache';

/**
 * Shelves: the rows of products on a storefront page.
 *
 * Resolving one is four steps, in this order, and the order is the design:
 *
 *   1. the pins          products the merchandiser put first, first
 *   2. the rule          whatever `shelfRules.ts` ranks, minus anything pinned
 *   3. the fallback      only when the rule came back short, and only when the
 *                        rule says a top-up would not be a lie
 *   4. the cards         one resolve through the storefront's own presenter, so
 *                        a shelf card is byte-identical to a listing card
 *
 * Step 3 is the one worth arguing about. A shop three weeks old has no repeat
 * purchases and a handful of wishlist saves, so "Most repurchased" renders
 * empty, the merchandiser concludes the feature is broken, and switches it off
 * for good. Topping up silently would be worse — so the shelf is topped up and
 * the admin preview says so, in words, on the screen where the decision is
 * made.
 */

/** How long a resolved shelf is reused before the rules are run again. */
const CACHE_TTL_MS = 3 * 60 * 1000;

/** Hard ceiling, whatever the row says. A shelf is an invitation, not a page. */
const MAX_PRODUCTS_CEILING = 24;


/**
 * A small in-process cache.
 *
 * Every shelf on the home page otherwise runs an aggregate over `order_items`
 * on every request, including the ones from bots. Three minutes is short
 * enough that a merchandiser who changes a shelf sees it before they finish
 * reading the page they went to check, and long enough to take the repeated
 * cost off the front page entirely. Cleared on any write so the admin's own
 * preview is never the stale one.
 *
 * It lives in the process because there is no shared cache here yet; with more
 * than one API instance each keeps its own, which for a three-minute TTL on
 * merchandising data is a difference nobody can see. It is partitioned by shop,
 * so one shop's shelves are never served to another and a write clears only
 * the shop that made it.
 */
const cache = new ShopScopedCache(CACHE_TTL_MS);

function cached<T>(key: string, produce: () => Promise<T>): Promise<T> {
  return cache.get(key, produce);
}

function clearCache(): void {
  cache.clear();
}

function windowFor(row: ShelfRow): number | null {
  const rule = SHELF_RULES[row.source];
  if (!rule?.window) return null;
  const chosen = row.window_days;
  if (chosen === null || chosen === undefined) return rule.window.default;
  return Math.min(Math.max(chosen, rule.window.min), rule.window.max);
}

/**
 * The products of one shelf, ranked, resolved and presented.
 *
 * Returns the cards plus a short account of how they were chosen, which the
 * admin preview shows and the storefront ignores.
 */
async function resolve(row: ShelfRow): Promise<{
  products: unknown[];
  from_rule: number;
  from_pins: number;
  from_fallback: number;
}> {
  const rule = SHELF_RULES[row.source];
  if (!rule) throw ApiError.badRequest(`Unknown shelf source "${row.source}".`);

  const limit = Math.min(row.max_products, MAX_PRODUCTS_CEILING);
  const inStockOnly = row.include_sold_out !== 1;

  // 1 · pins
  const pinRows = await shelvesRepository.publicPinIds(row.id);
  const ordered: number[] = [];
  const seen = new Set<number>();
  for (const pin of pinRows) {
    if (ordered.length >= limit) break;
    if (seen.has(pin.id)) continue;
    seen.add(pin.id);
    ordered.push(pin.id);
  }
  const fromPins = ordered.length;

  // 2 · the rule
  let fromRule = 0;
  if (row.source !== 'manual' && ordered.length < limit) {
    if (rule.needsCollection && !row.source_collection_id) {
      // Not an error: a half-built shelf should render as nothing, not as a
      // 500 on the front page.
      return { products: [], from_rule: 0, from_pins: fromPins, from_fallback: 0 };
    }
    const built = rule.build({
      windowDays: windowFor(row),
      // Asked for more than needed: some of what ranks highest may already be
      // pinned, and a second round-trip to make up the difference is worse
      // than a slightly wider LIMIT.
      limit: limit + ordered.length,
      inStockOnly,
      collectionId: row.source_collection_id,
    });
    const ranked = await shelvesRepository.rankedIds(built.sql, built.params);
    for (const candidate of ranked) {
      if (ordered.length >= limit) break;
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      ordered.push(candidate.id);
      fromRule += 1;
    }
  }

  // 3 · the fallback, only where the rule permits one
  let fromFallback = 0;
  if (row.source !== 'manual' && rule.fallback && ordered.length < limit) {
    const filler = await shelvesRepository.fillerIds(
      FALLBACK_ORDER[rule.fallback],
      limit - ordered.length,
      [...seen],
      inStockOnly,
    );
    for (const candidate of filler) {
      if (ordered.length >= limit) break;
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      ordered.push(candidate.id);
      fromFallback += 1;
    }
  }

  // 4 · the cards, in the ranked order
  const rows = await storefrontRepository.productsByIds(ordered);
  const byId = new Map(rows.map((product) => [product.id, product]));
  const inOrder = ordered.map((id) => byId.get(id)).filter((product) => product !== undefined);

  return {
    products: await cardsWithVariants(inOrder),
    from_rule: fromRule,
    from_pins: fromPins,
    from_fallback: fromFallback,
  };
}

/** The shape the storefront reads. */
function presentPublic(row: ShelfRow, products: unknown[]) {
  return {
    id: row.id,
    title: row.title,
    eyebrow: row.eyebrow,
    subtitle: row.subtitle,
    layout: row.layout,
    tone: row.tone,
    cta: row.cta_label ? { label: row.cta_label, href: hrefFor(row) } : null,
    products,
  };
}

/**
 * Where "View all" goes, as a path the storefront can follow.
 *
 * The same vocabulary the banners and the announcement lines use. A type whose
 * target needs a slug the shelf does not carry falls back to a listing
 * filtered by id, which is a real page rather than a dead link.
 */
function hrefFor(row: ShelfRow): string | null {
  switch (row.link_type) {
    case 'url':
      return row.link_url;
    case 'product':
      return row.link_ref_id ? `/shop?product=${row.link_ref_id}` : null;
    case 'category':
      return row.link_ref_id ? `/shop?category_id=${row.link_ref_id}` : null;
    case 'collection':
      return row.link_ref_id ? `/shop?collection_id=${row.link_ref_id}` : null;
    case 'article':
      return '/journal';
    case 'page':
    case 'policy':
      return row.link_url ?? null;
    default:
      return null;
  }
}

/** The shape the admin list reads: everything, plus why it is or is not live. */
function presentAdmin(row: ShelfRow) {
  return {
    id: row.id,
    title: row.title,
    eyebrow: row.eyebrow,
    subtitle: row.subtitle,
    placement: row.placement,
    scope_ref_id: row.scope_ref_id,
    layout: row.layout,
    source: row.source,
    source_label: SHELF_RULES[row.source]?.label ?? row.source,
    source_collection_id: row.source_collection_id,
    source_collection_title: row.collection_title,
    window_days: row.window_days,
    effective_window_days: windowFor(row),
    max_products: row.max_products,
    include_sold_out: row.include_sold_out === 1,
    tone: row.tone,
    cta_label: row.cta_label,
    link_type: row.link_type,
    link_url: row.link_url,
    link_ref_id: row.link_ref_id,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    is_active: row.is_active === 1,
    sort_order: row.sort_order,
    pin_count: Number(row.pin_count ?? 0),
    hidden_because: hiddenBecause(row),
    updated_at: row.updated_at,
  };
}

/**
 * Why this shelf is not on the site, in the admin's own words.
 *
 * A list of rows that are all "active" and half of which nobody can see is the
 * sort of screen people stop trusting.
 */
function hiddenBecause(row: ShelfRow): string | null {
  if (row.is_active !== 1) return 'Switched off';
  const now = Date.now();
  if (row.starts_at && new Date(row.starts_at).getTime() > now) return 'Scheduled — not started yet';
  if (row.ends_at && new Date(row.ends_at).getTime() < now) return 'Finished';
  if (SHELF_RULES[row.source]?.needsCollection && !row.source_collection_id) {
    return 'No collection chosen, so it has nothing to show';
  }
  return null;
}

export const shelvesService = {
  /** What the admin screen needs to draw its pickers. One source of truth. */
  catalogue() {
    return {
      sources: shelfSourceCatalogue(),
      layouts: SHELF_LAYOUTS,
      placements: SHELF_PLACEMENTS,
      max_products_ceiling: MAX_PRODUCTS_CEILING,
    };
  },

  async list(placement?: string) {
    const rows = await shelvesRepository.list(placement ?? null);
    return { shelves: rows.map(presentAdmin) };
  },

  async byId(id: number) {
    const row = await shelvesRepository.byId(id);
    if (!row) throw ApiError.notFound('Shelf');
    const pins = await shelvesRepository.pins(id);
    return {
      shelf: {
        ...presentAdmin(row),
        pins: pins.map((pin) => ({
          product_id: pin.product_id,
          name: pin.name,
          slug: pin.slug,
          status: pin.status,
          sort_order: pin.sort_order,
        })),
      },
    };
  },

  /**
   * What the rule would choose right now.
   *
   * The single most useful screen in this feature: a merchandiser picking
   * "Most repurchased over 180 days" has no way to know what that means for
   * their catalogue until they see the nine products it returns. Reads live
   * rather than cached, because it exists to answer "what did my change do".
   */
  async preview(id: number) {
    const row = await shelvesRepository.byId(id);
    if (!row) throw ApiError.notFound('Shelf');
    const resolved = await resolve(row);
    return {
      preview: {
        ...resolved,
        shortfall: Math.min(row.max_products, MAX_PRODUCTS_CEILING) - resolved.products.length,
        fallback: SHELF_RULES[row.source]?.fallback ?? null,
      },
    };
  },

  /**
   * What the storefront shows on one page.
   *
   * Empty shelves are dropped here rather than in the browser: a heading with
   * nothing under it is the most obvious kind of broken, and the storefront
   * should not have to know the rule that emptied it.
   */
  async publicList(placement: string, scope: { kind: 'category' | 'collection'; slug: string } | null) {
    const scopeRefId = scope ? await shelvesRepository.scopeIdBySlug(scope.kind, scope.slug) : null;
    const key = `${placement}:${scope ? `${scope.kind}:${scope.slug}` : 'all'}`;

    return cached(key, async () => {
      const rows = await shelvesRepository.live(placement, scopeRefId);
      const resolved = await Promise.all(rows.map(async (row) => presentPublic(row, (await resolve(row)).products)));
      return resolved.filter((shelf) => shelf.products.length > 0);
    }).then((shelves) => ({ shelves }));
  },

  /**
   * One shelf, resolved, for a page section that embeds it.
   *
   * Goes through the same `resolve` and the same cache as a placement request,
   * so a shelf dropped into the middle of a page and the same shelf on its own
   * cannot show different products. Returns null when the shelf is gone,
   * switched off, out of its window or empty — a page section that embeds it
   * then renders nothing rather than a heading over a gap.
   */
  async publicById(id: number) {
    return cached(`shelf:${id}`, async () => {
      const row = await shelvesRepository.byId(id);
      if (!row || row.is_active !== 1) return null;
      const now = Date.now();
      if (row.starts_at && new Date(row.starts_at).getTime() > now) return null;
      if (row.ends_at && new Date(row.ends_at).getTime() < now) return null;
      const { products } = await resolve(row);
      if (products.length === 0) return null;
      return presentPublic(row, products);
    });
  },

  async create(input: Record<string, unknown>) {
    const { pins, data } = writable(input, true);
    const id = await withTransaction(async (connection) => {
      const created = await shelvesRepository.create(data, connection);
      if (pins) await shelvesRepository.replacePins(created, pins, connection);
      return created;
    });
    clearCache();
    return this.byId(id);
  },

  async update(id: number, input: Record<string, unknown>) {
    const existing = await shelvesRepository.byId(id);
    if (!existing) throw ApiError.notFound('Shelf');
    const { pins, data } = writable(input, false);
    await withTransaction(async (connection) => {
      await shelvesRepository.update(id, data, connection);
      if (pins) await shelvesRepository.replacePins(id, pins, connection);
    });
    clearCache();
    return this.byId(id);
  },

  async remove(id: number) {
    const existing = await shelvesRepository.byId(id);
    if (!existing) throw ApiError.notFound('Shelf');
    await shelvesRepository.remove(id);
    clearCache();
    return { deleted: true };
  },

  async reorder(ids: number[]) {
    await withTransaction(async (connection) => {
      await shelvesRepository.setOrder(ids, connection);
    });
    clearCache();
    return this.list();
  },
};

/**
 * Only these columns are writable, and the combinations that cannot mean
 * anything are refused here rather than stored and puzzled over later.
 */
function writable(
  input: Record<string, unknown>,
  creating: boolean,
): { data: Record<string, unknown>; pins: number[] | null } {
  const data: Record<string, unknown> = {};
  const copy = (key: string) => {
    if (key in input) data[key] = input[key] ?? null;
  };

  if (creating || 'title' in input) {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title) throw ApiError.badRequest('A shelf needs a heading.');
    data.title = title;
  }

  if ('source' in input) {
    if (!isShelfSource(input.source)) throw ApiError.badRequest(`Unknown shelf source "${String(input.source)}".`);
    data.source = input.source;
  }

  copy('eyebrow');
  copy('subtitle');
  copy('placement');
  copy('scope_ref_id');
  copy('layout');
  copy('source_collection_id');
  copy('window_days');
  copy('max_products');
  copy('tone');
  copy('cta_label');
  copy('link_type');
  copy('link_url');
  copy('link_ref_id');
  copy('starts_at');
  copy('ends_at');
  copy('sort_order');
  if ('is_active' in input) data.is_active = input.is_active ? 1 : 0;
  if ('include_sold_out' in input) data.include_sold_out = input.include_sold_out ? 1 : 0;

  // A source that needs a collection, saved without one, is a shelf that will
  // render as nothing. Allowed — half-finished work is normal — but only on an
  // explicitly inactive row, so nobody publishes an empty band by accident.
  const source = (data.source ?? null) as string | null;
  if (source && SHELF_RULES[source]?.needsCollection) {
    const collectionId = 'source_collection_id' in data ? data.source_collection_id : undefined;
    const active = 'is_active' in data ? data.is_active === 1 : true;
    if (active && (collectionId === null || collectionId === undefined) && creating) {
      throw ApiError.badRequest('Choose a collection, or save this shelf switched off until you have.');
    }
  }

  if ('max_products' in data && data.max_products !== null) {
    const max = Number(data.max_products);
    if (!Number.isInteger(max) || max < 1 || max > MAX_PRODUCTS_CEILING) {
      throw ApiError.badRequest(`A shelf shows between 1 and ${MAX_PRODUCTS_CEILING} products.`);
    }
  }

  // Pins travel with the shelf rather than through endpoints of their own: the
  // order of the list is part of the edit, and two round-trips means a form
  // that can half-save.
  let pins: number[] | null = null;
  if ('pinned_product_ids' in input) {
    const raw = Array.isArray(input.pinned_product_ids) ? input.pinned_product_ids : [];
    const unique: number[] = [];
    for (const value of raw) {
      const id = Number(value);
      if (Number.isInteger(id) && id > 0 && !unique.includes(id)) unique.push(id);
    }
    if (unique.length > MAX_PRODUCTS_CEILING) {
      throw ApiError.badRequest(`A shelf can hold at most ${MAX_PRODUCTS_CEILING} products.`);
    }
    pins = unique;
  }

  return { data, pins };
}
