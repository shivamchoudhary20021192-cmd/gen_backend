import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination, parseSort, type PaginationMeta } from '../../core/pagination';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { discountsRepository, type CouponRow } from './discounts.repository';
import { formatMoney } from '../../platform/shops/format';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

const SORTABLE: Record<string, string> = {
  created_at: 'c.created_at',
  code: 'c.code',
  used_count: 'c.used_count',
  ends_at: 'c.ends_at',
  priority: 'c.priority',
};

const WRITABLE = [
  'code',
  'title',
  'description',
  'discount_type',
  'value',
  'max_discount_amount',
  'min_order_amount',
  'min_quantity',
  'applies_to',
  'customer_eligibility',
  'buy_quantity',
  'get_quantity',
  'get_variant_id',
  'gift_variant_id',
  'usage_limit_total',
  'usage_limit_per_customer',
  'priority',
] as const;

const BOOLEANS = ['is_stackable', 'is_automatic', 'is_visible', 'is_active', 'gift_reserves_inventory'] as const;

export type DiscountState = 'active' | 'scheduled' | 'expired' | 'disabled' | 'exhausted';

/** One place that decides what a discount's badge says. */
export function deriveState(row: CouponRow): DiscountState {
  if (row.is_active !== 1) return 'disabled';
  if (row.usage_limit_total !== null && row.used_count >= row.usage_limit_total) return 'exhausted';
  const now = Date.now();
  if (row.starts_at && row.starts_at.getTime() > now) return 'scheduled';
  if (row.ends_at && row.ends_at.getTime() < now) return 'expired';
  return 'active';
}

/** Plain-English summary, so a list row explains itself without arithmetic. */
export function summarise(row: CouponRow): string {
  const value = Number(row.value);
  switch (row.discount_type) {
    case 'percentage':
      return `${value}% off${row.max_discount_amount ? ` (max ${formatMoney(Number(row.max_discount_amount), { wholeUnits: true })})` : ''}`;
    case 'fixed_amount':
      return `${formatMoney(value, { wholeUnits: true })} off`;
    case 'free_shipping':
      return 'Free shipping';
    case 'buy_x_get_y':
      return `Buy ${row.buy_quantity ?? '?'} get ${row.get_quantity ?? '?'}`;
    case 'free_gift':
      return 'Free gift';
    default:
      return '—';
  }
}

function present(row: CouponRow, targets?: Awaited<ReturnType<typeof discountsRepository.targetsFor>>) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    discount_type: row.discount_type,
    value: Number(row.value),
    max_discount_amount: row.max_discount_amount ? Number(row.max_discount_amount) : null,
    min_order_amount: Number(row.min_order_amount),
    min_quantity: row.min_quantity,
    applies_to: row.applies_to,
    customer_eligibility: row.customer_eligibility,
    buy_quantity: row.buy_quantity,
    get_quantity: row.get_quantity,
    get_variant_id: row.get_variant_id,
    gift_variant_id: row.gift_variant_id,
    gift_reserves_inventory: row.gift_reserves_inventory === 1,
    usage_limit_total: row.usage_limit_total,
    usage_limit_per_customer: row.usage_limit_per_customer,
    used_count: row.used_count,
    is_stackable: row.is_stackable === 1,
    is_automatic: row.is_automatic === 1,
    is_visible: row.is_visible === 1,
    priority: row.priority,
    starts_at: row.starts_at?.toISOString() ?? null,
    ends_at: row.ends_at?.toISOString() ?? null,
    is_active: row.is_active === 1,
    state: deriveState(row),
    summary: summarise(row),
    product_count: Number(row.product_count ?? 0),
    redemption_count: Number(row.redemption_count ?? 0),
    created_at: row.created_at.toISOString(),
    ...(targets ? { targets } : {}),
  };
}

function pickColumns(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of WRITABLE) {
    if (column in input) out[column] = input[column] ?? null;
  }
  for (const column of BOOLEANS) {
    if (column in input) out[column] = input[column] ? 1 : 0;
  }
  if ('starts_at' in input) out.starts_at = input.starts_at ? new Date(input.starts_at as string) : null;
  if ('ends_at' in input) out.ends_at = input.ends_at ? new Date(input.ends_at as string) : null;
  return out;
}

export const discountsService = {
  async list(queryParams: Record<string, unknown>): Promise<{ discounts: unknown[]; pagination: PaginationMeta }> {
    const page = parsePagination(queryParams);
    const orderBy = parseSort(queryParams.sort, SORTABLE, 'c.created_at DESC');
    const filters = {
      search: queryParams.q as string | undefined,
      discountType: queryParams.discount_type as string | undefined,
      isAutomatic: queryParams.is_automatic as boolean | undefined,
      state: queryParams.state as 'active' | 'scheduled' | 'expired' | 'disabled' | undefined,
    };

    const [rows, total] = await Promise.all([
      discountsRepository.list(filters, orderBy, page.limit, page.offset),
      discountsRepository.count(filters),
    ]);

    return { discounts: rows.map((row) => present(row)), pagination: buildMeta(total, page) };
  },

  async get(id: number) {
    const row = await discountsRepository.findById(id);
    if (!row) throw ApiError.notFound('Discount');
    const targets = await discountsRepository.targetsFor(id);
    return present(row, targets);
  },

  async create(input: Record<string, unknown>, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const code = String(input.code ?? '').trim().toUpperCase();
    if (await discountsRepository.codeExists(code)) {
      throw ApiError.conflict(`The code "${code}" is already in use.`, 'CONFLICT');
    }

    await this.assertTargetsExist(input);

    const id = await withTransaction(async (tx) => {
      const columns = pickColumns(input);
      columns.code = code;
      columns.created_by_admin_id = actor.id;

      const newId = await discountsRepository.create(columns, tx);
      await this.writeTargets(newId, input, tx);

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'discount.created',
          entityType: 'coupon',
          entityId: newId,
          summary: `Created discount ${code}`,
          changes: {
            code: { from: null, to: code },
            type: { from: null, to: input.discount_type },
            value: { from: null, to: input.value },
          },
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return newId;
    });

    return this.get(id);
  },

  async update(id: number, input: Record<string, unknown>, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = await discountsRepository.findById(id);
    if (!existing) throw ApiError.notFound('Discount');

    if (typeof input.code === 'string') {
      const code = input.code.trim().toUpperCase();
      if (await discountsRepository.codeExists(code, id)) {
        throw ApiError.conflict(`The code "${code}" is already in use.`, 'CONFLICT');
      }
      input.code = code;
    }

    await this.assertTargetsExist(input);

    const fields = pickColumns(input);

    await withTransaction(async (tx) => {
      if (Object.keys(fields).length > 0) await discountsRepository.update(id, fields, tx);
      await this.writeTargets(id, input, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'discount.updated',
          entityType: 'coupon',
          entityId: id,
          summary: `Updated discount ${existing.code}`,
          changes: auditService.diff(existing as unknown as Record<string, unknown>, fields),
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  async remove(id: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<void> {
    const existing = await discountsRepository.findById(id);
    if (!existing) throw ApiError.notFound('Discount');

    await withTransaction(async (tx) => {
      await discountsRepository.softDelete(id, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'discount.deleted',
          entityType: 'coupon',
          entityId: id,
          summary: `Deleted discount ${existing.code}`,
          context: { request_id: meta.requestId, redemptions: Number(existing.redemption_count ?? 0) },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });
  },

  /** Discounts page → pick products, the Shopify way. */
  async setProducts(id: number, productIds: number[], actor: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = await discountsRepository.findById(id);
    if (!existing) throw ApiError.notFound('Discount');

    const valid = await discountsRepository.validateProductIds(productIds);
    const unknown = productIds.filter((productId) => !valid.includes(productId));
    if (unknown.length > 0) {
      throw ApiError.validation({ product_ids: [`Unknown product id(s): ${unknown.join(', ')}`] });
    }

    await withTransaction(async (tx) => {
      await discountsRepository.setProducts(id, valid, tx);
      if (valid.length > 0 && existing.applies_to === 'all') {
        await discountsRepository.update(id, { applies_to: 'products' }, tx);
      }
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'discount.products_changed',
          entityType: 'coupon',
          entityId: id,
          summary: `${existing.code} now targets ${valid.length} product(s)`,
          changes: { products: { to: valid } },
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  /**
   * Product form → which discounts apply.
   *
   * Returns everything reaching the product, tagged with where it came from,
   * plus the subset the dropdown owns. A discount inherited from a collection
   * must be visible but not removable here — it isn't this product's to detach.
   */
  async forProduct(productId: number) {
    const rows = await discountsRepository.forProduct(productId);
    const direct = await discountsRepository.directCouponIdsForProduct(productId);

    const seen = new Set<number>();
    const applicable = rows
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      })
      .map((row) => ({
        ...present(row),
        source: row.source as 'product' | 'collection' | 'category' | 'all_products',
        editable_here: row.source === 'product',
      }));

    return { discounts: applicable, direct_discount_ids: direct };
  },

  async setProductDiscounts(
    productId: number,
    discountIds: number[],
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const validProduct = await discountsRepository.validateProductIds([productId]);
    if (validProduct.length === 0) throw ApiError.notFound('Product');

    const valid = await discountsRepository.validateCouponIds(discountIds);
    const unknown = discountIds.filter((discountId) => !valid.includes(discountId));
    if (unknown.length > 0) {
      throw ApiError.validation({ discount_ids: [`Unknown discount id(s): ${unknown.join(', ')}`] });
    }

    await withTransaction(async (tx) => {
      await discountsRepository.setProductCoupons(productId, valid, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'product.discounts_changed',
          entityType: 'product',
          entityId: productId,
          summary: `Attached ${valid.length} discount(s)`,
          changes: { discounts: { to: valid } },
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.forProduct(productId);
  },

  // ── internals ──────────────────────────────────────────────────────────────
  async assertTargetsExist(input: Record<string, unknown>): Promise<void> {
    // A gift or "get" variant from another store, or a deleted one, would make
    // the offer silently do nothing at checkout; refuse it here instead.
    for (const field of ['gift_variant_id', 'get_variant_id'] as const) {
      const variantId = input[field];
      if (typeof variantId === 'number' && !(await discountsRepository.variantExists(variantId))) {
        throw ApiError.validation({ [`discount.${field}`]: ['That product variant does not exist in this store.'] });
      }
    }
    const productIds = input.product_ids as number[] | undefined;
    if (!productIds?.length) return;
    const valid = await discountsRepository.validateProductIds(productIds);
    const unknown = productIds.filter((id) => !valid.includes(id));
    if (unknown.length > 0) {
      throw ApiError.validation({ 'discount.product_ids': [`Unknown product id(s): ${unknown.join(', ')}`] });
    }
  },

  async writeTargets(
    couponId: number,
    input: Record<string, unknown>,
    tx: Parameters<typeof discountsRepository.setProducts>[2],
  ): Promise<void> {
    if (Array.isArray(input.product_ids)) {
      await discountsRepository.setProducts(couponId, input.product_ids as number[], tx);
    }
    if (Array.isArray(input.collection_ids)) {
      await discountsRepository.setCollections(couponId, input.collection_ids as number[], tx);
    }
    if (Array.isArray(input.category_ids)) {
      await discountsRepository.setCategories(couponId, input.category_ids as number[], tx);
    }
  },
};
