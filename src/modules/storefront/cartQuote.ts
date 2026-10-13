import { pool, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopPricing } from '../../platform/commerce/shopPricing';
import { roundMoney } from '../../platform/money/currency';
import type { TaxAddress } from '../../platform/tax/TaxCalculator';
import { taxService, type TaxQuote } from '../../platform/tax/taxService';
import { shopId, tenancy } from '../../platform/tenancy/context';
import { amountIn, marketContext, priceIn, variantPriceIn, type Market } from '../../platform/markets/markets';
import { discountEngine, type DiscountResult } from '../discounts/discountEngine';
import { shippingQuote, type ShippingMethod, type ShippingOption, type ShippingQuote } from '../shipping/shippingQuote';
import { storefrontRepository, type CartItemRow } from './storefront.repository';

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** "India" for IN: messages a shopper reads name the country. */
function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The price of a basket, worked out once, in the order a till would:
 *
 *   1. discounts — the code on the cart and the shop's automatic offers,
 *      allocated back onto the lines they apply to;
 *   2. delivery — from the shop's rate table, for the discounted value and the
 *      basket's weight, to the postcode if one is known;
 *   3. cash on delivery — the shop's COD rule and the postcode's own say;
 *   4. tax — per line, on what each line actually sells for after discount,
 *      and on delivery where the destination taxes it.
 *
 * The cart summary and checkout both call this, so what the bag shows is what
 * the order is placed for: the two used to compute tax separately and could
 * have drifted. Checkout calls it inside its transaction, once the customer is
 * known, which is when "first order only" and per-customer limits can finally
 * be decided.
 */

export interface QuoteOptions {
  couponCode?: string | null;
  customerId?: number | null;
  paymentMethod?: 'cod' | 'online';
  shippingMethod?: ShippingMethod | null;
  postalCode?: string | null;
  destinationRegion?: string | null;
  /** The rest of the address, when checkout has it: street-level tax services use it. */
  destinationCity?: string | null;
  destinationLine1?: string | null;
  /** The market the basket is priced in; omitted, the store's own. */
  market?: Market;
}

export interface QuotedLine {
  item: CartItemRow;
  /** The unit price in the basket's market, and its MRP there. */
  unitPrice: number;
  unitMrp: number;
  gross: number;
  discount: number;
  net: number;
}

export interface QuotedGift {
  couponId: number;
  variantId: number;
  productId: number;
  name: string;
  variantTitle: string | null;
  sku: string;
  mrp: number;
  reservesInventory: boolean;
}

export interface CartQuote {
  market: Market;
  lines: QuotedLine[];
  itemCount: number;
  subtotal: number;
  mrpTotal: number;
  discounts: DiscountResult;
  discountedSubtotal: number;
  gift: QuotedGift | null;
  shipping: {
    quote: ShippingQuote;
    selected: ShippingOption | null;
    price: number;
    /** What delivery would have cost without a free-delivery discount. */
    waived: number;
  };
  cod: { available: boolean; reason: string | null; fee: number; configuredFee: number | null };
  tax: TaxQuote;
  total: number;
}

interface GiftRow extends RowDataPacket {
  id: number;
  product_id: number;
  sku: string;
  variant_title: string | null;
  mrp: string;
  track_inventory: number;
  product_name: string;
  available: number;
}

/**
 * A free gift's variant. Not `sellableVariant`: gifts are usually samples kept
 * off the catalogue, so visibility is not required — only that the variant and
 * its product still exist and, if stock is tracked, that there is one to give.
 */
async function giftVariant(variantId: number, exec: Executor): Promise<GiftRow | null> {
  return queryOne<GiftRow>(
    `SELECT v.id, v.product_id, v.sku, v.variant_title, v.mrp, v.track_inventory, p.name AS product_name,
            COALESCE((SELECT SUM(ii.quantity_available) FROM inventory_items ii
                       WHERE ii.shop_id = v.shop_id AND ii.variant_id = v.id), 0) AS available
       FROM product_variants v
       JOIN products p ON p.id = v.product_id AND p.shop_id = v.shop_id
      WHERE v.shop_id = ? AND v.id = ? AND v.deleted_at IS NULL AND v.status = 'active' AND p.deleted_at IS NULL
      LIMIT 1`,
    [shopId(), variantId],
    exec,
  );
}

export async function quoteCart(cartId: number, options: QuoteOptions = {}, exec: Executor = pool): Promise<CartQuote> {
  const shop = tenancy.current();
  const market = options.market ?? marketContext.current();
  const round = (value: number) => roundMoney(value, market.currency);
  const items = await storefrontRepository.cartItems(cartId, exec);
  const pricing = await shopPricing.get();

  // 0. Prices in the basket's market. An export carries no domestic tax, so a
  // tax-inclusive price is first taken back to its price before tax.
  const exTax = (item: CartItemRow, amount: number) =>
    market.isExport && Number(item.tax_inclusive) === 1 && Number(item.tax_rate) > 0 ? amount / (1 + Number(item.tax_rate) / 100) : amount;
  // A market's fixed prices are final (not converted, and not reduced for export tax).
  const priced = items.map((item) => {
    const { price, mrp } = variantPriceIn(market, item.variant_id, exTax(item, Number(item.unit_price)), exTax(item, Number(item.unit_mrp)));
    return { item, unitPrice: price, unitMrp: mrp !== null && mrp > price ? mrp : price };
  });

  // 1. Discounts, with the store's amounts (minimum spend, fixed discounts)
  // expressed in the basket's currency. Gift cards being bought are money, not
  // merchandise: no discount reaches them (nor counts them towards a minimum).
  const isGiftCard = (item: CartItemRow) => Number(item.is_gift_card) === 1;
  const merchandise = priced.map((entry, index) => ({ entry, index })).filter(({ entry }) => !isGiftCard(entry.item));
  const evaluated = await discountEngine.evaluate(
    merchandise.map(({ entry: { item, unitPrice } }) => ({
      productId: item.product_id,
      variantId: item.variant_id,
      quantity: item.quantity,
      unitPrice,
    })),
    {
      code: options.couponCode ?? null,
      customerId: options.customerId ?? null,
      money: { currency: market.currency, convert: (amount) => amountIn(market, amount) },
    },
    exec,
  );
  // Back onto every line of the basket, gift cards at zero.
  const lineDiscounts = priced.map((_entry, index) => {
    const position = merchandise.findIndex((candidate) => candidate.index === index);
    return position < 0 ? 0 : (evaluated.lineDiscounts[position] ?? 0);
  });
  const discounts: DiscountResult = { ...evaluated, lineDiscounts };

  const lines: QuotedLine[] = priced.map(({ item, unitPrice, unitMrp }, index) => {
    const gross = round(unitPrice * item.quantity);
    const discount = Math.min(gross, discounts.lineDiscounts[index] ?? 0);
    return { item, unitPrice, unitMrp, gross, discount, net: round(gross - discount) };
  });
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = round(lines.reduce((sum, line) => sum + line.gross, 0));
  const mrpTotal = round(lines.reduce((sum, line) => sum + line.unitMrp * line.item.quantity, 0));
  const discountedSubtotal = round(lines.reduce((sum, line) => sum + line.net, 0));

  let gift: QuotedGift | null = null;
  if (discounts.gift) {
    const row = await giftVariant(discounts.gift.variantId, exec);
    const inStock = row !== null && (!discounts.gift.reservesInventory || row.track_inventory === 0 || Number(row.available) > 0);
    // An offer whose gift has run out still places the order — without the gift.
    if (row && inStock) {
      gift = {
        couponId: discounts.gift.couponId,
        variantId: row.id,
        productId: row.product_id,
        name: row.product_name,
        variantTitle: row.variant_title,
        sku: row.sku,
        mrp: priceIn(market, Number(row.mrp)),
        reservesInventory: discounts.gift.reservesInventory,
      };
    }
  }

  // 2. Delivery, on the discounted value ("free over ₹999" means paying ₹999),
  // for the zone the country, postcode and state fall in. Rates are the
  // store's, in its currency: the basket's value goes back to it for the
  // bands, and the prices come out in the basket's currency.
  // Gift cards are delivered by email: only the rest of the basket ships (and counts
  // towards "free over"); a basket of gift cards alone needs no delivery at all.
  const shippable = lines.filter((line) => !isGiftCard(line.item));
  const giftCardLines = lines.length - shippable.length;
  const shippableValue = round(shippable.reduce((sum, line) => sum + line.net, 0));
  const weightGrams = shippable.reduce((sum, line) => sum + Number(line.item.weight_grams ?? 0) * line.item.quantity, 0);
  const storeQuote =
    itemCount === 0
      ? { deliverable: true, needsAddress: false, reason: null, zone: null, options: [], codAvailable: true }
      : shippable.length === 0
        ? {
            deliverable: true,
            needsAddress: false,
            reason: null,
            zone: null,
            options: [{ method: 'standard' as ShippingMethod, name: 'Delivered by email', price: 0, basePrice: 0, freeAbove: null, etaMinDays: 0, etaMaxDays: 0 }],
            codAvailable: false,
          }
      : await shippingQuote.quote({
          subtotal: market.rate === 1 ? shippableValue : shippableValue / market.rate,
          weightGrams,
          postalCode: options.postalCode ?? null,
          region: options.destinationRegion ?? null,
          country: market.country,
        });
  const quote = {
    ...storeQuote,
    options: storeQuote.options.map((option) => ({
      ...option,
      price: amountIn(market, option.price),
      basePrice: amountIn(market, option.basePrice),
      freeAbove: option.freeAbove === null ? null : amountIn(market, option.freeAbove),
    })),
  };
  const selected =
    quote.options.find((option) => option.method === options.shippingMethod) ??
    quote.options.find((option) => option.method === 'standard') ??
    quote.options[0] ??
    null;
  const listed = selected?.price ?? 0;
  const shippingPrice = discounts.freeShipping ? 0 : listed;
  const waived = discounts.freeShipping ? listed : 0;
  if (waived > 0) {
    const freeDelivery = discounts.applied.find((applied) => applied.type === 'free_shipping');
    if (freeDelivery) freeDelivery.shippingAmount = waived;
  }

  // 3. Cash on delivery: the shop's rule, then the postcode's; never abroad.
  const rule = giftCardLines > 0
    ? { available: false, reason: 'Gift cards are paid for online.' }
    : market.isExport
      ? { available: false, reason: `Cash on delivery is only available for delivery within ${countryName(shop.countryCode)}.` }
      : shopPricing.codEligibility(pricing, discountedSubtotal);
  const cod =
    rule.available && !quote.codAvailable
      ? { available: false, reason: 'Cash on delivery is not available at this postcode.' }
      : rule;
  const codFee = options.paymentMethod === 'cod' && itemCount > 0 && cod.available ? pricing.cod.fee : 0;

  // 4. Tax on the discounted amounts, by the shop's regime: each product's
  // class rate (GST, VAT — extracted from inclusive prices), or the delivery
  // address's rate where the shop collects (US sales tax — added on top, and
  // on delivery where that is taxable).
  const destination: TaxAddress | null =
    options.destinationRegion || options.postalCode
      ? {
          country: market.country,
          region: options.destinationRegion ?? null,
          postalCode: options.postalCode ?? null,
          city: options.destinationCity ?? null,
          line1: options.destinationLine1 ?? null,
        }
      : null;
  const tax = await taxService.quote({
    lines: lines.map((line) => ({
      id: String(line.item.id),
      amount: line.net,
      quantity: line.item.quantity,
      unitPrice: line.unitPrice,
      discount: line.discount,
      // A gift card is taxed when it is spent, not when it is bought.
      rate: isGiftCard(line.item) ? 0 : Number(line.item.tax_rate),
      inclusive: Number(line.item.tax_inclusive) === 1,
      exempt: isGiftCard(line.item) || Number(line.item.tax_exempt) === 1,
    })),
    shipping: shippingPrice,
    destination,
    originRegion: pricing.originRegion,
    currency: market.currency,
    exportSale: market.isExport,
  });

  return {
    market,
    lines,
    itemCount,
    subtotal,
    mrpTotal,
    discounts,
    discountedSubtotal,
    gift,
    shipping: { quote, selected, price: shippingPrice, waived },
    cod: { available: cod.available, reason: cod.reason, fee: codFee, configuredFee: pricing.cod.enabled && !market.isExport ? pricing.cod.fee : null },
    tax,
    total: round(discountedSubtotal + shippingPrice + codFee + tax.addedToTotal),
  };
}
