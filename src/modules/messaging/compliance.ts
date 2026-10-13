import { CHANNEL_LIMITS, extractVariables, renderPreview, smsInfo } from './messageContent';
import { exampleFor, variableDefinition } from './messageVariables';
import { formatMinutes, minutesOfDayIn, type MessagingSettings } from './messagingSettings';

/**
 * The rules that stop a message going out, and the words to explain them.
 *
 * The shop chose the hard version of this: a send that breaks a rule is refused
 * rather than flagged, and the refusal names the rule. That is the right trade
 * for India. A promotional SMS at 21:30 is not a style mistake, it is a TRAI
 * violation that the operator bills the registered entity for; a WhatsApp
 * template sent without opt-in costs the business number its quality rating and
 * eventually its ability to deliver at all. Neither is recoverable by saying
 * sorry afterwards, so neither is a warning.
 *
 * Two entry points, because there are two moments:
 *
 *   checkTemplate  — static. Everything knowable from the words, the category
 *                    and the sender. Runs while someone types, and again before
 *                    a campaign is allowed to start.
 *
 *   checkSend      — per recipient, at the moment of sending. Consent, the
 *                    frequency cap and the clock, none of which a template can
 *                    be checked against in advance.
 *
 * Every violation carries a `fix`: a refusal that does not say what to do next
 * gets worked around rather than fixed.
 */

export type Severity = 'blocker' | 'warning';

export type ViolationCode =
  | 'template_inactive'
  | 'empty_body'
  | 'too_long'
  | 'missing_dlt_id'
  | 'missing_opt_out'
  | 'missing_unsubscribe'
  | 'not_approved'
  | 'no_sender'
  | 'sender_paused'
  | 'sender_incomplete'
  | 'too_many_variables'
  | 'variable_too_long'
  | 'unicode_sms'
  | 'many_segments'
  | 'bulk_authentication'
  | 'no_consent'
  | 'quiet_hours'
  | 'too_soon'
  | 'no_recipient';

export interface Violation {
  code: ViolationCode;
  severity: Severity;
  message: string;
  fix?: string;
  /** Which field the admin should be taken to, when there is one. */
  field?: string;
}

export interface TemplateLike {
  channel: string;
  category: string;
  subject: string | null;
  header_text?: string | null;
  body: string;
  footer_text?: string | null;
  dlt_template_id: string | null;
  provider_template_id: string | null;
  approval_status?: string | null;
  is_active: number;
  sample_variables?: unknown;
}

export interface SenderLike {
  id: number;
  channel: string;
  provider: string;
  status: string;
  from_email: string | null;
  sms_header: string | null;
  dlt_pe_id: string | null;
  phone_number_id: string | null;
}

/** Most operators cap a registered SMS template at six placeholders. */
const DLT_MAX_VARIABLES = 6;
/** And at thirty characters per resolved placeholder. */
const DLT_MAX_VARIABLE_LENGTH = 30;

function sampleMap(template: TemplateLike): Record<string, string> {
  const raw = template.sample_variables;
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = value == null ? '' : String(value);
  }
  return out;
}

export function checkTemplate(
  template: TemplateLike,
  sender: SenderLike | null,
  settings: MessagingSettings,
): Violation[] {
  const violations: Violation[] = [];
  const channel = template.channel;
  const marketing = template.category === 'marketing';
  const limits = CHANNEL_LIMITS[channel as keyof typeof CHANNEL_LIMITS] ?? CHANNEL_LIMITS.sms;

  if (!template.body || template.body.trim() === '') {
    violations.push({
      code: 'empty_body',
      severity: 'blocker',
      message: 'The message has no body.',
      fix: 'Write what the customer should read.',
      field: 'body',
    });
  }

  if (template.body && template.body.length > limits.body) {
    violations.push({
      code: 'too_long',
      severity: 'blocker',
      message: `${channel === 'whatsapp' ? 'WhatsApp' : 'This channel'} allows ${limits.body} characters and this is ${template.body.length}.`,
      fix: 'Shorten the body.',
      field: 'body',
    });
  }

  if (channel === 'email' && template.subject && template.subject.length > limits.subject) {
    violations.push({
      code: 'too_long',
      severity: 'warning',
      message: `Subjects over ${limits.subject} characters are cut off in most inboxes.`,
      fix: 'Put the important words first.',
      field: 'subject',
    });
  }

  // ── India, SMS ────────────────────────────────────────────────────────────
  if (channel === 'sms' && settings.enforceDlt && template.category !== 'authentication') {
    if (!template.dlt_template_id || template.dlt_template_id.trim() === '') {
      violations.push({
        code: 'missing_dlt_id',
        severity: 'blocker',
        message: 'Indian operators reject commercial SMS without a registered DLT template ID.',
        fix: 'Register this wording on the DLT portal and paste the template ID here. Approval usually takes two to four working days.',
        field: 'dlt_template_id',
      });
    }
  }
  if (channel === 'sms' && settings.enforceDlt && template.category === 'authentication' && !template.dlt_template_id) {
    violations.push({
      code: 'missing_dlt_id',
      severity: 'warning',
      message: 'OTP templates are also registered on DLT, under the service-implicit category.',
      fix: 'Add the template ID before this goes anywhere near production.',
      field: 'dlt_template_id',
    });
  }

  if (channel === 'sms' && marketing && settings.requireOptOut) {
    const body = (template.body ?? '').toUpperCase();
    if (!body.includes('STOP') && !body.includes(settings.optOutTextSms.toUpperCase())) {
      violations.push({
        code: 'missing_opt_out',
        severity: 'blocker',
        message: 'A promotional SMS must tell the recipient how to stop receiving them.',
        fix: `Add "${settings.optOutTextSms}" to the end of the body.`,
        field: 'body',
      });
    }
  }

  if (channel === 'email' && marketing && settings.requireOptOut) {
    const combined = `${template.body ?? ''} ${template.footer_text ?? ''}`;
    if (!combined.includes('{{unsubscribe_url}}') && !/unsubscribe/i.test(combined)) {
      violations.push({
        code: 'missing_unsubscribe',
        severity: 'blocker',
        message: 'A marketing email must carry a way to unsubscribe.',
        fix: 'Insert the {{unsubscribe_url}} field, usually in the footer.',
        field: 'body',
      });
    }
  }

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  if (channel === 'whatsapp') {
    const approved = (template.approval_status ?? 'not_required') === 'approved';
    if (!approved) {
      violations.push({
        code: 'not_approved',
        severity: 'blocker',
        message: 'WhatsApp will not deliver a business-initiated message from an unapproved template.',
        fix: 'Submit it to Meta for review, then mark it approved here once it passes.',
        field: 'approval_status',
      });
    }
    if (sender && sender.provider !== 'simulator' && !template.provider_template_id) {
      violations.push({
        code: 'not_approved',
        severity: 'blocker',
        message: 'This template has no name registered with the provider.',
        fix: 'Paste the approved template name from the WhatsApp Manager.',
        field: 'provider_template_id',
      });
    }
  }

  // ── placeholders ──────────────────────────────────────────────────────────
  const placeholders = extractVariables(template.subject, template.header_text, template.body, template.footer_text);
  const counted = placeholders.filter((key) => variableDefinition(key)?.dltCountsTowardsLimit !== false);

  if (channel === 'sms' && settings.enforceDlt && counted.length > DLT_MAX_VARIABLES) {
    violations.push({
      code: 'too_many_variables',
      severity: 'blocker',
      message: `DLT allows ${DLT_MAX_VARIABLES} variables in a registered SMS template; this uses ${counted.length}.`,
      fix: 'Fold some of them into fixed wording.',
      field: 'body',
    });
  }

  if (channel === 'sms' && settings.enforceDlt) {
    const samples = sampleMap(template);
    for (const key of counted) {
      const value = samples[key] ?? exampleFor(key);
      if (value.length > DLT_MAX_VARIABLE_LENGTH) {
        violations.push({
          code: 'variable_too_long',
          severity: 'warning',
          message: `{{${key}}} resolves to ${value.length} characters; operators truncate a variable at ${DLT_MAX_VARIABLE_LENGTH}.`,
          fix: 'Use a shorter value, or move it out of the placeholder.',
          field: 'body',
        });
      }
    }
  }

  // ── what it will cost ─────────────────────────────────────────────────────
  if (channel === 'sms' && template.body) {
    const preview = renderPreview(template.body, sampleMap(template), exampleFor);
    const info = smsInfo(preview);
    if (info.encoding === 'UCS-2') {
      violations.push({
        code: 'unicode_sms',
        severity: 'warning',
        message: `"${info.unsupportedCharacter}" forces Unicode encoding, which cuts an SMS from 160 characters to 70.`,
        fix: 'Replace curly quotes, dashes and symbols with plain ASCII, or accept the extra segments.',
        field: 'body',
      });
    }
    if (info.segments > 2) {
      violations.push({
        code: 'many_segments',
        severity: 'warning',
        message: `This sends as ${info.segments} SMS segments and is billed ${info.segments} times.`,
        fix: 'Shorten it, or send the detail as a link.',
        field: 'body',
      });
    }
  }

  // ── the sender ────────────────────────────────────────────────────────────
  if (!sender) {
    violations.push({
      code: 'no_sender',
      severity: 'blocker',
      message: 'No sender is chosen, so there is no identity to send this from.',
      fix: 'Pick one under Senders.',
      field: 'sender_id',
    });
  } else {
    if (sender.status !== 'active') {
      violations.push({
        code: 'sender_paused',
        severity: 'blocker',
        message: `The sender "${sender.channel}" is paused.`,
        fix: 'Resume it, or choose another.',
        field: 'sender_id',
      });
    }
    if (channel === 'email' && !sender.from_email) {
      violations.push({
        code: 'sender_incomplete',
        severity: 'blocker',
        message: 'This email sender has no From address.',
        fix: 'Add one under Senders.',
        field: 'sender_id',
      });
    }
    if (channel === 'sms' && settings.enforceDlt) {
      if (!sender.sms_header) {
        violations.push({
          code: 'sender_incomplete',
          severity: 'blocker',
          message: 'This SMS sender has no registered header.',
          fix: 'Add the six-character sender ID approved on the DLT portal.',
          field: 'sender_id',
        });
      }
      if (!sender.dlt_pe_id) {
        violations.push({
          code: 'sender_incomplete',
          severity: 'warning',
          message: 'This SMS sender has no Principal Entity ID recorded.',
          fix: 'Add the PE ID from the DLT registry so sends can be traced back to it.',
          field: 'sender_id',
        });
      }
    }
    if (channel === 'whatsapp' && sender.provider !== 'simulator' && !sender.phone_number_id) {
      violations.push({
        code: 'sender_incomplete',
        severity: 'blocker',
        message: 'This WhatsApp sender has no phone number ID.',
        fix: 'Copy it from the WhatsApp Manager.',
        field: 'sender_id',
      });
    }
  }

  if (!template.is_active) {
    violations.push({
      code: 'template_inactive',
      severity: 'warning',
      message: 'This template is switched off and will not be used by anything.',
      fix: 'Turn it on when the wording is final.',
      field: 'is_active',
    });
  }

  return violations;
}

// ── the clock ────────────────────────────────────────────────────────────────

export interface QuietHours {
  inside: boolean;
  nowMinutes: number;
  windowStart: number;
  windowEnd: number;
  /** Plain words for the screen: "Promotional sending resumes at 10:00 IST." */
  message: string;
}

/**
 * Whether promotional sending is permitted right now.
 *
 * TRAI prohibits promotional communication outside 10:00–21:00 local time. The
 * window is read from settings rather than hard-coded, but the default is the
 * regulation, and a campaign started at 21:05 waits rather than sending.
 */
export function quietHours(settings: MessagingSettings, when: Date = new Date()): QuietHours {
  const now = minutesOfDayIn(settings.timezone, when);
  const inside = now >= settings.marketingWindowStart && now < settings.marketingWindowEnd;
  return {
    inside,
    nowMinutes: now,
    windowStart: settings.marketingWindowStart,
    windowEnd: settings.marketingWindowEnd,
    message: inside
      ? `Promotional sending is open until ${formatMinutes(settings.marketingWindowEnd)}.`
      : `Promotional messages may only be sent between ${formatMinutes(settings.marketingWindowStart)} and ${formatMinutes(settings.marketingWindowEnd)} ${settings.timezone.split('/').pop()} time.`,
  };
}

/** Which channels the quiet-hours rule is enforced on. Email is not regulated this way. */
export function quietHoursApplies(channel: string, category: string): boolean {
  return category === 'marketing' && (channel === 'sms' || channel === 'whatsapp');
}

export function blockers(violations: Violation[]): Violation[] {
  return violations.filter((violation) => violation.severity === 'blocker');
}
