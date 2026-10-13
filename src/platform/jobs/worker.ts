import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { logger } from '../../core/logger';
import { metrics } from '../observability/metrics';
import { shopDirectory } from '../shops/shopDirectory';
import { tenancy } from '../tenancy/context';
import { jobQueue, type JobRow } from './queue';
import { exponentialBackoff, jobDefinition, PermanentJobError, registeredQueues } from './registry';
import { scheduler } from './scheduler';

/**
 * Pulls jobs and runs them.
 *
 * Runs in the API process by default (one server, one deploy) or on its own
 * with `npm run worker` — the same class either way. Concurrency is a cap on
 * jobs in flight in this process; claiming only ever takes as many as there
 * are free slots, so a slow job never causes a worker to hoard others.
 */

const LOCK_SECONDS = 120;
const DEFAULT_TIMEOUT_MS = 90_000;

export interface WorkerOptions {
  concurrency: number;
  pollIntervalMs: number;
  queues?: string[];
}

export class Worker {
  readonly id = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private running = false;
  private inFlight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private lastReapAt = 0;

  constructor(private readonly options: WorkerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    scheduler.start();
    logger.info('worker.started', {
      worker_id: this.id,
      concurrency: this.options.concurrency,
      queues: this.options.queues ?? registeredQueues(),
    });
    this.schedule(0);
  }

  /** Stops claiming, waits for what is running. */
  async stop(): Promise<void> {
    this.running = false;
    scheduler.stop();
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.inFlight]);
    logger.info('worker.stopped', { worker_id: this.id });
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    let claimed = 0;
    try {
      if (Date.now() - this.lastReapAt > 30_000) {
        this.lastReapAt = Date.now();
        const reaped = await jobQueue.reapExpiredLocks();
        if (reaped > 0) logger.warn('worker.locks_reaped', { count: reaped });
      }
      const free = this.options.concurrency - this.inFlight.size;
      if (free > 0) {
        const jobs = await jobQueue.claim(this.id, this.options.queues ?? registeredQueues(), free, LOCK_SECONDS);
        claimed = jobs.length;
        for (const job of jobs) this.track(this.run(job));
      }
    } catch (error) {
      logger.error('worker.tick_failed', { error: error instanceof Error ? error.message : String(error) });
    }
    // A full batch means there is probably more; do not sleep.
    this.schedule(claimed > 0 ? 0 : this.options.pollIntervalMs);
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise));
  }

  private async run(job: JobRow): Promise<void> {
    const started = Date.now();
    const definition = jobDefinition(job.type);
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;

    if (!definition) {
      await jobQueue.fail(job.id, this.id, `No handler is registered for job type "${job.type}".`, null);
      logger.error('worker.unknown_job_type', { job_id: job.id, type: job.type });
      return;
    }

    // Long jobs keep their lease alive; a hung one loses it and is retried.
    const heartbeat = setInterval(() => {
      void jobQueue.extendLock(job.id, this.id, LOCK_SECONDS).catch(() => undefined);
    }, (LOCK_SECONDS * 1000) / 3);
    heartbeat.unref?.();

    try {
      const shop = job.shop_id ? await shopDirectory.byId(Number(job.shop_id)) : null;
      if (definition.shopScoped) {
        if (!shop) throw new PermanentJobError(`Shop ${job.shop_id} does not exist.`);
        if (shop.status === 'closed') {
          await jobQueue.complete(job.id, this.id);
          return;
        }
      }

      const context = { jobId: job.id, attempt: job.attempts, maxAttempts: job.max_attempts, shop };
      const execute = () => definition.handler(payload, context);
      const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      await withTimeout(shop ? tenancy.run(shop, execute) : execute(), timeoutMs, job.type);

      await jobQueue.complete(job.id, this.id);
      metrics.counter('jobs_processed_total', { type: job.type, outcome: 'succeeded' }).inc();
      metrics.histogram('job_duration_seconds', { type: job.type }).observe((Date.now() - started) / 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof PermanentJobError;
      const exhausted = job.attempts >= job.max_attempts;
      const retryAt =
        permanent || exhausted
          ? null
          : new Date(Date.now() + (definition.backoff ?? exponentialBackoff)(job.attempts));

      await jobQueue.fail(job.id, this.id, message, retryAt).catch((failError) => {
        logger.error('worker.fail_record_failed', { job_id: job.id, error: String(failError) });
      });
      metrics.counter('jobs_processed_total', { type: job.type, outcome: retryAt ? 'retry' : 'dead' }).inc();

      const log = retryAt ? logger.warn : logger.error;
      log('worker.job_failed', {
        job_id: job.id,
        type: job.type,
        shop_id: job.shop_id,
        attempt: job.attempts,
        max_attempts: job.max_attempts,
        retry_at: retryAt?.toISOString() ?? null,
        dead: !retryAt,
        error: message,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
