import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../../core/ApiError';
import { controlPlane, queryOne, type RowDataPacket } from '../../db/pool';
import { tenancy, type ShopContext } from '../tenancy/context';

/**
 * What a shop's plan allows.
 *
 * Limits are numbers where null means unlimited; features are switches. Both
 * come from the plan row, so pricing and packaging change in the platform
 * admin, not in code. The keys the code understands are the ones below — a
 * limit a plan does not mention is unlimited, a feature it does not mention
 * is off.
 */

export const LIMIT_KEYS = [
  'staff_accounts',
  'products',
  'locations',
  'custom_domains',
  'themes',
  'webhook_subscriptions',
  'installed_apps',
  'api_bucket_size',
  'api_leak_rate',
  'storage_gb',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const FEATURE_KEYS = [
  'custom_domain',
  'third_party_integrations',
  'api_access',
  'abandoned_checkout_recovery',
  'advanced_reports',
  'multi_location_inventory',
  'remove_platform_branding',
  'automation_flows',
  'marketing_campaigns',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export interface Entitlements {
  planId: number | null;
  planHandle: string | null;
  planName: string | null;
  limits: Record<LimitKey, number | null>;
  features: Record<FeatureKey, boolean>;
}

interface PlanRow extends RowDataPacket {
  id: number;
  handle: string;
  name: string;
  limits: unknown;
  features: unknown;
}

const TTL_MS = 60_000;
const cache = new Map<number, { value: Entitlements; at: number }>();

function parse(value: unknown): Record<string, unknown> {
  if (!value) return {};
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

/** No plan at all behaves like the smallest one would: closed features, modest API. */
const FALLBACK_API = { api_bucket_size: 40, api_leak_rate: 2 };

export const entitlements = {
  async forShop(shop: ShopContext = tenancy.current()): Promise<Entitlements> {
    const hit = cache.get(shop.id);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

    const plan = shop.planId
      ? await queryOne<PlanRow>('SELECT id, handle, name, limits, features FROM plans WHERE id = ?', [shop.planId], controlPlane)
      : null;
    const rawLimits: Record<string, unknown> = { ...FALLBACK_API, ...parse(plan?.limits) };
    const rawFeatures = parse(plan?.features);

    const limits = {} as Record<LimitKey, number | null>;
    for (const key of LIMIT_KEYS) {
      const value = rawLimits[key];
      limits[key] = value === null || value === undefined ? null : Number(value);
    }
    const features = {} as Record<FeatureKey, boolean>;
    for (const key of FEATURE_KEYS) features[key] = rawFeatures[key] === true;

    const value: Entitlements = {
      planId: plan ? Number(plan.id) : null,
      planHandle: plan?.handle ?? null,
      planName: plan?.name ?? null,
      limits,
      features,
    };
    cache.set(shop.id, { value, at: Date.now() });
    return value;
  },

  async hasFeature(feature: FeatureKey, shop?: ShopContext): Promise<boolean> {
    return (await this.forShop(shop)).features[feature];
  },

  async assertFeature(feature: FeatureKey, shop?: ShopContext): Promise<void> {
    const found = await this.forShop(shop);
    if (!found.features[feature]) throw ApiError.featureNotInPlan(feature, found.planName);
  },

  /**
   * Throws when adding one more would exceed the plan. `current` is the count
   * BEFORE the addition — the caller counts, because only it knows what counts
   * (active staff, not removed staff; published themes, not deleted ones).
   */
  async assertWithinLimit(limit: LimitKey, current: number, shop?: ShopContext): Promise<void> {
    const found = await this.forShop(shop);
    const max = found.limits[limit];
    if (max !== null && current >= max) throw ApiError.planLimit(limit, max, found.planName);
  },

  invalidate(shopId?: number): void {
    if (shopId === undefined) cache.clear();
    else cache.delete(shopId);
  },
};

/** Route guard: `router.post('/', authenticate, requireFeature('api_access'), …)`. */
export function requireFeature(feature: FeatureKey) {
  return async (_req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await entitlements.assertFeature(feature);
      next();
    } catch (error) {
      next(error);
    }
  };
}
