import { env } from '../../config/env';
import { logger } from '../../core/logger';
import { controlPlane, execute, insert, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { postmarkProvider } from '../integrations/providers/postmark';
import { sendgridProvider } from '../integrations/providers/sendgrid';
import type { ConnectionContext } from '../integrations/types';
import { jobQueue } from '../jobs/queue';
import { defineJob } from '../jobs/registry';
import { metrics } from '../observability/metrics';
import { renderEmail, type TemplateData, type TemplateKey } from './templates';

/**
 * Email from the platform to merchants and staff.
 *
 * `send` renders and writes to the `platform_emails` outbox (inside the
 * caller's transaction when given one) and queues delivery; the request that
 * caused the email never waits on a provider. Delivery reuses the same
 * Postmark and SendGrid adapters shops connect, with the platform's own key.
 * With the `log` provider nothing leaves the machine: the message stays in
 * the outbox, where developers and operators read it.
 */

interface EmailRow extends RowDataPacket {
  id: number;
  to_email: string;
  template: string;
  subject: string;
  body: string | null;
  sensitive: number;
  status: 'queued' | 'sent' | 'failed';
  attempts: number;
}

function mask(email: string): string {
  const [name, domain] = email.split('@');
  return `${name.slice(0, 2)}…@${domain ?? ''}`;
}

function context<C>(credentials: C): ConnectionContext<C> {
  return {
    shopId: 0,
    connectionId: 0,
    publicId: 'platform',
    provider: env.mail.provider,
    name: 'Platform email',
    mode: 'live',
    credentials,
    config: { from_email: env.mail.from, from_name: env.mail.fromName },
    inboundUrl: '',
  };
}

function adapter() {
  switch (env.mail.provider) {
    case 'postmark':
      return postmarkProvider.messaging!(context({ server_token: env.mail.apiKey }), 'email');
    case 'sendgrid':
      return sendgridProvider.messaging!(context({ api_key: env.mail.apiKey }), 'email');
    default:
      return null;
  }
}

export const platformMail = {
  /**
   * Queues one email. Returns its id, or null when `dedupeKey` says it was
   * already sent. Pass `tx` to make the email part of the caller's unit of
   * work — an invitation that rolls back sends nothing.
   */
  async send<K extends TemplateKey>(
    input: { to: string; template: K; data: TemplateData[K]; shopId?: number | null; dedupeKey?: string | null },
    tx: Executor = controlPlane,
  ): Promise<number | null> {
    const rendered = renderEmail(input.template, input.data);
    let id: number;
    try {
      id = await insert(
        `INSERT INTO platform_emails (shop_id, to_email, template, subject, body, \`sensitive\`, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [input.shopId ?? null, input.to.trim().toLowerCase(), input.template, rendered.subject.slice(0, 255), rendered.body, rendered.sensitive ? 1 : 0, input.dedupeKey ?? null],
        tx,
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return null;
      throw error;
    }
    await jobQueue.enqueue('platform.email_send', { emailId: id }, { shopId: null, queue: 'default', maxAttempts: 6, uniqueKey: `platform-email:${id}`, tx });
    return id;
  },

  // `sensitive` is a reserved word in MySQL 8, so it is always quoted.

  /** Delivers one queued email. Throws on a provider failure, so the job retries. */
  async deliver(emailId: number): Promise<void> {
    const email = await queryOne<EmailRow>('SELECT * FROM platform_emails WHERE id = ?', [emailId], controlPlane);
    if (!email || email.status === 'sent') return;
    const attempts = email.attempts + 1;

    const sender = adapter();
    if (!sender) {
      await execute(
        "UPDATE platform_emails SET status = 'sent', provider = 'log', attempts = ?, sent_at = UTC_TIMESTAMP() WHERE id = ?",
        [attempts, email.id],
        controlPlane,
      );
      logger.info('platform_email.logged', { id: email.id, to: mask(email.to_email), template: email.template, subject: email.subject });
      metrics.counter('platform_emails_total', { template: email.template, outcome: 'logged' }).inc();
      return;
    }

    const result = await sender.send({
      channel: 'email',
      to: email.to_email,
      subject: email.subject,
      body: email.body ?? '',
      providerTemplateId: null,
      variables: {},
      sender: { fromEmail: env.mail.from, fromName: env.mail.fromName, replyTo: null, smsHeader: null, phoneNumberId: null, displayPhone: null },
      reference: `platform-email-${email.id}`,
    });

    if (result.status === 'failed') {
      await execute("UPDATE platform_emails SET status = 'failed', attempts = ?, error = ? WHERE id = ?", [attempts, (result.error ?? 'failed').slice(0, 500), email.id], controlPlane);
      metrics.counter('platform_emails_total', { template: email.template, outcome: 'failed' }).inc();
      throw new Error(`Platform email ${email.id} was not accepted: ${result.error ?? 'unknown error'}`);
    }
    // A delivered reset link is not kept: the outbox must not be a way into accounts.
    await execute(
      `UPDATE platform_emails
          SET status = 'sent', provider = ?, provider_message_id = ?, attempts = ?, error = NULL, sent_at = UTC_TIMESTAMP(),
              body = IF(\`sensitive\` = 1, NULL, body)
        WHERE id = ?`,
      [env.mail.provider, result.providerMessageId, attempts, email.id],
      controlPlane,
    );
    metrics.counter('platform_emails_total', { template: email.template, outcome: 'sent' }).inc();
  },

  /** The outbox, for operators (and developers reading `log` mail). */
  async recent(filters: { to?: string; template?: string; limit: number }) {
    const where = ['1 = 1'];
    const params: unknown[] = [];
    if (filters.to) {
      where.push('to_email = ?');
      params.push(filters.to.trim().toLowerCase());
    }
    if (filters.template) {
      where.push('template = ?');
      params.push(filters.template);
    }
    return query<EmailRow & { shop_id: number | null; created_at: Date; sent_at: Date | null; provider: string | null; error: string | null }>(
      `SELECT id, shop_id, to_email, template, subject, body, \`sensitive\`, status, provider, error, attempts, created_at, sent_at
         FROM platform_emails WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      [...params, filters.limit],
      controlPlane,
    );
  },
};

defineJob<{ emailId: number }>({
  type: 'platform.email_send',
  shopScoped: false,
  maxAttempts: 6,
  handler: async (payload) => {
    await platformMail.deliver(payload.emailId);
  },
});
