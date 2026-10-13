import { logger } from '../../core/logger';
import { execute, query, type RowDataPacket } from '../../db/pool';
import { podRouter } from '../../db/pods';
import { jobQueue } from '../jobs/queue';
import { defineJob } from '../jobs/registry';
import { tenancy } from '../tenancy/context';
import { privacyRequests } from './privacyRequests';

/**
 * privacy.sweep (every 15 minutes, all shops):
 *   - erasures whose date has come are queued, one job each, in their shop;
 *   - data exports past their expiry are deleted — the file is personal data;
 *   - storefront requests nobody confirmed within 7 days are cancelled.
 *
 * privacy.erase (per shop): runs one erasure. Idempotent — a request that is
 * no longer scheduled, or not yet due, is left alone.
 */

defineJob({
  type: 'privacy.sweep',
  queue: 'default',
  shopScoped: false,
  maxAttempts: 1,
  timeoutMs: 120_000,
  async handler() {
    let queued = 0;
    let exportsPurged = 0;
    let abandoned = 0;
    for (const podId of podRouter.configuredPods()) {
      const pool = podRouter.poolFor(podId);
      const due = await tenancy.unscoped('privacy sweep: erasures that are due, every shop on the pod', () =>
        query<RowDataPacket & { id: number; shop_id: number }>(
          `SELECT id, shop_id FROM data_requests
            WHERE status = 'scheduled' AND scheduled_for <= UTC_TIMESTAMP()
            ORDER BY scheduled_for LIMIT 200`,
          [],
          pool,
        ),
      );
      for (const request of due) {
        const added = await jobQueue.enqueue(
          'privacy.erase',
          { request_id: Number(request.id) },
          { shopId: Number(request.shop_id), queue: 'default', maxAttempts: 5, uniqueKey: `privacy.erase:${request.shop_id}:${request.id}` },
        );
        if (added) queued += 1;
      }
      const purged = await tenancy.unscoped('privacy sweep: expired data exports', () =>
        execute('DELETE FROM customer_data_exports WHERE expires_at < UTC_TIMESTAMP() LIMIT 500', [], pool),
      );
      exportsPurged += purged.affectedRows;
      const lapsed = await tenancy.unscoped('privacy sweep: unconfirmed requests', () =>
        execute(
          `UPDATE data_requests SET status = 'cancelled', verification_token_hash = NULL,
                  outcome_note = 'Not confirmed by the requester within 7 days.'
            WHERE status = 'verifying' AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) LIMIT 500`,
          [],
          pool,
        ),
      );
      abandoned += lapsed.affectedRows;
    }
    if (queued || exportsPurged || abandoned) logger.info('privacy.sweep', { erasures_queued: queued, exports_purged: exportsPurged, requests_lapsed: abandoned });
  },
});

defineJob<{ request_id: number }>({
  type: 'privacy.erase',
  queue: 'default',
  shopScoped: true,
  maxAttempts: 5,
  timeoutMs: 120_000,
  async handler(payload) {
    await privacyRequests.runErasure(Number(payload.request_id));
  },
});
