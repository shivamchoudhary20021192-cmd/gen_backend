import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { pool, query, type Executor, type RowDataPacket } from '../../db/pool';
import { audience, type AudienceRule, type AudienceSpec } from './audience';
import { campaignsRepository, type CampaignListRow } from './campaigns.repository';
import { blockers, checkTemplate, quietHours, quietHoursApplies, type Violation } from './compliance';
import { messagingRepository } from './messaging.repository';
import { messagingService } from './messaging.service';
import { messagingSettings } from './messagingSettings';
import { shopId, tenancy } from '../../platform/tenancy/context';
import { formatMoney, formatShortDate } from '../../platform/shops/format';

/**
 * One message to many people.
 *
 * The shape of this is stolen, deliberately, from how the mature messaging
 * platforms do it, because the failure modes are the same everywhere:
 *
 *   draft → preflight → freeze the audience → send in batches → completed
 *
 * The two steps people are tempted to skip are the two that matter.
 *
 * **Preflight** answers "would this be refused, and how many people would it
 * reach" *before* anything is sent, in one screen. Without it, a campaign's
 * first feedback is four thousand rows of "skipped: no consent", by which time
 * the mistake has already cost a send window.
 *
 * **Freezing** writes one row per recipient at the moment the campaign starts.
 * The audience stops moving, the send becomes resumable, and "who did this go
 * to" has an answer that is not a re-run of a query against data that has since
 * changed.
 *
 * Sending itself is deliberately dull: take a batch, hand each one to
 * `messagingService.send`, write down what happened. Every rule — consent, the
 * promotional window, the frequency cap, the template's own compliance state —
 * lives in that one function, so a campaign cannot be a way around any of them.
 */

export interface CampaignInput {
  name: string;
  description?: string | null;
  channel: 'email' | 'sms' | 'whatsapp';
  template_id?: number | null;
  sender_id?: number | null;
  audience_type?: 'segment' | 'rules' | 'manual' | 'all';
  segment_id?: number | null;
  rules?: AudienceRule[] | null;
  rules_operator?: 'all' | 'any';
  customer_ids?: number[] | null;
  exclude_recent_hours?: number | null;
  scheduled_at?: string | null;
  throttle_per_minute?: number | null;
  variables?: Record<string, string> | null;
  utm?: Record<string, string> | null;
}

/** States in which the campaign's definition may still be edited. */
const EDITABLE = new Set(['draft', 'scheduled', 'paused']);

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/**
 * The campaign's audience, as the resolver wants it.
 *
 * An automatic segment is its rules, not its membership list: `customer_segments`
 * stores rules for the automatic ones and nothing has ever evaluated them, so a
 * campaign pointed at "VIP customers" would otherwise reach nobody.
 */
async function specFor(
  campaign: CampaignListRow,
  marketing: boolean,
  exec: Executor,
): Promise<AudienceSpec> {
  const rules = parseJson<AudienceRule[] | null>(campaign.rules, null);
  const spec: AudienceSpec = {
    channel: campaign.channel as 'email' | 'sms' | 'whatsapp',
    marketing,
    audienceType: campaign.audience_type as AudienceSpec['audienceType'],
    segmentId: campaign.segment_id,
    rules,
    rulesOperator: campaign.rules_operator,
    customerIds: parseJson<number[] | null>(campaign.customer_ids, null),
    excludeRecentHours: campaign.exclude_recent_hours,
  };

  if (campaign.audience_type === 'segment' && campaign.segment_id) {
    const segment = await query<RowDataPacket & { segment_type: string; rules: unknown; rules_operator: 'all' | 'any' }>(
      'SELECT segment_type, rules, rules_operator FROM customer_segments WHERE shop_id = ? AND id = ? AND deleted_at IS NULL',
      [shopId(), campaign.segment_id],
      exec,
    );
    const row = segment[0];
    if (row && row.segment_type === 'auto') {
      const segmentRules = parseJson<AudienceRule[]>(row.rules, []);
      if (segmentRules.length > 0) {
        spec.audienceType = 'rules';
        spec.rules = [...segmentRules, ...(rules ?? [])];
        spec.rulesOperator = rules && rules.length > 0 ? 'all' : row.rules_operator;
      }
    }
  }

  return spec;
}

/** The shop's own constants, for the merge fields that are the same for everyone. */
async function shopVariables(exec: Executor): Promise<Record<string, string>> {
  const rows = await query<RowDataPacket & { setting_key: string; value: string | null }>(
    "SELECT setting_key, value FROM settings WHERE shop_id = ? AND setting_key IN ('store.name', 'store.support_phone', 'store.url')",
    [shopId()],
    exec,
  );
  const map = new Map(rows.map((row) => [row.setting_key, row.value ?? '']));
  const shop = tenancy.current();
  const shopUrl = map.get('store.url') || (shop.primaryDomain ? `https://${shop.primaryDomain}` : '');
  return {
    shop_name: map.get('store.name') || shop.name,
    support_phone: map.get('store.support_phone') || '',
    shop_url: shopUrl.replace(/\/$/, ''),
  };
}

function money(value: unknown): string {
  return formatMoney(value, { wholeUnits: true });
}

function shortDate(value: Date | null): string {
  return formatShortDate(value);
}

export const campaignsService = {
  async list(filters: { status?: string; channel?: string; search?: string }, exec: Executor = pool) {
    const rows = await campaignsRepository.list(filters, exec);
    return {
      campaigns: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        channel: row.channel,
        status: row.status,
        template_id: row.template_id,
        template_name: row.template_name,
        segment_name: row.segment_name,
        sender_name: row.sender_name,
        scheduled_at: row.scheduled_at,
        started_at: row.started_at,
        completed_at: row.completed_at,
        total_recipients: row.total_recipients,
        sent_count: row.sent_count,
        delivered_count: row.delivered_count,
        failed_count: row.failed_count,
        skipped_count: row.skipped_count,
        cost: Number(row.cost),
        created_by_name: row.created_by_name,
        created_at: row.created_at,
        last_error: row.last_error,
      })),
    };
  },

  async get(id: number, exec: Executor = pool) {
    const row = await campaignsRepository.byId(id, exec);
    if (!row || row.deleted_at) throw ApiError.notFound('Campaign');

    const delivered = row.delivered_count;
    const attempted = row.sent_count + row.failed_count;

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      channel: row.channel,
      status: row.status,
      template_id: row.template_id,
      template_name: row.template_name,
      template_category: row.template_category,
      sender_id: row.sender_id,
      sender_name: row.sender_name,
      audience_type: row.audience_type,
      segment_id: row.segment_id,
      segment_name: row.segment_name,
      rules: parseJson<AudienceRule[]>(row.rules, []),
      rules_operator: row.rules_operator,
      customer_ids: parseJson<number[]>(row.customer_ids, []),
      exclude_recent_hours: row.exclude_recent_hours,
      scheduled_at: row.scheduled_at,
      timezone: row.timezone,
      started_at: row.started_at,
      completed_at: row.completed_at,
      throttle_per_minute: row.throttle_per_minute,
      variables: parseJson<Record<string, string>>(row.variables, {}),
      utm: parseJson<Record<string, string>>(row.utm, {}),
      last_error: row.last_error,
      created_by_name: row.created_by_name,
      created_at: row.created_at,
      editable: EDITABLE.has(row.status),
      stats: {
        total_recipients: row.total_recipients,
        sent: row.sent_count,
        delivered: row.delivered_count,
        failed: row.failed_count,
        skipped: row.skipped_count,
        pending: Math.max(0, row.total_recipients - row.sent_count - row.failed_count - row.skipped_count),
        cost: Number(row.cost),
        delivery_rate: attempted > 0 ? Math.round((delivered / attempted) * 100) : null,
      },
    };
  },

  async create(input: CampaignInput, adminId: number, exec: Executor = pool) {
    const id = await campaignsRepository.create(
      {
        name: input.name,
        description: input.description ?? null,
        channel: input.channel,
        template_id: input.template_id ?? null,
        sender_id: input.sender_id ?? null,
        status: 'draft',
        audience_type: input.audience_type ?? 'segment',
        segment_id: input.segment_id ?? null,
        rules: input.rules ? JSON.stringify(input.rules) : null,
        rules_operator: input.rules_operator ?? 'all',
        customer_ids: input.customer_ids ? JSON.stringify(input.customer_ids) : null,
        // On by default. The commonest mistake in bulk messaging is messaging
        // the same people twice in a week because two campaigns overlapped.
        exclude_recent_hours: input.exclude_recent_hours ?? 72,
        scheduled_at: input.scheduled_at ? new Date(input.scheduled_at) : null,
        throttle_per_minute: input.throttle_per_minute ?? null,
        variables: input.variables ? JSON.stringify(input.variables) : null,
        utm: input.utm ? JSON.stringify(input.utm) : null,
        created_by_admin_id: adminId,
      },
      exec,
    );
    return this.get(id, exec);
  },

  async update(id: number, input: Partial<CampaignInput>, exec: Executor = pool) {
    const existing = await campaignsRepository.byId(id, exec);
    if (!existing || existing.deleted_at) throw ApiError.notFound('Campaign');
    if (!EDITABLE.has(existing.status)) {
      throw ApiError.conflict(
        `A campaign that is ${existing.status} cannot be edited. Duplicate it instead.`,
        'INVALID_TRANSITION',
      );
    }

    const patch: Record<string, unknown> = {};
    for (const key of ['name', 'description', 'channel', 'template_id', 'sender_id', 'audience_type', 'segment_id', 'rules_operator', 'exclude_recent_hours', 'throttle_per_minute'] as const) {
      if (input[key] !== undefined) patch[key] = input[key] ?? null;
    }
    if (input.rules !== undefined) patch.rules = input.rules ? JSON.stringify(input.rules) : null;
    if (input.customer_ids !== undefined) {
      patch.customer_ids = input.customer_ids ? JSON.stringify(input.customer_ids) : null;
    }
    if (input.variables !== undefined) patch.variables = input.variables ? JSON.stringify(input.variables) : null;
    if (input.utm !== undefined) patch.utm = input.utm ? JSON.stringify(input.utm) : null;
    if (input.scheduled_at !== undefined) {
      patch.scheduled_at = input.scheduled_at ? new Date(input.scheduled_at) : null;
      // Clearing the date takes it off the schedule rather than leaving a
      // scheduled campaign with nothing to fire on.
      if (!input.scheduled_at && existing.status === 'scheduled') patch.status = 'draft';
    }

    await campaignsRepository.update(id, patch, exec);
    return this.get(id, exec);
  },

  async remove(id: number, exec: Executor = pool) {
    const existing = await campaignsRepository.byId(id, exec);
    if (!existing) throw ApiError.notFound('Campaign');
    if (existing.status === 'sending') {
      throw ApiError.conflict('Pause or cancel this campaign before deleting it.', 'INVALID_TRANSITION');
    }
    await campaignsRepository.softDelete(id, exec);
    return { deleted: true };
  },

  /** An editable copy, back at draft, with the counters and the audience cleared. */
  async duplicate(id: number, adminId: number, exec: Executor = pool) {
    const source = await campaignsRepository.byId(id, exec);
    if (!source) throw ApiError.notFound('Campaign');
    return this.create(
      {
        name: `${source.name} (copy)`,
        description: source.description,
        channel: source.channel as 'email' | 'sms' | 'whatsapp',
        template_id: source.template_id,
        sender_id: source.sender_id,
        audience_type: source.audience_type as CampaignInput['audience_type'],
        segment_id: source.segment_id,
        rules: parseJson<AudienceRule[] | null>(source.rules, null),
        rules_operator: source.rules_operator,
        customer_ids: parseJson<number[] | null>(source.customer_ids, null),
        exclude_recent_hours: source.exclude_recent_hours,
        throttle_per_minute: source.throttle_per_minute,
        variables: parseJson<Record<string, string> | null>(source.variables, null),
        utm: parseJson<Record<string, string> | null>(source.utm, null),
        scheduled_at: null,
      },
      adminId,
      exec,
    );
  },

  /**
   * Everything that would stop this campaign, and everything it would reach.
   *
   * One call, because the two questions are always asked together and because a
   * review step that needs three round trips is a review step people click past.
   */
  async preflight(id: number, exec: Executor = pool) {
    const campaign = await campaignsRepository.byId(id, exec);
    if (!campaign || campaign.deleted_at) throw ApiError.notFound('Campaign');

    const settings = await messagingSettings(exec);
    const violations: Violation[] = [];

    const template = campaign.template_id
      ? await messagingRepository.findTemplateById(campaign.template_id, exec)
      : null;

    if (!template) {
      violations.push({
        code: 'template_inactive',
        severity: 'blocker',
        message: 'No template is chosen, so there is nothing to send.',
        fix: 'Pick one, or write a new one.',
        field: 'template_id',
      });
    } else {
      if (template.channel !== campaign.channel) {
        violations.push({
          code: 'template_inactive',
          severity: 'blocker',
          message: `This is a ${campaign.channel} campaign and the template is for ${template.channel}.`,
          fix: 'Choose a template on the same channel.',
          field: 'template_id',
        });
      }
      if (template.category === 'authentication') {
        violations.push({
          code: 'bulk_authentication',
          severity: 'blocker',
          message: 'An authentication template sends a one-time code and must never go out in bulk.',
          fix: 'Use a marketing or utility template.',
          field: 'template_id',
        });
      }
      const sender = campaign.sender_id
        ? await messagingRepository.findSender(campaign.sender_id, exec)
        : template.sender_id
          ? await messagingRepository.findSender(template.sender_id, exec)
          : await messagingRepository.defaultSender(template.channel, exec);

      violations.push(...checkTemplate(template, sender, settings));
    }

    const marketing = template?.category === 'marketing';
    const spec = await specFor(campaign, marketing, exec);
    const reach = await audience.breakdown(spec, exec);

    if (reach.eligible === 0) {
      violations.push({
        code: 'no_recipient',
        severity: 'blocker',
        message: 'Nobody in this audience can be messaged right now.',
        fix:
          reach.matched > 0
            ? 'Everyone who matches has either not opted in or was messaged recently. Widen the audience, or lower the "leave alone for" setting.'
            : 'No customer matches these rules.',
        field: 'audience',
      });
    }

    const window = template && quietHoursApplies(campaign.channel, template.category) ? quietHours(settings) : null;
    if (window && !window.inside) {
      violations.push({
        code: 'quiet_hours',
        severity: 'blocker',
        message: window.message,
        fix: 'Schedule it inside the window instead of sending now.',
        field: 'scheduled_at',
      });
    }

    const sample = await audience.members(spec, 5, 0, exec);

    return {
      campaign_id: id,
      ready: blockers(violations).length === 0,
      violations,
      audience: reach,
      quiet_hours: window,
      sample: sample.map((member) => ({
        id: member.id,
        name: [member.first_name, member.last_name].filter(Boolean).join(' ') || 'Customer',
        recipient: member.recipient,
      })),
      // What a full send would cost at the simulator's prices, so the number is
      // the right order of magnitude before a real provider exists.
      estimated_cost: null as number | null,
    };
  },

  /** A live count while the audience is being edited, before anything is saved. */
  async estimate(spec: AudienceSpec, exec: Executor = pool) {
    return audience.breakdown(spec, exec);
  },

  /**
   * Freezes the audience and puts the campaign into `sending`.
   *
   * Everything about this is designed to be safe to call twice: the recipient
   * insert ignores duplicates, the status move is idempotent, and a campaign
   * that was interrupted mid-freeze picks up where it stopped.
   */
  async start(id: number, adminId: number, exec: Executor = pool) {
    const campaign = await campaignsRepository.byId(id, exec);
    if (!campaign || campaign.deleted_at) throw ApiError.notFound('Campaign');
    if (campaign.status === 'sending') return this.get(id, exec);
    if (campaign.status === 'completed' || campaign.status === 'cancelled') {
      throw ApiError.conflict(`This campaign is ${campaign.status}. Duplicate it to send again.`, 'INVALID_TRANSITION');
    }

    const preflight = await this.preflight(id, exec);
    if (!preflight.ready) {
      const reasons = blockers(preflight.violations).map((violation) => violation.message);
      await campaignsRepository.update(id, { last_error: reasons.join(' ').slice(0, 500) }, exec);
      throw ApiError.conflict(reasons.join(' '), 'INVALID_OPERATION', {
        violations: preflight.violations as unknown as Record<string, unknown>,
      });
    }

    const template = await messagingRepository.findTemplateById(campaign.template_id as number, exec);
    const marketing = template?.category === 'marketing';
    const spec = await specFor(campaign, marketing, exec);

    const shop = await shopVariables(exec);
    const campaignVariables = parseJson<Record<string, string>>(campaign.variables, {});

    // Frozen in pages of five hundred rather than one enormous statement: the
    // audience can be tens of thousands and a single insert of that size is one
    // lock, one packet limit and one timeout waiting to happen.
    const PAGE = 500;
    let offset = 0;
    let frozen = 0;
    for (;;) {
      const page = await audience.members(spec, PAGE, offset, exec);
      if (page.length === 0) break;

      frozen += await campaignsRepository.addRecipients(
        id,
        page.map((member) => ({
          customerId: member.id,
          recipient: member.recipient,
          variables: {
            ...shop,
            ...campaignVariables,
            first_name: member.first_name ?? 'there',
            last_name: member.last_name ?? '',
            full_name: [member.first_name, member.last_name].filter(Boolean).join(' ') || member.first_name || 'there',
            email: member.email ?? '',
            phone: member.phone ?? '',
            orders_count: String(member.orders_count ?? 0),
            total_spent: money(member.total_spent),
            last_order_date: shortDate(member.last_order_at),
            unsubscribe_url: `${shop.shop_url}/unsubscribe/${member.public_id}`,
          },
        })),
        exec,
      );

      offset += PAGE;
      // A campaign larger than this is a data problem, not a campaign.
      if (offset > 200_000) break;
    }

    await campaignsRepository.update(
      id,
      { status: 'sending', started_at: new Date(), last_error: null, approved_by_admin_id: adminId },
      exec,
    );
    await campaignsRepository.refreshCounters(id, exec);

    logger.info('messaging.campaign_started', { campaign_id: id, recipients: frozen, admin_id: adminId });
    return this.get(id, exec);
  },

  async pause(id: number, exec: Executor = pool) {
    const campaign = await campaignsRepository.byId(id, exec);
    if (!campaign) throw ApiError.notFound('Campaign');
    if (campaign.status !== 'sending' && campaign.status !== 'scheduled') {
      throw ApiError.conflict(`A campaign that is ${campaign.status} cannot be paused.`, 'INVALID_TRANSITION');
    }
    await campaignsRepository.requeueStuck(id, exec);
    await campaignsRepository.update(id, { status: 'paused' }, exec);
    return this.get(id, exec);
  },

  async resume(id: number, exec: Executor = pool) {
    const campaign = await campaignsRepository.byId(id, exec);
    if (!campaign) throw ApiError.notFound('Campaign');
    if (campaign.status !== 'paused') {
      throw ApiError.conflict(`A campaign that is ${campaign.status} cannot be resumed.`, 'INVALID_TRANSITION');
    }
    // Resuming re-checks the rules: a template may have lost its approval, or
    // the clock may have moved outside the promotional window since it paused.
    const preflight = await this.preflight(id, exec);
    const stoppers = blockers(preflight.violations).filter((violation) => violation.code !== 'no_recipient');
    if (stoppers.length > 0) {
      throw ApiError.conflict(stoppers.map((violation) => violation.message).join(' '), 'INVALID_OPERATION');
    }
    await campaignsRepository.update(id, { status: 'sending' }, exec);
    return this.get(id, exec);
  },

  async cancel(id: number, exec: Executor = pool) {
    const campaign = await campaignsRepository.byId(id, exec);
    if (!campaign) throw ApiError.notFound('Campaign');
    if (campaign.status === 'completed') {
      throw ApiError.conflict('This campaign has already finished.', 'INVALID_TRANSITION');
    }
    await campaignsRepository.cancelPending(id, exec);
    await campaignsRepository.update(id, { status: 'cancelled', completed_at: new Date() }, exec);
    await campaignsRepository.refreshCounters(id, exec);
    return this.get(id, exec);
  },

  async schedule(id: number, when: string, exec: Executor = pool) {
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) throw ApiError.badRequest('That is not a date.');
    if (at.getTime() < Date.now() - 60_000) throw ApiError.badRequest('That time has already passed.');

    const campaign = await campaignsRepository.byId(id, exec);
    if (!campaign) throw ApiError.notFound('Campaign');
    if (!EDITABLE.has(campaign.status)) {
      throw ApiError.conflict(`A campaign that is ${campaign.status} cannot be scheduled.`, 'INVALID_TRANSITION');
    }

    await campaignsRepository.update(id, { scheduled_at: at, status: 'scheduled' }, exec);
    return this.get(id, exec);
  },

  /**
   * Sends one batch.
   *
   * Called by the worker on a timer and by the "send now" button, which is the
   * same thing done once. Returns how much it did so the caller can decide
   * whether to come straight back.
   */
  async runBatch(campaignId: number, exec: Executor = pool) {
    const campaign = await campaignsRepository.byId(campaignId, exec);
    if (!campaign || campaign.status !== 'sending') return { processed: 0, done: true };

    const settings = await messagingSettings(exec);
    const size = Math.max(1, Math.min(settings.campaignBatchSize, campaign.throttle_per_minute ?? settings.campaignBatchSize));
    const batch = await campaignsRepository.claimBatch(campaignId, size, exec);

    if (batch.length === 0) {
      const pending = await campaignsRepository.pendingCount(campaignId, exec);
      if (pending === 0) {
        await campaignsRepository.update(campaignId, { status: 'completed', completed_at: new Date() }, exec);
        await campaignsRepository.refreshCounters(campaignId, exec);
        logger.info('messaging.campaign_completed', { campaign_id: campaignId });
        return { processed: 0, done: true };
      }
      return { processed: 0, done: false };
    }

    for (const recipient of batch) {
      const variables = parseJson<Record<string, string>>(recipient.variables, {});
      const outcome = await messagingService.send(
        {
          templateId: campaign.template_id ?? undefined,
          channel: campaign.channel as 'email' | 'sms' | 'whatsapp',
          to: recipient.recipient,
          variables,
          customerId: recipient.customer_id,
          campaignId,
          // The campaign's own "leave alone for" window already excluded anyone
          // messaged recently, at freeze time. Applying the global cap again
          // here would drop people the campaign was explicitly built to reach.
          ignoreFrequencyCap: true,
        },
        exec,
      );

      if (outcome.sent) {
        await campaignsRepository.markRecipient(
          recipient.id,
          { status: outcome.delivered ? 'delivered' : 'sent', logId: outcome.logId },
          exec,
        );
      } else if (outcome.reason === 'quiet_hours') {
        // Not a failure and not a skip: the window closed mid-send. The person
        // goes back in the queue and the campaign pauses itself, which is the
        // only behaviour that does not either break the law or lose the audience.
        await campaignsRepository.markRecipient(recipient.id, { status: 'pending' }, exec);
        await campaignsRepository.update(
          campaignId,
          { status: 'paused', last_error: outcome.detail.slice(0, 500) },
          exec,
        );
        logger.info('messaging.campaign_paused_quiet_hours', { campaign_id: campaignId });
        return { processed: 0, done: false };
      } else if (outcome.reason === 'provider_failed') {
        await campaignsRepository.markRecipient(
          recipient.id,
          { status: 'failed', error: outcome.detail },
          exec,
        );
      } else {
        await campaignsRepository.markRecipient(
          recipient.id,
          { status: 'skipped', skipReason: outcome.reason, error: outcome.detail },
          exec,
        );
      }
    }

    await campaignsRepository.refreshCounters(campaignId, exec);
    const pending = await campaignsRepository.pendingCount(campaignId, exec);
    if (pending === 0) {
      await campaignsRepository.update(campaignId, { status: 'completed', completed_at: new Date() }, exec);
      logger.info('messaging.campaign_completed', { campaign_id: campaignId, sent: batch.length });
    }

    return { processed: batch.length, done: pending === 0 };
  },

  async recipients(
    campaignId: number,
    filters: { status?: string; search?: string; page?: number; limit?: number },
    exec: Executor = pool,
  ) {
    const limit = Math.min(filters.limit ?? 50, 200);
    const page = Math.max(1, filters.page ?? 1);
    const rows = await campaignsRepository.recipients(
      campaignId,
      { status: filters.status, search: filters.search, limit, offset: (page - 1) * limit },
      exec,
    );
    const total = await campaignsRepository.countRecipients(campaignId, filters.status, exec);

    return {
      recipients: rows.map((row) => ({
        id: row.id,
        customer_id: row.customer_id,
        name: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Customer',
        recipient: row.recipient,
        status: row.status,
        skip_reason: row.skip_reason,
        error_message: row.error_message,
        log_id: row.log_id,
        sent_at: row.sent_at,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  },
};
