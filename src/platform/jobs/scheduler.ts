import { logger } from '../../core/logger';
import { jobQueue } from './queue';

/**
 * Recurring work: "every 30 seconds, run campaigns.tick".
 *
 * Each worker runs this, and each would enqueue the same tick — so the job's
 * unique key is the schedule name plus the time slot, and only the first
 * enqueue for a slot lands. Adding a worker adds throughput, never duplicate
 * ticks. Nothing is stored about schedules themselves: they are code.
 */

interface Schedule {
  name: string;
  everyMs: number;
  jobType: string;
  payload: unknown;
  queue?: string;
}

const schedules: Schedule[] = [];
let timer: NodeJS.Timeout | null = null;
const TICK_MS = 1000;
const lastSlot = new Map<string, number>();

export const scheduler = {
  every(name: string, everyMs: number, jobType: string, payload: unknown = {}, queue?: string): void {
    if (schedules.some((schedule) => schedule.name === name)) return;
    schedules.push({ name, everyMs, jobType, payload, queue });
  },

  start(): void {
    if (timer) return;
    timer = setInterval(() => void this.tick(), TICK_MS);
    timer.unref?.();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },

  async tick(now = Date.now()): Promise<void> {
    for (const schedule of schedules) {
      const slot = Math.floor(now / schedule.everyMs);
      if (lastSlot.get(schedule.name) === slot) continue;
      try {
        await jobQueue.enqueue(schedule.jobType, schedule.payload, {
          shopId: null,
          queue: schedule.queue,
          priority: 3,
          maxAttempts: 1,
          uniqueKey: `schedule:${schedule.name}:${slot}`,
        });
        lastSlot.set(schedule.name, slot);
      } catch (error) {
        logger.error('scheduler.enqueue_failed', { schedule: schedule.name, error: String(error) });
      }
    }
  },

  list(): readonly Schedule[] {
    return schedules;
  },
};
