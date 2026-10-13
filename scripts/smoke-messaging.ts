/**
 * End-to-end smoke test for messaging: templates, senders, campaigns, the
 * delivery log and the one-to-one composer.
 *
 *   npm run dev
 *   npm run smoke:messaging
 *
 * The assertions are written around the things that would actually hurt, rather
 * than around the happy path:
 *
 *   - a marketing SMS with no DLT template ID cannot be sent, and says so
 *   - a marketing email with no unsubscribe link cannot be sent
 *   - a WhatsApp template that Meta has not approved cannot be sent
 *   - an authentication template cannot be used for a bulk campaign
 *   - a campaign reaches only people who opted in, and the review step says how
 *     many were dropped and why
 *   - starting a campaign twice does not message anyone twice
 *   - a campaign that is sending cannot be edited
 *   - free-text SMS is refused while DLT is enforced, and free-text WhatsApp is
 *     refused outside the 24-hour window
 *   - the promotional window is enforced on the clock, not on good intentions
 *
 * Everything it creates is prefixed `smokemsg` and removed at the end.
 */
import { env } from '../src/config/env';
import { closePool, execute, query, queryOne, type RowDataPacket } from '../src/db/pool';

const ADMIN = `http://127.0.0.1:${env.port}${env.apiPrefix}`;

let passed = 0;
const failures: string[] = [];
let adminToken = '';

function ok(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failures.push(label);
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}\n`);
  }
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

interface Raw<T> {
  status: number;
  body: T;
}

async function admin<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Raw<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (adminToken) headers.Authorization = `Bearer ${adminToken}`;
  const response = await fetch(`${ADMIN}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed as T };
}

async function orThrow<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const result = await admin<T>(path, options);
  if (result.status >= 400) {
    throw new Error(`${options.method ?? 'GET'} ${path} → ${result.status} ${JSON.stringify(result.body).slice(0, 400)}`);
  }
  return result.body;
}

const stamp = Date.now().toString().slice(-6);
const key = (suffix: string) => `smokemsg.${stamp}.${suffix}`;

interface Template {
  id: number;
  can_send: boolean;
  violations: { code: string; severity: string; message: string }[];
  sms: { segments: number; encoding: string } | null;
  variables: string[];
}

interface Campaign {
  id: number;
  status: string;
  editable: boolean;
  stats: { total_recipients: number; sent: number; skipped: number; delivered: number; failed: number; pending: number };
}

interface Preflight {
  ready: boolean;
  violations: { code: string; severity: string; message: string }[];
  audience: { matched: number; contactable: number; eligible: number; no_consent: number };
  sample: { id: number; recipient: string }[];
}

async function cleanup(): Promise<void> {
  await execute(
    `DELETE r FROM message_campaign_recipients r
       JOIN message_campaigns c ON c.id = r.campaign_id
      WHERE c.name LIKE 'smokemsg%'`,
  );
  await execute("DELETE FROM notification_logs WHERE event_key LIKE 'smokemsg%' OR event_key LIKE 'test.smokemsg%'");
  await execute(
    `DELETE FROM notification_logs WHERE campaign_id IN (SELECT id FROM message_campaigns WHERE name LIKE 'smokemsg%')`,
  );
  await execute("DELETE FROM message_campaigns WHERE name LIKE 'smokemsg%'");
  await execute("DELETE FROM notification_templates WHERE event_key LIKE 'smokemsg%'");
  await execute("DELETE FROM messaging_senders WHERE name LIKE 'smokemsg%'");
}

async function main(): Promise<void> {
  await execute("DELETE FROM rate_limits WHERE bucket_key LIKE 'admin.%'");
  await cleanup();

  const login = await admin<{ tokens?: { access_token: string }; access_token?: string }>('/auth/login', {
    method: 'POST',
    body: { email: env.superAdmin.email, password: env.superAdmin.password },
  });
  adminToken = login.body.tokens?.access_token ?? login.body.access_token ?? '';
  if (!adminToken) throw new Error(`admin sign-in failed: ${JSON.stringify(login.body).slice(0, 200)}`);

  // ── the vocabulary ────────────────────────────────────────────────────────
  section('The catalogue');
  const catalogue = await orThrow<{
    variables: { key: string }[];
    audience: { fields: { key: string; operators: { value: string }[] }[] };
    rules: { dlt_enforced: boolean; promotional_window: string };
  }>('/messaging/catalogue');

  ok('merge fields are served, not hard-coded in the admin', catalogue.variables.length > 10);
  ok('audience fields carry their own operators', catalogue.audience.fields.every((field) => field.operators.length > 0));
  ok('the promotional window is published', /\d\d:\d\d–\d\d:\d\d/.test(catalogue.rules.promotional_window));

  // ── what cannot be sent ───────────────────────────────────────────────────
  section('Refusals that matter');

  const smsNoDlt = await orThrow<Template>('/messaging/templates', {
    method: 'POST',
    body: {
      event_key: key('sms.nodlt'),
      channel: 'sms',
      category: 'marketing',
      name: 'smokemsg SMS without DLT',
      body: 'Hi {{first_name}}, 20% off this week at {{shop_name}}. To stop, reply STOP',
      is_active: true,
    },
  });
  ok('a marketing SMS with no DLT template ID cannot send', smsNoDlt.can_send === false);
  ok(
    'and the refusal names the DLT registration',
    smsNoDlt.violations.some((violation) => violation.code === 'missing_dlt_id' && violation.severity === 'blocker'),
    smsNoDlt.violations,
  );

  const withDlt = await orThrow<Template>(`/messaging/templates/${smsNoDlt.id}`, {
    method: 'PATCH',
    body: { dlt_template_id: '1307161234567890123' },
  });
  ok('adding the DLT ID clears it', withDlt.can_send === true, withDlt.violations);

  const noStop = await orThrow<Template>(`/messaging/templates/${smsNoDlt.id}`, {
    method: 'PATCH',
    body: { body: 'Hi {{first_name}}, 20% off this week at {{shop_name}}.' },
  });
  ok(
    'a promotional SMS with no way to opt out is refused',
    noStop.violations.some((violation) => violation.code === 'missing_opt_out' && violation.severity === 'blocker'),
    noStop.violations,
  );
  await orThrow(`/messaging/templates/${smsNoDlt.id}`, {
    method: 'PATCH',
    body: { body: 'Hi {{first_name}}, 20% off this week at {{shop_name}}. To stop, reply STOP' },
  });

  const emailNoUnsub = await orThrow<Template>('/messaging/templates', {
    method: 'POST',
    body: {
      event_key: key('email.nounsub'),
      channel: 'email',
      category: 'marketing',
      name: 'smokemsg email without unsubscribe',
      subject: 'A note from {{shop_name}}',
      body: 'Hi {{first_name}}, we have something new.',
      is_active: true,
    },
  });
  ok(
    'a marketing email with no unsubscribe is refused',
    emailNoUnsub.violations.some((violation) => violation.code === 'missing_unsubscribe' && violation.severity === 'blocker'),
    emailNoUnsub.violations,
  );

  const whatsapp = await orThrow<Template>('/messaging/templates', {
    method: 'POST',
    body: {
      event_key: key('wa.unapproved'),
      channel: 'whatsapp',
      category: 'marketing',
      name: 'smokemsg WhatsApp unapproved',
      body: 'Hi {{first_name}}, your edit is ready at {{shop_url}}. Reply STOP to stop.',
      is_active: true,
    },
  });
  ok(
    'an unapproved WhatsApp template cannot send',
    whatsapp.violations.some((violation) => violation.code === 'not_approved' && violation.severity === 'blocker'),
    whatsapp.violations,
  );

  // ── the cost of a sentence ────────────────────────────────────────────────
  section('What an SMS actually costs');
  const unicode = await orThrow<Template>(`/messaging/templates/${smsNoDlt.id}`, {
    method: 'PATCH',
    body: { body: 'Hi {{first_name}}, here’s 20% off — this week only at {{shop_name}}. To stop, reply STOP' },
  });
  ok('a curly apostrophe is caught as Unicode', unicode.sms?.encoding === 'UCS-2', unicode.sms);
  ok(
    'and the editor is warned before it bills three times',
    unicode.violations.some((violation) => violation.code === 'unicode_sms'),
  );
  const plain = await orThrow<Template>(`/messaging/templates/${smsNoDlt.id}`, {
    method: 'PATCH',
    body: { body: 'Hi {{first_name}}, 20% off this week at {{shop_name}}. To stop, reply STOP' },
  });
  ok('plain ASCII is one GSM segment', plain.sms?.encoding === 'GSM-7' && plain.sms.segments === 1, plain.sms);

  // ── preview and test send ─────────────────────────────────────────────────
  section('Preview and test send');
  const preview = await orThrow<{ body: string; sender: { simulated: boolean } | null }>(
    `/messaging/templates/${smsNoDlt.id}/preview`,
    { method: 'POST', body: { variables: { first_name: 'Ananya' } } },
  );
  ok('every placeholder resolves in a preview', !preview.body.includes('{{'), preview.body);
  ok('the preview says the sender is simulated', preview.sender?.simulated === true);

  const test = await admin<{ sent: boolean; simulated: boolean }>(`/messaging/templates/${smsNoDlt.id}/test-send`, {
    method: 'POST',
    body: { to: '919999900001' },
  });
  ok('a test send goes through and is marked simulated', test.status === 200 && test.body.simulated === true, test.body);

  const blockedTest = await admin(`/messaging/templates/${emailNoUnsub.id}/test-send`, {
    method: 'POST',
    body: { to: 'someone@example.com' },
  });
  ok('a template that cannot send cannot be test-sent either', blockedTest.status === 409, blockedTest.body);

  // ── an audience ───────────────────────────────────────────────────────────
  section('Audience');

  // Two customers who have opted in to email, and one who has not, so the
  // breakdown has something to subtract.
  const consenting = await query<RowDataPacket & { id: number }>(
    `SELECT id FROM customers
      WHERE deleted_at IS NULL AND status = 'active' AND email IS NOT NULL AND email <> ''
      ORDER BY id LIMIT 3`,
  );
  if (consenting.length < 2) throw new Error('needs at least two customers with an email address');
  await execute(
    `UPDATE customers SET accepts_email_marketing = 1 WHERE id IN (${consenting.slice(0, 2).map(() => '?').join(',')})`,
    consenting.slice(0, 2).map((row) => row.id),
  );
  if (consenting[2]) await execute('UPDATE customers SET accepts_email_marketing = 0 WHERE id = ?', [consenting[2].id]);

  const estimate = await orThrow<{ matched: number; contactable: number; eligible: number }>(
    '/messaging/campaigns/estimate',
    {
      method: 'POST',
      body: {
        channel: 'email',
        marketing: true,
        audience_type: 'manual',
        customer_ids: consenting.map((row) => row.id),
        exclude_recent_hours: 0,
      },
    },
  );
  ok('the estimate separates who matched from who may be messaged', estimate.matched >= estimate.contactable, estimate);
  ok('and only opted-in customers are contactable', estimate.contactable === 2, estimate);

  const badRule = await admin('/messaging/campaigns/estimate', {
    method: 'POST',
    body: {
      channel: 'email',
      audience_type: 'rules',
      rules: [{ field: 'id) OR 1=1 --', operator: '=', value: 1 }],
    },
  });
  ok('a field that is not in the catalogue is refused, not interpolated', badRule.status === 400, badRule.body);

  // ── a campaign ────────────────────────────────────────────────────────────
  section('A campaign, end to end');

  const goodEmail = await orThrow<Template>('/messaging/templates', {
    method: 'POST',
    body: {
      event_key: key('email.offer'),
      channel: 'email',
      category: 'marketing',
      name: 'smokemsg offer email',
      subject: 'Something new at {{shop_name}}',
      body: 'Hi {{first_name}},\n\nUse {{offer_code}} before {{offer_ends}}.\n\nNot interested? {{unsubscribe_url}}',
      is_active: true,
    },
  });
  ok('a complete marketing email can send', goodEmail.can_send === true, goodEmail.violations);

  const campaign = await orThrow<Campaign>('/messaging/campaigns', {
    method: 'POST',
    body: {
      name: `smokemsg campaign ${stamp}`,
      channel: 'email',
      template_id: goodEmail.id,
      audience_type: 'manual',
      customer_ids: consenting.map((row) => row.id),
      exclude_recent_hours: 0,
      variables: { offer_code: 'VEYLOR15', offer_ends: '30 Sep' },
    },
  });
  ok('a campaign starts as a draft', campaign.status === 'draft');

  const preflight = await orThrow<Preflight>(`/messaging/campaigns/${campaign.id}/preflight`);
  ok('preflight passes on a complete campaign', preflight.ready === true, preflight.violations);
  ok('preflight reports who was dropped for consent', preflight.audience.no_consent >= 1, preflight.audience);
  ok('preflight shows a sample of who would receive it', preflight.sample.length > 0);

  const started = await orThrow<Campaign>(`/messaging/campaigns/${campaign.id}/start`, { method: 'POST' });
  ok('starting freezes the audience', started.stats.total_recipients === 2, started.stats);
  ok('and the campaign is now sending', started.status === 'sending');

  const editWhileSending = await admin(`/messaging/campaigns/${campaign.id}`, {
    method: 'PATCH',
    body: { name: 'smokemsg renamed' },
  });
  ok('a campaign that is sending cannot be edited', editWhileSending.status === 409, editWhileSending.body);

  // Pressing start twice is the commonest way to double-send.
  await admin(`/messaging/campaigns/${campaign.id}/start`, { method: 'POST' });
  const afterDouble = await orThrow<Campaign>(`/messaging/campaigns/${campaign.id}`);
  ok('starting twice does not duplicate the audience', afterDouble.stats.total_recipients === 2, afterDouble.stats);

  let guard = 0;
  let run = await orThrow<{ processed: number; done: boolean }>(`/messaging/campaigns/${campaign.id}/run`, { method: 'POST' });
  while (!run.done && guard < 20) {
    run = await orThrow(`/messaging/campaigns/${campaign.id}/run`, { method: 'POST' });
    guard += 1;
  }

  const finished = await orThrow<Campaign>(`/messaging/campaigns/${campaign.id}`);
  ok('the campaign completes', finished.status === 'completed', finished.status);
  ok('and everyone in it was attempted', finished.stats.pending === 0, finished.stats);
  ok('with at least one send recorded', finished.stats.sent >= 1, finished.stats);

  const recipients = await orThrow<{ recipients: { status: string; log_id: number | null }[] }>(
    `/messaging/campaigns/${campaign.id}/recipients`,
  );
  ok('every recipient has a row', recipients.recipients.length === 2);
  ok(
    'and each one points at what was actually sent',
    recipients.recipients.filter((recipient) => recipient.status !== 'skipped').every((recipient) => recipient.log_id !== null),
    recipients.recipients,
  );

  const logged = await queryOne<RowDataPacket & { total: number }>(
    'SELECT COUNT(*) AS total FROM notification_logs WHERE campaign_id = ?',
    [campaign.id],
  );
  ok('the outbox holds one row per message', Number(logged?.total ?? 0) === finished.stats.sent + finished.stats.failed, {
    logged: logged?.total,
    stats: finished.stats,
  });

  // ── an authentication template in bulk ────────────────────────────────────
  section('What a campaign may not do');
  const otpTemplate = await queryOne<RowDataPacket & { id: number }>(
    "SELECT id FROM notification_templates WHERE category = 'authentication' AND channel = 'sms' LIMIT 1",
  );
  if (otpTemplate) {
    const otpCampaign = await orThrow<Campaign>('/messaging/campaigns', {
      method: 'POST',
      body: {
        name: `smokemsg otp blast ${stamp}`,
        channel: 'sms',
        template_id: otpTemplate.id,
        audience_type: 'manual',
        customer_ids: consenting.map((row) => row.id),
      },
    });
    const otpPreflight = await orThrow<Preflight>(`/messaging/campaigns/${otpCampaign.id}/preflight`);
    ok(
      'a one-time-code template cannot be sent in bulk',
      otpPreflight.violations.some((violation) => violation.code === 'bulk_authentication'),
      otpPreflight.violations,
    );
    const otpStart = await admin(`/messaging/campaigns/${otpCampaign.id}/start`, { method: 'POST' });
    ok('and starting it is refused', otpStart.status === 409, otpStart.body);
  }

  // ── one customer ──────────────────────────────────────────────────────────
  section('Messaging one person');
  const customerId = consenting[0].id;
  const context = await orThrow<{
    channels: { channel: string; free_text: boolean; free_text_reason: string | null; templates: unknown[] }[];
  }>(`/messaging/customers/${customerId}/context`);

  const sms = context.channels.find((channel) => channel.channel === 'sms');
  const wa = context.channels.find((channel) => channel.channel === 'whatsapp');
  const email = context.channels.find((channel) => channel.channel === 'email');
  ok('free-text SMS is not offered while DLT is enforced', sms?.free_text === false, sms?.free_text_reason);
  ok('free-text WhatsApp is not offered outside the 24-hour window', wa?.free_text === false, wa?.free_text_reason);
  ok('free-text email is offered', email?.free_text === true);

  const freeSms = await admin(`/messaging/customers/${customerId}/send`, {
    method: 'POST',
    body: { channel: 'sms', body: 'hello' },
  });
  ok('and free-text SMS is actually refused, not just hidden', freeSms.status === 409, freeSms.body);

  const freeEmail = await admin<{ sent: boolean; log_id: number }>(`/messaging/customers/${customerId}/send`, {
    method: 'POST',
    body: { channel: 'email', subject: 'smokemsg hello', body: 'Hi {{first_name}}, just checking in.', purpose: 'service' },
  });
  ok('a service email to one customer goes through', freeEmail.status === 200 && freeEmail.body.sent, freeEmail.body);

  const thread = await orThrow<{ messages: { id: number; body: string | null }[] }>(
    `/messaging/customers/${customerId}/thread`,
  );
  ok('the customer’s thread shows it', thread.messages.some((message) => message.id === freeEmail.body.log_id));
  ok(
    'and the thread carries what was said, rendered',
    thread.messages.find((message) => message.id === freeEmail.body.log_id)?.body?.includes('checking in') === true,
  );

  // ── the clock ─────────────────────────────────────────────────────────────
  section('The promotional window');
  const beforeWindow = await orThrow<{ settings: { setting_key: string; value: string }[] }>('/messaging/settings');
  const startKey = 'messaging.marketing_window_start';
  const endKey = 'messaging.marketing_window_end';
  const previous = {
    start: beforeWindow.settings.find((setting) => setting.setting_key === startKey)?.value ?? '10:00',
    end: beforeWindow.settings.find((setting) => setting.setting_key === endKey)?.value ?? '21:00',
  };

  // Close the window entirely, then try to send promotional WhatsApp.
  await orThrow('/messaging/settings', {
    method: 'PUT',
    body: { values: { [startKey]: '00:00', [endKey]: '00:01' } },
  });

  await execute("UPDATE notification_templates SET approval_status = 'approved' WHERE id = ?", [whatsapp.id]);
  const waCampaign = await orThrow<Campaign>('/messaging/campaigns', {
    method: 'POST',
    body: {
      name: `smokemsg wa window ${stamp}`,
      channel: 'whatsapp',
      template_id: whatsapp.id,
      audience_type: 'manual',
      customer_ids: [customerId],
      exclude_recent_hours: 0,
    },
  });
  const waPreflight = await orThrow<Preflight>(`/messaging/campaigns/${waCampaign.id}/preflight`);
  ok(
    'a promotional campaign outside the window is refused',
    waPreflight.violations.some((violation) => violation.code === 'quiet_hours'),
    waPreflight.violations,
  );

  await orThrow('/messaging/settings', {
    method: 'PUT',
    body: { values: { [startKey]: previous.start, [endKey]: previous.end } },
  });

  // ── the delivery log ──────────────────────────────────────────────────────
  section('The delivery log');
  const activity = await orThrow<{ messages: { campaign_id: number | null }[]; pagination: { total: number } }>(
    `/messaging/activity?campaign_id=${campaign.id}`,
  );
  ok('the log filters by campaign', activity.messages.every((message) => message.campaign_id === campaign.id));
  ok('and counts them', activity.pagination.total === Number(logged?.total ?? 0));

  const summary = await orThrow<{ totals: { total: number }; by_channel: { channel: string }[] }>(
    '/messaging/activity/summary?days=30',
  );
  ok('the summary reports a total', summary.totals.total > 0);
  ok('broken down by channel', summary.by_channel.length > 0);

  // ── tidy up ───────────────────────────────────────────────────────────────
  await cleanup();

  section(`${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`);
    process.exitCode = 1;
  }
}

main()
  .catch(async (error) => {
    process.stdout.write(`\nFAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
