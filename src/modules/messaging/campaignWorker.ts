import { logger } from '../../core/logger';
import { podRouter } from '../../db/pods';
import { jobQueue } from '../../platform/jobs/queue';
import { defineJob } from '../../platform/jobs/registry';
import { scheduler } from '../../platform/jobs/scheduler';
import { tenancy } from '../../platform/tenancy/context';
import { campaignsRepository } from './campaigns.repository';
import { campaignsService } from './campaigns.service';

/**
 * The thing that actually sends.
 *
 * Campaign sending runs on the platform job queue in two steps:
 *
 *   1. `messaging.campaigns_tick` — scheduled every few seconds, not tied to a
 *      shop. It asks each pod which shops have campaign work (ids only) and
 *      enqueues one `messaging.campaigns_run` per shop. The job's unique key
 *      includes the time slot, so however many workers tick, each shop gets at
 *      most one run per slot.
 *
 *   2. `messaging.campaigns_run` — runs inside that shop's tenancy context and
 *      pushes one batch through each of its due campaigns, exactly as the old
 *      in-process timer did.
 *
 * What that buys over the old timer:
 *
 *   - **Any number of workers.** Shops are spread across whichever workers
 *     claim their jobs; a forty-thousand-recipient campaign in one shop never
 *     delays another shop's order confirmations, which run on other queues.
 *   - **Isolation by construction.** A run cannot see another shop's campaigns
 *     because every query in it is scoped to the shop the job carries.
 *   - **Still paced.** One batch per campaign per run; `claimBatch` moves rows
 *     out of 'pending' before reading them, so overlapping runs never send
 *     twice, and `requeueStuck` recovers a batch a crashed worker left behind.
 *
 * `MESSAGING_WORKER=off` stops the schedule (for a test run that should not send
 * by itself); campaigns then wait until a worker that has it on picks them up.
 */

const TICK_MS = Number(process.env.MESSAGING_WORKER_INTERVAL_MS ?? 10_000);

defineJob({
  type: 'messaging.campaigns_tick',
  queue: 'default',
  shopScoped: false,
  maxAttempts: 1,
  timeoutMs: 30_000,
  async handler() {
    const slot = Math.floor(Date.now() / TICK_MS);
    for (const podId of podRouter.configuredPods()) {
      const shops = await campaignsRepository.shopsWithDueCampaigns(podRouter.poolFor(podId));
      for (const shopId of shops) {
        await jobQueue.enqueue(
          'messaging.campaigns_run',
          {},
          {
            shopId,
            queue: 'messaging',
            maxAttempts: 1,
            uniqueKey: `messaging.campaigns_run:${shopId}:${slot}`,
          },
        );
      }
    }
  },
});

defineJob({
  type: 'messaging.campaigns_run',
  queue: 'messaging',
  shopScoped: true,
  maxAttempts: 1,
  timeoutMs: 5 * 60_000,
  async handler() {
    // A paused, frozen or suspended shop keeps its campaigns exactly where they
    // are; they resume on their own when the shop is active again.
    if (tenancy.current().status !== 'active') return;

    const due = await campaignsRepository.due();
    for (const campaign of due) {
      try {
        if (campaign.status === 'scheduled') {
          // Its moment has come: freeze the audience and start it. `start`
          // re-runs preflight, so a campaign scheduled for 22:00 with a
          // promotional template refuses at 22:00 rather than sending.
          await campaignsService.start(campaign.id, campaign.created_by_admin_id ?? 0);
          continue;
        }
        await campaignsService.runBatch(campaign.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('messaging.worker_campaign_failed', { campaign_id: campaign.id, error: message });
        await campaignsRepository.update(campaign.id, { status: 'paused', last_error: message.slice(0, 500) });
      }
    }
  },
});

/** Registers the tick with the scheduler. Called once at boot by every process that runs a worker. */
export function registerCampaignSchedule(): void {
  if ((process.env.MESSAGING_WORKER ?? 'on').toLowerCase() === 'off') {
    logger.info('messaging.worker_disabled', { reason: 'MESSAGING_WORKER=off' });
    return;
  }
  scheduler.every('messaging.campaigns', TICK_MS, 'messaging.campaigns_tick');
}
