import { env } from '../../config/env';
import { controlPlane, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { platformMail } from '../mail/mailer';
import { adminUrl } from '../mail/templates';
import { billingRepository, type InvoiceRow } from './billing.repository';

/**
 * The emails billing sends a merchant. Written in the same transaction as the
 * state they describe, so a bill marked failed always has its email and a
 * rolled-back charge sends nothing.
 */

interface Recipient {
  email: string;
  shopName: string;
}

/** Who hears about a shop's bills: its billing email, else the store's, else the owner's. */
async function recipient(shopId: number, exec: Executor): Promise<Recipient | null> {
  const row = await queryOne<RowDataPacket & { email: string | null; name: string }>(
    `SELECT COALESCE(ba.billing_email, sh.email,
              (SELECT u.email FROM shop_staff ss JOIN admin_users u ON u.id = ss.admin_user_id
                WHERE ss.shop_id = sh.id AND ss.is_owner = 1 LIMIT 1)) AS email,
            sh.name
       FROM shops sh LEFT JOIN billing_accounts ba ON ba.shop_id = sh.id
      WHERE sh.id = ?`,
    [shopId],
    exec,
  );
  return row?.email ? { email: row.email, shopName: row.name } : null;
}

const billingUrl = () => adminUrl('/settings/billing');

export const billingNotices = {
  async receipt(invoice: InvoiceRow, exec: Executor): Promise<void> {
    if (Number(invoice.total) <= 0) return;
    const to = await recipient(invoice.shop_id, exec);
    if (!to) return;
    const lines = await billingRepository.lines(invoice.id, exec);
    await platformMail.send(
      {
        to: to.email,
        template: 'billing.receipt',
        shopId: invoice.shop_id,
        dedupeKey: `billing-receipt:${invoice.id}`,
        data: {
          shopName: to.shopName,
          number: invoice.invoice_number ?? String(invoice.id),
          total: Number(invoice.total),
          currency: invoice.currency,
          lines: lines.map((line) => ({ description: line.description, amount: Number(line.amount) })),
        },
      },
      exec,
    );
  },

  async paymentFailed(invoice: InvoiceRow, reason: string, nextAttempt: Date | null, attempt: number, exec: Executor): Promise<void> {
    const to = await recipient(invoice.shop_id, exec);
    if (!to) return;
    await platformMail.send(
      {
        to: to.email,
        template: 'billing.payment_failed',
        shopId: invoice.shop_id,
        // One email per failed attempt, not per retry of the job that made it.
        dedupeKey: `billing-failed:${invoice.id}:${attempt}`,
        data: {
          shopName: to.shopName,
          number: invoice.invoice_number ?? String(invoice.id),
          total: Number(invoice.total),
          currency: invoice.currency,
          reason,
          nextAttempt,
          billingUrl: billingUrl(),
          graceDays: env.billing.graceDays,
        },
      },
      exec,
    );
  },

  async frozen(shopId: number, invoiceNumber: string, exec: Executor): Promise<void> {
    const to = await recipient(shopId, exec);
    if (!to) return;
    await platformMail.send(
      { to: to.email, template: 'billing.store_frozen', shopId, data: { shopName: to.shopName, number: invoiceNumber, billingUrl: billingUrl() } },
      exec,
    );
  },

  async unfrozen(shopId: number, exec: Executor): Promise<void> {
    const to = await recipient(shopId, exec);
    if (!to) return;
    await platformMail.send({ to: to.email, template: 'billing.store_unfrozen', shopId, data: { shopName: to.shopName } }, exec);
  },

  /**
   * Reminds trialing stores whose trial ends within three days, once each —
   * with or without a card on file, because what happens next differs.
   */
  async trialsEnding(now: Date, shopId: number | null): Promise<number> {
    const rows = await query<RowDataPacket & { id: number; shop_id: number; trial_ends_at: Date; price_amount: string; currency: string; plan_name: string; has_card: number }>(
      `SELECT s.id, s.shop_id, s.trial_ends_at, s.price_amount, s.currency, p.name AS plan_name,
              (ba.payment_method_ref IS NOT NULL) AS has_card
         FROM shop_subscriptions s
         JOIN plans p ON p.id = s.plan_id
         JOIN shops sh ON sh.id = s.shop_id AND sh.status IN ('active', 'paused')
         LEFT JOIN billing_accounts ba ON ba.shop_id = s.shop_id
        WHERE s.status = 'trialing' AND s.provider NOT IN ('manual', 'internal')
          AND s.trial_ends_at > ? AND s.trial_ends_at <= ? AND (? IS NULL OR s.shop_id = ?)`,
      [now, new Date(now.getTime() + 3 * 86_400_000), shopId, shopId],
      controlPlane,
    );
    let sent = 0;
    for (const row of rows) {
      const to = await recipient(row.shop_id, controlPlane);
      if (!to) continue;
      const id = await platformMail.send({
        to: to.email,
        template: 'billing.trial_ending',
        shopId: row.shop_id,
        dedupeKey: `trial-ending:${row.id}`,
        data: {
          shopName: to.shopName,
          trialEnds: row.trial_ends_at,
          planName: row.plan_name,
          price: Number(row.price_amount),
          currency: row.currency,
          hasCard: Number(row.has_card) === 1,
          billingUrl: billingUrl(),
        },
      });
      if (id !== null) sent += 1;
    }
    return sent;
  },
};
