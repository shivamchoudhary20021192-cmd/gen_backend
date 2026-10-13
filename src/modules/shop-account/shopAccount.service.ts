import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { storage } from '../media/storage';
import { shopAccountRepository, type SavedItemRow } from './shopAccount.repository';

/**
 * The signed-in shopper's own things: what they saved, and what they looked at.
 *
 * Kept apart from the storefront catalogue module because everything here is
 * about one identified person, and the catalogue must never accidentally join
 * against it.
 */

function imageUrl(key: string | null): string | null {
  return key ? storage.publicUrl(key) : null;
}

function presentSaved(row: SavedItemRow) {
  const price = row.price === null ? null : Number(row.price);
  const mrp = row.mrp === null ? null : Number(row.mrp);
  return {
    product_id: row.product_id,
    slug: row.slug,
    name: row.name,
    subtitle: row.subtitle,
    image: imageUrl(row.primary_image_key),
    price,
    mrp: mrp !== null && price !== null && mrp > price ? mrp : null,
    discount_percent:
      mrp !== null && price !== null && mrp > price ? Math.round(((mrp - price) / mrp) * 100) : null,
    rating: Number(row.rating_average),
    review_count: row.review_count,
    in_stock: Number(row.in_stock) > 0,
    /**
     * A product can be retired after someone saved it.
     *
     * Kept in the list and marked, rather than silently vanishing — someone who
     * saved six things and comes back to five will think the shop lost one.
     */
    available: row.deleted_at === null,
    added_at: row.added_at,
  };
}

export const shopAccountService = {
  async listSaved(customerId: number) {
    const wishlistId = await shopAccountRepository.ensureWishlist(customerId);
    const rows = await shopAccountRepository.listSaved(wishlistId);
    return { saved: rows.map(presentSaved), count: rows.length };
  },

  /** The ids only — what a listing page needs to fill in its save controls. */
  async savedIds(customerId: number) {
    return { product_ids: await shopAccountRepository.savedProductIds(customerId) };
  },

  async save(customerId: number, slug: string, variantId: number | null) {
    const productId = await shopAccountRepository.productIdBySlug(slug);
    if (!productId) throw ApiError.notFound('Product');

    const wishlistId = await shopAccountRepository.ensureWishlist(customerId);
    const added = await shopAccountRepository.save({ wishlistId, productId, variantId });

    logger.info('shop_account.saved', { customer_id: customerId, product_id: productId, added });
    // `saved: true` either way — the caller asked for it to be saved and it is.
    // Reporting "already saved" as a failure makes a double tap look broken.
    return { saved: true, newly_added: added };
  },

  async unsave(customerId: number, slug: string) {
    const productId = await shopAccountRepository.productIdBySlug(slug);
    if (!productId) throw ApiError.notFound('Product');

    const wishlistId = await shopAccountRepository.ensureWishlist(customerId);
    await shopAccountRepository.unsave(wishlistId, productId);
    return { saved: false };
  },

  /**
   * Records a product view.
   *
   * Fire-and-forget from the storefront's point of view: it must never be able
   * to fail a page render, so the route answers 202 and a bad product id is
   * simply not recorded rather than raised.
   */
  async recordView(input: {
    slug: string;
    customerId: number | null;
    sessionToken: string | null;
    source: string;
  }) {
    const productId = await shopAccountRepository.productIdBySlug(input.slug);
    if (!productId) return { recorded: false };

    await shopAccountRepository.recordView({
      productId,
      customerId: input.customerId,
      sessionToken: input.sessionToken,
      source: input.source,
    });
    return { recorded: true };
  },

  /** Called right after sign-in, with the cart token the browser was using. */
  async claimGuestHistory(customerId: number, sessionToken: string) {
    const claimed = await shopAccountRepository.claimGuestHistory({ customerId, sessionToken });
    logger.info('shop_account.history_claimed', { customer_id: customerId, views: claimed.views });
    return claimed;
  },
};
