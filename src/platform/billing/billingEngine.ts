import { logger } from '../../core/logger';
import { controlPlane, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { env } from '../../config/env';
import { metrics } from '../observability/metrics';
import { toMinor } from '../money/currency';
import { formatShortDate } from '../shops/format';
import { shopDirectory } from '../shops/shopDirectory';
import { shopsRepository, type PlanRow, type SubscriptionRow } from '../shops/shops.repository';
import { entitlements } from '../plans/entitlements';
import { tenancy, type ShopContext } from '../tenancy/context';
import { addInterval, nextAttemptAt, transactionFee, unusedCredit } from './billingMath';
import { billingRepository, type InvoiceRow, type NewLine } from './billing.repository';
import { billingNotices } from './billingNotices';
import { billingProvider } from './providers';
import type { ChargeResult } from './providers/types';
import { platformTaxConfig, type TaxBuyer } from './platformTax';

/**
 * The platform billing its shops — Shopify's model:
 *
 *   - the plan is billed **in advance**, one period at a time, from the end of
 *     the trial;
 *   - transaction fees are billed **in arrears**: at the end of a period, the
 *     plan's percentage of what the shop took through online gateways in it
 *     (cash on delivery carries no fee);
 *   - a plan change bills the new plan from today and credits the unused part
 *     of the old one;
 *   - a failed charge is retried after 1, 3 and 5 days; a bill still unpaid
 *     `BILLING_GRACE_DAYS` after its first failure freezes the store — admin
 *     read-only except Billing, checkout closed — and paying unfreezes it.
 *
 * Every step takes `now` so the whole cycle can be run against a test clock.
 * Invoices are keyed by subscription period, so a job that runs twice bills
 * once.
 */

export interface TickResult {
  billed: number;
  retried: number;
  frozen: number;
  /** Trial-ending reminders sent. */
  reminded: number;
}

export interface CollectResult {
  invoice: InvoiceRow;
  outcome: 'paid' | 'failed' | 'requires_action' | 'pending' | 'already_settled';
  clientSecret: string | null;
}

const NO_CARD = 'No payment method on file. Add a card under Billing.';

/**
 * Subscriptions billed outside the processor: `manual` (invoiced, paid by
 * transfer, marked paid by an operator) and `internal` (the platform's own
 * founding store).
 */
export const MANUAL_MODES: ReadonlySet<string> = new Set(['manual', 'internal']);

/** What a plan costs in a currency: its own price there, else its base price. */
export async function planPriceFor(plan: PlanRow, currency: string): Promise<{ amount: number; currency: string }> {
  const local = await billingRepository.planPrice(plan.id, currency);
  if (local !== null) return { amount: local, currency };
  const dollars = await billingRepository.planPrice(plan.id, 'USD');
  if (dollars !== null) return { amount: dollars, currency: 'USD' };
  return { amount: Number(plan.price_amount), currency: plan.currency };
}

/**
 * Online sales in a window, in the shop's currency: what transaction fees are
 * a percentage of. Read from the shop's own pod.
 */
async function onlineSales(shop: ShopContext, from: Date, to: Date, currency: string): Promise<number> {
  if (shop.currency !== currency) {
    // No exchange rates on the platform yet: a fee cannot be taken in a
    // currency the sales were not made in. Logged, so it is visible.
    logger.warn('billing.fees_currency_mismatch', { shop_id: shop.id, shop_currency: shop.currency, billing_currency: currency });
    return 0;
  }
  return tenancy.run(shop, async () => {
    // In the store's currency: a payment from another market is converted at
    // its order's rate.
    const row = await queryOne<RowDataPacket & { total: string }>(
      `SELECT COALESCE(SUM(p.amount * o.exchange_rate), 0) AS total FROM payments p
         JOIN orders o ON o.id = p.order_id AND o.shop_id = p.shop_id
        WHERE p.shop_id = ? AND p.status IN ('captured', 'partially_refunded', 'refunded')
          AND p.captured_at >= ? AND p.captured_at < ?`,
      [shop.id, from, to],
    );
    return Number(row?.total ?? 0);
  });
}

async function feeLine(shop: ShopContext, plan: PlanRow, from: Date, to: Date, currency: string): Promise<NewLine | null> {
  if (plan.transaction_fee_bps <= 0 || to <= from) return null;
  const sales = await onlineSales(shop, from, to, currency);
  const amount = transactionFee(sales, plan.transaction_fee_bps, currency);
  if (amount <= 0) return null;
  return {
    kind: 'transaction_fee',
    description: `Transaction fees: ${plan.transaction_fee_bps / 100}% of online sales, ${formatShortDate(from)} – ${formatShortDate(to)}`,
    currency,
    amount,
    periodStart: from,
    periodEnd: to,
  };
}

function planLine(subscriptionId: number, plan: PlanRow, amount: number, currency: string, from: Date, to: Date): NewLine {
  return {
    kind: 'subscription',
    description: `${plan.name} plan, ${formatShortDate(from)} – ${formatShortDate(to)}`,
    currency,
    amount,
    periodStart: from,
    periodEnd: to,
    reference: `subscription:${subscriptionId}`,
  };
}

/** Whether the period being left was actually billed — only then is it credited. */
async function periodWasBilled(subscription: SubscriptionRow, exec: Executor): Promise<boolean> {
  const row = await queryOne<RowDataPacket>(
    `SELECT 1 AS hit FROM platform_invoice_lines l JOIN platform_invoices i ON i.id = l.invoice_id AND i.status <> 'void'
      WHERE l.kind = 'subscription' AND l.reference = ? AND l.period_start = ? LIMIT 1`,
    [`subscription:${subscription.id}`, subscription.current_period_start],
    exec,
  );
  return row !== null;
}

/**
 * The store as the platform's tax sees it: its country, its state (from
 * Settings → Billing, else its main stock location) and its tax ID. Read
 * before a bill's transaction — the location is on the store's own pod.
 */
export async function taxBuyerFor(shop: ShopContext): Promise<TaxBuyer | null> {
  if (!platformTaxConfig().country) return null;
  const account = await billingRepository.account(shop.id);
  let region = account?.tax_region ?? null;
  if (!region) {
    const location = await tenancy
      .run(shop, () =>
        queryOne<RowDataPacket & { state_code: string | null }>(
          'SELECT state_code FROM inventory_locations WHERE shop_id = ? AND is_active = 1 ORDER BY is_default DESC, priority, id LIMIT 1',
          [shop.id],
        ),
      )
      .catch(() => null);
    region = location?.state_code ?? null;
  }
  return { country: shop.countryCode, region, taxId: account?.tax_id ?? null };
}

async function unfreezeIfSettled(shopId: number, now: Date, exec: Executor): Promise<boolean> {
  const unpaid = await billingRepository.unpaidForShop(shopId, exec);
  if (unpaid.length > 0) return false;
  const subscription = await shopsRepository.liveSubscription(shopId, exec);
  if (subscription && (subscription.status === 'past_due' || subscription.status === 'frozen')) {
    // A store frozen past its period end starts a fresh period on the day it
    // comes back, rather than being billed at once for time it could not sell.
    const periodEnd = subscription.current_period_end < now ? now : subscription.current_period_end;
    await shopsRepository.updateSubscription(subscription.id, { status: 'active', current_period_end: periodEnd }, exec);
  }
  const shop = await shopsRepository.byId(shopId, exec);
  if (shop?.status === 'frozen') {
    await shopsRepository.update(shopId, { status: 'active', status_reason: null }, exec);
    return true;
  }
  return false;
}

export const billingEngine = {
  /**
   * One pass of the billing job: bill ended periods, retry due charges,
   * freeze. `shopId` narrows it to one store — for an operator's test-clock
   * run, which must not bill every other store "as of" next month.
   */
  async tick(now: Date = new Date(), shopId: number | null = null): Promise<TickResult> {
    const result: TickResult = { billed: 0, retried: 0, frozen: 0, reminded: 0 };
    for (const due of await billingRepository.dueSubscriptions(now, shopId)) {
      try {
        if (await this.billPeriod(due.id, now)) result.billed += 1;
      } catch (error) {
        logger.error('billing.cycle_failed', { shop_id: due.shop_id, subscription_id: due.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const invoice of await billingRepository.dueRetries(now, shopId)) {
      await this.collect(invoice.id, now);
      result.retried += 1;
    }
    result.frozen = await this.freezePastGrace(now, shopId);
    result.reminded = await billingNotices.trialsEnding(now, shopId);
    if (result.billed || result.retried || result.frozen || result.reminded) logger.info('billing.tick', { ...result, at: now.toISOString() });
    return result;
  },

  /**
   * Opens the next period of one subscription: its plan charge in advance,
   * the ended period's transaction fees, and any pending credits. False when
   * another run already did it.
   */
  async billPeriod(subscriptionId: number, now: Date): Promise<boolean> {
    const current = await queryOne<SubscriptionRow>('SELECT * FROM shop_subscriptions WHERE id = ?', [subscriptionId], controlPlane);
    if (!current || current.current_period_end > now) return false;
    const shop = await shopDirectory.byId(current.shop_id);
    const plan = await shopsRepository.planById(current.plan_id);
    if (!shop || !plan) return false;

    // Fees for the period that just ended (none for a trial), read from the
    // shop's pod before the control-plane transaction.
    const fees = current.status === 'trialing' ? null : await feeLine(shop, plan, current.current_period_start, current.current_period_end, current.currency);
    const buyer = await taxBuyerFor(shop);

    const invoiceId = await withTransaction(async (tx) => {
      const subscription = await queryOne<SubscriptionRow>('SELECT * FROM shop_subscriptions WHERE id = ? FOR UPDATE', [subscriptionId], tx);
      if (!subscription || subscription.status === 'cancelled' || subscription.current_period_end > now) return null;

      const periodStart = subscription.current_period_end;
      // Anchored on the day billing began, so a plan started on the 31st is
      // billed on the 28th in February and on the 31st again in March.
      const anchor = subscription.trial_ends_at ?? subscription.created_at;
      const periodEnd = addInterval(periodStart, subscription.billing_interval, anchor ? new Date(anchor).getUTCDate() : undefined);
      const id = await billingRepository.createInvoice(
        {
          shopId: subscription.shop_id,
          subscriptionId: subscription.id,
          kind: 'cycle',
          currency: subscription.currency,
          periodStart,
          periodEnd,
          issuedAt: now,
          cycleKey: `subscription:${subscription.id}:${periodStart.toISOString()}`,
          provider: subscription.provider,
        },
        tx,
      );
      await billingRepository.addLines(
        subscription.shop_id,
        id,
        [planLine(subscription.id, plan, Number(subscription.price_amount), subscription.currency, periodStart, periodEnd), ...(fees ? [fees] : [])],
        tx,
      );
      await billingRepository.sweepPendingLines(subscription.shop_id, id, subscription.currency, tx);
      await billingRepository.finaliseTotal(id, subscription.shop_id, subscription.currency, tx, buyer);
      await shopsRepository.updateSubscription(
        subscription.id,
        { current_period_start: periodStart, current_period_end: periodEnd, ...(subscription.status === 'trialing' ? { status: 'active' } : {}) },
        tx,
      );
      return id;
    }, controlPlane);

    if (invoiceId === null) return false;
    metrics.counter('platform_invoices_total', { kind: 'cycle' }).inc();
    await this.collect(invoiceId, now);
    return true;
  },

  /**
   * The bill for a plan change, inside the plan change's own transaction:
   * the new plan from now, a credit for the unused part of the old one if it
   * was billed, and the old plan's fees accrued so far.
   */
  async planChangeInvoice(
    input: { shop: ShopContext; previous: SubscriptionRow; previousPlan: PlanRow; next: { id: number; plan: PlanRow; amount: number; currency: string; periodEnd: Date }; fees: NewLine | null; now: Date },
    tx: Executor,
  ): Promise<number> {
    const { shop, previous, previousPlan, next, now } = input;
    const lines: NewLine[] = [planLine(next.id, next.plan, next.amount, next.currency, now, next.periodEnd)];
    if (previous.currency === next.currency && (await periodWasBilled(previous, tx))) {
      const credit = unusedCredit(Number(previous.price_amount), previous.current_period_start, previous.current_period_end, now, previous.currency);
      if (credit > 0) {
        lines.push({
          kind: 'proration',
          description: `Unused time on the ${previousPlan.name} plan, ${formatShortDate(now)} – ${formatShortDate(previous.current_period_end)}`,
          currency: previous.currency,
          amount: -credit,
          periodStart: now,
          periodEnd: previous.current_period_end,
        });
      }
    }
    if (input.fees) lines.push(input.fees);

    const id = await billingRepository.createInvoice(
      { shopId: shop.id, subscriptionId: next.id, kind: 'plan_change', currency: next.currency, periodStart: now, periodEnd: next.periodEnd, issuedAt: now, cycleKey: null, provider: previous.provider },
      tx,
    );
    await billingRepository.addLines(shop.id, id, lines, tx);
    await billingRepository.sweepPendingLines(shop.id, id, next.currency, tx);
    await billingRepository.finaliseTotal(id, shop.id, next.currency, tx, await taxBuyerFor(shop));
    metrics.counter('platform_invoices_total', { kind: 'plan_change' }).inc();
    return id;
  },

  /** Fees accrued on the current period so far, for a plan change. */
  async accruedFees(shop: ShopContext, subscription: SubscriptionRow, plan: PlanRow, now: Date): Promise<NewLine | null> {
    if (subscription.status === 'trialing') return null;
    return feeLine(shop, plan, subscription.current_period_start, now, subscription.currency);
  },

  /**
   * Tries to take payment for one bill. Safe to call concurrently for the same
   * bill: the charge is idempotent per attempt and the outcome is applied
   * under a row lock, once.
   */
  async collect(invoiceId: number, now: Date = new Date()): Promise<CollectResult> {
    const invoice = await billingRepository.invoice(invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} does not exist.`);
    if (invoice.status === 'paid' || invoice.status === 'void') return { invoice, outcome: 'already_settled', clientSecret: null };

    const provider = billingProvider();
    const account = await billingRepository.account(invoice.shop_id);
    const shopRow = await shopsRepository.byId(invoice.shop_id);
    const subscription = await shopsRepository.liveSubscription(invoice.shop_id);
    const total = Number(invoice.total);
    // How the shop is billed now, not when the bill was cut: a store that has
    // since added a card has its older open bills charged to it.
    const mode = subscription?.provider ?? invoice.provider ?? provider.name;

    let result: ChargeResult;
    if (total <= 0) {
      result = { status: 'succeeded', providerPaymentId: 'no_charge' };
    } else if (MANUAL_MODES.has(mode) || provider.name === 'manual') {
      // Settled outside the platform: the bill stays open for an operator to
      // mark paid, and never counts as a failed charge.
      result = { status: 'pending', providerPaymentId: null };
    } else if (!account?.payment_method_ref || account.provider !== provider.name) {
      result = { status: 'failed', providerPaymentId: null, error: NO_CARD };
    } else {
      try {
        result = await provider.charge({
          customer: { shopId: invoice.shop_id, shopName: shopRow?.name ?? `Shop ${invoice.shop_id}`, email: account.billing_email, providerCustomerId: account.provider_customer_id },
          paymentMethodRef: account.payment_method_ref,
          amountMinor: toMinor(total, invoice.currency),
          currency: invoice.currency,
          description: `${env.platform.name} bill ${invoice.invoice_number}`,
          idempotencyKey: `platform-invoice-${invoice.id}-attempt-${invoice.attempt_count + 1}`,
          invoiceId: invoice.id,
        });
      } catch (error) {
        // The processor was unreachable: not the merchant's failure, so it
        // does not count as an attempt. The next tick tries again.
        logger.error('billing.charge_error', { invoice_id: invoice.id, error: error instanceof Error ? error.message : String(error) });
        return { invoice, outcome: 'pending', clientSecret: null };
      }
    }
    return this.applyResult(invoice.id, result, now);
  },

  /** Records a charge's outcome on the bill, the subscription and the store. */
  async applyResult(invoiceId: number, result: ChargeResult, now: Date): Promise<CollectResult> {
    let unfrozen = false;
    const outcome = await withTransaction(async (tx) => {
      const invoice = await billingRepository.invoiceForUpdate(invoiceId, tx);
      if (!invoice) throw new Error(`Invoice ${invoiceId} does not exist.`);
      if (invoice.status === 'paid' || invoice.status === 'void') return { invoice, outcome: 'already_settled' as const, clientSecret: null };

      if (result.status === 'succeeded') {
        await billingRepository.markPaid(invoice.id, result.providerPaymentId, now, tx);
        await billingNotices.receipt(invoice, tx);
        unfrozen = await unfreezeIfSettled(invoice.shop_id, now, tx);
        if (unfrozen) await billingNotices.unfrozen(invoice.shop_id, tx);
        metrics.counter('platform_invoice_payments_total', { outcome: 'paid' }).inc();
        return { invoice: { ...invoice, status: 'paid' as const, paid_at: now }, outcome: 'paid' as const, clientSecret: null };
      }
      if (result.status === 'pending') return { invoice, outcome: 'pending' as const, clientSecret: null };

      const attempts = invoice.attempt_count + 1;
      // A charge that needs the cardholder is not retried on a timer: the
      // same bank would ask again. It waits for them to pay from Billing.
      const next = result.status === 'requires_action' ? null : nextAttemptAt(attempts, now);
      await billingRepository.markFailed(
        invoice.id,
        { error: result.error, attempts, nextAttemptAt: next, firstFailedAt: now, providerPaymentId: result.providerPaymentId },
        tx,
      );
      const subscription = await shopsRepository.liveSubscription(invoice.shop_id, tx);
      if (subscription && (subscription.status === 'active' || subscription.status === 'trialing')) {
        await shopsRepository.updateSubscription(subscription.id, { status: 'past_due' }, tx);
      }
      await billingNotices.paymentFailed(invoice, result.error, next, attempts, tx);
      metrics.counter('platform_invoice_payments_total', { outcome: result.status }).inc();
      logger.warn('billing.charge_failed', { shop_id: invoice.shop_id, invoice: invoice.invoice_number, attempts, error: result.error });
      return {
        invoice: { ...invoice, status: 'failed' as const, attempt_count: attempts, next_attempt_at: next, last_error: result.error },
        outcome: result.status === 'requires_action' ? ('requires_action' as const) : ('failed' as const),
        clientSecret: result.status === 'requires_action' ? result.clientSecret : null,
      };
    }, controlPlane);

    if (unfrozen) {
      shopDirectory.invalidate(outcome.invoice.shop_id);
      entitlements.invalidate(outcome.invoice.shop_id);
      logger.info('billing.shop_unfrozen', { shop_id: outcome.invoice.shop_id });
    }
    return outcome;
  },

  /** Freezes stores whose bill has been unpaid past the grace period. */
  async freezePastGrace(now: Date, shopId: number | null = null): Promise<number> {
    const cutoff = new Date(now.getTime() - env.billing.graceDays * 86_400_000);
    let frozen = 0;
    for (const row of await billingRepository.shopsPastGrace(cutoff, shopId)) {
      await withTransaction(async (tx) => {
        await shopsRepository.update(row.shop_id, { status: 'frozen', status_reason: `Unpaid bill ${row.invoice_number}` }, tx);
        const subscription = await shopsRepository.liveSubscription(row.shop_id, tx);
        if (subscription) await shopsRepository.updateSubscription(subscription.id, { status: 'frozen' }, tx);
        await billingNotices.frozen(row.shop_id, row.invoice_number, tx);
      }, controlPlane);
      shopDirectory.invalidate(row.shop_id);
      entitlements.invalidate(row.shop_id);
      metrics.counter('platform_shops_frozen_total').inc();
      logger.warn('billing.shop_frozen', { shop_id: row.shop_id, invoice: row.invoice_number });
      frozen += 1;
    }
    return frozen;
  },

  /** An operator recording a payment received outside the platform. */
  async markPaidManually(invoiceId: number, now: Date = new Date()): Promise<CollectResult> {
    return this.applyResult(invoiceId, { status: 'succeeded', providerPaymentId: 'manual' }, now);
  },

  async void(invoiceId: number, now: Date = new Date()): Promise<void> {
    let unfrozen = false;
    let shopId = 0;
    await withTransaction(async (tx) => {
      const invoice = await billingRepository.invoiceForUpdate(invoiceId, tx);
      if (!invoice || invoice.status === 'paid' || invoice.status === 'void') return;
      shopId = invoice.shop_id;
      await billingRepository.markVoid(invoice.id, now, tx);
      unfrozen = await unfreezeIfSettled(invoice.shop_id, now, tx);
      if (unfrozen) await billingNotices.unfrozen(invoice.shop_id, tx);
    }, controlPlane);
    if (unfrozen) {
      shopDirectory.invalidate(shopId);
      entitlements.invalidate(shopId);
    }
  },
};
