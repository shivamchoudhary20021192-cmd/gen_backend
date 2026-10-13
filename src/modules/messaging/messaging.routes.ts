import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { execute, query, pool, type RowDataPacket } from '../../db/pool';
import { authenticate, type AuthRequest } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { activityService } from './activity.service';
import { audienceCatalogue, type AudienceRule } from './audience';
import { campaignsService } from './campaigns.service';
import { directService } from './direct.service';
import { MESSAGE_VARIABLES } from './messageVariables';
import { clearMessagingSettingsCache, messagingSettings } from './messagingSettings';
import { sendersService } from './senders.service';
import { templatesService } from './templates.service';
import { shopId } from '../../platform/tenancy/context';

/**
 * The messaging API.
 *
 * Four nouns — templates, senders, campaigns, activity — plus one composer for
 * a single customer, under one prefix. The catalogue endpoint is the same idea
 * as the page builder's: merge fields and audience fields come from the server,
 * so adding either is a backend change and the admin picks it up on reload.
 *
 * Reading is `notifications.view`; anything that spends money or puts a message
 * on somebody's phone is `notifications.manage`.
 */

const router = Router();
router.use(authenticate);

const canRead = requirePermission('notifications.view', 'notifications.manage');
const canWrite = requirePermission('notifications.manage');

const idParam = z.object({ id: z.coerce.number().int().positive() });
const CHANNEL = z.enum(['email', 'sms', 'whatsapp', 'push']);
const CATEGORY = z.enum(['transactional', 'utility', 'marketing', 'authentication']);

const ruleSchema = z.object({
  field: z.string().trim().min(1).max(60),
  operator: z.enum([
    '=', '!=', '>', '>=', '<', '<=',
    'contains', 'starts_with', 'is_set', 'is_not_set', 'in_last_days', 'not_in_last_days',
  ]),
  value: z.unknown().optional(),
});

// ── the vocabulary ───────────────────────────────────────────────────────────

router.get('/catalogue', canRead, asyncHandler(async (_req: Request, res: Response) => {
  const settings = await messagingSettings();
  res.json({
    variables: MESSAGE_VARIABLES,
    audience: audienceCatalogue(),
    channels: [
      { value: 'whatsapp', label: 'WhatsApp' },
      { value: 'sms', label: 'SMS' },
      { value: 'email', label: 'Email' },
    ],
    categories: [
      { value: 'marketing', label: 'Marketing', help: 'Offers and announcements. Needs opt-in, and only sends inside the promotional window.' },
      { value: 'utility', label: 'Utility', help: 'About something the customer is already doing — an order, a delivery, a refund.' },
      { value: 'transactional', label: 'Transactional', help: 'The same, for channels that do not distinguish the two.' },
      { value: 'authentication', label: 'Authentication', help: 'One-time codes. Never sent in bulk.' },
    ],
    rules: {
      promotional_window: `${String(Math.floor(settings.marketingWindowStart / 60)).padStart(2, '0')}:00–${String(Math.floor(settings.marketingWindowEnd / 60)).padStart(2, '0')}:00`,
      frequency_cap_hours: settings.frequencyCapHours,
      dlt_enforced: settings.enforceDlt,
      timezone: settings.timezone,
    },
  });
}));

// ── templates ────────────────────────────────────────────────────────────────

const templateBody = z.object({
  event_key: z.string().trim().min(1).max(60).regex(/^[a-z0-9._-]+$/i, 'Use letters, numbers, dots, dashes and underscores.'),
  channel: CHANNEL,
  category: CATEGORY,
  locale: z.string().trim().max(10).optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).nullish(),
  subject: z.string().trim().max(255).nullish(),
  preheader: z.string().trim().max(255).nullish(),
  header_text: z.string().trim().max(160).nullish(),
  body: z.string().max(200_000),
  footer_text: z.string().trim().max(160).nullish(),
  buttons: z.unknown().optional(),
  sender_id: z.coerce.number().int().positive().nullish(),
  provider_template_id: z.string().trim().max(120).nullish(),
  dlt_template_id: z.string().trim().max(60).nullish(),
  approval_status: z.enum(['not_required', 'draft', 'pending', 'approved', 'rejected']).optional(),
  approval_note: z.string().trim().max(500).nullish(),
  sample_variables: z.record(z.string(), z.string()).nullish(),
  is_active: z.boolean().optional(),
});

router.get(
  '/templates',
  canRead,
  validate({
    query: z.object({
      channel: CHANNEL.optional(),
      category: CATEGORY.optional(),
      search: z.string().trim().max(120).optional(),
      is_active: z.enum(['true', 'false']).optional(),
      include_deleted: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(
      await templatesService.list({
        channel: q.channel,
        category: q.category,
        search: q.search,
        is_active: q.is_active === undefined ? undefined : q.is_active === 'true',
        include_deleted: q.include_deleted === 'true',
      }),
    );
  }),
);

router.post(
  '/templates',
  canWrite,
  validate({ body: templateBody }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(201).json(await templatesService.create(req.body as never, req.admin.id));
  }),
);

router.get(
  '/templates/:id',
  canRead,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await templatesService.get(Number(req.params.id)));
  }),
);

router.patch(
  '/templates/:id',
  canWrite,
  validate({ params: idParam, body: templateBody.partial() }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.json(await templatesService.update(Number(req.params.id), req.body as never, req.admin.id));
  }),
);

router.delete(
  '/templates/:id',
  canWrite,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await templatesService.remove(Number(req.params.id)));
  }),
);

router.post(
  '/templates/:id/duplicate',
  canWrite,
  validate({ params: idParam }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(201).json(await templatesService.duplicate(Number(req.params.id), req.admin.id));
  }),
);

router.post(
  '/templates/:id/restore',
  canWrite,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await templatesService.restore(Number(req.params.id)));
  }),
);

router.post(
  '/templates/:id/preview',
  canRead,
  validate({ params: idParam, body: z.object({ variables: z.record(z.string(), z.string()).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { variables } = req.body as { variables?: Record<string, string> };
    res.json(await templatesService.preview(Number(req.params.id), variables ?? {}));
  }),
);

router.post(
  '/templates/:id/test-send',
  canWrite,
  validate({
    params: idParam,
    body: z.object({
      to: z.string().trim().min(3).max(191),
      variables: z.record(z.string(), z.string()).optional(),
    }),
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { to, variables } = req.body as { to: string; variables?: Record<string, string> };
    res.json(await templatesService.testSend(Number(req.params.id), to, req.admin.id, variables ?? {}));
  }),
);

// ── senders ──────────────────────────────────────────────────────────────────

const senderBody = z.object({
  channel: CHANNEL,
  name: z.string().trim().min(1).max(120),
  provider: z.string().trim().max(40).optional(),
  status: z.enum(['active', 'paused']).optional(),
  is_default: z.boolean().optional(),
  from_email: z.string().trim().email().max(191).nullish(),
  from_name: z.string().trim().max(120).nullish(),
  reply_to: z.string().trim().email().max(191).nullish(),
  sms_header: z.string().trim().max(12).nullish(),
  dlt_pe_id: z.string().trim().max(40).nullish(),
  dlt_entity_name: z.string().trim().max(160).nullish(),
  waba_id: z.string().trim().max(40).nullish(),
  phone_number_id: z.string().trim().max(40).nullish(),
  display_phone: z.string().trim().max(20).nullish(),
  config: z.record(z.string(), z.unknown()).nullish(),
  daily_limit: z.coerce.number().int().positive().nullish(),
  notes: z.string().trim().max(500).nullish(),
});

router.get(
  '/senders',
  canRead,
  validate({ query: z.object({ channel: CHANNEL.optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await sendersService.list(req.query.channel as string | undefined));
  }),
);

router.post(
  '/senders',
  canWrite,
  validate({ body: senderBody }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(201).json(await sendersService.create(req.body as Record<string, unknown>, req.admin.id));
  }),
);

router.get(
  '/senders/:id',
  canRead,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await sendersService.get(Number(req.params.id)));
  }),
);

router.patch(
  '/senders/:id',
  canWrite,
  validate({ params: idParam, body: senderBody.partial() }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await sendersService.update(Number(req.params.id), req.body as Record<string, unknown>));
  }),
);

router.delete(
  '/senders/:id',
  canWrite,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await sendersService.remove(Number(req.params.id)));
  }),
);

router.post(
  '/senders/:id/default',
  canWrite,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await sendersService.makeDefault(Number(req.params.id)));
  }),
);

router.get(
  '/senders/:id/readiness',
  canRead,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await sendersService.readiness(Number(req.params.id)));
  }),
);

// ── campaigns ────────────────────────────────────────────────────────────────

const campaignBody = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).nullish(),
  channel: z.enum(['email', 'sms', 'whatsapp']),
  template_id: z.coerce.number().int().positive().nullish(),
  sender_id: z.coerce.number().int().positive().nullish(),
  audience_type: z.enum(['segment', 'rules', 'manual', 'all']).optional(),
  segment_id: z.coerce.number().int().positive().nullish(),
  rules: z.array(ruleSchema).max(20).nullish(),
  rules_operator: z.enum(['all', 'any']).optional(),
  customer_ids: z.array(z.coerce.number().int().positive()).max(5000).nullish(),
  exclude_recent_hours: z.coerce.number().int().min(0).max(8760).nullish(),
  scheduled_at: z.string().datetime().nullish(),
  throttle_per_minute: z.coerce.number().int().positive().max(10_000).nullish(),
  variables: z.record(z.string(), z.string()).nullish(),
  utm: z.record(z.string(), z.string()).nullish(),
});

router.get(
  '/campaigns',
  canRead,
  validate({
    query: z.object({
      status: z.string().trim().max(20).optional(),
      channel: z.enum(['email', 'sms', 'whatsapp']).optional(),
      search: z.string().trim().max(120).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await campaignsService.list(req.query as Record<string, string | undefined>));
  }),
);

router.post(
  '/campaigns',
  canWrite,
  validate({ body: campaignBody }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(201).json(await campaignsService.create(req.body as never, req.admin.id));
  }),
);

/** A live count while the audience is being built, before anything is saved. */
router.post(
  '/campaigns/estimate',
  canRead,
  validate({
    body: z.object({
      channel: z.enum(['email', 'sms', 'whatsapp']),
      marketing: z.boolean().optional(),
      audience_type: z.enum(['segment', 'rules', 'manual', 'all']),
      segment_id: z.coerce.number().int().positive().nullish(),
      rules: z.array(ruleSchema).max(20).nullish(),
      rules_operator: z.enum(['all', 'any']).optional(),
      customer_ids: z.array(z.coerce.number().int().positive()).max(5000).nullish(),
      exclude_recent_hours: z.coerce.number().int().min(0).max(8760).nullish(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;
    res.json(
      await campaignsService.estimate({
        channel: body.channel as 'email' | 'sms' | 'whatsapp',
        marketing: body.marketing !== false,
        audienceType: body.audience_type as 'segment' | 'rules' | 'manual' | 'all',
        segmentId: (body.segment_id as number | null) ?? null,
        rules: (body.rules as AudienceRule[] | null) ?? null,
        rulesOperator: (body.rules_operator as 'all' | 'any') ?? 'all',
        customerIds: (body.customer_ids as number[] | null) ?? null,
        excludeRecentHours: (body.exclude_recent_hours as number | null) ?? null,
      }),
    );
  }),
);

router.get(
  '/campaigns/:id',
  canRead,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await campaignsService.get(Number(req.params.id)));
  }),
);

router.patch(
  '/campaigns/:id',
  canWrite,
  validate({ params: idParam, body: campaignBody.partial() }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await campaignsService.update(Number(req.params.id), req.body as never));
  }),
);

router.delete(
  '/campaigns/:id',
  canWrite,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await campaignsService.remove(Number(req.params.id)));
  }),
);

router.post(
  '/campaigns/:id/duplicate',
  canWrite,
  validate({ params: idParam }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.status(201).json(await campaignsService.duplicate(Number(req.params.id), req.admin.id));
  }),
);

/** Everything that would stop it, and everyone it would reach. */
router.get(
  '/campaigns/:id/preflight',
  canRead,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await campaignsService.preflight(Number(req.params.id)));
  }),
);

router.post(
  '/campaigns/:id/start',
  canWrite,
  validate({ params: idParam }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.json(await campaignsService.start(Number(req.params.id), req.admin.id));
  }),
);

router.post(
  '/campaigns/:id/schedule',
  canWrite,
  validate({ params: idParam, body: z.object({ scheduled_at: z.string().min(4) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { scheduled_at: when } = req.body as { scheduled_at: string };
    res.json(await campaignsService.schedule(Number(req.params.id), when));
  }),
);

router.post('/campaigns/:id/pause', canWrite, validate({ params: idParam }), asyncHandler(async (req: Request, res: Response) => {
  res.json(await campaignsService.pause(Number(req.params.id)));
}));

router.post('/campaigns/:id/resume', canWrite, validate({ params: idParam }), asyncHandler(async (req: Request, res: Response) => {
  res.json(await campaignsService.resume(Number(req.params.id)));
}));

router.post('/campaigns/:id/cancel', canWrite, validate({ params: idParam }), asyncHandler(async (req: Request, res: Response) => {
  res.json(await campaignsService.cancel(Number(req.params.id)));
}));

/**
 * Pushes one batch by hand.
 *
 * The worker does this on a timer; this is the same call, for someone watching
 * a campaign who wants it to move now rather than in ten seconds.
 */
router.post('/campaigns/:id/run', canWrite, validate({ params: idParam }), asyncHandler(async (req: Request, res: Response) => {
  res.json(await campaignsService.runBatch(Number(req.params.id)));
}));

router.get(
  '/campaigns/:id/recipients',
  canRead,
  validate({
    params: idParam,
    query: z.object({
      status: z.string().trim().max(20).optional(),
      search: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await campaignsService.recipients(Number(req.params.id), req.query as never));
  }),
);

// ── activity ─────────────────────────────────────────────────────────────────

router.get(
  '/activity/summary',
  canRead,
  validate({ query: z.object({ days: z.coerce.number().int().positive().max(365).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await activityService.summary(Number(req.query.days ?? 30)));
  }),
);

router.get(
  '/activity',
  canRead,
  validate({
    query: z.object({
      channel: CHANNEL.optional(),
      status: z.string().trim().max(20).optional(),
      campaign_id: z.coerce.number().int().positive().optional(),
      customer_id: z.coerce.number().int().positive().optional(),
      template_id: z.coerce.number().int().positive().optional(),
      search: z.string().trim().max(120).optional(),
      from: z.string().trim().max(40).optional(),
      to: z.string().trim().max(40).optional(),
      page: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().positive().max(200).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await activityService.list(req.query as never));
  }),
);

router.get(
  '/activity/:id',
  canRead,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const message = await activityService.get(Number(req.params.id));
    if (!message) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'That message is not in the log.' } });
      return;
    }
    res.json(message);
  }),
);

// ── one customer ─────────────────────────────────────────────────────────────

router.get(
  '/customers/:id/context',
  canRead,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await directService.context(Number(req.params.id)));
  }),
);

router.get(
  '/customers/:id/thread',
  canRead,
  validate({ params: idParam, query: z.object({ limit: z.coerce.number().int().positive().max(200).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await activityService.forCustomer(Number(req.params.id), Number(req.query.limit ?? 50)));
  }),
);

router.post(
  '/customers/:id/send',
  canWrite,
  validate({
    params: idParam,
    body: z.object({
      channel: z.enum(['email', 'sms', 'whatsapp']),
      template_id: z.coerce.number().int().positive().nullish(),
      subject: z.string().trim().max(255).nullish(),
      body: z.string().max(20_000).nullish(),
      variables: z.record(z.string(), z.string()).optional(),
      purpose: z.enum(['service', 'marketing']).optional(),
    }),
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as Record<string, unknown>;
    res.json(
      await directService.send(
        {
          customerId: Number(req.params.id),
          channel: body.channel as 'email' | 'sms' | 'whatsapp',
          templateId: (body.template_id as number | null) ?? null,
          subject: (body.subject as string | null) ?? null,
          body: (body.body as string | null) ?? null,
          variables: (body.variables as Record<string, string>) ?? {},
          purpose: (body.purpose as 'service' | 'marketing') ?? 'service',
        },
        req.admin.id,
      ),
    );
  }),
);

// ── settings ─────────────────────────────────────────────────────────────────

router.get('/settings', canRead, asyncHandler(async (_req: Request, res: Response) => {
  const rows = await query<RowDataPacket & Record<string, unknown>>(
    `SELECT setting_key, label, value, default_value, value_type, description, sort_order
       FROM settings WHERE shop_id = ? AND group_key = 'messaging' ORDER BY sort_order, id`,
    [shopId()],
    pool,
  );
  res.json({ settings: rows, resolved: await messagingSettings() });
}));

/**
 * Saves the messaging rules.
 *
 * Only keys that already exist in the group are written: the settings table is
 * shared with payments, invoices and the store profile, and an endpoint that
 * accepts any key is an endpoint that can rewrite the GST number.
 */
router.put(
  '/settings',
  canWrite,
  validate({ body: z.object({ values: z.record(z.string(), z.string()) }) }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { values } = req.body as { values: Record<string, string> };
    for (const [key, value] of Object.entries(values)) {
      await execute(
        "UPDATE settings SET value = ?, updated_by_admin_id = ? WHERE shop_id = ? AND setting_key = ? AND group_key = 'messaging'",
        [value, req.admin.id, shopId(), key],
        pool,
      );
    }
    clearMessagingSettingsCache();
    res.json({ saved: true, resolved: await messagingSettings() });
  }),
);

export { router as messagingRoutes };
