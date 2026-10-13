import { query, queryOne, type Executor, pool, type RowDataPacket } from '../../db/pool';
import { formatMoney } from '../../platform/shops/format';
import { roundMoney } from '../../platform/money/currency';
import { shopId, tenancy } from '../../platform/tenancy/context';

/**
 * What a basket actually costs after discounts.
 *
 * Two kinds of discount reach a basket:
 *
 *   - a **code** the shopper typed (coupons.is_automatic = 0), at most one
 *     unless it is stackable;
 *   - **automatic** discounts (is_automatic = 1) the shop runs without a code —
 *     "10% off over ₹2,000" — the best non-stackable one plus every stackable
 *     one that qualifies.
 *
 * Every rule the coupon table can express is enforced here: dates and the
 * active flag, minimum order and quantity, the usage limit overall and per
 * customer, who may use it (everyone, new customers, returning customers, a
 * named list), and what it applies to (everything, products, collections,
 * categories). The line discounts are allocated back onto the eligible lines
 * in proportion to their value, because tax is computed on what each line
 * actually sells for — an inclusive GST line discounted by 10% carries 10%
 * less GST, and the invoice has to show that.
 *
 * Nothing here writes. Checkout re-runs the evaluation inside its transaction
 * and then records the redemption; the cart summary shows the same result
 * without committing to it.
 */

/**
 * The currency a basket is priced in, and how a store-currency amount (a
 * minimum spend, a fixed discount, a cap) is expressed in it. At home: the
 * store's currency, unchanged.
 */
export interface MoneyIn {
  currency: string;
  convert(storeAmount: number): number;
}

export interface DiscountLineInput {
  productId: number;
  variantId: number;
  quantity: number;
  unitPrice: number;
}

export interface AppliedDiscount {
  couponId: number;
  code: string | null;
  title: string;
  type: string;
  automatic: boolean;
  /** Off the merchandise. */
  amount: number;
  /** Off delivery (free_shipping). */
  shippingAmount: number;
}

export interface DiscountResult {
  applied: AppliedDiscount[];
  /** Per input line, in order. */
  lineDiscounts: number[];
  merchandiseDiscount: number;
  /** Whether delivery is free because of a discount. */
  freeShipping: boolean;
  /** A free gift the basket earned, to add as a zero-priced line at checkout. */
  gift: { couponId: number; variantId: number; reservesInventory: boolean } | null;
  /** Why the code the shopper entered did not apply, in their words. */
  codeRejection: string | null;
}

interface CouponRow extends RowDataPacket {
  id: number;
  code: string;
  title: string | null;
  discount_type: 'percentage' | 'fixed_amount' | 'free_shipping' | 'buy_x_get_y' | 'free_gift';
  value: string;
  max_discount_amount: string | null;
  min_order_amount: string;
  min_quantity: number;
  applies_to: 'all' | 'products' | 'categories' | 'collections';
  customer_eligibility: 'all' | 'new_customers' | 'returning' | 'specific';
  buy_quantity: number | null;
  get_quantity: number | null;
  get_variant_id: number | null;
  gift_variant_id: number | null;
  gift_reserves_inventory: number;
  usage_limit_total: number | null;
  usage_limit_per_customer: number;
  used_count: number;
  is_stackable: number;
  is_automatic: number;
  priority: number;
}

const LIVE = `shop_id = ? AND is_active = 1 AND deleted_at IS NULL
  AND (starts_at IS NULL OR starts_at <= NOW())
  AND (ends_at IS NULL OR ends_at >= NOW())`;

const COLUMNS = `id, code, title, discount_type, value, max_discount_amount, min_order_amount, min_quantity,
  applies_to, customer_eligibility, buy_quantity, get_quantity, get_variant_id, gift_variant_id,
  gift_reserves_inventory, usage_limit_total, usage_limit_per_customer, used_count, is_stackable,
  is_automatic, priority`;

export function normaliseCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

async function findCode(code: string, exec: Executor): Promise<CouponRow | null> {
  return queryOne<CouponRow>(
    `SELECT ${COLUMNS} FROM coupons WHERE ${LIVE} AND is_automatic = 0 AND UPPER(code) = ? LIMIT 1`,
    [shopId(), normaliseCode(code)],
    exec,
  );
}

async function automaticDiscounts(exec: Executor): Promise<CouponRow[]> {
  return query<CouponRow>(`SELECT ${COLUMNS} FROM coupons WHERE ${LIVE} AND is_automatic = 1 ORDER BY priority, id LIMIT 50`, [shopId()], exec);
}

/** Which of the basket's products a coupon covers, in one query per coupon. */
async function coveredProducts(coupon: CouponRow, productIds: number[], exec: Executor): Promise<Set<number>> {
  if (coupon.applies_to === 'all' || productIds.length === 0) return new Set(productIds);
  const placeholders = productIds.map(() => '?').join(', ');
  const rows = await query<RowDataPacket & { product_id: number }>(
    coupon.applies_to === 'products'
      ? `SELECT product_id FROM coupon_products WHERE shop_id = ? AND coupon_id = ? AND product_id IN (${placeholders})`
      : coupon.applies_to === 'collections'
        ? `SELECT DISTINCT cp.product_id FROM coupon_collections cc
             JOIN collection_products cp ON cp.collection_id = cc.collection_id AND cp.shop_id = cc.shop_id
            WHERE cc.shop_id = ? AND cc.coupon_id = ? AND cp.product_id IN (${placeholders})`
        : `SELECT p.id AS product_id FROM coupon_categories cc
             JOIN products p ON p.category_id = cc.category_id AND p.shop_id = cc.shop_id
            WHERE cc.shop_id = ? AND cc.coupon_id = ? AND p.id IN (${placeholders})`,
    [shopId(), coupon.id, ...productIds],
    exec,
  );
  return new Set(rows.map((row) => Number(row.product_id)));
}

/** Whether this customer may use this coupon (null customer: not yet known). */
async function eligibility(coupon: CouponRow, customerId: number | null, exec: Executor): Promise<string | null> {
  if (coupon.usage_limit_total !== null && coupon.used_count >= coupon.usage_limit_total) {
    return 'This code has been fully used.';
  }
  if (coupon.customer_eligibility === 'all' && !customerId) return null;
  if (!customerId) {
    // Unknown until checkout, where the customer is identified by phone.
    return null;
  }
  if (coupon.customer_eligibility !== 'all') {
    // Counted from orders rather than read from customers.orders_count, which a
    // nightly job recomputes: a shopper's second order placed an hour after the
    // first must not still pass as a first order. An online order never paid
    // for was not really an order, so it does not spend "first order" either.
    const placed = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total FROM orders
        WHERE shop_id = ? AND customer_id = ? AND order_status <> 'cancelled'
          AND payment_status NOT IN ('pending', 'failed', 'cancelled')`,
      [shopId(), customerId],
      exec,
    );
    const orders = Number(placed?.total ?? 0);
    if (coupon.customer_eligibility === 'new_customers' && orders > 0) return 'This code is for first orders only.';
    if (coupon.customer_eligibility === 'returning' && orders === 0) return 'This code is for returning customers.';
    if (coupon.customer_eligibility === 'specific') {
      const listed = await queryOne<RowDataPacket>(
        'SELECT 1 AS hit FROM coupon_customers WHERE shop_id = ? AND coupon_id = ? AND customer_id = ? LIMIT 1',
        [shopId(), coupon.id, customerId],
        exec,
      );
      if (!listed) return 'This code is not available on your account.';
    }
  }
  if (coupon.usage_limit_per_customer > 0) {
    const used = await queryOne<RowDataPacket & { total: number }>(
      'SELECT COUNT(*) AS total FROM coupon_redemptions WHERE shop_id = ? AND coupon_id = ? AND customer_id = ?',
      [shopId(), coupon.id, customerId],
      exec,
    );
    if (Number(used?.total ?? 0) >= coupon.usage_limit_per_customer) return 'You have already used this code.';
  }
  return null;
}

/**
 * The discount one coupon gives this basket, or why it gives none.
 * Returns per-line amounts in input order.
 */
async function evaluate(
  coupon: CouponRow,
  lines: DiscountLineInput[],
  customerId: number | null,
  exec: Executor,
  money: MoneyIn,
): Promise<{ lineDiscounts: number[]; shipping: boolean; gift: DiscountResult['gift'] } | { rejection: string }> {
  const round = (value: number) => roundMoney(value, money.currency);
  const subtotal = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  // The coupon's amounts are in the store's currency; the basket is in the shopper's.
  const minimum = money.convert(Number(coupon.min_order_amount));

  const notAllowed = await eligibility(coupon, customerId, exec);
  if (notAllowed) return { rejection: notAllowed };
  if (subtotal < minimum) {
    return { rejection: `Spend ${formatMoney(minimum, { currency: money.currency })} or more to use this code.` };
  }
  if (coupon.min_quantity > 0 && quantity < coupon.min_quantity) {
    return { rejection: `Add at least ${coupon.min_quantity} items to use this code.` };
  }

  const covered = await coveredProducts(coupon, [...new Set(lines.map((line) => line.productId))], exec);
  const eligible = lines.map((line) => covered.has(line.productId));
  const eligibleValue = lines.reduce((sum, line, index) => sum + (eligible[index] ? line.unitPrice * line.quantity : 0), 0);
  const none = lines.map(() => 0);

  switch (coupon.discount_type) {
    case 'free_shipping':
      return { lineDiscounts: none, shipping: true, gift: null };

    case 'free_gift':
      if (!coupon.gift_variant_id) return { rejection: 'This offer is not set up correctly.' };
      return {
        lineDiscounts: none,
        shipping: false,
        gift: { couponId: coupon.id, variantId: Number(coupon.gift_variant_id), reservesInventory: coupon.gift_reserves_inventory === 1 },
      };

    case 'buy_x_get_y': {
      const buy = Math.max(1, Number(coupon.buy_quantity ?? 1));
      const get = Math.max(1, Number(coupon.get_quantity ?? 1));
      const eligibleUnits = lines.reduce((sum, line, index) => sum + (eligible[index] ? line.quantity : 0), 0);
      let freeUnits = Math.floor(eligibleUnits / (buy + (coupon.get_variant_id ? 0 : get))) * get;
      if (freeUnits === 0) return { rejection: `Add ${buy + (coupon.get_variant_id ? 0 : get)} qualifying items to use this offer.` };
      const discounts = [...none];
      // `value` is the percentage off the "get" items; 0 or 100 means free.
      const percentOff = Number(coupon.value) > 0 && Number(coupon.value) < 100 ? Number(coupon.value) / 100 : 1;
      // The free units are the cheapest ones (or the named variant), so the
      // offer costs the shop what it advertised and no more.
      const candidates = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line, index }) => (coupon.get_variant_id ? line.variantId === Number(coupon.get_variant_id) : eligible[index]))
        .sort((a, b) => a.line.unitPrice - b.line.unitPrice);
      for (const { line, index } of candidates) {
        if (freeUnits === 0) break;
        const units = Math.min(freeUnits, line.quantity);
        discounts[index] = round(discounts[index] + units * line.unitPrice * percentOff);
        freeUnits -= units;
      }
      if (discounts.every((amount) => amount === 0)) return { rejection: 'Add the free item to your bag to use this offer.' };
      return { lineDiscounts: discounts, shipping: false, gift: null };
    }

    case 'percentage':
    case 'fixed_amount': {
      if (eligibleValue <= 0) return { rejection: 'This code does not apply to anything in your bag.' };
      let amount =
        coupon.discount_type === 'percentage'
          ? (eligibleValue * Math.min(100, Number(coupon.value))) / 100
          : Math.min(money.convert(Number(coupon.value)), eligibleValue);
      if (coupon.max_discount_amount !== null) amount = Math.min(amount, money.convert(Number(coupon.max_discount_amount)));
      amount = round(amount);
      // Allocate across eligible lines by value; the last line takes the
      // rounding remainder so the parts add up to the whole exactly.
      const discounts = [...none];
      const indexes = lines.map((_, index) => index).filter((index) => eligible[index]);
      let allocated = 0;
      indexes.forEach((index, position) => {
        const value = lines[index].unitPrice * lines[index].quantity;
        const share = position === indexes.length - 1 ? round(amount - allocated) : round((amount * value) / eligibleValue);
        discounts[index] = share;
        allocated = round(allocated + share);
      });
      return { lineDiscounts: discounts, shipping: false, gift: null };
    }

    default:
      return { rejection: 'This code cannot be used here.' };
  }
}

function describe(coupon: CouponRow): string {
  return coupon.title || coupon.code;
}

export const discountEngine = {
  /**
   * Evaluates a basket: the code the shopper entered (if any) and every
   * automatic discount. Never throws for a code that does not apply — it
   * reports why, so the storefront can say it next to the field.
   */
  async evaluate(
    lines: DiscountLineInput[],
    options: { code?: string | null; customerId?: number | null; money?: MoneyIn },
    exec: Executor = pool,
  ): Promise<DiscountResult> {
    const money: MoneyIn = options.money ?? { currency: tenancy.current().currency, convert: (amount) => amount };
    const round = (value: number) => roundMoney(value, money.currency);
    const result: DiscountResult = {
      applied: [],
      lineDiscounts: lines.map(() => 0),
      merchandiseDiscount: 0,
      freeShipping: false,
      gift: null,
      codeRejection: null,
    };
    if (lines.length === 0) return result;
    const customerId = options.customerId ?? null;

    const candidates: { coupon: CouponRow; automatic: boolean }[] = [];
    if (options.code) {
      const coupon = await findCode(options.code, exec);
      if (!coupon) result.codeRejection = 'That code is not valid.';
      else candidates.push({ coupon, automatic: false });
    }
    for (const coupon of await automaticDiscounts(exec)) candidates.push({ coupon, automatic: true });

    let nonStackableTaken = false;
    // A code the shopper typed is considered first; automatic discounts follow
    // in priority order. Only one non-stackable discount applies.
    for (const { coupon, automatic } of candidates) {
      if (coupon.is_stackable !== 1 && nonStackableTaken) {
        if (!automatic) result.codeRejection = 'This code cannot be combined with your other discount.';
        continue;
      }
      // Stacked discounts apply to what is left after the earlier ones.
      const remaining = lines.map((line, index) => ({
        ...line,
        unitPrice: Math.max(0, line.unitPrice - result.lineDiscounts[index] / Math.max(1, line.quantity)),
      }));
      const outcome = await evaluate(coupon, remaining, customerId, exec, money);
      if ('rejection' in outcome) {
        if (!automatic) result.codeRejection = outcome.rejection;
        continue;
      }
      const amount = round(outcome.lineDiscounts.reduce((sum, value) => sum + value, 0));
      outcome.lineDiscounts.forEach((value, index) => {
        result.lineDiscounts[index] = round(result.lineDiscounts[index] + value);
      });
      if (outcome.shipping) result.freeShipping = true;
      if (outcome.gift && !result.gift) result.gift = outcome.gift;
      result.applied.push({
        couponId: coupon.id,
        code: automatic ? null : coupon.code,
        title: describe(coupon),
        type: coupon.discount_type,
        automatic,
        amount,
        shippingAmount: 0,
      });
      if (coupon.is_stackable !== 1) nonStackableTaken = true;
    }

    result.merchandiseDiscount = round(result.lineDiscounts.reduce((sum, value) => sum + value, 0));
    return result;
  },
};
