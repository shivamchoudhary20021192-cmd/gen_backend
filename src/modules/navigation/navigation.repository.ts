import { execute, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface MenuItemRow extends RowDataPacket {
  id: number;
  parent_id: number | null;
  menu_key: string;
  title: string;
  subtitle: string | null;
  hover_description: string | null;
  keyboard_shortcut: string | null;
  icon: string | null;
  icon_color: string | null;
  icon_type: string;
  route: string | null;
  active_match: string | null;
  section: string | null;
  group_key: string | null;
  badge_key: string | null;
  badge_variant: string;
  sort_order: number;
  status: 'available' | 'coming_soon' | 'hidden';
  is_active: number;
  is_visible: number;
  show_in_collapsed: number;
  is_pinnable: number;
  requires_super_admin: number;
  feature_flag: string | null;
  is_external: number;
  opens_new_tab: number;
  divider_after: number;
  analytics_key: string | null;
  metadata: any;
  is_system: number;
  /** Comma-joined permission slugs; NULL when the item is unrestricted. */
  permission_slugs: string | null;
}

export const navigationRepository = {
  /**
   * The whole menu in one query, with permissions aggregated rather than
   * fetched per row. 46 items would otherwise be 47 round trips on a request
   * that fires on every page load.
   */
  async allItems(includeHidden = false, exec: Executor = pool): Promise<MenuItemRow[]> {
    return query<MenuItemRow>(
      `SELECT m.*,
              GROUP_CONCAT(p.slug ORDER BY p.slug SEPARATOR ',') AS permission_slugs
         FROM menu_items m
         LEFT JOIN menu_item_permissions mp ON mp.menu_item_id = m.id
         LEFT JOIN permissions p            ON p.id = mp.permission_id
        ${includeHidden ? '' : "WHERE m.is_active = 1 AND m.status <> 'hidden'"}
        GROUP BY m.id
        ORDER BY m.sort_order, m.title`,
      [],
      exec,
    );
  },

  async findById(id: number, exec: Executor = pool): Promise<MenuItemRow | null> {
    return queryOne<MenuItemRow>(
      `SELECT m.*, GROUP_CONCAT(p.slug SEPARATOR ',') AS permission_slugs
         FROM menu_items m
         LEFT JOIN menu_item_permissions mp ON mp.menu_item_id = m.id
         LEFT JOIN permissions p            ON p.id = mp.permission_id
        WHERE m.id = ?
        GROUP BY m.id`,
      [id],
      exec,
    );
  },

  async update(id: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `\`${k}\` = ?`).join(', ');
    await execute(`UPDATE menu_items SET ${assignments} WHERE id = ?`, [...Object.values(fields), id], exec);
  },

  async setPermissions(itemId: number, permissionIds: number[], exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM menu_item_permissions WHERE menu_item_id = ?', [itemId], exec);
    if (permissionIds.length === 0) return;
    const values = permissionIds.map(() => '(?, ?)').join(', ');
    await execute(
      `INSERT INTO menu_item_permissions (menu_item_id, permission_id) VALUES ${values}`,
      permissionIds.flatMap((permissionId) => [itemId, permissionId]),
      exec,
    );
  },

  async reorder(items: { id: number; sort_order: number; parent_id?: number | null }[], exec: Executor = pool): Promise<void> {
    for (const item of items) {
      if (item.parent_id !== undefined) {
        await execute('UPDATE menu_items SET sort_order = ?, parent_id = ? WHERE id = ?', [item.sort_order, item.parent_id, item.id], exec);
      } else {
        await execute('UPDATE menu_items SET sort_order = ? WHERE id = ?', [item.sort_order, item.id], exec);
      }
    }
  },

  /**
   * Live counters for the sidebar badges. One query per badge, run only for
   * badges the caller can actually see — a Content editor never triggers the
   * open-orders count.
   */
  async badgeCounts(keys: string[], exec: Executor = pool): Promise<Record<string, number>> {
    // Every counter is the current shop's: each takes the shop id as its only parameter.
    const sql: Record<string, string> = {
      'orders.pending': "SELECT COUNT(*) AS n FROM orders WHERE shop_id = ? AND order_status IN ('pending','confirmed')",
      'returns.open': "SELECT COUNT(*) AS n FROM return_requests WHERE shop_id = ? AND status IN ('requested','approved','pickup_scheduled','received')",
      'inventory.low': `SELECT COUNT(*) AS n FROM inventory_items ii
                          JOIN product_variants v ON v.id = ii.variant_id AND v.deleted_at IS NULL
                         WHERE ii.shop_id = ? AND v.track_inventory = 1 AND ii.quantity_available <= v.low_stock_threshold`,
      'reviews.pending': "SELECT COUNT(*) AS n FROM reviews WHERE shop_id = ? AND status = 'pending' AND deleted_at IS NULL",
      'claims.review_due': "SELECT COUNT(*) AS n FROM claims WHERE shop_id = ? AND status = 'approved' AND review_due_at IS NOT NULL AND review_due_at <= CURDATE()",
      // Waiting on staff: not those still waiting on the requester to confirm, nor erasures already scheduled.
      'privacy.open': "SELECT COUNT(*) AS n FROM data_requests WHERE shop_id = ? AND status IN ('received','in_progress')",
      'support.open': "SELECT COUNT(*) AS n FROM support_tickets WHERE shop_id = ? AND status IN ('open','pending_customer','in_progress','escalated')",
      'adverse.open': "SELECT COUNT(*) AS n FROM adverse_events WHERE shop_id = ? AND status IN ('reported','under_review','escalated')",
    };

    const out: Record<string, number> = {};
    await Promise.all(
      keys
        .filter((key) => sql[key])
        .map(async (key) => {
          try {
            const row = await queryOne<RowDataPacket & { n: number }>(sql[key], [shopId()], exec);
            out[key] = Number(row?.n ?? 0);
          } catch {
            // A badge that cannot be counted is not a reason to fail the menu.
            out[key] = 0;
          }
        }),
    );
    return out;
  },
};
