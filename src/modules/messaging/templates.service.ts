import { ApiError } from '../../core/ApiError';
import { pool, type Executor } from '../../db/pool';
import { blockers, checkTemplate, type Violation } from './compliance';
import { CHANNEL_LIMITS, extractVariables, renderPreview, smsInfo } from './messageContent';
import { exampleFor, MESSAGE_VARIABLES } from './messageVariables';
import { messagingRepository, type SenderRow } from './messaging.repository';
import { messagingSettings } from './messagingSettings';
import { outboundSender, resolveMessageProvider } from './providers';
import { templatesRepository, type TemplateFilters, type TemplateListRow } from './templates.repository';

/**
 * Authoring a message.
 *
 * The interesting decisions are all about *when the rules are applied*:
 *
 *   - saving is never blocked. A half-written template with no DLT id is a
 *     normal state of work, and an editor that refuses to save it is an editor
 *     people write in a text file instead.
 *   - every read carries its violations, so the list can mark what cannot send
 *     and the editor can show it while someone types.
 *   - sending is blocked, in `messaging.service`, whatever the editor said.
 *
 * `is_transactional` is kept in step with `category` on every write. Half the
 * codebase still reads the flag; nothing should have to know both.
 */

/** WhatsApp is the only channel with a pre-approval gate to track. */
function approvalDefault(channel: string): string {
  return channel === 'whatsapp' ? 'draft' : 'not_required';
}

function transactionalFor(category: string): number {
  return category === 'marketing' ? 0 : 1;
}

export interface TemplateInput {
  event_key: string;
  channel: string;
  category: string;
  locale?: string;
  name: string;
  description?: string | null;
  subject?: string | null;
  preheader?: string | null;
  header_text?: string | null;
  body: string;
  footer_text?: string | null;
  buttons?: unknown;
  sender_id?: number | null;
  provider_template_id?: string | null;
  dlt_template_id?: string | null;
  approval_status?: string;
  approval_note?: string | null;
  sample_variables?: Record<string, string> | null;
  is_active?: boolean;
}

async function senderFor(template: { sender_id: number | null; channel: string }, exec: Executor): Promise<SenderRow | null> {
  return template.sender_id
    ? await messagingRepository.findSender(template.sender_id, exec)
    : await messagingRepository.defaultSender(template.channel, exec);
}

/** The row as a screen wants it: parsed JSON, derived state, violations. */
async function decorate(row: TemplateListRow, exec: Executor) {
  const settings = await messagingSettings(exec);
  const sender = await senderFor(row, exec);
  const violations = checkTemplate(row, sender, settings);
  const placeholders = extractVariables(row.subject, row.header_text, row.body, row.footer_text);

  return {
    id: row.id,
    event_key: row.event_key,
    channel: row.channel,
    category: row.category,
    locale: row.locale,
    name: row.name,
    description: row.description,
    subject: row.subject,
    preheader: row.preheader,
    header_text: row.header_text,
    body: row.body,
    footer_text: row.footer_text,
    buttons: row.buttons ?? null,
    sender_id: row.sender_id,
    sender_name: row.sender_name,
    provider_template_id: row.provider_template_id,
    dlt_template_id: row.dlt_template_id,
    approval_status: row.approval_status,
    approval_note: row.approval_note,
    approved_at: row.approved_at,
    sample_variables: (row.sample_variables as Record<string, string> | null) ?? null,
    variables: placeholders,
    is_transactional: row.is_transactional === 1,
    is_active: row.is_active === 1,
    last_used_at: row.last_used_at,
    usage_count: row.usage_count,
    deleted_at: row.deleted_at,
    updated_at: row.updated_at,
    stats: { sent_30d: Number(row.sent_30d), delivered_30d: Number(row.delivered_30d), failed_30d: Number(row.failed_30d) },
    violations,
    can_send: blockers(violations).length === 0 && row.is_active === 1,
    sms: row.channel === 'sms' ? smsInfo(row.body ?? '') : null,
  };
}

export const templatesService = {
  async list(filters: TemplateFilters, exec: Executor = pool) {
    const rows = await templatesRepository.list(filters, exec);
    const templates = [];
    for (const row of rows) templates.push(await decorate(row, exec));
    return { templates };
  },

  async get(id: number, exec: Executor = pool) {
    const row = await templatesRepository.byId(id, exec);
    if (!row) throw ApiError.notFound('Template');
    return decorate(row, exec);
  },

  async create(input: TemplateInput, adminId: number, exec: Executor = pool) {
    const locale = input.locale ?? 'en-IN';
    if (await templatesRepository.conflicting(input.event_key, input.channel, locale, null, exec)) {
      throw ApiError.conflict(
        `There is already a ${input.channel} template for "${input.event_key}" in ${locale}.`,
        'CONFLICT',
      );
    }

    const id = await templatesRepository.create(
      {
        event_key: input.event_key,
        channel: input.channel,
        category: input.category,
        locale,
        name: input.name,
        description: input.description ?? null,
        subject: input.subject ?? null,
        preheader: input.preheader ?? null,
        header_text: input.header_text ?? null,
        body: input.body,
        footer_text: input.footer_text ?? null,
        buttons: input.buttons ? JSON.stringify(input.buttons) : null,
        sender_id: input.sender_id ?? null,
        provider_template_id: input.provider_template_id ?? null,
        dlt_template_id: input.dlt_template_id ?? null,
        approval_status: input.approval_status ?? approvalDefault(input.channel),
        sample_variables: input.sample_variables ? JSON.stringify(input.sample_variables) : null,
        is_transactional: transactionalFor(input.category),
        // A new template is off. Someone writes it, previews it, sends a test,
        // and only then turns it on — the opposite order is how a first draft
        // goes to four thousand people.
        is_active: input.is_active ? 1 : 0,
        created_by_admin_id: adminId,
        updated_by_admin_id: adminId,
      },
      exec,
    );

    return this.get(id, exec);
  },

  async update(id: number, input: Partial<TemplateInput>, adminId: number, exec: Executor = pool) {
    const existing = await templatesRepository.byId(id, exec);
    if (!existing) throw ApiError.notFound('Template');

    const eventKey = input.event_key ?? existing.event_key;
    const channel = input.channel ?? existing.channel;
    const locale = input.locale ?? existing.locale;
    if (
      (input.event_key || input.channel || input.locale) &&
      (await templatesRepository.conflicting(eventKey, channel, locale, id, exec))
    ) {
      throw ApiError.conflict(`Another ${channel} template already uses "${eventKey}" in ${locale}.`, 'CONFLICT');
    }

    const patch: Record<string, unknown> = { updated_by_admin_id: adminId };
    const copy = <K extends keyof TemplateInput>(key: K, column = key as string) => {
      if (input[key] !== undefined) patch[column] = input[key] ?? null;
    };

    copy('event_key');
    copy('channel');
    copy('locale');
    copy('name');
    copy('description');
    copy('subject');
    copy('preheader');
    copy('header_text');
    copy('body');
    copy('footer_text');
    copy('sender_id');
    copy('provider_template_id');
    copy('dlt_template_id');
    copy('approval_status');
    copy('approval_note');

    if (input.buttons !== undefined) patch.buttons = input.buttons ? JSON.stringify(input.buttons) : null;
    if (input.sample_variables !== undefined) {
      patch.sample_variables = input.sample_variables ? JSON.stringify(input.sample_variables) : null;
    }
    if (input.is_active !== undefined) patch.is_active = input.is_active ? 1 : 0;
    if (input.category !== undefined) {
      patch.category = input.category;
      patch.is_transactional = transactionalFor(input.category);
    }
    // Approving is a moment, not a flag, and the date is what an auditor asks for.
    if (input.approval_status === 'approved' && existing.approval_status !== 'approved') {
      patch.approved_at = new Date();
    }

    await templatesRepository.update(id, patch, exec);
    return this.get(id, exec);
  },

  /** A copy, off, with " (copy)" on the name and a free event key. */
  async duplicate(id: number, adminId: number, exec: Executor = pool) {
    const source = await templatesRepository.byId(id, exec);
    if (!source) throw ApiError.notFound('Template');

    let eventKey = `${source.event_key}.copy`;
    let attempt = 1;
    while (await templatesRepository.conflicting(eventKey, source.channel, source.locale, null, exec)) {
      attempt += 1;
      eventKey = `${source.event_key}.copy${attempt}`;
    }

    return this.create(
      {
        event_key: eventKey,
        channel: source.channel,
        category: source.category,
        locale: source.locale,
        name: `${source.name} (copy)`,
        description: source.description,
        subject: source.subject,
        preheader: source.preheader,
        header_text: source.header_text,
        body: source.body,
        footer_text: source.footer_text,
        buttons: source.buttons,
        sender_id: source.sender_id,
        // Deliberately not copied: an approval and a DLT registration belong to
        // the exact wording that was registered, and this is about to be edited.
        dlt_template_id: null,
        provider_template_id: null,
        sample_variables: (source.sample_variables as Record<string, string> | null) ?? null,
        is_active: false,
      },
      adminId,
      exec,
    );
  },

  async remove(id: number, exec: Executor = pool) {
    const inUse = await templatesRepository.campaignsUsing(id, exec);
    if (inUse > 0) {
      throw ApiError.conflict(
        `${inUse} campaign${inUse === 1 ? '' : 's'} still point at this template. Cancel or finish them first.`,
        'IN_USE',
      );
    }
    await templatesRepository.softDelete(id, exec);
    return { deleted: true };
  },

  async restore(id: number, exec: Executor = pool) {
    await templatesRepository.restore(id, exec);
    return this.get(id, exec);
  },

  /**
   * What the message will look like, filled in.
   *
   * Every placeholder resolves: the sample values first, then the catalogue's
   * examples. A preview showing {{first_name}} teaches nobody anything about
   * whether the sentence reads well.
   */
  async preview(
    id: number,
    overrides: Record<string, string> = {},
    exec: Executor = pool,
  ) {
    const row = await templatesRepository.byId(id, exec);
    if (!row) throw ApiError.notFound('Template');

    const sample = { ...((row.sample_variables as Record<string, string> | null) ?? {}), ...overrides };
    const fill = (text: string | null) => (text ? renderPreview(text, sample, exampleFor) : null);
    const body = fill(row.body) ?? '';
    const sender = await senderFor(row, exec);
    const settings = await messagingSettings(exec);

    return {
      channel: row.channel,
      category: row.category,
      subject: fill(row.subject),
      preheader: fill(row.preheader),
      header_text: fill(row.header_text),
      body,
      footer_text: fill(row.footer_text),
      buttons: row.buttons ?? null,
      variables: extractVariables(row.subject, row.header_text, row.body, row.footer_text),
      resolved: sample,
      sms: row.channel === 'sms' ? smsInfo(body) : null,
      limits: CHANNEL_LIMITS[row.channel as keyof typeof CHANNEL_LIMITS] ?? null,
      sender: sender
        ? {
            id: sender.id,
            name: sender.name,
            provider: sender.provider,
            from: sender.from_email ?? sender.sms_header ?? sender.display_phone ?? sender.name,
            simulated: sender.provider === 'simulator',
          }
        : null,
      violations: checkTemplate(row, sender, settings),
    };
  },

  /**
   * Sends the template to one address, to see it land.
   *
   * Consent and the frequency cap are skipped — this goes to whoever asked for
   * it, not to a customer — but the compliance blockers are not, because a
   * template that cannot legally be sent should not be testable into believing
   * it can. Logged like any other message, with the admin who asked recorded
   * against it.
   */
  async testSend(
    id: number,
    to: string,
    adminId: number,
    overrides: Record<string, string> = {},
    exec: Executor = pool,
  ) {
    const row = await templatesRepository.byId(id, exec);
    if (!row) throw ApiError.notFound('Template');

    const settings = await messagingSettings(exec);
    const sender = await senderFor(row, exec);
    const failed = blockers(checkTemplate(row, sender, settings));
    if (failed.length > 0) {
      throw ApiError.conflict(
        `This template cannot be sent yet: ${failed.map((violation) => violation.message).join(' ')}`,
        'INVALID_OPERATION',
        { violations: failed as unknown as Record<string, unknown> },
      );
    }

    const sample = { ...((row.sample_variables as Record<string, string> | null) ?? {}), ...overrides };
    const filled: Record<string, string> = {};
    for (const key of extractVariables(row.subject, row.header_text, row.body, row.footer_text)) {
      filled[key] = sample[key] ?? exampleFor(key);
    }

    const body = renderPreview(row.body, filled, exampleFor);
    const provider = await resolveMessageProvider(row.channel as 'sms' | 'email' | 'whatsapp' | 'push', {
      provider: sender?.provider ?? null,
      category: row.category,
      deliveryRate: settings.simulatorDeliveryRate,
    });

    const result = await provider.send({
      channel: row.channel as 'sms' | 'email' | 'whatsapp' | 'push',
      to,
      body,
      subject: row.subject ? renderPreview(row.subject, filled, exampleFor) : null,
      providerTemplateId: row.provider_template_id,
      variables: filled,
      sender: outboundSender(sender),
    });

    const logId = await messagingRepository.logMessage(
      {
        templateId: row.id,
        // Prefixed so a test can never be mistaken for a real send in the log,
        // or counted in a template's thirty-day numbers.
        eventKey: `test.${row.event_key}`.slice(0, 60),
        channel: row.channel,
        recipient: to,
        customerId: null,
        orderId: null,
        senderId: sender?.id ?? null,
        sentByAdminId: adminId,
        provider: provider.name,
        providerMessageId: result.providerMessageId,
        status: result.status,
        error: result.error,
        cost: result.cost,
        payload: { body, variables: filled, test: true, provider_status: result.providerStatus },
      },
      exec,
    );

    return {
      sent: result.status !== 'failed',
      status: result.status,
      log_id: logId,
      simulated: provider.name === 'simulator' || provider.name === 'logging',
      error: result.error,
    };
  },

  /** The insert menu's contents. Same idea as the page builder's catalogue. */
  variables() {
    return { variables: MESSAGE_VARIABLES };
  },
};
