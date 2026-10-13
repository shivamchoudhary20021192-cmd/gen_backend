import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { controlPlane, queryOne, query, type RowDataPacket } from '../../db/pool';
import { authenticate } from '../../middleware/authenticate';
import { rateLimit } from '../../middleware/rateLimit';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { onlineStoreUrl } from '../shops/urls';
import { shopId, tenancy } from '../tenancy/context';
import { policies, POLICY_KINDS, type PolicyKind } from './policies';
import { policyTemplate, type PolicyContext } from './policyTemplates';
import { privacyRequests, REQUEST_TYPES, TYPE_LABELS } from './privacyRequests';
import { privacySettings } from './privacySettings';
import { trackingConsents } from './trackingConsents';

/**
 * Admin API: /privacy — Customers → Consents & privacy, Settings → Customer
 * privacy, Settings → Policies.
 *
 *   GET    /overview                        what needs attention: open and overdue requests, consent rates, missing policies
 *   GET    /settings                        the banner, opt-out and request settings, with the defaults beside them
 *   PATCH  /settings                        (privacy.settings)
 *   GET    /policies                        every policy, empty ones included
 *   PUT    /policies/:kind                  { title?, body } — a new version when the text changes (privacy.settings)
 *   POST   /policies/:kind/template         a draft from the store's details; not saved (privacy.settings)
 *   GET    /policies/:kind/versions[/:v]    the text as it was
 *   GET    /consents                        the proof-of-consent record ?method=&customer_id=&consent_id=&page=
 *   GET    /requests                        ?status=open|…&type=&q=&customer_id=&page=
 *   POST   /requests                        { type, customer_id? | contact, details?, verified } (data_requests.manage)
 *   GET    /requests/:id                    the request, who it is about, its exports
 *   POST   /requests/:id/verify|start|export|send-export|erase|cancel-erasure|withdraw-consent|complete|reject
 *   GET    /requests/:id/export             the latest data file, as a download
 */
export const privacyRoutes = Router();
privacyRoutes.use(authenticate);

const canView = requirePermission('privacy.view');
const canConfigure = requirePermission('privacy.settings');
const canHandle = requirePermission('data_requests.manage');
const idParam = z.object({ id: z.coerce.number().int().positive() });
const kindParam = z.object({ kind: z.enum(Object.keys(POLICY_KINDS) as [PolicyKind, ...PolicyKind[]]) });
const country = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const copyEntry = z.object({
  title: z.string().max(120).optional(),
  message: z.string().max(1000).optional(),
  accept: z.string().max(60).optional(),
  decline: z.string().max(60).optional(),
  manage: z.string().max(60).optional(),
});

function actor(req: Request) {
  return { id: req.admin?.id ?? null, label: req.admin?.email ?? null };
}

async function setting(key: string): Promise<string | null> {
  const row = await queryOne<RowDataPacket & { value: string | null }>('SELECT value FROM settings WHERE shop_id = ? AND setting_key = ? LIMIT 1', [shopId(), key]);
  const value = row?.value?.trim();
  return value ? value : null;
}

/** What a policy draft is filled in from: Store details, and the privacy contacts. */
async function policyContext(): Promise<PolicyContext> {
  const shop = tenancy.current();
  const settings = await privacySettings.get();
  // The shop row lives on the control plane, not the shop's pod.
  const record = await queryOne<RowDataPacket & { email: string | null; phone: string | null }>('SELECT email, phone FROM shops WHERE id = ?', [shop.id], controlPlane);
  const url = onlineStoreUrl();
  return {
    shopName: shop.name,
    legalName: (await setting('store.legal_name')) ?? (await setting('seller_legal_name')) ?? shop.name,
    address: await setting('seller_address'),
    gstin: (await setting('store.gstin')) ?? (await setting('seller_gstin')),
    email: (await setting('store.support_email')) ?? record?.email ?? null,
    phone: (await setting('store.support_phone')) ?? record?.phone ?? null,
    supportHours: await setting('store.support_hours'),
    countryCode: shop.countryCode,
    storeUrl: url,
    privacyEmail: settings.privacy_email,
    grievanceName: settings.grievance_officer_name ?? (await setting('store.grievance_officer')),
    grievanceEmail: settings.grievance_officer_email,
    grievancePhone: settings.grievance_officer_phone,
    responseDays: settings.request_response_days,
    requestUrl: `${url}/privacy/request`,
    choicesUrl: `${url}/pages/data-sharing-opt-out`,
    today: new Date().toISOString().slice(0, 10),
  };
}

// ── overview ───────────────────────────────────────────────────────────────

privacyRoutes.get(
  '/overview',
  canView,
  asyncHandler(async (_req: Request, res: Response) => {
    const [requests, stats, settings, list] = await Promise.all([
      privacyRequests.list({ status: 'open', limit: 5 }),
      trackingConsents.stats(30),
      privacySettings.get(),
      policies.forAdmin(),
    ]);
    const exports = await query<RowDataPacket & { n: number }>('SELECT COUNT(*) AS n FROM customer_data_exports WHERE shop_id = ?', [shopId()]);
    res.json({
      requests: { open: requests.pagination.total, overdue: requests.overdue, counts: requests.counts, next: requests.requests },
      consents: stats,
      banner: { enabled: settings.banner_enabled, regions: settings.banner_regions, sale_opt_out_enabled: settings.sale_opt_out_enabled, honor_gpc: settings.honor_gpc },
      policies: list.map((policy) => ({ kind: policy.kind, title: policy.title, published: policy.body.trim() !== '', version: policy.version, updated_at: policy.updated_at })),
      grievance_officer_named: Boolean(settings.grievance_officer_name && (settings.grievance_officer_email || settings.privacy_email)),
      exports_held: Number(exports[0]?.n ?? 0),
      storefront_url: onlineStoreUrl(),
    });
  }),
);

// ── settings ───────────────────────────────────────────────────────────────

privacyRoutes.get(
  '/settings',
  canView,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ settings: await privacySettings.get(), defaults: privacySettings.defaults(), storefront_url: onlineStoreUrl() });
  }),
);

privacyRoutes.patch(
  '/settings',
  canConfigure,
  validate({
    body: z
      .object({
        banner_enabled: z.boolean(),
        banner_regions: z.enum(['required', 'all', 'custom']),
        banner_countries: z.array(country).max(250),
        banner_position: z.enum(['bottom', 'bottom_left', 'bottom_right', 'center']),
        banner_colors: z.object({ background: color, text: color, button: color, button_text: color }),
        banner_copy: z.record(z.string().regex(/^[a-z]{2}(-[a-z]{2,4})?$/), copyEntry),
        consent_max_age_days: z.number().int().min(30).max(730),
        reprompt_on_policy_change: z.boolean(),
        sale_opt_out_enabled: z.boolean(),
        sale_opt_out_countries: z.array(country).max(250),
        honor_gpc: z.boolean(),
        request_form_enabled: z.boolean(),
        request_response_days: z.number().int().min(1).max(90),
        erasure_grace_days: z.number().int().min(0).max(90),
        erasure_order_hold_days: z.number().int().min(0).max(730),
        privacy_email: z.string().trim().email().max(191).nullable(),
        grievance_officer_name: z.string().trim().max(120).nullable(),
        grievance_officer_email: z.string().trim().email().max(191).nullable(),
        grievance_officer_phone: z.string().trim().max(40).nullable(),
      })
      .partial()
      .strict(),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ settings: await privacySettings.update(req.body, actor(req)) });
  }),
);

// ── policies ───────────────────────────────────────────────────────────────

privacyRoutes.get(
  '/policies',
  canView,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ policies: await policies.forAdmin(), storefront_url: onlineStoreUrl() });
  }),
);

privacyRoutes.put(
  '/policies/:kind',
  canConfigure,
  validate({ params: kindParam, body: z.object({ title: z.string().trim().max(191).nullish(), body: z.string().max(200_000) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const kind = req.params.kind as PolicyKind;
    await policies.save(kind, req.body, actor(req));
    res.json({ policy: (await policies.forAdmin()).find((policy) => policy.kind === kind) });
  }),
);

privacyRoutes.post(
  '/policies/:kind/template',
  canConfigure,
  validate({ params: kindParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const kind = req.params.kind as PolicyKind;
    res.json({ draft: { kind, title: POLICY_KINDS[kind].title, body: policyTemplate(kind, await policyContext()) } });
  }),
);

privacyRoutes.get(
  '/policies/:kind/versions',
  canView,
  validate({ params: kindParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ versions: await policies.versions(req.params.kind as PolicyKind) });
  }),
);

privacyRoutes.get(
  '/policies/:kind/versions/:version',
  canView,
  validate({ params: kindParam.extend({ version: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ version: await policies.version(req.params.kind as PolicyKind, Number(req.params.version)) });
  }),
);

// ── the consent record ─────────────────────────────────────────────────────

privacyRoutes.get(
  '/consents',
  canView,
  validate({
    query: z.object({
      method: z.enum(['accept_all', 'reject_all', 'custom', 'opt_out_page', 'gpc', 'api', 'account']).optional(),
      customer_id: z.coerce.number().int().positive().optional(),
      consent_id: z.string().uuid().optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await trackingConsents.list(req.query as never));
  }),
);

// ── requests ───────────────────────────────────────────────────────────────

privacyRoutes.get(
  '/requests',
  canView,
  validate({
    query: z.object({
      status: z.enum(['open', 'verifying', 'received', 'in_progress', 'scheduled', 'completed', 'rejected', 'cancelled']).optional(),
      type: z.enum(REQUEST_TYPES as [string, ...string[]]).optional(),
      q: z.string().trim().max(120).optional(),
      customer_id: z.coerce.number().int().positive().optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ ...(await privacyRequests.list(req.query as never)), types: TYPE_LABELS });
  }),
);

privacyRoutes.post(
  '/requests',
  canHandle,
  rateLimit({ bucket: 'privacy.request_admin', max: 60, windowSeconds: 600 }),
  validate({
    body: z
      .object({
        type: z.enum(REQUEST_TYPES as [string, ...string[]]),
        customer_id: z.number().int().positive().optional(),
        contact: z.string().trim().max(191).optional(),
        details: z.string().trim().max(4000).optional(),
        // Staff confirmed who is asking (a signed-in customer, a call, an ID check); otherwise a link is emailed.
        verified: z.boolean().default(true),
      })
      .refine((body) => body.customer_id || body.contact, { message: 'Choose a customer or give an email address or phone number.', path: ['contact'] }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    let contact = req.body.contact as string | undefined;
    if (!contact && req.body.customer_id) {
      const customer = await queryOne<RowDataPacket & { email: string | null; phone: string | null }>('SELECT email, phone FROM customers WHERE shop_id = ? AND id = ?', [shopId(), req.body.customer_id]);
      contact = customer?.email ?? customer?.phone ?? undefined;
    }
    const created = await privacyRequests.create({
      type: req.body.type,
      source: 'admin',
      contact: contact ?? '',
      customerId: req.body.customer_id ?? null,
      details: req.body.details ?? null,
      verified: req.body.verified,
      actor: actor(req),
    });
    res.status(201).json(created);
  }),
);

privacyRoutes.get(
  '/requests/:id',
  canView,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await privacyRequests.get(Number(req.params.id)));
  }),
);

privacyRoutes.get(
  '/requests/:id/export',
  canHandle,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const file = await privacyRequests.exportContent(Number(req.params.id));
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/json').send(file.content);
  }),
);

const note = z.object({ note: z.string().trim().max(4000).optional() });
const actions: Record<string, (id: number, req: Request) => Promise<unknown>> = {
  verify: (id, req) => privacyRequests.markVerified(id, actor(req)),
  start: (id, req) => privacyRequests.start(id, actor(req)),
  export: (id, req) => privacyRequests.exportData(id, actor(req)),
  'send-export': (id, req) => privacyRequests.sendExport(id, actor(req)),
  erase: (id, req) => privacyRequests.scheduleErasure(id, actor(req)),
  'cancel-erasure': (id, req) => privacyRequests.cancelErasure(id, actor(req)),
  'withdraw-consent': (id, req) => privacyRequests.withdrawConsent(id, actor(req)),
  complete: (id, req) => privacyRequests.complete(id, req.body?.note ?? null, actor(req)),
  reject: (id, req) => privacyRequests.reject(id, String(req.body?.note ?? ''), actor(req)),
};

privacyRoutes.post(
  '/requests/:id/:action',
  canHandle,
  validate({ params: idParam.extend({ action: z.enum(Object.keys(actions) as [string, ...string[]]) }), body: note }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await actions[String(req.params.action)](Number(req.params.id), req);
    res.json(result && typeof result === 'object' && 'request' in (result as object) ? result : { request: result });
  }),
);
