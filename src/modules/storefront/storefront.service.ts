import { randomUUID } from 'node:crypto';
import { ApiError } from '../../core/ApiError';
import { sectionsService } from '../content/sections/sections.service';
import { storefrontFields } from '../catalog/storefrontFields';
import { buildMeta, parsePagination, type PaginationMeta } from '../../core/pagination';
import { execute, insert } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { storage } from '../media/storage';
import { REVIEW_WINDOW_DAYS } from '../reviews/reviews.service';
import {
  CARD_PRICE_SQL,
  storefrontRepository,
  type CardVariantRow,
  type CartRow,
  type StorefrontProductDetailRow,
  type StorefrontProductRow,
} from './storefront.repository';
import { shopId, tenancy } from '../../platform/tenancy/context';
import { callingCodeFor } from '../../platform/geo/phone';
import { eventBus } from '../../platform/events/eventBus';
import { resourceSnapshot } from '../../platform/events/resourceSnapshots';
import { resolveGateway } from '../payments/gateway';
import { normaliseCode } from '../discounts/discountEngine';
import type { ShippingMethod } from '../shipping/shippingQuote';
import { quoteCart } from './cartQuote';
import { markets, marketContext, present, presentVariant, type Market } from '../../platform/markets/markets';
import { MissingRateError, storeAmount } from '../../platform/markets/fx';
import { isValidPostalCode, normalisePostalCode, postalCodeLabel } from '../../platform/geo/postalCodes';
import { knowsRegionsOf, regionCodeFor } from '../../platform/geo/regions';
import { DESTINATION_ENGINES } from '../../platform/tax/taxService';
import { newsletterService } from '../newsletter/newsletter.service';
import { logger } from '../../core/logger';
import { formatMoney } from '../../platform/shops/format';
import { giftCardsService, todayIn, unusableReason } from '../giftCards/giftCards.service';
import type { GiftCardRow } from '../giftCards/giftCards.repository';

/**
 * Complete ORDER BY clauses, not column names.
 *
 * These deliberately do not go through `parseSort`, which is built for the
 * admin grid's `field:direction` params and appends a direction of its own —
 * against a multi-column clause that produces `... p.id DESC ASC`, which is a
 * syntax error, so every sort but the default 500s. A whitelist lookup is both
 * the correct behaviour and the safer one: nothing the client sends reaches
 * the SQL, only the key it matches.
 */
const SORTABLE: Record<string, string> = {
  featured: 'p.is_bestseller DESC, p.total_sold DESC, p.id DESC',
  newest: 'p.published_at DESC, p.id DESC',
  price_asc: `${CARD_PRICE_SQL} ASC, p.id ASC`,
  price_desc: `${CARD_PRICE_SQL} DESC, p.id DESC`,
  rating: 'p.rating_average DESC, p.review_count DESC, p.id DESC',
  name: 'p.name ASC, p.id ASC',
  // The rest of the Online Store's sort options (Shopify's sort_by values).
  name_desc: 'p.name DESC, p.id DESC',
  best_selling: 'p.total_sold DESC, p.id DESC',
  oldest: 'p.published_at ASC, p.id ASC',
};

function orderClause(raw: unknown): string {
  const key = typeof raw === 'string' ? raw : '';
  return SORTABLE[key] ?? SORTABLE.featured;
}

function money(value: number): number {
  return Number(value.toFixed(2));
}

function imageUrl(key: string | null): string | null {
  return key ? storage.publicUrl(key) : null;
}

/**
 * Plain words for an order status on the tracking timeline.
 *
 * Carrier events arrive with their own label and keep it; only our own status
 * changes come through here. Anything unrecognised is de-underscored rather
 * than dropped, so a status added later still reads as English.
 */
const STATUS_LABELS: Record<string, string> = {
  pending: 'Order placed',
  partially_refunded: 'Partially refunded',
  confirmed: 'Order confirmed',
  packed: 'Packed and ready',
  shipped: 'Handed to the courier',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  returned: 'Returned',
  refunded: 'Refunded',
};

/**
 * A JSON column read as a list of strings.
 *
 * mysql2 hands back a parsed value for a JSON column, but these rows are also
 * written by an admin form and by seed scripts, so a string, a null, an object
 * or a list of objects all turn up in practice. Anything that is not a usable
 * string is dropped rather than rendered as "[object Object]" on a product page.
 */
function stringList(value: unknown): string[] {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return value.trim() ? [value] : [];
          }
        })()
      : value;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (entry && typeof entry === 'object') {
        const named = entry as { name?: unknown; label?: unknown; title?: unknown };
        const candidate = named.name ?? named.label ?? named.title;
        return typeof candidate === 'string' ? candidate.trim() : '';
      }
      return '';
    })
    .filter((entry) => entry.length > 0);
}

/**
 * Key ingredients, which are written either as plain names or as
 * `{ name, benefit }` pairs. The pair is the more useful shape on a product
 * page, so it is kept when it is there rather than flattened to a name.
 */
function keyIngredients(value: unknown): { name: string; benefit: string | null }[] {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return [];
          }
        })()
      : value;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === 'string') return { name: entry.trim(), benefit: null };
      if (entry && typeof entry === 'object') {
        const named = entry as { name?: unknown; benefit?: unknown; description?: unknown };
        const name = typeof named.name === 'string' ? named.name.trim() : '';
        const benefit = named.benefit ?? named.description;
        return { name, benefit: typeof benefit === 'string' && benefit.trim() ? benefit.trim() : null };
      }
      return { name: '', benefit: null };
    })
    .filter((entry) => entry.name.length > 0);
}

function sentenceCase(value: string): string {
  return value.replace(/^./, (character) => character.toUpperCase());
}

function statusLabel(code: string | null): string {
  if (!code) return 'Update';
  return STATUS_LABELS[code] ?? sentenceCase(code.replace(/_/g, ' '));
}

/**
 * How long after publication a product may still call itself new.
 *
 * Six weeks is roughly the shelf life of the claim in cosmetics: long enough to
 * cover a launch and the first restock, short enough that the tag still means
 * something when a shopper sees it.
 */
export const NEW_WINDOW_DAYS = 45;

/** The one merchandising tag a card may wear, or nothing at all. */
export interface ProductTag {
  key: 'custom' | 'bestseller' | 'new';
  label: string;
  /** How to draw it. The storefront owns the colours; this is the intent. */
  tone: 'dark' | 'accent';
}

function daysSince(value: Date | string | null): number | null {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return (Date.now() - at.getTime()) / 86_400_000;
}

/**
 * The tag a product has earned, if any.
 *
 * Three rules, in order, and the first one that fits wins:
 *
 *  1. A badge someone wrote by hand — "Limited edition", "Award winner" — which
 *     beats the automatic ones because it is the more specific claim. Honoured
 *     only until `badge_expires_at`; a campaign nobody remembers to switch off
 *     is the usual way these go stale.
 *  2. Bestseller.
 *  3. New, which is derived from the publication date rather than trusted from
 *     the flag. `is_new` left on since spring is the single most common way a
 *     storefront ends up lying to people, so the flag only opens the window —
 *     the calendar closes it.
 *
 * Nothing else earns a tag. A label on every card is a label on none: the point
 * of the thing is that most products do not have one.
 */
export function productTag(row: StorefrontProductRow): ProductTag | null {
  const custom = row.badge?.trim() ?? '';
  // A campaign nobody remembers to switch off is the usual way these go stale,
  // so a badge past its expiry is simply not there.
  const badgeLive =
    custom.length > 0 && (row.badge_expires_at === null || new Date(row.badge_expires_at).getTime() > Date.now());
  const normalised = custom.toLowerCase();
  const saysBestseller = normalised === 'bestseller' || normalised === 'best seller';
  const saysNew = normalised === 'new';

  // Bespoke wording wins, because it is the more specific claim: "Limited
  // edition" says something no flag can. But a badge that merely spells out one
  // of the automatic claims is treated as intent, not as an override — someone
  // typing "New" into the box means the same thing as ticking the box, and must
  // not thereby escape the window that stops the claim going stale.
  if (badgeLive && !saysBestseller && !saysNew) return { key: 'custom', label: custom, tone: 'dark' };

  if (row.is_bestseller === 1 || (badgeLive && saysBestseller)) {
    return { key: 'bestseller', label: 'Best seller', tone: 'dark' };
  }

  // The flag marks intent, the calendar enforces it. Both are required: a
  // merchandiser decides what counts as a launch, and the window makes sure the
  // claim lapses without anyone having to remember it. Nothing is tagged new
  // merely for having been created, or a bulk import would label the whole
  // catalogue at once.
  const age = daysSince(row.published_at);
  if ((row.is_new === 1 || (badgeLive && saysNew)) && age !== null && age <= NEW_WINDOW_DAYS) {
    return { key: 'new', label: 'New', tone: 'accent' };
  }

  return null;
}

function presentCard(row: StorefrontProductRow) {
  // Falls back to the cached min_price only if a product somehow has no active
  // variant to quote — it should not, but a card with no price at all is worse.
  // In the shopper's market: their currency, adjusted and rounded.
  const storePrice = row.card_price !== null ? Number(row.card_price) : row.min_price === null ? null : Number(row.min_price);
  const storeMrp = row.card_mrp === null ? null : Number(row.card_mrp);
  // A market's fixed price for the quoted variant, when it has one.
  const quoted = row.card_variant_id && storePrice !== null ? presentVariant(Number(row.card_variant_id), storePrice, storeMrp) : null;
  const price = quoted ? quoted.price : present(storePrice);
  const mrp = quoted ? quoted.mrp : present(storeMrp);
  // Only claim a discount when there genuinely is one — an MRP equal to the
  // price rendered as "0% off" is the sort of thing that erodes trust fast.
  const hasOffer = price !== null && mrp !== null && mrp > price;

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    subtitle: row.subtitle,
    short_description: row.short_description,
    price,
    mrp: hasOffer ? mrp : null,
    discount_percent: hasOffer ? Math.round(((mrp - price) / mrp) * 100) : null,
    image: imageUrl(row.primary_image_key),
    image_alt: row.primary_image_alt ?? row.name,
    category: row.category_slug ? { slug: row.category_slug, name: row.category_name } : null,
    /**
     * The one tag this product has earned, already resolved.
     *
     * Decided here rather than on the client so the shelf, the product page and
     * the "pairs well with" rail cannot disagree about whether something is
     * still new — and so an expired badge is absent from the payload rather
     * than sent and hidden in the browser.
     */
    tag: productTag(row),
    // Kept for anything still reading the raw flags. `tag` is the one to draw.
    is_new: row.is_new === 1,
    is_bestseller: row.is_bestseller === 1,
    badge: row.badge,
    rating: Number(row.rating_average),
    review_count: row.review_count,
    in_stock: Number(row.total_inventory) > 0,
  };
}

/**
 * The same cards, with the buyable rows behind them attached.
 *
 * A shelf card now carries an "Add to cart" button, and a button needs a
 * variant id to have anything to add. Sizes ride along so a card can offer
 * "30 ml / 50 ml" without a second request per tile, and the gallery rides
 * along so the card can page through a product's photographs in place.
 *
 * Three queries for a page of cards, not three per card.
 */
export async function cardsWithVariants(rows: StorefrontProductRow[]) {
  const cards = rows.map(presentCard);
  if (cards.length === 0) return cards;

  const ids = rows.map((row) => row.id);
  const [variantRows, imageRows] = await Promise.all([
    storefrontRepository.cardVariants(ids),
    storefrontRepository.cardImages(ids),
  ]);

  const byProduct = new Map<number, ReturnType<typeof presentCardVariant>[]>();
  for (const variant of variantRows) {
    const list = byProduct.get(variant.product_id);
    const presented = presentCardVariant(variant);
    if (list) list.push(presented);
    else byProduct.set(variant.product_id, [presented]);
  }

  const galleries = new Map<number, { url: string; alt: string }[]>();
  for (const image of imageRows) {
    const url = imageUrl(image.storage_key);
    if (!url) continue;
    const gallery = galleries.get(image.product_id) ?? [];
    // A shelf card is a glance, not a lookbook. Past half a dozen the dots
    // stop being countable and the carousel stops being a shortcut.
    if (gallery.length >= CARD_GALLERY_LIMIT) continue;
    gallery.push({ url, alt: image.alt_text ?? '' });
    galleries.set(image.product_id, gallery);
  }

  return cards.map((card) => ({
    ...card,
    variants: byProduct.get(card.id) ?? [],
    // Always at least the primary image, so the carousel and the still card are
    // the same component reading the same field.
    images: (galleries.get(card.id) ?? (card.image ? [{ url: card.image, alt: '' }] : [])).map((image) => ({
      url: image.url,
      // An untitled photograph still has to say something to a screen reader.
      alt: image.alt || card.image_alt,
    })),
  }));
}

/** How many photographs a shelf card will page through. */
const CARD_GALLERY_LIMIT = 6;

function presentCardVariant(variant: CardVariantRow) {
  const { price, mrp } = presentVariant(variant.id, Number(variant.price), variant.mrp === null ? null : Number(variant.mrp));
  return {
    id: variant.id,
    // A pill reads better as "30 ml" than as the full variant title, so the
    // size line wins where an author wrote one.
    title: variant.size_description?.trim() || variant.variant_title || null,
    price,
    mrp: mrp !== null && mrp > price ? mrp : null,
    // Untracked stock is always sellable — made to order, or a service line.
    in_stock: variant.track_inventory === 0 || Number(variant.available) > 0,
    is_default: variant.is_default === 1,
  };
}

/** A price typed by the shopper, in their market's currency, as the store's own. */
function inStoreCurrency(amount: number | undefined): number | undefined {
  if (amount === undefined || amount === null || !Number.isFinite(Number(amount))) return undefined;
  const market = marketContext.current();
  return market.rate === 1 && market.adjustmentPercent === 0 ? Number(amount) : storeAmount(Number(amount), market);
}

/** The gift cards on a bag, as ids in the order they were applied. */
function giftCardIdsOf(cart: Pick<CartRow, 'gift_card_ids'>): number[] {
  let value: unknown = cart.gift_card_ids;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  return Array.isArray(value) ? value.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [];
}

export const storefrontService = {
  async listProducts(queryParams: Record<string, unknown>): Promise<{
    products: unknown[];
    pagination: PaginationMeta;
    currency: string;
  }> {
    const page = parsePagination({ ...queryParams, limit: queryParams.limit ?? 24 });
    const orderBy = orderClause(queryParams.sort);
    const filters = {
      search: queryParams.q as string | undefined,
      categorySlug: queryParams.category as string | undefined,
      collectionSlug: queryParams.collection as string | undefined,
      concernSlug: queryParams.concern as string | undefined,
      skinTypeSlug: queryParams.skin_type as string | undefined,
      // The shopper filters in the prices they see: their market's currency.
      minPrice: inStoreCurrency(queryParams.min_price as number | undefined),
      maxPrice: inStoreCurrency(queryParams.max_price as number | undefined),
      inStockOnly: queryParams.in_stock as boolean | undefined,
    };

    const [rows, total] = await Promise.all([
      storefrontRepository.listProducts(filters, orderBy, page.limit, page.offset),
      storefrontRepository.countProducts(filters),
    ]);

    return { products: await cardsWithVariants(rows), pagination: buildMeta(total, page), currency: marketContext.current().currency };
  },

  async getProduct(slug: string) {
    const currency = marketContext.current().currency;
    const row = await storefrontRepository.findProductBySlug(slug);
    if (!row) throw ApiError.notFound('Product');

    const [variants, images, curated, shadeRows, sections, productFields] = await Promise.all([
      storefrontRepository.variantsFor(row.id),
      storefrontRepository.imagesFor(row.id),
      storefrontRepository.curatedRelated(row.id, 4),
      storefrontRepository.shadesFor(row.id),
      sectionsService.publicFor('product', row.id),
      storefrontFields('product', [row.id]),
    ]);
    const variantFields = await storefrontFields('variant', variants.map((variant) => Number(variant.id)));

    // Hand-picked first, then topped up from the category so the rail is never
    // empty on a product nobody has curated yet.
    const filler = await storefrontRepository.relatedProducts(
      row.id,
      row.category_id,
      Math.max(0, 4 - curated.length),
      curated.map((item) => item.id),
    );
    const related = [...curated, ...filler];

    const shadeImageRows = await storefrontRepository.shadeImages(
      shadeRows.map((shade) => Number(shade.id)),
    );
    const shadeImages = new Map<number, typeof shadeImageRows>();
    for (const image of shadeImageRows) {
      const key = Number(image.option_value_id);
      shadeImages.set(key, [...(shadeImages.get(key) ?? []), image]);
    }

    /**
     * Options grouped for the picker. A shade that cannot be bought is still
     * listed — struck through and unselectable — because "gemini is sold out"
     * is information, and silently dropping it looks like it never existed.
     */
    const optionGroups = new Map<number, Record<string, unknown>>();
    for (const shade of shadeRows) {
      const optionId = Number(shade.option_id);
      if (!optionGroups.has(optionId)) {
        optionGroups.set(optionId, {
          id: optionId,
          name: shade.option_name,
          display_type: shade.display_type,
          values: [],
        });
      }
      const id = Number(shade.id);
      (optionGroups.get(optionId)!.values as unknown[]).push({
        id,
        value: shade.value,
        descriptor: shade.descriptor ?? null,
        badge: shade.badge ?? null,
        description: shade.description ?? null,
        swatch_hex: shade.swatch_hex ?? null,
        swatch: shade.swatch_key ? imageUrl(String(shade.swatch_key)) : null,
        is_sold_out: Number(shade.sellable_units ?? 0) <= 0,
        price: shade.price === null || shade.price === undefined ? null : present(Number(shade.price)),
        images: (shadeImages.get(id) ?? []).map((image) => ({
          url: imageUrl(String(image.storage_key)),
          alt: (image.alt_override as string | null) ?? (image.alt_text as string | null) ?? row.name,
          is_primary: Number(image.is_primary) === 1,
        })),
      });
    }

    const detail = row as StorefrontProductDetailRow;

    return {
      product: {
        ...presentCard(row),
        description: detail.description,
        full_inci: detail.full_inci,
        texture: detail.texture,
        scent: detail.scent,
        suitability: detail.suitability_note,
        patch_test: detail.patch_test_note,
        routine_position: detail.routine_position,
        time_of_day: detail.time_of_day,
        country_of_origin: detail.country_of_origin,
        shelf_life_months: detail.shelf_life_months,
        pao_months: detail.pao_months,
        template_suffix: (detail as { template_suffix?: string | null }).template_suffix ?? null,

        // What it does, and who it is for.
        benefits: stringList(detail.benefits),
        key_ingredients: keyIngredients(detail.key_ingredients),
        ingredient_highlights: detail.ingredient_highlights,
        free_from: stringList(detail.free_from),
        skin_types: stringList(detail.skin_types),
        skin_concerns: stringList(detail.skin_concerns),
        contraindications: detail.contraindications,
        fragrance_disclosure: detail.fragrance_disclosure,
        formulation_type: detail.formulation_type,
        ph_level: detail.ph_level,
        finish: detail.finish,
        is_hypoallergenic: detail.is_hypoallergenic === 1,
        is_non_comedogenic: detail.is_non_comedogenic === 1,
        pregnancy_safe: detail.pregnancy_safe,

        // How to use it.
        usage_instructions: detail.usage_instructions,
        application_method: detail.application_method,
        usage_frequency: detail.usage_frequency,
        best_used_with: stringList(detail.best_used_with),
        results_timeline: detail.results_timeline,

        // How it feels, and what it comes in.
        texture_description: detail.texture_description,
        absorption_rate: detail.absorption_rate,
        feel_on_skin: detail.feel_on_skin,
        packaging_type: detail.packaging_type,
        packaging_material: detail.packaging_material,
        is_recyclable: detail.is_recyclable === 1,
        is_refillable: detail.is_refillable === 1,
        is_eco_friendly: detail.is_eco_friendly === 1,
        storage_instructions: detail.storage_instructions,
        disposal_instructions: detail.disposal_instructions,

        certifications: stringList(detail.certifications),
        claims: stringList(detail.claims),
        awards: stringList(detail.awards),
        press_features: stringList(detail.press_features),
        regulatory_approvals: stringList(detail.regulatory_approvals),

        /**
         * The declarations an Indian listing has to carry.
         *
         * Legal Metrology (Packaged Commodities) Rule 6 and the Cosmetics Rules
         * 2020 require the maker, the marketer, the licence number, the country
         * of origin and a customer care contact to be on the listing itself.
         * Grouped rather than scattered so the page can render "we are missing
         * three of these" instead of quietly omitting them one at a time.
         */
        compliance: {
          manufacturer_name: detail.manufacturer_name,
          manufacturer_address: detail.manufacturer_address,
          marketed_by_name: detail.marketed_by_name,
          marketed_by_address: detail.marketed_by_address,
          manufacturing_licence_no: detail.manufacturing_licence_no,
          customer_care_contact: detail.customer_care_contact,
          country_of_origin: detail.country_of_origin,
        },

        seo: {
          title: detail.meta_title ?? `${row.name} | ${tenancy.current().name}`,
          description: detail.meta_description ?? detail.short_description,
        },
        // A row whose file has no storage key resolves to no URL, and a gallery
        // entry with no URL is a broken <img> on the product page — dropped
        // here rather than shipped for the client to guard against, which is
        // also what lets the storefront's own type say `url: string`.
        images: images
          .map((image) => ({
            url: imageUrl(image.storage_key),
            alt: image.alt_text ?? row.name,
            is_primary: image.is_primary === 1,
          }))
          .filter((image): image is { url: string; alt: string; is_primary: boolean } => image.url !== null),
        variants: variants.map((variant) => ({
          id: variant.id,
          sku: variant.sku,
          title: variant.variant_title,
          ...(() => {
            const priced = presentVariant(variant.id, Number(variant.price), variant.mrp === null ? null : Number(variant.mrp));
            return { price: priced.price, mrp: priced.mrp !== null && priced.mrp > priced.price ? priced.mrp : null };
          })(),
          is_default: variant.is_default === 1,
          /** "30 ml — about six weeks of nightly use", written by the merchant. */
          size_description: variant.size_description ?? null,
          /** Which shades this row is, so a swatch can select a buyable variant. */
          option_value_ids: String(variant.option_value_ids ?? '')
            .split(',')
            .filter(Boolean)
            .map(Number),
          // Stock counts are a competitor's business, not a shopper's. They get
          // availability and, when it is genuinely low, a nudge.
          in_stock: variant.track_inventory === 0 || Number(variant.available) > 0,
          low_stock: variant.track_inventory === 1 && Number(variant.available) > 0 && Number(variant.available) <= 5,
          custom_fields: variantFields.get(Number(variant.id)) ?? [],
        })),
        /**
         * The merchant's own fields (Products (new) › Custom fields) that are
         * readable by the storefront, in the admin's order, references resolved.
         */
        custom_fields: productFields.get(Number(row.id)) ?? [],
        related: await cardsWithVariants(related),
        /** Shade and size pickers, with their swatches and availability. */
        options: [...optionGroups.values()],
        /** The story below the fold: claims, packaging, a model's routine. */
        sections,
      },
      currency,
    };
  },

  async navigation() {
    const [categories, collections] = await Promise.all([
      storefrontRepository.menuCategories(),
      storefrontRepository.menuCollections(),
    ]);

    const byParent = new Map<number | null, typeof categories>();
    for (const row of categories) {
      const list = byParent.get(row.parent_id) ?? [];
      list.push(row);
      byParent.set(row.parent_id, list);
    }

    return {
      categories: (byParent.get(null) ?? []).map((parent) => ({
        slug: parent.slug,
        name: parent.name,
        children: (byParent.get(parent.id) ?? []).map((child) => ({ slug: child.slug, name: child.name })),
      })),
      collections: collections.map((collection) => ({
        slug: collection.slug,
        title: collection.title,
        subtitle: collection.subtitle,
        product_count: collection.product_count,
      })),
    };
  },

  // ── cart ───────────────────────────────────────────────────────────────────

  /**
   * Totals, computed from the cart lines every single time.
   *
   * Nothing about money is trusted from the client, and nothing is cached on
   * the cart row and read back — `carts.subtotal` exists for abandoned-cart
   * reporting, not as the number anyone is charged. The arithmetic is
   * `quoteCart`'s, shared with checkout so the bag and the order agree.
   */
  async summarise(
    cart: CartRow,
    options: { paymentMethod?: 'cod' | 'online'; shippingMethod?: ShippingMethod | null; destinationRegion?: string | null } = {},
  ) {
    const market = await this.cartMarket(cart);
    const quote = await quoteCart(cart.id, {
      couponCode: cart.coupon_code,
      customerId: cart.customer_id,
      paymentMethod: options.paymentMethod,
      shippingMethod: options.shippingMethod ?? null,
      postalCode: cart.pincode,
      destinationRegion: options.destinationRegion ?? cart.region_code,
      market,
    });

    const lines = quote.lines.map(({ item, unitPrice, unitMrp, gross, discount, net }) => ({
      id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id,
      slug: item.product_slug,
      name: item.product_name,
      variant_title: item.variant_title,
      sku: item.sku,
      image: imageUrl(item.image_key),
      quantity: item.quantity,
      unit_price: unitPrice,
      unit_mrp: unitMrp > unitPrice ? unitMrp : null,
      line_total: gross,
      line_mrp: money(unitMrp * item.quantity),
      discount,
      line_total_after_discount: net,
      in_stock: item.track_inventory === 0 || Number(item.available) >= item.quantity,
      available: item.track_inventory === 0 ? null : Number(item.available),
    }));

    const freeAbove = quote.shipping.selected?.freeAbove ?? null;
    const codeApplied = quote.discounts.applied.find((applied) => !applied.automatic) ?? null;
    // Gift cards pay towards the total like a payment: the total and its tax stay as they are.
    const buyingGiftCards = quote.lines.some((line) => Number(line.item.is_gift_card) === 1);
    const giftCards = (await giftCardsService.forBag(giftCardIdsOf(cart), buyingGiftCards ? 0 : quote.total, market.currency)).map((card) =>
      buyingGiftCards ? { ...card, amount: 0, balance_after: card.balance, usable: false, message: 'Gift cards cannot be used to buy gift cards.' } : card,
    );
    const giftCardTotal = money(giftCards.reduce((sum, card) => sum + card.amount, 0));

    await storefrontRepository.touchCart(cart.id, { itemCount: quote.itemCount, subtotal: quote.subtotal, total: quote.total });

    return {
      cart: {
        token: cart.token,
        // Where the bag is priced and shipped: the shopper's country and currency.
        market: { country: market.country, currency: market.currency, name: market.name, export: market.isExport },
        items: lines,
        item_count: quote.itemCount,
        free_gift: quote.gift
          ? { variant_id: quote.gift.variantId, name: quote.gift.name, variant_title: quote.gift.variantTitle, mrp: quote.gift.mrp }
          : null,
        discount_code: cart.coupon_code
          ? {
              code: cart.coupon_code,
              applied: codeApplied !== null,
              // Why it is not taking effect: "spend ₹500 or more", "first orders only".
              message: codeApplied ? null : quote.discounts.codeRejection,
            }
          : null,
        gift_cards: giftCards,
        discounts: quote.discounts.applied.map((applied) => ({
          title: applied.title,
          code: applied.code,
          type: applied.type,
          automatic: applied.automatic,
          amount: applied.amount,
          shipping_amount: applied.shippingAmount,
        })),
        totals: {
          subtotal: quote.subtotal,
          mrp_total: quote.mrpTotal,
          savings: money(Math.max(0, quote.mrpTotal - quote.subtotal) + quote.discounts.merchandiseDiscount + quote.shipping.waived),
          discount: quote.discounts.merchandiseDiscount,
          shipping: quote.shipping.price,
          cod_fee: quote.cod.fee,
          tax_total: quote.tax.tax,
          taxable_value: quote.tax.taxable,
          shipping_tax: quote.tax.shippingTax,
          total: quote.total,
          gift_cards: giftCardTotal,
          // What is left to pay once the gift cards have paid their part.
          total_due: money(Math.max(0, quote.total - giftCardTotal)),
          tax_included_in_prices: quote.tax.addedToTotal === 0 && !quote.tax.needsAddress,
          // "Taxes calculated at checkout": a destination-taxed store with no address yet.
          tax_calculated_at_checkout: quote.tax.needsAddress,
          tax_lines: quote.tax.taxLines,
          tax_breakdown: { cgst: quote.tax.cgst, sgst: quote.tax.sgst, igst: quote.tax.igst },
          currency: quote.market.currency,
          free_shipping_threshold: freeAbove,
          amount_to_free_shipping: freeAbove === null ? null : money(Math.max(0, freeAbove - quote.discountedSubtotal)),
        },
        delivery: {
          pincode: cart.pincode,
          region: cart.region_code,
          deliverable: quote.shipping.quote.deliverable,
          calculated_at_checkout: quote.shipping.quote.needsAddress,
          message: quote.shipping.quote.reason,
          selected_method: quote.shipping.selected?.method ?? null,
          options: quote.shipping.quote.options.map((option) => ({
            method: option.method,
            name: option.name,
            price: quote.discounts.freeShipping ? 0 : option.price,
            eta_min_days: option.etaMinDays,
            eta_max_days: option.etaMaxDays,
          })),
        },
        payment_options: {
          cod: quote.cod.available,
          cod_unavailable_reason: quote.cod.reason,
          cod_fee: quote.cod.configuredFee,
        },
        has_unavailable_items: lines.some((line) => !line.in_stock),
      },
    };
  },

  async cartOr404(token: string): Promise<CartRow> {
    const cart = await storefrontRepository.findCart(token);
    if (!cart) throw ApiError.notFound('Cart');
    return cart;
  },

  /**
   * The market a cart is priced in: its country's. A country the store has
   * since stopped selling to, or whose rate has gone missing, falls back to
   * the store's own market, so the bag still opens; checkout re-checks.
   */
  async cartMarket(cart: CartRow): Promise<Market> {
    try {
      return (await markets.forCountry(cart.country_code)) ?? (await markets.forCountry(null))!;
    } catch (error) {
      if (error instanceof MissingRateError) return (await markets.forCountry(null))!;
      throw error;
    }
  },

  /** Where the shopper is buying from: prices, delivery and tax follow. */
  async setMarket(token: string, country: string) {
    const cart = await this.cartOr404(token);
    let market: Market | null;
    try {
      market = await markets.forCountry(country);
    } catch (error) {
      if (error instanceof MissingRateError) market = null;
      else throw error;
    }
    if (!market) throw ApiError.validation({ country: [`This store does not sell to ${country.toUpperCase()} yet.`] });
    await storefrontRepository.setCartMarket(cart.id, market.country, market.currency);
    return this.summarise((await this.cartOr404(token)) as CartRow);
  },

  async createCart() {
    const token = randomUUID();
    await storefrontRepository.createCart(token);
    return this.summarise(await this.cartOr404(token));
  },

  /** `preview` lets the bag show totals for a delivery or payment choice before checkout. */
  async getCart(token: string, preview: { shippingMethod?: ShippingMethod | null; paymentMethod?: 'cod' | 'online' } = {}) {
    return this.summarise(await this.cartOr404(token), preview);
  },

  async addItem(token: string, variantId: number, quantity: number) {
    const cart = await this.cartOr404(token);

    const variant = await storefrontRepository.sellableVariant(variantId);
    if (!variant) throw ApiError.notFound('Product');

    const existing = await storefrontRepository.findCartItem(cart.id, variantId);
    const wanted = (existing?.quantity ?? 0) + quantity;

    if (variant.track_inventory === 1 && wanted > Number(variant.available)) {
      throw ApiError.conflict(
        Number(variant.available) === 0
          ? `${variant.product_name} is out of stock.`
          : `Only ${variant.available} left of ${variant.product_name}.`,
      );
    }

    if (existing) {
      await storefrontRepository.setCartItemQuantity(existing.id, wanted);
    } else {
      // Price is copied from the variant at add time, so a price change mid-
      // session cannot silently alter what someone thought they were paying.
      await storefrontRepository.addCartItem({
        cartId: cart.id,
        productId: variant.product_id,
        variantId,
        quantity,
        price: variant.price,
        mrp: variant.mrp,
      });
    }

    return this.summarise(cart);
  },

  async updateItem(token: string, itemId: number, quantity: number) {
    const cart = await this.cartOr404(token);

    if (quantity === 0) {
      const removed = await storefrontRepository.removeCartItem(cart.id, itemId);
      if (removed === 0) throw ApiError.notFound('Cart item');
      return this.summarise(cart);
    }

    const items = await storefrontRepository.cartItems(cart.id);
    const item = items.find((candidate) => candidate.id === itemId);
    if (!item) throw ApiError.notFound('Cart item');

    if (item.track_inventory === 1 && quantity > Number(item.available)) {
      throw ApiError.conflict(`Only ${item.available} left of ${item.product_name}.`);
    }

    await storefrontRepository.setCartItemQuantity(itemId, quantity);
    return this.summarise(cart);
  },

  async removeItem(token: string, itemId: number) {
    const cart = await this.cartOr404(token);
    const removed = await storefrontRepository.removeCartItem(cart.id, itemId);
    if (removed === 0) throw ApiError.notFound('Cart item');
    return this.summarise(cart);
  },

  /**
   * Puts a discount code on the bag.
   *
   * A code that does not exist is refused outright. A real code that does not
   * apply yet — below its minimum spend, say — is kept, and the summary says
   * what it needs: add one more item and it switches on by itself, which is
   * what a shopper who was told "spend ₹200 more" expects to happen.
   */
  async applyDiscountCode(token: string, rawCode: string) {
    const cart = await this.cartOr404(token);
    // One field for both, as on Shopify: a gift card's code is tried first.
    const card = await giftCardsService.findByCode(rawCode);
    if (card) return this.applyGiftCard(cart, card);
    const code = normaliseCode(rawCode);
    if (!(await storefrontRepository.liveCodeExists(code))) {
      throw ApiError.validation({ code: ['That code is not valid.'] }, 'That code is not valid.');
    }
    await storefrontRepository.setCartCoupon(cart.id, code);
    return this.summarise({ ...cart, coupon_code: code } as CartRow);
  },

  async applyGiftCard(cart: CartRow, card: GiftCardRow) {
    const applied = giftCardIdsOf(cart);
    if (applied.includes(card.id)) return this.summarise(cart);
    const items = await storefrontRepository.cartItems(cart.id);
    if (items.some((item) => Number(item.is_gift_card) === 1)) {
      throw ApiError.validation({ code: ['Gift cards cannot be used to buy gift cards.'] }, 'Gift cards cannot be used to buy gift cards.');
    }
    if (applied.length >= 5) throw ApiError.validation({ code: ['Up to five gift cards can be used on one order.'] }, 'Up to five gift cards can be used on one order.');
    const market = await this.cartMarket(cart);
    const reason = unusableReason(card, market.currency, todayIn(tenancy.current().timezone));
    if (reason) throw ApiError.validation({ code: [reason] }, reason);
    const ids = [...applied, card.id];
    await storefrontRepository.setCartGiftCards(cart.id, ids);
    return this.summarise({ ...cart, gift_card_ids: ids } as CartRow);
  },

  async removeGiftCard(token: string, giftCardId: number) {
    const cart = await this.cartOr404(token);
    const ids = giftCardIdsOf(cart).filter((id) => id !== giftCardId);
    await storefrontRepository.setCartGiftCards(cart.id, ids);
    return this.summarise({ ...cart, gift_card_ids: ids } as CartRow);
  },

  async removeDiscountCode(token: string) {
    const cart = await this.cartOr404(token);
    await storefrontRepository.setCartCoupon(cart.id, null);
    return this.summarise({ ...cart, coupon_code: null } as CartRow);
  },

  /**
   * Where the bag is going — postcode, and the state where tax depends on it
   * — so delivery options, cash on delivery and tax are the real ones.
   */
  async setDelivery(token: string, rawPincode: string | null, state: string | null) {
    const cart = await this.cartOr404(token);
    const country = cart.country_code ?? tenancy.current().countryCode;
    const pincode = rawPincode ? normalisePostalCode(rawPincode) : null;
    if (pincode && !isValidPostalCode(pincode, country)) {
      throw ApiError.validation({ pincode: [`Enter a valid ${postalCodeLabel(country)}.`] });
    }
    const regionCode = state ? regionCodeFor(country, state) : null;
    if (state && !regionCode && knowsRegionsOf(country)) {
      throw ApiError.validation({ state: [`"${state}" is not a state or province we recognise.`] });
    }
    await storefrontRepository.setCartDestination(cart.id, pincode, regionCode);
    return this.summarise({ ...cart, pincode, region_code: regionCode } as CartRow);
  },

  // ── checkout ───────────────────────────────────────────────────────────────

  /**
   * Place an order.
   *
   * Every amount is recomputed here from the cart lines; the request body
   * carries only the address, the delivery method, the payment method and
   * perhaps a code. A checkout that accepts a total from the browser is a
   * checkout that can be bought from at any price.
   *
   * The quote is taken inside the transaction, after the customer is found or
   * created, because that is the first moment "first order only" and "once per
   * customer" can be decided. Each discount's use is counted with a guarded
   * increment on the coupon row, which both enforces the overall limit under
   * concurrency and serialises two checkouts racing for the last use.
   *
   * COD orders are placed as `cod_pending`; online orders as `pending` with
   * nothing paid until the gateway confirms.
   */
  async checkout(
    token: string,
    input: {
      payment_method: 'cod' | 'online';
      shipping_method?: ShippingMethod | null;
      discount_code?: string | null;
      contact: { first_name: string; last_name?: string | null; phone: string; email?: string | null };
      shipping_address: {
        line1: string;
        line2?: string | null;
        landmark?: string | null;
        city: string;
        state: string;
        state_code?: string | null;
        country?: string | null;
        pincode: string;
      };
      customer_note?: string | null;
      /** "Email me with news and offers", ticked at checkout. */
      accepts_marketing?: boolean;
    },
    meta: { ip: string | null; userAgent: string | null },
  ) {
    const cart = await this.cartOr404(token);

    const items = await storefrontRepository.cartItems(cart.id);
    if (items.length === 0) throw ApiError.conflict('Your bag is empty.');

    // Re-check stock at the moment of ordering, not at the moment of adding.
    for (const item of items) {
      if (item.track_inventory === 1 && item.quantity > Number(item.available)) {
        throw ApiError.conflict(
          Number(item.available) === 0
            ? `${item.product_name} sold out while it was in your bag.`
            : `Only ${item.available} left of ${item.product_name}.`,
        );
      }
    }

    // A paused store keeps its catalogue up but takes no orders.
    if (tenancy.current().status !== 'active') {
      throw ApiError.shopUnavailable('This store is not taking orders right now.');
    }

    // The country decides the market — the currency, the rates, whether it is
    // an export — and the state decides the tax where it follows the address.
    const shop = tenancy.current();
    const country = (input.shipping_address.country ?? cart.country_code ?? shop.countryCode).toUpperCase();
    let market: Market | null;
    try {
      market = await markets.forCountry(country);
    } catch (error) {
      if (error instanceof MissingRateError) market = null;
      else throw error;
    }
    if (!market) throw ApiError.validation({ 'shipping_address.country': [`This store does not deliver to ${country} yet.`] });
    const destinationRegion = input.shipping_address.state_code ?? regionCodeFor(country, input.shipping_address.state);
    if (!destinationRegion && !market.isExport && DESTINATION_ENGINES.has(shop.taxEngine) && knowsRegionsOf(country)) {
      throw ApiError.validation({ 'shipping_address.state': [`"${input.shipping_address.state}" is not a state or province we recognise.`] });
    }

    // The gateway that will take the money is fixed on the order at placement,
    // so the payment page opens the right one even if the default changes.
    const gateway = input.payment_method === 'online' ? await resolveGateway() : null;
    const giftCardIds = giftCardIdsOf(cart);
    // Without gift cards a gateway is needed up front; with them, only if they do not pay it all (checked below).
    if (input.payment_method === 'online' && !gateway && giftCardIds.length === 0) {
      throw ApiError.integrationNotConfigured('payments', 'Online payment is not available in this store right now. Choose cash on delivery if it is offered.');
    }

    const isCod = input.payment_method === 'cod';
    const couponCode = input.discount_code ? normaliseCode(input.discount_code) : cart.coupon_code;

    const placed = await withTransaction(async (tx) => {
      // Drawn inside the transaction so a rolled-back order does not hold a number.
      const orderNumber = await storefrontRepository.nextOrderNumber(tx);
      const { id: customerId, created: customerCreated } = await storefrontRepository.findOrCreateCustomer(
        {
          countryCode: `+${callingCodeFor(country) ?? callingCodeFor(shop.countryCode) ?? '91'}`,
          phone: input.contact.phone,
          email: input.contact.email ?? null,
          firstName: input.contact.first_name,
          lastName: input.contact.last_name ?? null,
        },
        tx,
      );

      const quote = await quoteCart(
        cart.id,
        {
          couponCode,
          customerId,
          paymentMethod: input.payment_method,
          shippingMethod: input.shipping_method ?? null,
          postalCode: input.shipping_address.pincode,
          destinationRegion,
          destinationCity: input.shipping_address.city,
          destinationLine1: input.shipping_address.line1,
          market,
        },
        tx,
      );

      const delivery = quote.shipping.selected;
      if (!quote.shipping.quote.deliverable || !delivery) {
        throw ApiError.conflict(quote.shipping.quote.reason ?? 'We cannot deliver this order to that address.', 'UNDELIVERABLE');
      }
      if (input.shipping_method && delivery.method !== input.shipping_method) {
        throw ApiError.conflict(`${sentenceCase(input.shipping_method)} delivery is not available for this address.`, 'SHIPPING_METHOD_UNAVAILABLE');
      }
      if (isCod && !quote.cod.available) {
        throw ApiError.conflict(quote.cod.reason ?? 'Cash on delivery is not available for this order.', 'COD_UNAVAILABLE');
      }
      const codeDiscount = quote.discounts.applied.find((applied) => !applied.automatic) ?? null;
      // A code the shopper is looking at in their bag must not silently vanish
      // from the order: if it no longer applies, say so and let them decide.
      if (couponCode && !codeDiscount) {
        throw ApiError.conflict(quote.discounts.codeRejection ?? 'That discount code no longer applies.', 'DISCOUNT_NOT_APPLICABLE');
      }

      const newOrderId = await insert(
        `INSERT INTO orders
           (shop_id, order_number, public_id, cart_id, customer_id, is_guest, contact_phone, contact_email, customer_name,
            currency, market_id, shop_currency, exchange_rate, order_status, payment_status, fulfillment_status, payment_method,
            subtotal, discount_total, coupon_discount, coupon_id, coupon_code, shipping_total, shipping_tax, cod_fee, tax_total,
            cgst_total, sgst_total, igst_total, tax_lines, place_of_supply_state_code, grand_total, amount_paid, amount_due,
            pincode, shipping_method, estimated_delivery_from, estimated_delivery_to, customer_note,
            source_channel, placed_at)
         VALUES (?, ?, UUID(), ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'unfulfilled', ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?,
                 DATE_ADD(CURDATE(), INTERVAL ? DAY), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, 'web', NOW())`,
        [
          shopId(),
          orderNumber,
          cart.id,
          customerId,
          input.contact.phone,
          input.contact.email ?? null,
          [input.contact.first_name, input.contact.last_name].filter(Boolean).join(' '),
          // Charged in the market's currency; the rate keeps reports in the store's.
          market.currency,
          market.id || null,
          shop.currency,
          market.rate === 1 ? 1 : 1 / market.rate,
          isCod ? 'cod_pending' : 'pending',
          isCod ? 'cod' : (gateway?.gateway.name ?? 'gift_card'),
          quote.subtotal,
          quote.discounts.merchandiseDiscount,
          codeDiscount?.amount ?? 0,
          codeDiscount?.couponId ?? null,
          codeDiscount?.code ?? null,
          quote.shipping.price,
          quote.tax.shippingTax,
          quote.cod.fee,
          quote.tax.tax,
          quote.tax.cgst,
          quote.tax.sgst,
          quote.tax.igst,
          quote.tax.taxLines.length > 0 ? JSON.stringify(quote.tax.taxLines) : null,
          quote.tax.placeOfSupply,
          quote.total,
          quote.total,
          input.shipping_address.pincode,
          delivery.method,
          delivery.etaMinDays,
          delivery.etaMaxDays,
          input.customer_note ?? null,
        ],
        tx,
      );

      // The bag's gift cards pay first, in this transaction: locked, re-checked,
      // each debit guarded by the balance. What they do not cover is due.
      // Checked again here: a gift card may have been applied before a gift card product was added.
      if (giftCardIds.length && quote.lines.some((line) => Number(line.item.is_gift_card) === 1)) {
        throw ApiError.conflict('Gift cards cannot be used to buy gift cards. Remove the gift card to continue.', 'GIFT_CARD_NOT_APPLICABLE');
      }
      const spent = await giftCardsService.spendOnOrder(newOrderId, giftCardIds, quote.total, market.currency, customerId, tx);
      const amountDue = money(Math.max(0, quote.total - spent.total));
      const paidByCards = spent.total > 0 && amountDue === 0;
      if (spent.total > 0) {
        if (amountDue > 0 && input.payment_method === 'online' && !gateway) {
          throw ApiError.integrationNotConfigured('payments', 'Online payment is not available in this store right now. Choose cash on delivery if it is offered.');
        }
        await execute(
          `UPDATE orders SET gift_card_total = ?, amount_paid = ?, amount_due = ?,
                  payment_status = IF(? = 1, 'paid', payment_status), payment_method = IF(? = 1, 'gift_card', payment_method),
                  order_status = IF(? = 1, 'confirmed', order_status), confirmed_at = IF(? = 1, NOW(), confirmed_at)
            WHERE shop_id = ? AND id = ?`,
          [spent.total, spent.total, amountDue, paidByCards ? 1 : 0, paidByCards ? 1 : 0, paidByCards ? 1 : 0, paidByCards ? 1 : 0, shopId(), newOrderId],
          tx,
        );
      }

      for (const [index, line] of quote.lines.entries()) {
        const { item } = line;
        const lineTaxed = quote.tax.lines[index];
        await execute(
          `INSERT INTO order_items
             (shop_id, order_id, product_id, variant_id, line_type, sku, product_name, variant_title, product_slug,
              image_url, hsn_code, unit_mrp, unit_price, quantity, discount_amount, taxable_amount, tax_rate,
              cgst_amount, sgst_amount, igst_amount, tax_amount, line_total)
           VALUES (?, ?, ?, ?, 'product', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            shopId(),
            newOrderId,
            item.product_id,
            item.variant_id,
            item.sku,
            item.product_name,
            item.variant_title,
            item.product_slug,
            imageUrl(item.image_key),
            item.hsn_code,
            // In the order's currency: the market's price, not the stored one.
            line.unitMrp,
            line.unitPrice,
            item.quantity,
            line.discount,
            lineTaxed.taxable,
            lineTaxed.rate,
            lineTaxed.cgst,
            lineTaxed.sgst,
            lineTaxed.igst,
            lineTaxed.tax,
            // What the line sells for: the discount is already off, so invoices,
            // refunds and returns all work from the price actually paid.
            line.net,
          ],
          tx,
        );

        await storefrontRepository.reserveStock(item.variant_id, item.quantity, newOrderId, tx);
      }

      if (quote.gift) {
        await execute(
          `INSERT INTO order_items
             (shop_id, order_id, product_id, variant_id, line_type, sku, product_name, variant_title,
              unit_mrp, unit_price, quantity, line_total)
           VALUES (?, ?, ?, ?, 'gift', ?, ?, ?, ?, 0, 1, 0)`,
          [
            shopId(),
            newOrderId,
            quote.gift.productId,
            quote.gift.variantId,
            quote.gift.sku,
            quote.gift.name,
            quote.gift.variantTitle,
            quote.gift.mrp,
          ],
          tx,
        );
        if (quote.gift.reservesInventory) await storefrontRepository.reserveStock(quote.gift.variantId, 1, newOrderId, tx);
      }

      // Count each discount's use. The guarded increment is the limit check
      // that holds under concurrency: of two checkouts racing for the last use,
      // the second updates no row and is turned away.
      for (const applied of quote.discounts.applied) {
        const counted = await storefrontRepository.countCouponUse(applied.couponId, customerId, tx);
        if (!counted) {
          throw ApiError.conflict(
            applied.automatic ? `The offer "${applied.title}" has just ended. Please review your bag.` : 'That discount code has just been used up.',
            'DISCOUNT_NOT_APPLICABLE',
          );
        }
        await execute(
          `INSERT INTO coupon_redemptions (shop_id, coupon_id, order_id, customer_id, discount_amount)
           VALUES (?, ?, ?, ?, ?)`,
          [shopId(), applied.couponId, newOrderId, customerId, money(applied.amount + applied.shippingAmount)],
          tx,
        );
      }

      await execute(
        `INSERT INTO order_addresses
           (shop_id, order_id, address_type, first_name, last_name, phone, email, line1, line2, landmark,
            city, state, state_code, pincode, country)
         VALUES (?, ?, 'shipping', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          shopId(),
          newOrderId,
          input.contact.first_name,
          input.contact.last_name ?? null,
          input.contact.phone,
          input.contact.email ?? null,
          input.shipping_address.line1,
          input.shipping_address.line2 ?? null,
          input.shipping_address.landmark ?? null,
          input.shipping_address.city,
          input.shipping_address.state,
          destinationRegion,
          input.shipping_address.pincode,
          country,
        ],
        tx,
      );

      // The address goes into the customer's address book too (as Shopify's checkout
      // does), so it is there to pick next time — once, not on every order.
      await execute(
        `INSERT INTO customer_addresses
           (shop_id, customer_id, label, first_name, last_name, phone, line1, line2, landmark, city, state, state_code, pincode,
            country, is_default_shipping, is_default_billing)
         SELECT ?, ?, 'Home', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, d.none, d.none
           FROM (SELECT IF(COUNT(*) = 0, 1, 0) AS none FROM customer_addresses
                  WHERE shop_id = ? AND customer_id = ? AND deleted_at IS NULL) d
          WHERE NOT EXISTS (SELECT 1 FROM customer_addresses
                             WHERE shop_id = ? AND customer_id = ? AND deleted_at IS NULL AND line1 = ? AND pincode = ?)`,
        [
          shopId(), customerId, input.contact.first_name, input.contact.last_name ?? null, input.contact.phone,
          input.shipping_address.line1, input.shipping_address.line2 ?? null, input.shipping_address.landmark ?? null,
          input.shipping_address.city, input.shipping_address.state, destinationRegion, input.shipping_address.pincode, country,
          shopId(), customerId, shopId(), customerId, input.shipping_address.line1, input.shipping_address.pincode,
        ],
        tx,
      );

      await execute(
        `INSERT INTO order_status_history
           (shop_id, order_id, status_type, from_status, to_status, note, actor_type, is_customer_visible)
         VALUES (?, ?, 'order', NULL, 'pending', ?, 'customer', 1)`,
        [shopId(), newOrderId, isCod ? 'Placed with cash on delivery' : 'Placed, awaiting payment'],
        tx,
      );
      for (const card of spent.cards) {
        await execute(
          `INSERT INTO order_status_history
             (shop_id, order_id, status_type, from_status, to_status, note, actor_type, is_customer_visible)
           VALUES (?, ?, 'payment', NULL, ?, ?, 'customer', 1)`,
          [shopId(), newOrderId, paidByCards ? 'paid' : 'pending', `${formatMoney(card.amount, { currency: market.currency })} paid with gift card •••• ${card.last}`],
          tx,
        );
      }

      await storefrontRepository.markCartConverted(cart.id, newOrderId, tx);

      // The order as apps and automations see it, committed with the order.
      const snapshot = (await resourceSnapshot('order', newOrderId, tx)) ?? { id: newOrderId };
      await eventBus.publish('orders/create', snapshot, { resourceType: 'order', resourceId: newOrderId, actorType: 'customer', actorId: customerId, tx });
      // Paid in full by gift cards: confirmed now, as a paid online order is when its payment lands.
      if (paidByCards) await eventBus.publish('orders/paid', snapshot, { resourceType: 'order', resourceId: newOrderId, actorType: 'customer', actorId: customerId, tx });
      if (customerCreated) {
        const customer = (await resourceSnapshot('customer', customerId, tx)) ?? { id: customerId };
        await eventBus.publish('customers/create', customer, { resourceType: 'customer', resourceId: customerId, actorType: 'customer', actorId: customerId, tx });
      }
      return { orderId: newOrderId, orderNumber, quote, customerId, giftCards: spent, amountDue, paidByCards };
    });

    // The mailing list, after the order is safe: a failure here must never
    // undo a sale. Ticking the box subscribes; otherwise an existing
    // subscriber is simply linked to the customer they have now become.
    const email = input.contact.email?.trim();
    if (email) {
      try {
        if (input.accepts_marketing) {
          await newsletterService.subscribe(
            { email, source: 'checkout', customerId: placed.customerId, countryCode: market.country, wording: 'Email me with news and offers' },
            meta,
          );
        } else {
          await newsletterService.linkCustomer(email, placed.customerId, meta);
        }
      } catch (error) {
        logger.warn('checkout.newsletter_failed', { order: placed.orderNumber, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const { quote } = placed;

    return {
      order: {
        id: placed.orderId,
        order_number: placed.orderNumber,
        status: 'pending',
        payment_method: placed.paidByCards ? 'gift_card' : input.payment_method,
        payment_status: placed.paidByCards ? 'paid' : isCod ? 'cod_pending' : 'pending',
        shipping_method: quote.shipping.selected?.method ?? null,
        subtotal: quote.subtotal,
        discount: quote.discounts.merchandiseDiscount,
        shipping: quote.shipping.price,
        cod_fee: quote.cod.fee,
        tax: quote.tax.tax,
        tax_lines: quote.tax.taxLines,
        total: quote.total,
        gift_cards: placed.giftCards.total,
        total_due: placed.amountDue,
        currency: market.currency,
        // Explicitly not a payment confirmation. The storefront shows a
        // "we'll confirm shortly" state for online orders until the gateway
        // webhook says otherwise.
        payment_required: !isCod && !placed.paidByCards,
        contact_phone: input.contact.phone,
      },
    };
  },

  /**
   * Everything a shopper needs to answer "where is my order?" without an account.
   *
   * The order number plus the phone it was placed with is the whole credential,
   * so this returns what a customer is entitled to see and nothing more: no
   * internal notes, no risk score, no email, no other order. The address comes
   * back because the commonest reason to look an order up is to check that the
   * address is right while it can still be changed.
   */
  async trackOrder(orderNumber: string, phone: string) {
    const row = await storefrontRepository.findOrderByNumber(orderNumber, phone);
    if (!row) throw ApiError.notFound('Order');

    const [items, shipments, timeline, address] = await Promise.all([
      storefrontRepository.trackedOrderItems(row.id),
      storefrontRepository.trackedShipments(row.id),
      storefrontRepository.trackedTimeline(row.id),
      storefrontRepository.trackedAddress(row.id),
    ]);

    const delivered = row.order_status === 'delivered' || row.delivered_at !== null;
    const reviewDeadline = row.delivered_at
      ? new Date(new Date(row.delivered_at).getTime() + REVIEW_WINDOW_DAYS * 86_400_000)
      : null;
    const windowOpen = reviewDeadline === null ? delivered : Date.now() <= reviewDeadline.getTime();

    return {
      order: {
        order_number: row.order_number,
        status: row.order_status,
        payment_status: row.payment_status,
        fulfillment_status: row.fulfillment_status,
        payment_method: row.payment_method,
        customer_name: row.customer_name,
        placed_at: row.placed_at,
        confirmed_at: row.confirmed_at,
        packed_at: row.packed_at,
        shipped_at: row.shipped_at,
        delivered_at: row.delivered_at,
        cancelled_at: row.cancelled_at,
        cancel_reason: row.cancel_reason,
        shipping_method: row.shipping_method,
        estimated_delivery_from: row.estimated_delivery_from,
        estimated_delivery_to: row.estimated_delivery_to,
        // The money the customer paid in, which may be another market's.
        currency: row.currency,
        totals: {
          subtotal: Number(row.subtotal),
          discount: Number(row.discount_total),
          shipping: Number(row.shipping_total),
          cod_fee: Number(row.cod_fee),
          tax: Number(row.tax_total),
          total: Number(row.grand_total),
          paid: Number(row.amount_paid),
          due: Number(row.amount_due),
        },
      },
      items: items.map((item) => ({
        id: item.id,
        name: item.product_name,
        variant_title: item.variant_title,
        sku: item.sku,
        // The product page is only linked when the product is still listed —
        // a link from an old order to a retired product is a 404 with extra steps.
        slug: item.product_deleted_at === null ? item.product_slug : null,
        image: imageUrl(item.image_key) ?? item.image_url,
        quantity: item.quantity,
        cancelled_quantity: item.cancelled_quantity,
        returned_quantity: item.returned_quantity,
        unit_price: Number(item.unit_price),
        unit_mrp: item.unit_mrp === null ? null : Number(item.unit_mrp),
        discount: Number(item.discount_amount),
        line_total: Number(item.line_total),
        is_gift: item.line_type === 'gift',
        /** Why the "write a review" link is or is not offered on this line. */
        review: {
          can_review:
            item.line_type === 'product' && delivered && windowOpen && item.review_id === null && item.product_deleted_at === null,
          already_reviewed: item.review_id !== null,
          closes_at: reviewDeadline,
        },
      })),
      shipments: shipments.map((shipment) => ({
        shipment_number: shipment.shipment_number,
        carrier: shipment.carrier_name,
        awb_number: shipment.awb_number,
        tracking_url:
          shipment.tracking_url ??
          (shipment.awb_number && shipment.tracking_url_template
            ? shipment.tracking_url_template.replace('{awb}', shipment.awb_number)
            : null),
        status: shipment.status,
        shipping_mode: shipment.shipping_mode,
        shipped_at: shipment.shipped_at,
        estimated_delivery_at: shipment.estimated_delivery_at,
        delivered_at: shipment.delivered_at,
        // Shown so an undelivered parcel explains itself rather than going quiet.
        ndr_reason: shipment.ndr_reason,
      })),
      timeline: timeline.map((event) => ({
        source: event.source,
        code: event.code,
        // Carrier events keep the carrier's own wording — only the first letter
        // is lifted, so "label generated" does not sit mid-sentence in a list
        // of properly capitalised steps.
        label: event.label ? sentenceCase(event.label) : statusLabel(event.code),
        description: event.description,
        location: event.location,
        happened_at: event.happened_at,
      })),
      shipping_address: address
        ? {
            name: address.name,
            line1: address.line1,
            line2: address.line2,
            landmark: address.landmark,
            city: address.city,
            state: address.state,
            pincode: address.pincode,
          }
        : null,
    };
  },
};
