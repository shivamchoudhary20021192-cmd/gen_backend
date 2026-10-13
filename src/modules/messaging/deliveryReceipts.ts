import { execute, query, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { onInboundEvent } from '../../platform/integrations/inbound';
import { shopId } from '../../platform/tenancy/context';
import { campaignsRepository } from './campaigns.repository';

/**
 * What providers tell us after a message leaves: delivered, read, bounced —
 * and messages customers send back.
 *
 * Receipts arrive out of order and more than once (a "delivered" can overtake
 * its "sent"), so status only ever moves forward: queued → sent → delivered →
 * read, with failed/bounced terminal from anything short of delivered. A
 * receipt for a message this shop never sent is ignored.
 *
 * An inbound message is written to the outbox log as `direction = 'inbound'`.
 * That is what opens WhatsApp's 24-hour service window for the customer, which
 * the direct-message screen reads.
 */

const RANK_SQL = `CASE status WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END`;
const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4, bounced: 4 };

interface LogRow extends RowDataPacket {
  id: number;
  campaign_id: number | null;
  status: string;
}

onInboundEvent('message.status', async ({ data, connection }) => {
  const providerMessageId = typeof data.provider_message_id === 'string' ? data.provider_message_id : null;
  const status = String(data.status ?? '');
  if (!providerMessageId || RANK[status] === undefined) return 'ignored';

  const logs = await query<LogRow>(
    `SELECT id, campaign_id, status FROM notification_logs
      WHERE shop_id = ? AND provider_message_id = ? AND direction = 'outbound'
      ${connection ? 'AND provider = ?' : ''}
      LIMIT 5`,
    connection ? [shopId(), providerMessageId, connection.provider] : [shopId(), providerMessageId],
  );
  if (logs.length === 0) return 'ignored';

  const failed = status === 'failed' || status === 'bounced';
  const error = typeof data.error_code === 'string' ? data.error_code.slice(0, 500) : null;

  await withTransaction(async (tx) => {
    const ids = logs.map((log) => log.id);
    // Forward only. A failure after delivery (a late bounce report for a
    // message the handset already showed) does not un-deliver it.
    await execute(
      `UPDATE notification_logs
          SET status = ?,
              error_message = COALESCE(?, error_message),
              sent_at = CASE WHEN ? IN ('sent','delivered','read') THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
              delivered_at = CASE WHEN ? IN ('delivered','read') THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
              failed_at = CASE WHEN ? IN ('failed','bounced') THEN COALESCE(failed_at, NOW()) ELSE failed_at END
        WHERE shop_id = ? AND id IN (?)
          AND (${RANK_SQL}) < ?
          AND NOT (? = 4 AND status IN ('delivered','read'))`,
      [status, error, status, status, status, shopId(), ids, RANK[status], RANK[status]],
      tx,
    );

    const recipientStatus = failed ? 'failed' : status === 'delivered' || status === 'read' ? 'delivered' : null;
    if (recipientStatus) {
      await execute(
        `UPDATE message_campaign_recipients
            SET status = ?,
                delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, NOW()) ELSE delivered_at END,
                error_message = CASE WHEN ? = 'failed' THEN COALESCE(?, error_message) ELSE error_message END
          WHERE shop_id = ? AND log_id IN (?) AND status IN ('sending','sent')`,
        [recipientStatus, recipientStatus, recipientStatus, error, shopId(), ids],
        tx,
      );
    }
    for (const campaignId of new Set(logs.map((log) => log.campaign_id).filter((id): id is number => id !== null))) {
      await campaignsRepository.refreshCounters(campaignId, tx);
    }
  });
  return 'processed';
});

onInboundEvent('message.inbound', async ({ data, connection }) => {
  const from = typeof data.from === 'string' ? data.from.replace(/\D/g, '') : '';
  const channel = data.channel === 'whatsapp' ? 'whatsapp' : data.channel === 'sms' ? 'sms' : null;
  if (!from || !channel) return 'ignored';

  // Customers store the national number and the calling code apart.
  const customers = await query<RowDataPacket & { id: number }>(
    `SELECT id FROM customers
      WHERE shop_id = ? AND deleted_at IS NULL
        AND CONCAT(REPLACE(COALESCE(country_code, ''), '+', ''), phone) = ?
      LIMIT 1`,
    [shopId(), from],
  );

  await execute(
    `INSERT INTO notification_logs
       (shop_id, template_id, event_key, channel, direction, recipient, customer_id, provider,
        provider_message_id, status, payload, queued_at, delivered_at)
     VALUES (?, NULL, 'inbound.message', ?, 'inbound', ?, ?, ?, ?, 'delivered', ?, NOW(), NOW())`,
    [
      shopId(),
      channel,
      from,
      customers[0]?.id ?? null,
      connection?.provider ?? null,
      typeof data.provider_message_id === 'string' ? data.provider_message_id : null,
      JSON.stringify({ body: typeof data.body === 'string' ? data.body.slice(0, 4000) : null }),
    ],
  );
  return 'processed';
});
