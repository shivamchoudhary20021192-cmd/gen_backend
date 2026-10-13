import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface SavedItemRow extends RowDataPacket {
  id: number;
  product_id: number;
  variant_id: number | null;
  note: string | null;
  added_at: Date;
  slug: string;
  name: string;
  subtitle: string | null;
  price: string | null;
  mrp: string | null;
  primary_image_key: string | null;
  rating_average: string;
  review_count: number;
  in_stock: number;
  deleted_at: Date | null;
}

export const shopAccountRepository = {
  /**
   * The customer's one wishlist, created on first use.
   *
   * The schema allows several named lists per customer; the storefront offers
   * one, so this resolves to the default rather than making every caller worry
   * about which list. A second list is a new row, not a migration.
   */
  async ensureWishlist(customerId: number, exec: Executor = pool): Promise<number> {
    const existing = await queryOne<RowDataPacket & { id: number }>(
      `SELECT id FROM wishlists WHERE shop_id = ? AND customer_id = ? ORDER BY id LIMIT 1`,
      [shopId(), customerId],
      exec,
    );
    if (existing) return existing.id;
    return insert(
      `INSERT INTO wishlists (shop_id, customer_id, name, is_public, share_token) VALUES (?, ?, 'Saved', 0, UUID())`,
      [shopId(), customerId],
      exec,
    );
  },

  /**
   * Saves a product.
   *
   * `INSERT IGNORE` against the unique index, so saving twice — a double tap, a
   * retry — is not an error and does not produce two rows.
   */
  async save(
    input: { wishlistId: number; productId: number; variantId: number | null },
    exec: Executor = pool,
  ): Promise<boolean> {
    const result = await execute(
      `INSERT IGNORE INTO wishlist_items (shop_id, wishlist_id, product_id, variant_id) VALUES (?, ?, ?, ?)`,
      [shopId(), input.wishlistId, input.productId, input.variantId],
      exec,
    );
    return result.affectedRows > 0;
  },

  async unsave(wishlistId: number, productId: number, exec: Executor = pool): Promise<boolean> {
    const result = await execute(
      `DELETE FROM wishlist_items WHERE shop_id = ? AND wishlist_id = ? AND product_id = ?`,
      [shopId(), wishlistId, productId],
      exec,
    );
    return result.affectedRows > 0;
  },

  /** The saved list, with everything a product card needs to render. */
  async listSaved(wishlistId: number, exec: Executor = pool): Promise<SavedItemRow[]> {
    return query<SavedItemRow>(
      `SELECT wi.id, wi.product_id, wi.variant_id, wi.note, wi.added_at,
              p.slug, p.name, p.subtitle, p.rating_average, p.review_count, p.deleted_at,
              (SELECT MIN(v.price) FROM product_variants v
                WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.status = 'active') AS price,
              (SELECT MIN(v.mrp) FROM product_variants v
                WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.status = 'active') AS mrp,
              (SELECT m.storage_key FROM media_attachments ma
                 JOIN media m ON m.id = ma.media_id
                WHERE ma.shop_id = p.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = p.id
                  AND ma.collection = 'gallery'
                ORDER BY ma.is_primary DESC, ma.sort_order ASC LIMIT 1) AS primary_image_key,
              (SELECT COUNT(*) FROM product_variants v
                 JOIN inventory_items ii ON ii.variant_id = v.id
                WHERE v.product_id = p.id AND v.deleted_at IS NULL
                  AND (v.track_inventory = 0 OR ii.quantity_available > 0)) AS in_stock
         FROM wishlist_items wi
         JOIN products p ON p.id = wi.product_id
        WHERE wi.shop_id = ? AND wi.wishlist_id = ?
        ORDER BY wi.added_at DESC`,
      [shopId(), wishlistId],
      exec,
    );
  },

  /** Just the ids, for painting the save control on a listing page. */
  async savedProductIds(customerId: number, exec: Executor = pool): Promise<number[]> {
    const rows = await query<RowDataPacket & { product_id: number }>(
      `SELECT wi.product_id
         FROM wishlist_items wi
         JOIN wishlists w ON w.id = wi.wishlist_id
        WHERE wi.shop_id = ? AND w.customer_id = ?`,
      [shopId(), customerId],
      exec,
    );
    return rows.map((row) => row.product_id);
  },

  // ── browsing ──────────────────────────────────────────────────────────────

  /**
   * Records that a product was looked at.
   *
   * Written for signed-out visitors too, against the cart token — which is what
   * makes "they looked at this before they ever gave us a phone number" usable
   * once they do sign in.
   */
  async recordView(
    input: { productId: number; customerId: number | null; sessionToken: string | null; source: string },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `INSERT INTO product_views (shop_id, product_id, customer_id, session_token, source, viewed_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [shopId(), input.productId, input.customerId, input.sessionToken, input.source.slice(0, 60)],
      exec,
    );
  },

  /**
   * Attaches a guest's history to the account they have just created.
   *
   * Views and carts recorded against a browser token become theirs on sign-in,
   * so someone who browsed for a week and then signed in is not a blank slate.
   */
  async claimGuestHistory(
    input: { customerId: number; sessionToken: string },
    exec: Executor = pool,
  ): Promise<{ views: number }> {
    const views = await execute(
      `UPDATE product_views SET customer_id = ?
        WHERE shop_id = ? AND session_token = ? AND customer_id IS NULL`,
      [input.customerId, shopId(), input.sessionToken],
      exec,
    );
    return { views: views.affectedRows };
  },

  async productIdBySlug(slug: string, exec: Executor = pool): Promise<number | null> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      `SELECT id FROM products
        WHERE shop_id = ? AND slug = ? AND deleted_at IS NULL AND status = 'active' AND visibility = 'public'
        LIMIT 1`,
      [shopId(), slug],
      exec,
    );
    return row?.id ?? null;
  },
};
