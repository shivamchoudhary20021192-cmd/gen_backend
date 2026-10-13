import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../core/ApiError';
import { asyncHandler } from '../../core/asyncHandler';
import { controlPlane, execute, insert, query, type RowDataPacket } from '../../db/pool';
import { podRouter } from '../../db/pods';
import { authenticateIdentity } from '../../middleware/authenticate';
import { requirePlatformAdmin, requirePlatformRole } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { auditService } from '../../shared/audit.service';
import { platformAppsRoutes } from '../apps/apps.routes';
import { jobQueue } from '../jobs/queue';
import { entitlements, FEATURE_KEYS, LIMIT_KEYS } from '../plans/entitlements';
import { shopDirectory } from '../shops/shopDirectory';
import { shopsRepository } from '../shops/shops.repository';
import { env } from '../../config/env';
import { billingEngine } from '../billing/billingEngine';
import { billingRepository } from '../billing/billing.repository';
import { platformMail } from '../mail/mailer';
import { fx } from '../markets/fx';
import { platformAuditRoutes } from '../../modules/audit/audit.routes';
import { domainsRepository } from '../domains/domains.repository';
import { check as checkDomain } from '../domains/domains.service';
import { edgeProvider } from '../domains/edge/edgeProvider';

/**
 * The operators' API: every shop on the platform, plans, pods and the job
 * queue. Mounted at /platform/api/v1 behind a signed-in identity with a
 * platform role — support can look, only admins can change.
 *
 * Nothing here runs inside a shop's tenancy context; it reads the control
 * plane, and where it acts on a shop it does so through that shop's row.
 */
export const platformRoutes = Router();
platformRoutes.use(authenticateIdentity, requirePlatformRole('admin', 'support'));

function actor(req: Request) {
  return { id: req.identity?.id ?? null, label: req.identity?.email ?? null };
}

const shopRef = z.object({ id: z.coerce.number().int().positive() });

platformRoutes.get(
  '/overview',
  asyncHandler(async (_req: Request, res: Response) => {
    const statuses = await shopsRepository.statusCounts();
    const plans = await query<RowDataPacket & { handle: string; total: number }>(
      "SELECT p.handle, COUNT(s.id) AS total FROM plans p LEFT JOIN shops s ON s.plan_id = p.id AND s.status <> 'closed' GROUP BY p.id ORDER BY p.sort_order",
      [],
      controlPlane,
    );
    // Recurring revenue from paying subscriptions (a trial pays nothing yet),
    // a yearly plan counted as a twelfth a month; per currency, never summed
    // across currencies.
    const recurring = await query<RowDataPacket & { currency: string; mrr: string; paying: number; trialing: number }>(
      `SELECT currency,
              SUM(CASE WHEN status IN ('active', 'past_due') THEN IF(billing_interval = 'year', price_amount / 12, price_amount) ELSE 0 END) AS mrr,
              SUM(status IN ('active', 'past_due')) AS paying,
              SUM(status = 'trialing') AS trialing
         FROM shop_subscriptions WHERE status <> 'cancelled' GROUP BY currency`,
      [],
      controlPlane,
    );
    const outstanding = await query<RowDataPacket & { currency: string; total: string; bills: number }>(
      "SELECT currency, SUM(total) AS total, COUNT(*) AS bills FROM platform_invoices WHERE status IN ('open', 'failed') GROUP BY currency",
      [],
      controlPlane,
    );
    const signups = await query<RowDataPacket & { day: string; total: number }>(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS total
         FROM shops WHERE created_at >= UTC_TIMESTAMP() - INTERVAL 30 DAY GROUP BY day ORDER BY day`,
      [],
      controlPlane,
    );
    const newest = await query<RowDataPacket>(
      `SELECT s.id, s.handle, s.name, s.status, s.country_code, s.created_at, p.handle AS plan
         FROM shops s LEFT JOIN plans p ON p.id = s.plan_id ORDER BY s.id DESC LIMIT 8`,
      [],
      controlPlane,
    );
    res.json({
      shops_by_status: Object.fromEntries(statuses.map((row) => [row.status, Number(row.total)])),
      shops_by_plan: Object.fromEntries(plans.map((row) => [row.handle, Number(row.total)])),
      revenue: recurring.map((row) => ({
        currency: row.currency,
        mrr: Math.round(Number(row.mrr) * 100) / 100,
        paying: Number(row.paying),
        trialing: Number(row.trialing),
      })),
      outstanding: outstanding.map((row) => ({ currency: row.currency, total: Number(row.total), bills: Number(row.bills) })),
      signups_last_30_days: signups.map((row) => ({ day: row.day, total: Number(row.total) })),
      newest_shops: newest,
      jobs: await jobQueue.stats(),
      pods: podRouter.configuredPods(),
    });
  }),
);

platformRoutes.get(
  '/shops',
  validate({
    query: z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum(['provisioning', 'active', 'paused', 'frozen', 'suspended', 'closed']).optional(),
      plan_id: z.coerce.number().int().positive().optional(),
      pod_id: z.coerce.number().int().positive().optional(),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(200).default(50),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { q?: string; status?: string; plan_id?: number; pod_id?: number; page: number; limit: number };
    const { rows, total } = await shopsRepository.search({
      q: q.q,
      status: q.status,
      planId: q.plan_id,
      podId: q.pod_id,
      limit: Number(q.limit),
      offset: (Number(q.page) - 1) * Number(q.limit),
    });
    res.json({
      shops: rows.map((row) => ({
        id: row.id,
        public_id: row.public_id,
        handle: row.handle,
        name: row.name,
        status: row.status,
        plan: row.plan_handle,
        pod_id: row.pod_id,
        vertical: row.vertical,
        country_code: row.country_code,
        currency: row.currency,
        primary_domain: row.primary_domain,
        owner_email: row.owner_email,
        created_at: row.created_at,
      })),
      pagination: { page: Number(q.page), limit: Number(q.limit), total, pages: Math.ceil(total / Number(q.limit)) },
    });
  }),
);

platformRoutes.get(
  '/shops/:id',
  validate({ params: shopRef }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const shop = await shopsRepository.byId(id);
    if (!shop) throw ApiError.notFound('Shop');
    const { storefront_password_hash: _hidden, ...visible } = shop;
    res.json({
      shop: visible,
      plan: shop.plan_id ? await shopsRepository.planById(shop.plan_id) : null,
      domains: await shopsRepository.domains(id),
      subscription: await shopsRepository.liveSubscription(id),
      invoices: (await billingRepository.search({ shopId: id, limit: 12, offset: 0 })).map((row) => ({
        id: row.id,
        number: row.invoice_number,
        status: row.status,
        total: Number(row.total),
        currency: row.currency,
        issued_at: row.issued_at,
        paid_at: row.paid_at,
      })),
      staff: await query<RowDataPacket>(
        `SELECT s.admin_user_id, a.email, a.first_name, a.last_name, s.is_owner, s.has_full_access, s.status, s.last_accessed_at
           FROM shop_staff s JOIN admin_users a ON a.id = s.admin_user_id
          WHERE s.shop_id = ? ORDER BY s.is_owner DESC, a.email`,
        [id],
        controlPlane,
      ),
    });
  }),
);

/**
 * Freezing and suspending are operator actions: a frozen shop (unpaid) keeps
 * its admin read-only-ish and its storefront closed; a suspended shop (abuse,
 * fraud) is shut entirely. Reactivating restores `active`.
 */
platformRoutes.post(
  '/shops/:id/status',
  requirePlatformAdmin,
  validate({
    params: shopRef,
    body: z.object({ status: z.enum(['active', 'frozen', 'suspended']), reason: z.string().trim().min(3).max(255) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const shop = await shopsRepository.byId(id);
    if (!shop) throw ApiError.notFound('Shop');
    if (shop.status === 'closed' || shop.status === 'provisioning') {
      throw ApiError.conflict(`A ${shop.status} shop cannot be changed here.`, 'INVALID_TRANSITION');
    }
    await shopsRepository.update(id, { status: req.body.status, status_reason: req.body.reason });
    shopDirectory.invalidate(id);
    await auditService.log({
      actorId: actor(req).id,
      actorLabel: actor(req).label,
      action: 'platform.shop_status_changed',
      entityType: 'shop',
      entityId: id,
      summary: `${shop.handle}: ${shop.status} → ${req.body.status} (${req.body.reason})`,
    });
    res.json({ id, status: req.body.status });
  }),
);

platformRoutes.post(
  '/shops/:id/plan',
  requirePlatformAdmin,
  validate({ params: shopRef, body: z.object({ plan: z.string().trim().min(2).max(40) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const shop = await shopsRepository.byId(id);
    const plan = await shopsRepository.planByHandle(req.body.plan);
    if (!shop) throw ApiError.notFound('Shop');
    if (!plan) throw ApiError.notFound('Plan');
    await shopsRepository.update(id, { plan_id: plan.id });
    const subscription = await shopsRepository.liveSubscription(id);
    if (subscription) {
      await shopsRepository.updateSubscription(subscription.id, { plan_id: plan.id, price_amount: plan.price_amount, currency: plan.currency });
    }
    shopDirectory.invalidate(id);
    entitlements.invalidate(id);
    await auditService.log({ actorId: actor(req).id, actorLabel: actor(req).label, action: 'platform.shop_plan_changed', entityType: 'shop', entityId: id, summary: `${shop.handle} moved to ${plan.handle}` });
    res.json({ id, plan: plan.handle });
  }),
);

// ── plans ────────────────────────────────────────────────────────────────────

platformRoutes.get(
  '/plans',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ plans: await shopsRepository.allPlans(), limit_keys: LIMIT_KEYS, feature_keys: FEATURE_KEYS });
  }),
);

const planLimits = z.record(z.enum(LIMIT_KEYS as unknown as [string, ...string[]]), z.number().int().min(0).nullable());
const planFeatures = z.record(z.enum(FEATURE_KEYS as unknown as [string, ...string[]]), z.boolean());

/** A new plan. Starts hidden from signup until an operator makes it public. */
platformRoutes.post(
  '/plans',
  requirePlatformAdmin,
  validate({
    body: z.object({
      handle: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,38}$/, 'Use lowercase letters, numbers and hyphens.'),
      name: z.string().trim().min(2).max(80),
      tagline: z.string().trim().max(160).nullish(),
      price_amount: z.number().min(0),
      currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).default('INR'),
      billing_interval: z.enum(['month', 'year']).default('month'),
      trial_days: z.number().int().min(0).max(365).default(14),
      transaction_fee_bps: z.number().int().min(0).max(1000).default(0),
      limits: planLimits.default({}),
      features: planFeatures.default({}),
      is_public: z.boolean().default(false),
      sort_order: z.number().int().min(0).max(1000).default(100),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as {
      handle: string; name: string; tagline?: string | null; price_amount: number; currency: string; billing_interval: 'month' | 'year';
      trial_days: number; transaction_fee_bps: number; limits: Record<string, number | null>; features: Record<string, boolean>; is_public: boolean; sort_order: number;
    };
    if (await shopsRepository.planByHandleAny(body.handle)) throw ApiError.conflict(`There is already a plan called "${body.handle}".`, 'SLUG_TAKEN');
    // Every key present, so a plan never "forgets" a limit or feature by omission.
    const limits = Object.fromEntries(LIMIT_KEYS.map((key) => [key, body.limits[key] ?? null]));
    const features = Object.fromEntries(FEATURE_KEYS.map((key) => [key, body.features[key] ?? false]));
    const id = await insert(
      `INSERT INTO plans (handle, name, tagline, price_amount, currency, billing_interval, trial_days, transaction_fee_bps, limits, features, is_public, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [body.handle, body.name, body.tagline ?? null, body.price_amount, body.currency, body.billing_interval, body.trial_days, body.transaction_fee_bps,
        JSON.stringify(limits), JSON.stringify(features), body.is_public ? 1 : 0, body.sort_order],
      controlPlane,
    );
    await auditService.log({ actorId: actor(req).id, actorLabel: actor(req).label, action: 'platform.plan_created', entityType: 'plan', entityId: id, summary: `Created plan ${body.handle}` });
    res.status(201).json({ plan: await shopsRepository.planById(id) });
  }),
);

platformRoutes.patch(
  '/plans/:handle',
  requirePlatformAdmin,
  validate({
    params: z.object({ handle: z.string().trim().min(2).max(40) }),
    body: z.object({
      name: z.string().trim().min(2).max(80).optional(),
      tagline: z.string().trim().max(160).nullish(),
      price_amount: z.number().min(0).optional(),
      currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).optional(),
      billing_interval: z.enum(['month', 'year']).optional(),
      trial_days: z.number().int().min(0).max(365).optional(),
      transaction_fee_bps: z.number().int().min(0).max(1000).optional(),
      limits: planLimits.optional(),
      features: planFeatures.optional(),
      is_public: z.boolean().optional(),
      is_active: z.boolean().optional(),
      sort_order: z.number().int().min(0).max(1000).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    // Any plan, retired or not: reactivating one is an edit too.
    const plan = await shopsRepository.planByHandleAny(String(req.params.handle));
    if (!plan) throw ApiError.notFound('Plan');
    const body = req.body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of ['name', 'tagline', 'price_amount', 'currency', 'billing_interval', 'trial_days', 'transaction_fee_bps', 'sort_order']) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (body.is_public !== undefined) patch.is_public = body.is_public ? 1 : 0;
    if (body.is_active !== undefined) patch.is_active = body.is_active ? 1 : 0;
    if (body.limits) patch.limits = JSON.stringify({ ...(typeof plan.limits === 'string' ? JSON.parse(plan.limits) : plan.limits), ...(body.limits as object) });
    if (body.features) patch.features = JSON.stringify({ ...(typeof plan.features === 'string' ? JSON.parse(plan.features) : plan.features), ...(body.features as object) });
    const columns = Object.keys(patch);
    if (columns.length > 0) {
      await execute(`UPDATE plans SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE id = ?`, [...columns.map((column) => patch[column]), plan.id], controlPlane);
      entitlements.invalidate();
    }
    await auditService.log({ actorId: actor(req).id, actorLabel: actor(req).label, action: 'platform.plan_updated', entityType: 'plan', entityId: plan.id, summary: `Updated plan ${plan.handle}`, changes: { fields: columns } });
    res.json({ plan: await shopsRepository.planById(plan.id) });
  }),
);

// ── infrastructure ───────────────────────────────────────────────────────────

platformRoutes.get(
  '/pods',
  asyncHandler(async (_req: Request, res: Response) => {
    const pods = await query<RowDataPacket>(
      `SELECT p.*, COUNT(s.id) AS shops
         FROM pods p LEFT JOIN shops s ON s.pod_id = p.id AND s.status <> 'closed'
        GROUP BY p.id ORDER BY p.id`,
      [],
      controlPlane,
    );
    res.json({ pods, configured: podRouter.configuredPods() });
  }),
);

platformRoutes.get(
  '/jobs',
  asyncHandler(async (_req: Request, res: Response) => {
    const dead = await query<RowDataPacket>(
      `SELECT id, queue, type, shop_id, attempts, last_error, finished_at
         FROM jobs WHERE status = 'dead' ORDER BY finished_at DESC LIMIT 100`,
      [],
      controlPlane,
    );
    res.json({ stats: await jobQueue.stats(), dead });
  }),
);

platformRoutes.post(
  '/jobs/:id/retry',
  requirePlatformAdmin,
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const retried = await jobQueue.retry(Number(req.params.id));
    if (!retried) throw ApiError.conflict('Only dead or cancelled jobs can be retried.', 'INVALID_TRANSITION');
    res.json({ retried: true });
  }),
);

// The app store, curated by operators.
platformRoutes.use('/', platformAppsRoutes);

// The audit trail across every store, and the platform's own.
platformRoutes.use('/', platformAuditRoutes);

// ── custom domains across every store ──────────────────────────────────────

/** How the fleet's domains are doing, and which need someone to look: operators' first stop for "my domain doesn't work". */
platformRoutes.get(
  '/domains',
  validate({
    query: z.object({
      status: z.enum(['pending_dns', 'provisioning_ssl', 'active', 'misconfigured', 'ssl_failed', 'expired']).optional(),
      q: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(200).default(50),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = req.query as unknown as { status?: string; q?: string; page: number; limit: number };
    const [counts, rows] = await Promise.all([
      domainsRepository.statusCounts(),
      domainsRepository.search({ status: input.status, q: input.q, limit: input.limit, offset: (input.page - 1) * input.limit }),
    ]);
    res.json({
      counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.total)])),
      edge: edgeProvider().name,
      domains: rows.map((row) => ({
        id: row.id,
        hostname: row.hostname,
        status: row.status,
        source: row.source,
        is_primary: row.is_primary === 1,
        shop: { id: row.shop_id, handle: row.shop_handle, name: row.shop_name },
        certificate: { status: row.certificate_status, expires_at: row.certificate_expires_at },
        reason: row.failure_reason,
        last_checked_at: row.last_checked_at,
        next_check_at: row.next_check_at,
        status_changed_at: row.status_changed_at,
      })),
    });
  }),
);

/** An operator re-checking a store's domain (support: "I fixed my DNS, please look"). */
platformRoutes.post(
  '/domains/:id/check',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const domain = await domainsRepository.anyById(Number(req.params.id));
    if (!domain) throw ApiError.notFound('Domain');
    const checked = await checkDomain(domain, { manual: true });
    res.json({ id: checked.id, hostname: checked.hostname, status: checked.status, reason: checked.failure_reason });
  }),
);

// ── billing ──────────────────────────────────────────────────────────────────

platformRoutes.get(
  '/billing/invoices',
  validate({
    query: z.object({
      status: z.enum(['open', 'paid', 'failed', 'void']).optional(),
      shop_id: z.coerce.number().int().positive().optional(),
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(50),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { status, shop_id, page, limit } = req.query as unknown as { status?: string; shop_id?: number; page: number; limit: number };
    const rows = await billingRepository.search({ status, shopId: shop_id, limit, offset: (page - 1) * limit });
    res.json({
      invoices: rows.map((row) => ({
        id: row.id,
        number: row.invoice_number,
        shop: { id: row.shop_id, handle: row.shop_handle, name: row.shop_name },
        kind: row.kind,
        status: row.status,
        total: Number(row.total),
        currency: row.currency,
        issued_at: row.issued_at,
        paid_at: row.paid_at,
        attempts: row.attempt_count,
        last_error: row.last_error,
      })),
    });
  }),
);

const invoiceRef = z.object({ id: z.coerce.number().int().positive() });

/** A bill settled outside the platform (bank transfer): marks it paid, unfreezing the store if it was the last. */
platformRoutes.post(
  '/billing/invoices/:id/mark-paid',
  requirePlatformAdmin,
  validate({ params: invoiceRef }),
  asyncHandler(async (req: Request, res: Response) => {
    const invoice = await billingRepository.invoice(Number(req.params.id));
    if (!invoice) throw ApiError.notFound('Invoice');
    const result = await billingEngine.markPaidManually(invoice.id);
    await auditService.log({ actorId: actor(req).id, actorLabel: actor(req).label, action: 'platform.invoice_marked_paid', entityType: 'platform_invoice', entityId: invoice.id, summary: `Marked ${invoice.invoice_number} paid` });
    res.json({ outcome: result.outcome });
  }),
);

platformRoutes.post(
  '/billing/invoices/:id/void',
  requirePlatformAdmin,
  validate({ params: invoiceRef }),
  asyncHandler(async (req: Request, res: Response) => {
    const invoice = await billingRepository.invoice(Number(req.params.id));
    if (!invoice) throw ApiError.notFound('Invoice');
    await billingEngine.void(invoice.id);
    await auditService.log({ actorId: actor(req).id, actorLabel: actor(req).label, action: 'platform.invoice_voided', entityType: 'platform_invoice', entityId: invoice.id, summary: `Voided ${invoice.invoice_number}` });
    res.json({ voided: true });
  }),
);

/**
 * Runs the billing cycle now. Outside production it may run "as of" another
 * moment (`now`), like a Stripe test clock: a trial end or a grace period can
 * be walked through in seconds.
 */
platformRoutes.post(
  '/billing/run',
  requirePlatformAdmin,
  validate({
    body: z.object({
      now: z.string().datetime().optional(),
      // One store, by id or handle: a test-clock run must not bill every store "as of" next month.
      shop_id: z.coerce.number().int().positive().optional(),
      shop: z.string().trim().min(1).max(60).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { now: requested, shop_id: byId, shop: byHandle } = req.body as { now?: string; shop_id?: number; shop?: string };
    if (requested && !env.billing.testClock) throw ApiError.badRequest('A billing test clock is not available in production.');
    let shopId = byId ?? null;
    if (byHandle) {
      const row = await shopsRepository.byHandle(byHandle.toLowerCase());
      if (!row) throw ApiError.notFound('Shop');
      shopId = row.id;
    }
    const now = requested ? new Date(requested) : new Date();
    res.json({ now: now.toISOString(), shop_id: shopId, ...(await billingEngine.tick(now, shopId)) });
  }),
);

// ── the platform's own email ─────────────────────────────────────────────────

/**
 * The outbox. With PLATFORM_EMAIL_PROVIDER=log this is where development
 * email is read; in production, where an email went and whether it was
 * accepted. Bodies of emails carrying a secret are gone once delivered.
 */
platformRoutes.get(
  '/emails',
  validate({
    query: z.object({
      to: z.string().trim().max(191).optional(),
      template: z.string().trim().max(60).optional(),
      limit: z.coerce.number().int().positive().max(200).default(50),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { to, template, limit } = req.query as unknown as { to?: string; template?: string; limit: number };
    const rows = await platformMail.recent({ to, template, limit });
    res.json({
      emails: rows.map((row) => ({
        id: row.id,
        shop_id: row.shop_id,
        to: row.to_email,
        template: row.template,
        subject: row.subject,
        // A reset or invitation link is readable only in development (log
        // mode); a real one is between the platform and the recipient.
        body: row.sensitive === 1 && env.mail.provider !== 'log' ? null : row.body,
        status: row.status,
        provider: row.provider,
        error: row.error,
        attempts: row.attempts,
        created_at: row.created_at,
        sent_at: row.sent_at,
      })),
    });
  }),
);

// ── exchange rates ───────────────────────────────────────────────────────────

platformRoutes.get(
  '/exchange-rates',
  asyncHandler(async (_req: Request, res: Response) => {
    const rows = await fx.list();
    res.json({ base: 'USD', rates: rows.map((row) => ({ currency: row.currency, per_usd: Number(row.per_usd), source: row.source, updated_at: row.updated_at })) });
  }),
);

const currencyRef = z.object({ currency: z.string().trim().length(3).transform((value) => value.toUpperCase()) });

/** An operator's rate — for a currency the ECB does not publish, or to pin one. Kept until cleared. */
platformRoutes.put(
  '/exchange-rates/:currency',
  requirePlatformAdmin,
  validate({ params: currencyRef, body: z.object({ per_usd: z.coerce.number().positive().max(1_000_000) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { currency } = req.params as unknown as { currency: string };
    if (currency === 'USD') throw ApiError.badRequest('The US dollar is the base rate.');
    await fx.setManual(currency, (req.body as { per_usd: number }).per_usd);
    await auditService.log({ actorId: actor(req).id, actorLabel: actor(req).label, action: 'platform.exchange_rate_set', entityType: 'exchange_rate', entityId: null, summary: `${currency} set to ${(req.body as { per_usd: number }).per_usd} per USD` });
    res.json({ currency, per_usd: (req.body as { per_usd: number }).per_usd, source: 'manual' });
  }),
);

/** Hands a currency back to the daily ECB refresh. */
platformRoutes.delete(
  '/exchange-rates/:currency/manual',
  requirePlatformAdmin,
  validate({ params: currencyRef }),
  asyncHandler(async (req: Request, res: Response) => {
    await fx.clearManual((req.params as unknown as { currency: string }).currency);
    // Straight back to the published rate, not the pinned one until the next refresh.
    const refreshed = await fx.refreshFromEcb().then(() => true, () => false);
    res.json({ cleared: true, refreshed });
  }),
);

platformRoutes.post(
  '/exchange-rates/refresh',
  requirePlatformAdmin,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ updated: await fx.refreshFromEcb() });
  }),
);

