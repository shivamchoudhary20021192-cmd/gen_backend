import { billingEngine, planPriceFor } from '../billing/billingEngine';
import { addInterval } from '../billing/billingMath';
import { billingProvider } from '../billing/providers';
import bcrypt from 'bcryptjs';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { controlPlane, execute, queryOne, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import { eventBus } from '../events/eventBus';
import { entitlements, LIMIT_KEYS, type LimitKey } from '../plans/entitlements';
import { shopId, tenancy } from '../tenancy/context';
import { regionFor } from './blueprints/regions';
import { verticalCatalog } from './blueprints/verticals';
import { shopProvisioner } from './provisioning';
import { shopDirectory } from './shopDirectory';
import { shopsRepository, type PlanRow, type ShopRow } from './shops.repository';
import { onlineStoreUrlFor } from './urls';

/**
 * The shop, as its owner and staff manage it: store details, the setup guide,
 * ownership, pausing and closing, and the plan it is on.
 *
 * Store details live on the control-plane `shops` row (the resolver and every
 * shop context read them), and the handful that the single-shop code reads
 * from `settings` (store.name, store.currency, store.timezone) are mirrored
 * there in the same request so both stay true.
 */

export interface Actor {
  id: number | null;
  label: string | null;
}

function parse<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function presentShop(row: ShopRow, primaryDomain: string | null) {
  return {
    id: row.public_id,
    handle: row.handle,
    name: row.name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    status_reason: row.status_reason,
    vertical: row.vertical,
    country_code: row.country_code,
    currency: row.currency,
    timezone: row.timezone,
    locale: row.locale,
    weight_unit: row.weight_unit,
    tax_engine: row.tax_engine,
    storefront_password_enabled: row.storefront_password_enabled === 1,
    primary_domain: primaryDomain,
    // Its Online Store: in development <handle>.localhost, which resolves; the domain would not.
    storefront_url: onlineStoreUrlFor({ handle: row.handle, primaryDomain }),
    provisioned_at: row.provisioned_at,
    created_at: row.created_at,
  };
}

function presentPlan(plan: PlanRow, currentPlanId: number | null) {
  return {
    handle: plan.handle,
    name: plan.name,
    tagline: plan.tagline,
    price: { amount: Number(plan.price_amount), currency: plan.currency, interval: plan.billing_interval },
    trial_days: plan.trial_days,
    transaction_fee_percent: plan.transaction_fee_bps / 100,
    limits: parse<Record<string, number | null>>(plan.limits, {}),
    features: parse<Record<string, boolean>>(plan.features, {}),
    current: plan.id === currentPlanId,
  };
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const row = await queryOne<RowDataPacket & { total: number }>(sql, params);
  return Number(row?.total ?? 0);
}

/** What the shop uses of each plan limit right now. */
async function usage(): Promise<Record<LimitKey, number>> {
  const id = shopId();
  const staff = await queryOne<RowDataPacket & { total: number }>(
    "SELECT COUNT(*) AS total FROM shop_staff WHERE shop_id = ? AND status <> 'suspended'",
    [id],
    controlPlane,
  );
  const customDomains = await shopsRepository.countCustomDomains(id);
  return {
    staff_accounts: Number(staff?.total ?? 0),
    products: await count('SELECT COUNT(*) AS total FROM products WHERE shop_id = ? AND deleted_at IS NULL', [id]),
    locations: await count('SELECT COUNT(*) AS total FROM inventory_locations WHERE shop_id = ? AND is_active = 1', [id]),
    custom_domains: customDomains,
    themes: await count('SELECT COUNT(*) AS total FROM shop_themes WHERE shop_id = ?', [id]),
    webhook_subscriptions: await count("SELECT COUNT(*) AS total FROM webhook_subscriptions WHERE shop_id = ? AND status = 'active'", [id]),
    installed_apps: await count("SELECT COUNT(*) AS total FROM app_installations WHERE shop_id = ? AND status = 'active'", [id]),
    api_bucket_size: 0,
    api_leak_rate: 0,
    storage_gb: Math.ceil((await count('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM media WHERE shop_id = ? AND deleted_at IS NULL', [id])) / 1024 ** 3),
  };
}

async function requireOwner(actor: Actor): Promise<void> {
  const member = actor.id ? await shopsRepository.staffMember(shopId(), actor.id) : null;
  if (!member || member.is_owner !== 1) throw ApiError.forbidden('Only the store owner can do this.');
}

export const shopsService = {
  verticals() {
    return { verticals: verticalCatalog() };
  },

  async current() {
    const shop = tenancy.current();
    const row = await shopsRepository.byId(shop.id);
    if (!row) throw ApiError.notFound('Shop');
    const plan = row.plan_id ? await shopsRepository.planById(row.plan_id) : null;
    const subscription = await shopsRepository.liveSubscription(shop.id);
    const found = await entitlements.forShop(shop);
    return {
      shop: presentShop(row, shop.primaryDomain),
      plan: plan ? presentPlan(plan, plan.id) : null,
      subscription: subscription
        ? {
            status: subscription.status,
            trial_ends_at: subscription.trial_ends_at,
            current_period_end: subscription.current_period_end,
            cancel_at_period_end: subscription.cancel_at_period_end === 1,
          }
        : null,
      entitlements: { limits: found.limits, features: found.features },
      setup: await shopProvisioner.progress(),
    };
  },

  async update(
    input: {
      name?: string;
      email?: string | null;
      phone?: string | null;
      timezone?: string;
      locale?: string;
      weight_unit?: 'g' | 'kg' | 'lb' | 'oz';
      currency?: string;
      country_code?: string;
      storefront_password?: { enabled: boolean; password?: string | null };
    },
    actor: Actor,
  ) {
    const shop = tenancy.current();
    const row = await shopsRepository.byId(shop.id);
    if (!row) throw ApiError.notFound('Shop');
    const patch: Record<string, unknown> = {};

    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.email !== undefined) patch.email = input.email;
    if (input.phone !== undefined) patch.phone = input.phone;
    if (input.weight_unit !== undefined) patch.weight_unit = input.weight_unit;
    if (input.locale !== undefined) patch.locale = input.locale;
    if (input.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: input.timezone });
      } catch {
        throw ApiError.validation({ timezone: ['That is not a timezone we recognise, such as Asia/Kolkata or America/New_York.'] });
      }
      patch.timezone = input.timezone;
    }

    // Money and country are fixed once the shop has taken an order: every
    // order, refund and report is denominated in them.
    if (input.currency !== undefined || input.country_code !== undefined) {
      const orders = await count('SELECT COUNT(*) AS total FROM orders WHERE shop_id = ?', [shop.id]);
      if (orders > 0) {
        throw ApiError.conflict('The store currency and country cannot change after the first order.', 'INVALID_TRANSITION');
      }
      if (input.currency !== undefined) {
        const currency = input.currency.toUpperCase();
        try {
          new Intl.NumberFormat('en', { style: 'currency', currency });
        } catch {
          throw ApiError.validation({ currency: ['That is not an ISO currency code, such as INR or USD.'] });
        }
        patch.currency = currency;
      }
      if (input.country_code !== undefined) {
        const country = input.country_code.toUpperCase();
        patch.country_code = country;
        patch.tax_engine = regionFor(country).taxEngine;
      }
    }

    if (input.storefront_password !== undefined) {
      if (input.storefront_password.enabled) {
        const password = input.storefront_password.password?.trim();
        if (!password && !row.storefront_password_hash) {
          throw ApiError.validation({ 'storefront_password.password': ['Set a password visitors will enter.'] });
        }
        if (password) patch.storefront_password_hash = await bcrypt.hash(password, env.auth.bcryptRounds);
        patch.storefront_password_enabled = 1;
      } else {
        patch.storefront_password_enabled = 0;
      }
    }

    await shopsRepository.update(shop.id, patch);

    // The settings the single-shop code still reads.
    const mirrored: [string, unknown][] = [
      ['store.name', patch.name],
      ['store.currency', patch.currency],
      ['store.timezone', patch.timezone],
      ['store.support_email', patch.email],
      ['store.support_phone', patch.phone],
    ];
    for (const [key, value] of mirrored) {
      if (value === undefined) continue;
      await execute('UPDATE settings SET value = ? WHERE shop_id = ? AND setting_key = ?', [value ?? '', shop.id, key]);
    }

    shopDirectory.invalidate(shop.id);
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'shop.updated',
      entityType: 'shop',
      entityId: shop.id,
      summary: 'Updated store details',
      changes: { fields: Object.keys(patch).filter((key) => key !== 'storefront_password_hash') },
    });
    const fresh = await shopDirectory.byId(shop.id);
    if (fresh) {
      await tenancy.run(fresh, () =>
        eventBus.publishSafely('shop/update', { shop_id: fresh.publicId, fields: Object.keys(patch) }, { resourceType: 'shop', resourceId: shop.id, actorType: 'admin', actorId: actor.id }),
      );
    }
    return tenancy.run(fresh ?? shop, () => this.current());
  },

  /** A merchant ticks off (or skips) a setup-guide task. */
  async setTask(taskKey: string, status: 'done' | 'skipped' | 'pending') {
    const result = await execute(
      `UPDATE shop_setup_tasks SET status = ?, completed_at = ${status === 'pending' ? 'NULL' : 'NOW()'}
        WHERE shop_id = ? AND task_key = ? AND kind = 'onboarding'`,
      [status, shopId(), taskKey],
    );
    if (result.affectedRows === 0) throw ApiError.notFound('Setup task');
    return shopProvisioner.progress();
  },

  async transferOwnership(toAdminUserId: number, actor: Actor) {
    await requireOwner(actor);
    const shop = tenancy.current();
    const target = await shopsRepository.staffMember(shop.id, toAdminUserId);
    if (!target || target.status !== 'active') {
      throw ApiError.conflict('Ownership can only go to an active staff member of this store.', 'INVALID_TRANSITION');
    }
    await withTransaction(async (tx) => {
      await shopsRepository.transferOwnership(shop.id, actor.id!, toAdminUserId, tx);
    }, controlPlane);
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'shop.ownership_transferred', entityType: 'shop', entityId: shop.id, summary: `Ownership transferred to staff member ${toAdminUserId}` });
    return { transferred: true };
  },

  /**
   * Pause: the storefront stays up (browsing, the password page) but checkout
   * refuses — Shopify's "pause and build". Unpausing returns to active.
   */
  async setPaused(paused: boolean, actor: Actor) {
    await requireOwner(actor);
    const shop = tenancy.current();
    const row = await shopsRepository.byId(shop.id);
    if (!row) throw ApiError.notFound('Shop');
    if (paused && row.status !== 'active') throw ApiError.conflict(`A ${row.status} store cannot be paused.`, 'INVALID_TRANSITION');
    if (!paused && row.status !== 'paused') throw ApiError.conflict('The store is not paused.', 'INVALID_TRANSITION');
    await shopsRepository.update(shop.id, { status: paused ? 'paused' : 'active', status_reason: paused ? 'Paused by the owner' : null });
    shopDirectory.invalidate(shop.id);
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: paused ? 'shop.paused' : 'shop.unpaused', entityType: 'shop', entityId: shop.id, summary: paused ? 'Store paused' : 'Store unpaused' });
    return this.current();
  },

  /**
   * Closing is final for the merchant: the storefront stops, staff lose
   * access, the subscription ends, and installed apps are told to erase what
   * they hold (shop/redact). Data is retained for the platform's retention
   * period and then purged by an operator job.
   */
  async close(reason: string, actor: Actor) {
    await requireOwner(actor);
    const shop = tenancy.current();
    await eventBus.publish('shop/redact', { shop_id: shop.publicId, shop_domain: shop.primaryDomain }, { resourceType: 'shop', resourceId: shop.id, actorType: 'admin', actorId: actor.id });
    await withTransaction(async (tx) => {
      const subscription = await shopsRepository.liveSubscription(shop.id, tx);
      if (subscription) await shopsRepository.cancelSubscription(subscription.id, tx);
      await shopsRepository.update(shop.id, { status: 'closed', status_reason: reason.slice(0, 255), closed_at: new Date() }, tx);
    }, controlPlane);
    shopDirectory.invalidate(shop.id);
    entitlements.invalidate(shop.id);
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'shop.closed', entityType: 'shop', entityId: shop.id, summary: `Store closed: ${reason}` });
    return { closed: true };
  },

  // ── billing ────────────────────────────────────────────────────────────────

  async plans() {
    const shop = tenancy.current();
    const plans = await shopsRepository.publicPlans();
    return { plans: plans.map((plan) => presentPlan(plan, shop.planId)) };
  },

  async subscription() {
    const shop = tenancy.current();
    const found = await entitlements.forShop(shop);
    const used = await usage();
    const subscription = await shopsRepository.liveSubscription(shop.id);
    const plan = shop.planId ? await shopsRepository.planById(shop.planId) : null;
    return {
      plan: plan ? presentPlan(plan, plan.id) : null,
      subscription,
      usage: Object.fromEntries(
        LIMIT_KEYS.filter((key) => !key.startsWith('api_')).map((key) => [key, { used: used[key], limit: found.limits[key] }]),
      ),
    };
  },

  /**
   * Moves the shop to another plan. A downgrade is refused while the shop
   * uses more than the new plan allows, with the list of what to reduce —
   * a store silently losing half its staff accounts is not a plan change.
   *
   * During the trial the switch is free and the trial carries over. After it,
   * the new plan is billed from today in the same transaction as the switch:
   * the unused part of the old plan is credited, and the old plan's
   * transaction fees so far are settled at its rate.
   */
  async changePlan(handle: string, actor: Actor) {
    await requireOwner(actor);
    const shop = tenancy.current();
    const plan = await shopsRepository.planByHandle(handle);
    if (!plan || plan.is_public !== 1) throw ApiError.notFound('Plan');
    if (plan.id === shop.planId) return this.subscription();

    const limits = parse<Record<string, number | null>>(plan.limits, {});
    const used = await usage();
    const over = LIMIT_KEYS.filter((key) => !key.startsWith('api_') && limits[key] !== null && limits[key] !== undefined && used[key] > Number(limits[key]));
    if (over.length > 0) {
      throw ApiError.conflict(`Your store uses more than the ${plan.name} plan allows.`, 'PLAN_LIMIT_REACHED', {
        over: over.map((key) => ({ limit: key, used: used[key], allowed: limits[key] })),
      });
    }

    const now = new Date();
    const current = await shopsRepository.liveSubscription(shop.id);
    const previousPlan = current ? await shopsRepository.planById(current.plan_id) : null;
    const stillInTrial = Boolean(current?.status === 'trialing' && current.trial_ends_at && current.trial_ends_at > now);
    // The billing currency stays what it was; a new store gets its own.
    const price = await planPriceFor(plan, current?.currency ?? shop.currency);
    // Read from the shop's pod before the control-plane transaction opens.
    const fees = current && previousPlan && !stillInTrial ? await billingEngine.accruedFees(shop, current, previousPlan, now) : null;

    const invoiceId = await withTransaction(async (tx) => {
      const live = await shopsRepository.liveSubscription(shop.id, tx);
      if (live) await shopsRepository.cancelSubscription(live.id, tx);
      const billNow = !stillInTrial && live !== null && previousPlan !== null;
      const periodEnd = stillInTrial
        ? live!.trial_ends_at!
        : billNow
          ? addInterval(now, plan.billing_interval)
          : // No previous subscription to prorate against: the next billing
            // run bills the first period, from now.
            now;
      const newId = await shopsRepository.createSubscription(
        {
          shopId: shop.id,
          planId: plan.id,
          status: stillInTrial ? 'trialing' : 'active',
          price: price.amount,
          currency: price.currency,
          interval: plan.billing_interval,
          trialEndsAt: stillInTrial ? live!.trial_ends_at : null,
          periodStart: now,
          periodEnd,
          // A plan change does not change how the store pays.
          provider: live?.provider ?? billingProvider().name,
        },
        tx,
      );
      await shopsRepository.update(shop.id, { plan_id: plan.id }, tx);
      if (!billNow) return null;
      return billingEngine.planChangeInvoice(
        { shop, previous: live!, previousPlan: previousPlan!, next: { id: newId, plan, amount: price.amount, currency: price.currency, periodEnd }, fees, now },
        tx,
      );
    }, controlPlane);

    shopDirectory.invalidate(shop.id);
    entitlements.invalidate(shop.id);
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'billing.plan_changed', entityType: 'shop', entityId: shop.id, summary: `Plan changed to ${plan.name}` });

    const charge = invoiceId ? await billingEngine.collect(invoiceId, now) : null;
    const fresh = await shopDirectory.byId(shop.id);
    const summary = await tenancy.run(fresh ?? shop, () => this.subscription());
    return {
      ...summary,
      charge: charge
        ? { invoice_id: charge.invoice.id, number: charge.invoice.invoice_number, total: Number(charge.invoice.total), outcome: charge.outcome, error: charge.invoice.last_error }
        : null,
    };
  },
};
