import { query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopIdSql } from '../../platform/tenancy/context';

export interface InterestedCustomerRow extends RowDataPacket {
  customer_id: number;
  public_id: string;
  country_code: string;
  phone: string;
  first_name: string | null;
  email: string | null;
  accepts_whatsapp_marketing: number;
  consent_status: string | null;
  product_id: number;
  slug: string;
  product_name: string;
  price: string | null;
  primary_image_key: string | null;
  in_stock: number;
  /** saved | cart */
  interest: 'saved' | 'cart';
  interested_at: Date;
  last_contacted_at: Date | null;
}

/**
 * The audience: people who wanted something and did not buy it.
 *
 * Two sources of "wanted" — they saved it, or they put it in a bag and walked
 * away. Both are joined against orders so that anyone who did eventually buy
 * that product drops out, which is the difference between a useful nudge and
 * telling a customer about the thing they are already holding.
 *
 * The consent join is `LEFT`, deliberately. The list shows everyone who is
 * interested, marked with whether they may be contacted — a merchandiser should
 * be able to see that forty people want a product and only six opted in, rather
 * than seeing six and drawing the wrong conclusion about demand.
 */
// A function, not a constant: the shop is part of the query. Its id is inlined
// (see shopIdSql) because this block is wrapped by callers that append their
// own positional filters after it.
const interestSql = (): string => `
  SELECT c.id AS customer_id, c.public_id, c.country_code, c.phone, c.first_name, c.email,
         c.accepts_whatsapp_marketing,
         latest_consent.status AS consent_status,
         p.id AS product_id, p.slug, p.name AS product_name,
         (SELECT MIN(v.price) FROM product_variants v
           WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.status = 'active') AS price,
         (SELECT m.storage_key FROM media_attachments ma
            JOIN media m ON m.id = ma.media_id
           WHERE ma.shop_id = p.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = p.id
             AND ma.collection = 'gallery'
           ORDER BY ma.is_primary DESC, ma.sort_order ASC LIMIT 1) AS primary_image_key,
         (SELECT COUNT(*) FROM product_variants v
            JOIN inventory_items ii ON ii.variant_id = v.id
           WHERE v.product_id = p.id AND v.deleted_at IS NULL
             AND (v.track_inventory = 0 OR ii.quantity_available > 0)) AS in_stock,
         src.interest, src.interested_at,
         (SELECT MAX(nl.queued_at) FROM notification_logs nl
            LEFT JOIN notification_templates nt ON nt.id = nl.template_id AND nt.shop_id = nl.shop_id
           WHERE nl.shop_id = c.shop_id AND nl.customer_id = c.id AND nl.channel = 'whatsapp'
             AND COALESCE(nt.is_transactional, 0) = 0
             AND nl.status <> 'failed') AS last_contacted_at
    FROM (
          SELECT w.customer_id, wi.product_id, 'saved' AS interest, wi.added_at AS interested_at
            FROM wishlist_items wi
            JOIN wishlists w ON w.id = wi.wishlist_id
           WHERE wi.shop_id = ${shopIdSql()}
           UNION ALL
          SELECT ct.customer_id, ci.product_id, 'cart' AS interest, ci.added_at AS interested_at
            FROM cart_items ci
            JOIN carts ct ON ct.id = ci.cart_id
           WHERE ci.shop_id = ${shopIdSql()}
             AND ct.customer_id IS NOT NULL
             AND ct.status IN ('active', 'abandoned')
             AND ct.converted_order_id IS NULL
         ) src
    JOIN customers c ON c.id = src.customer_id
    JOIN products p ON p.id = src.product_id
    LEFT JOIN (
          SELECT cc.customer_id, cc.status
            FROM customer_consents cc
            JOIN (SELECT customer_id, MAX(id) AS id
                    FROM customer_consents
                   WHERE shop_id = ${shopIdSql()} AND purpose = 'marketing_whatsapp'
                   GROUP BY customer_id) newest ON newest.id = cc.id
         ) latest_consent ON latest_consent.customer_id = c.id
   WHERE c.shop_id = ${shopIdSql()}
     AND c.deleted_at IS NULL
     AND c.status = 'active'
     AND c.anonymised_at IS NULL
     AND p.deleted_at IS NULL
     AND p.status = 'active'
     AND p.visibility = 'public'
     -- Never nudge someone about something they have already bought.
     AND NOT EXISTS (
           SELECT 1 FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
            WHERE o.shop_id = c.shop_id AND o.customer_id = c.id
              AND oi.product_id = p.id
              AND o.order_status NOT IN ('cancelled')
         )`;

export interface AudienceFilters {
  /** 'saved' | 'cart' | undefined for both. */
  interest?: string;
  /** Only those who may actually be messaged. */
  contactableOnly?: boolean;
  /** Only products that can be bought right now. */
  inStockOnly?: boolean;
  /** Ignore interest older than this many days. */
  withinDays?: number;
}

function buildFilters(filters: AudienceFilters): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.interest === 'saved' || filters.interest === 'cart') {
    conditions.push('src.interest = ?');
    params.push(filters.interest);
  }
  if (filters.contactableOnly) {
    // Both, not either: the flag is what the audience query reads quickly and
    // the consent row is the evidence. They are kept in step when consent is
    // recorded, and requiring both means a drift between them fails closed.
    conditions.push("latest_consent.status = 'granted' AND c.accepts_whatsapp_marketing = 1");
  }
  if (filters.inStockOnly) {
    // tenancy: scoped by caller — correlated to p inside interestSql().
    conditions.push(`(SELECT COUNT(*) FROM product_variants v
                        JOIN inventory_items ii ON ii.variant_id = v.id
                       WHERE v.product_id = p.id AND v.deleted_at IS NULL
                         AND (v.track_inventory = 0 OR ii.quantity_available > 0)) > 0`);
  }
  if (filters.withinDays) {
    conditions.push('src.interested_at >= DATE_SUB(NOW(), INTERVAL ? DAY)');
    params.push(filters.withinDays);
  }

  return { sql: conditions.length ? ` AND ${conditions.join(' AND ')}` : '', params };
}

export const reengagementRepository = {
  async listInterested(
    filters: AudienceFilters,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<InterestedCustomerRow[]> {
    const built = buildFilters(filters);
    return query<InterestedCustomerRow>(
      `${interestSql()}${built.sql} ORDER BY src.interested_at DESC LIMIT ? OFFSET ?`,
      [...built.params, limit, offset],
      exec,
    );
  },

  async countInterested(filters: AudienceFilters, exec: Executor = pool): Promise<number> {
    const built = buildFilters(filters);
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM (${interestSql()}${built.sql}) counted`,
      built.params,
      exec,
    );
    return row?.total ?? 0;
  },

  /** Headline figures for the screen: how many, and how many reachable. */
  async summary(filters: AudienceFilters, exec: Executor = pool): Promise<{
    people: number;
    contactable: number;
    saved: number;
    cart: number;
  }> {
    const built = buildFilters({ ...filters, contactableOnly: false });
    const row = await queryOne<
      RowDataPacket & { people: number; contactable: number; saved: number; cart: number }
    >(
      `SELECT COUNT(DISTINCT customer_id) AS people,
              COUNT(DISTINCT CASE WHEN consent_status = 'granted' AND accepts_whatsapp_marketing = 1
                                  THEN customer_id END) AS contactable,
              SUM(interest = 'saved') AS saved,
              SUM(interest = 'cart') AS cart
         FROM (${interestSql()}${built.sql}) counted`,
      built.params,
      exec,
    );
    return {
      people: Number(row?.people ?? 0),
      contactable: Number(row?.contactable ?? 0),
      saved: Number(row?.saved ?? 0),
      cart: Number(row?.cart ?? 0),
    };
  },
};
