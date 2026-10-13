import { shopIdSql } from '../../platform/tenancy/context';
import { IN_STOCK_SQL, publicWhere } from '../storefront/storefront.repository';

/**
 * How a shelf decides which products are on it.
 *
 * Each rule is a ranking query that returns product ids, best first. Nothing
 * the client sends ever reaches the SQL: the source name is looked up in this
 * fixed map and every value is a bound `?`. That is what keeps a feature whose
 * whole purpose is "let a merchandiser write query conditions" from being an
 * injection hole — the same discipline `collections/ruleCompiler.ts` uses.
 *
 * Three things every rule states for itself:
 *
 *   window     whether "how long have we been counting" is a question worth
 *              asking. Best selling over thirty days is the shop's current
 *              taste; over all time it is a monument to whatever sold in year
 *              one, and it stops moving. Some rules have no window at all —
 *              a rating is not a period.
 *
 *   fallback   what to fill the remaining slots with when the signal is thin.
 *              A new shop has no repeat purchases and few wishlist saves, and
 *              a shelf that renders empty for the first three months is a
 *              feature nobody switches on again. The fallback is always
 *              reported to the admin (`fallback_used` in the preview), so the
 *              screen never quietly claims a rule found something it did not.
 *
 *   floor      the minimum evidence a product needs before the rule will make
 *              a claim about it. One five-star review is not "top rated".
 */

/** Orders that represent a real purchase, for every rule that counts sales. */
const PURCHASED = `o.payment_status IN ('paid','cod_collected','partially_refunded')
                   AND o.order_status NOT IN ('cancelled','returned','rto')
                   AND o.placed_at IS NOT NULL`;

/** A product needs this many reviews before a rating means anything. */
const MIN_REVIEWS_FOR_RATING = 3;

export interface ShelfRule {
  /** What the admin screen calls it. */
  label: string;
  /** One line, in the admin, saying what it will actually do. */
  description: string;
  /** Whether `window_days` applies, and what it is when nobody has chosen. */
  window: { default: number; min: number; max: number } | null;
  /**
   * Builds the ranking query.
   *
   * `limit` is already widened by the caller to leave room for products that
   * turn out to be unbuyable, and the caller trims the result.
   */
  build: (options: { windowDays: number | null; limit: number; inStockOnly: boolean; collectionId: number | null }) => {
    sql: string;
    params: unknown[];
  };
  /** Fills the shelf when the rule itself is short. Null means leave it short. */
  fallback: 'newest' | 'bestselling' | 'rating' | null;
  /** Rules that cannot run without a collection chosen. */
  needsCollection?: boolean;
}

function stockClause(inStockOnly: boolean): string {
  return inStockOnly ? ` AND ${IN_STOCK_SQL}` : '';
}

export const SHELF_RULES: Record<string, ShelfRule> = {
  manual: {
    label: 'Hand-picked',
    description: 'Exactly the products you choose, in the order you put them in.',
    window: null,
    fallback: null,
    // Never called: the service short-circuits a manual shelf before it gets
    // here. Present so the map is total and a missing key is a real error.
    build: () => ({ sql: 'SELECT p.id FROM products p WHERE 1 = 0', params: [] }),
  },

  bestselling: {
    label: 'Best selling',
    description: 'Ranked by units actually sold in the window, paid orders only.',
    window: { default: 30, min: 1, max: 365 },
    fallback: 'bestselling',
    build: ({ windowDays, limit, inStockOnly }) => ({
      // Cancelled and returned units are subtracted rather than counted. A
      // product that shipped four hundred and had three hundred sent back is
      // not a bestseller, it is a problem, and a shelf that promotes it sells
      // three hundred more returns.
      sql: `SELECT p.id,
                   SUM(oi.quantity - oi.cancelled_quantity - oi.returned_quantity) AS rank_value
              FROM products p
              JOIN order_items oi ON oi.product_id = p.id AND oi.shop_id = p.shop_id
              JOIN orders o ON o.id = oi.order_id
             WHERE ${publicWhere()}${stockClause(inStockOnly)}
               AND ${PURCHASED}
               AND o.placed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY p.id
            HAVING rank_value > 0
             ORDER BY rank_value DESC, p.total_sold DESC, p.id DESC
             LIMIT ?`,
      params: [windowDays, limit],
    }),
  },

  new_arrivals: {
    label: 'New arrivals',
    description: 'Most recently published, and only inside the window — so a quiet quarter empties the shelf rather than filling it with year-old products under a “New” heading.',
    window: { default: 90, min: 1, max: 365 },
    // Deliberately none. The whole claim is "this is new"; filling it with
    // older products to make it look full is the one lie this feature must not
    // tell, and it is exactly what a shop does by hand when the shelf looks bare.
    fallback: null,
    build: ({ windowDays, limit, inStockOnly }) => ({
      sql: `SELECT p.id, p.published_at AS rank_value
              FROM products p
             WHERE ${publicWhere()}${stockClause(inStockOnly)}
               AND p.published_at IS NOT NULL
               AND p.published_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
             ORDER BY p.published_at DESC, p.id DESC
             LIMIT ?`,
      params: [windowDays, limit],
    }),
  },

  most_loved: {
    label: 'Most loved',
    description: 'Ranked by how many different people saved it, then by rating — what shoppers bookmark and come back to, which is not always what sells most.',
    window: { default: 90, min: 7, max: 365 },
    fallback: 'rating',
    build: ({ windowDays, limit, inStockOnly }) => ({
      // Distinct customers, not rows. One person with four wishlists is one
      // person, and a shelf ranked on rows is a shelf ranked on that person.
      sql: `SELECT p.id, COUNT(DISTINCT w.customer_id) AS rank_value
              FROM products p
              JOIN wishlist_items wi ON wi.product_id = p.id
              JOIN wishlists w ON w.id = wi.wishlist_id
             WHERE ${publicWhere()}${stockClause(inStockOnly)}
               AND wi.added_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY p.id
             ORDER BY rank_value DESC, p.rating_average DESC, p.id DESC
             LIMIT ?`,
      params: [windowDays, limit],
    }),
  },

  most_repurchased: {
    label: 'Most repurchased',
    description: 'Products the same customer has bought more than once. The strongest signal a shop owns — nobody reorders a product that did not work.',
    window: { default: 365, min: 30, max: 1095 },
    fallback: 'bestselling',
    build: ({ windowDays, limit, inStockOnly }) => ({
      // Two passes on purpose. The inner query asks "which customer bought
      // which product in how many separate orders" and keeps only those who
      // came back; the outer counts those customers per product. Counting
      // order lines instead would rank a product somebody bought three of at
      // once as a repurchase, which it plainly is not.
      sql: `SELECT p.id, COUNT(*) AS rank_value
              FROM (
                    SELECT oi.product_id, o.customer_id, COUNT(DISTINCT o.id) AS orders_placed
                      FROM order_items oi
                      JOIN orders o ON o.id = oi.order_id
                     -- Aggregated before products are joined, so it needs its
                     -- own shop filter or it ranks on every shop's customers.
                     WHERE o.shop_id = ${shopIdSql()}
                       AND o.customer_id IS NOT NULL
                       AND ${PURCHASED}
                       AND o.placed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
                     GROUP BY oi.product_id, o.customer_id
                    HAVING orders_placed >= 2
                   ) AS returners
              JOIN products p ON p.id = returners.product_id
             WHERE ${publicWhere()}${stockClause(inStockOnly)}
             GROUP BY p.id
             ORDER BY rank_value DESC, p.total_sold DESC, p.id DESC
             LIMIT ?`,
      params: [windowDays, limit],
    }),
  },

  trending: {
    label: 'Trending now',
    description: 'Most viewed in the last few days. Moves fastest of all the rules — good for a shelf that should feel alive, wrong for one that should feel considered.',
    window: { default: 7, min: 1, max: 90 },
    fallback: 'bestselling',
    build: ({ windowDays, limit, inStockOnly }) => ({
      sql: `SELECT p.id, COUNT(*) AS rank_value
              FROM products p
              JOIN product_views pv ON pv.product_id = p.id
             WHERE ${publicWhere()}${stockClause(inStockOnly)}
               AND pv.viewed_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
             GROUP BY p.id
             ORDER BY rank_value DESC, p.total_sold DESC, p.id DESC
             LIMIT ?`,
      params: [windowDays, limit],
    }),
  },

  top_rated: {
    label: 'Highest rated',
    description: `Best average rating, counting only products with at least ${MIN_REVIEWS_FOR_RATING} reviews.`,
    window: null,
    fallback: 'bestselling',
    build: ({ limit, inStockOnly }) => ({
      sql: `SELECT p.id, p.rating_average AS rank_value
              FROM products p
             WHERE ${publicWhere()}${stockClause(inStockOnly)}
               AND p.review_count >= ${MIN_REVIEWS_FOR_RATING}
             ORDER BY p.rating_average DESC, p.review_count DESC, p.id DESC
             LIMIT ?`,
      params: [limit],
    }),
  },

  featured: {
    label: 'Flagged by the shop',
    description: 'Products carrying the bestseller flag or a live badge — the shop’s own choice rather than a calculation.',
    window: null,
    fallback: 'bestselling',
    build: ({ limit, inStockOnly }) => ({
      sql: `SELECT p.id
              FROM products p
             WHERE ${publicWhere()}${stockClause(inStockOnly)}
               AND (p.is_bestseller = 1
                    OR (p.badge IS NOT NULL AND p.badge <> ''
                        AND (p.badge_expires_at IS NULL OR p.badge_expires_at > NOW())))
             ORDER BY p.sort_order ASC, p.total_sold DESC, p.id DESC
             LIMIT ?`,
      params: [limit],
    }),
  },

  collection: {
    label: 'From a collection',
    description: 'Everything in a collection you pick, in the collection’s own order — including a smart collection, which keeps its own membership up to date.',
    window: null,
    fallback: null,
    needsCollection: true,
    build: ({ limit, inStockOnly, collectionId }) => ({
      sql: `SELECT p.id
              FROM products p
              JOIN collection_products cp ON cp.product_id = p.id AND cp.collection_id = ?
             WHERE ${publicWhere()}${stockClause(inStockOnly)}
             ORDER BY cp.is_pinned DESC, cp.position ASC, p.id ASC
             LIMIT ?`,
      params: [collectionId, limit],
    }),
  },
};

/** The fallbacks, as ordinary ranking queries. Never the primary of a shelf. */
export const FALLBACK_ORDER: Record<'newest' | 'bestselling' | 'rating', string> = {
  newest: 'p.published_at DESC, p.id DESC',
  bestselling: 'p.is_bestseller DESC, p.total_sold DESC, p.id DESC',
  rating: 'p.rating_average DESC, p.review_count DESC, p.id DESC',
};

export function isShelfSource(value: unknown): value is keyof typeof SHELF_RULES {
  return typeof value === 'string' && Object.hasOwn(SHELF_RULES, value);
}

/** What the admin screen draws its source picker from. One source of truth. */
export function shelfSourceCatalogue() {
  return Object.entries(SHELF_RULES).map(([key, rule]) => ({
    key,
    label: rule.label,
    description: rule.description,
    window: rule.window,
    needs_collection: rule.needsCollection === true,
    /** So the form can warn that a thin rule will be topped up, and with what. */
    fallback: rule.fallback,
  }));
}

export const SHELF_LAYOUTS = [
  {
    key: 'carousel',
    label: 'Swipe carousel',
    description: 'A row that scrolls sideways, the next card peeking. Swipe on a phone, arrows on a desktop. Best when there are more products than fit.',
  },
  {
    key: 'grid',
    label: 'Grid',
    description: 'Everything at once — two across on a phone, four on a desktop. Best for four to eight products a shopper should compare.',
  },
  {
    key: 'spotlight',
    label: 'Spotlight',
    description: 'The first product large with its story, the rest smaller beside it. Best for a launch or an editor’s pick.',
  },
  {
    key: 'ranked',
    label: 'Ranked chart',
    description: 'Numbered 1, 2, 3 down the row. Reads as a chart, which is what makes “Top 5 bestsellers” persuasive.',
  },
] as const;

export const SHELF_PLACEMENTS = [
  { key: 'home', label: 'Home page', scope: null },
  { key: 'shop', label: 'Shop (all products)', scope: null },
  { key: 'category', label: 'Category pages', scope: 'category' },
  { key: 'collection', label: 'Collection pages', scope: 'collection' },
  { key: 'product', label: 'Product pages', scope: null },
] as const;
