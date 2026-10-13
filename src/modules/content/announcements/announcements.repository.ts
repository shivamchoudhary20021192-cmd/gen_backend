import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../../db/pool';
import { shopId } from '../../../platform/tenancy/context';

/**
 * The lines in the strip above the header, and the strip's own settings.
 *
 * Coupons are joined rather than copied. The code, the amount and — crucially —
 * whether the offer is still live are read at request time, so a line stops
 * advertising a dead code the moment it dies rather than the day somebody
 * notices.
 */

export interface AnnouncementRow extends RowDataPacket {
  id: number;
  message: string;
  coupon_id: number | null;
  link_type: string;
  link_url: string | null;
  link_ref_id: number | null;
  cta_label: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  is_active: number;
  sort_order: number;
  created_at: Date;
  updated_at: Date;

  kind: 'message' | 'free_shipping';
  success_message: string | null;
  free_shipping_threshold: string | null;
  show_countdown: number;
  background_hex: string | null;
  text_hex: string | null;
  visibility: 'all' | 'desktop' | 'mobile';
  show_on: unknown;
  audience: 'all' | 'guests' | 'customers';
  countries: unknown;
  /** The link's handle on the Online Store (product slug, blog/article…), resolved in SQL. */
  ref_handle: string | null;

  // Joined from `coupons`, and null when no coupon is attached.
  coupon_code: string | null;
  coupon_title: string | null;
  coupon_type: string | null;
  coupon_value: string | null;
  /** 1 when the coupon may be advertised right now. Computed in SQL. */
  coupon_live: number | null;
}

export interface AnnouncementSettingsRow extends RowDataPacket {
  id: number;
  is_enabled: number;
  rotation_seconds: number;
  is_dismissible: number;
  background_hex: string | null;
  text_hex: string | null;
  updated_at: Date;

  display_mode: 'rotate' | 'marquee';
  transition: 'fade' | 'slide' | 'slide_up' | 'typewriter' | 'none';
  autoplay: number;
  pause_on_hover: number;
  marquee_speed: number;
  marquee_direction: 'left' | 'right';
  marquee_separator: string;
  height_mode: 'auto' | 'uniform' | 'fixed';
  fixed_height_desktop: number;
  fixed_height_mobile: number;
  max_lines: number;
  font_size_desktop: number;
  font_size_mobile: number;
  font_weight: 'regular' | 'medium' | 'bold';
  text_transform: 'none' | 'uppercase';
  text_align: 'center' | 'left';
  background_gradient_hex: string | null;
  bar_visibility: 'all' | 'desktop' | 'mobile';
  arrows_visibility: 'all' | 'desktop' | 'mobile' | 'none';
  link_arrow_visibility: 'all' | 'desktop' | 'mobile' | 'none';
  dismiss_days: number;
}

/**
 * Whether a coupon is worth putting in front of a shopper.
 *
 * Four ways an offer stops being real, and all four have been seen in the wild:
 * switched off, not started yet, finished, or used up to its limit. Evaluated
 * here rather than in the service so the list query and the single-row query
 * cannot answer it differently.
 */
const COUPON_LIVE = `
  (c.id IS NOT NULL
   AND c.is_active = 1
   AND (c.starts_at IS NULL OR c.starts_at <= NOW())
   AND (c.ends_at IS NULL OR c.ends_at >= NOW())
   AND (c.usage_limit_total IS NULL OR c.used_count < c.usage_limit_total))`;

const COLUMNS = `
  a.id, a.message, a.coupon_id, a.link_type, a.link_url, a.link_ref_id, a.cta_label,
  a.starts_at, a.ends_at, a.is_active, a.sort_order, a.created_at, a.updated_at,
  a.kind, a.success_message, a.free_shipping_threshold, a.show_countdown, a.background_hex, a.text_hex,
  a.visibility, a.show_on, a.audience, a.countries,
  CASE a.link_type
    WHEN 'product'    THEN (SELECT p.slug  FROM products p    WHERE p.shop_id = a.shop_id AND p.id = a.link_ref_id AND p.deleted_at IS NULL)
    WHEN 'collection' THEN (SELECT k.slug  FROM collections k WHERE k.shop_id = a.shop_id AND k.id = a.link_ref_id AND k.deleted_at IS NULL)
    WHEN 'category'   THEN (SELECT g.slug  FROM categories g  WHERE g.shop_id = a.shop_id AND g.id = a.link_ref_id AND g.deleted_at IS NULL)
    WHEN 'page'       THEN (SELECT pg.slug FROM cms_pages pg  WHERE pg.shop_id = a.shop_id AND pg.id = a.link_ref_id AND pg.deleted_at IS NULL)
    WHEN 'article'    THEN (SELECT CONCAT(b.slug, '/', ar.slug) FROM cms_articles ar JOIN cms_blogs b ON b.shop_id = ar.shop_id AND b.id = ar.blog_id
                             WHERE ar.shop_id = a.shop_id AND ar.id = a.link_ref_id AND ar.deleted_at IS NULL)
  END AS ref_handle,
  c.code AS coupon_code, c.title AS coupon_title,
  c.discount_type AS coupon_type, c.value AS coupon_value,
  ${COUPON_LIVE} AS coupon_live`;

const FROM = `announcements a LEFT JOIN coupons c ON c.id = a.coupon_id AND c.shop_id = a.shop_id`;

export const announcementsRepository = {
  /** Everything the admin should see, including scheduled and switched-off rows. */
  async list(exec: Executor = pool): Promise<AnnouncementRow[]> {
    return query<AnnouncementRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE a.shop_id = ? AND a.deleted_at IS NULL ORDER BY a.sort_order, a.id`,
      [shopId()],
      exec,
    );
  },

  /**
   * What the storefront may show, in order.
   *
   * The schedule is applied here rather than in the browser: a line whose
   * window has not opened should not be in the payload at all, or it is one
   * view-source away from being read early.
   */
  async live(exec: Executor = pool): Promise<AnnouncementRow[]> {
    return query<AnnouncementRow>(
      `SELECT ${COLUMNS}
         FROM ${FROM}
        WHERE a.shop_id = ?
          AND a.deleted_at IS NULL
          AND a.is_active = 1
          AND (a.starts_at IS NULL OR a.starts_at <= NOW())
          AND (a.ends_at IS NULL OR a.ends_at >= NOW())
        ORDER BY a.sort_order, a.id`,
      [shopId()],
      exec,
    );
  },

  async byId(id: number, exec: Executor = pool): Promise<AnnouncementRow | null> {
    const row = await queryOne<AnnouncementRow>(
      `SELECT ${COLUMNS} FROM ${FROM} WHERE a.shop_id = ? AND a.id = ? AND a.deleted_at IS NULL`,
      [shopId(), id],
      exec,
    );
    return row ?? null;
  },

  async create(data: Record<string, unknown>, exec: Executor = pool): Promise<number> {
    const row = { ...data, shop_id: shopId() };
    const columns = Object.keys(row);
    return insert(
      `INSERT INTO announcements (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(row),
      exec,
    );
  },

  async update(id: number, data: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const columns = Object.keys(data);
    if (columns.length === 0) return;
    await execute(
      `UPDATE announcements SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE shop_id = ? AND id = ?`,
      [...Object.values(data), shopId(), id],
      exec,
    );
  },

  /** Soft, like everything else here: a line taken down is often put back up. */
  async remove(id: number, exec: Executor = pool): Promise<void> {
    await execute('UPDATE announcements SET deleted_at = NOW() WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  /** Reorder in one statement per row, inside the caller's transaction. */
  async setOrder(ids: number[], exec: Executor = pool): Promise<void> {
    for (const [index, id] of ids.entries()) {
      await execute('UPDATE announcements SET sort_order = ? WHERE shop_id = ? AND id = ? AND deleted_at IS NULL', [index, shopId(), id], exec);
    }
  },

  /**
   * The strip's settings — one row per shop, created with defaults the first
   * time a shop reads them, so a new shop never has to be seeded for it.
   */
  async settings(exec: Executor = pool): Promise<AnnouncementSettingsRow> {
    const read = () =>
      queryOne<AnnouncementSettingsRow>('SELECT * FROM announcement_settings WHERE shop_id = ? LIMIT 1', [shopId()], exec);
    const row = await read();
    if (row) return row;
    await execute('INSERT IGNORE INTO announcement_settings (shop_id) VALUES (?)', [shopId()], exec);
    return (await read()) as AnnouncementSettingsRow;
  },

  /** One more view or click for each line, today. Aggregated per day, so the table stays small. */
  async recordStats(events: { id: number; views: number; clicks: number }[], exec: Executor = pool): Promise<void> {
    if (events.length === 0) return;
    await execute(
      `INSERT INTO announcement_stats (shop_id, announcement_id, day, views, clicks)
       SELECT ?, a.id, UTC_DATE(), e.views, e.clicks
         FROM announcements a
         JOIN (${events.map(() => 'SELECT ? AS id, ? AS views, ? AS clicks').join(' UNION ALL ')}) e ON e.id = a.id
        WHERE a.shop_id = ? AND a.deleted_at IS NULL
       ON DUPLICATE KEY UPDATE views = announcement_stats.views + VALUES(views), clicks = announcement_stats.clicks + VALUES(clicks)`,
      [shopId(), ...events.flatMap((event) => [event.id, event.views, event.clicks]), shopId()],
      exec,
    );
  },

  /** Views and clicks per line over the last N days. */
  async stats(days: number, exec: Executor = pool): Promise<Map<number, { views: number; clicks: number }>> {
    const rows = await query<RowDataPacket & { announcement_id: number; views: string; clicks: string }>(
      `SELECT announcement_id, SUM(views) AS views, SUM(clicks) AS clicks
         FROM announcement_stats
        WHERE shop_id = ? AND day >= DATE_SUB(UTC_DATE(), INTERVAL ? DAY)
        GROUP BY announcement_id`,
      [shopId(), days],
      exec,
    );
    return new Map(rows.map((row) => [Number(row.announcement_id), { views: Number(row.views), clicks: Number(row.clicks) }]));
  },

  async updateSettings(data: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const columns = Object.keys(data);
    if (columns.length === 0) return;
    await execute(
      `UPDATE announcement_settings SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE shop_id = ?`,
      [...Object.values(data), shopId()],
      exec,
    );
  },
};
