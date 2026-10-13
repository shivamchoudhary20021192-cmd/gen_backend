import type { ShopContext } from '../tenancy/context';

/**
 * Job types and their handlers.
 *
 * A module defines its jobs next to the code they belong to and registers them
 * at boot (see platform/jobs/index.ts). The worker only knows this map, so the
 * queue has no idea what a webhook or a campaign is.
 */

export interface JobContext {
  jobId: number;
  attempt: number;
  maxAttempts: number;
  /** The shop the job runs as; the handler is already inside tenancy.run(). */
  shop: ShopContext | null;
}

export interface JobDefinition<P = unknown> {
  type: string;
  queue?: string;
  maxAttempts?: number;
  /** Delay before retry N (1-based). Defaults to exponential with jitter. */
  backoff?: (attempt: number) => number;
  /** A job still running after this is treated as hung. */
  timeoutMs?: number;
  /**
   * Whether the job acts for one shop. Shop jobs refuse to run without one,
   * and are skipped for shops that have since closed.
   */
  shopScoped: boolean;
  handler: (payload: P, context: JobContext) => Promise<void>;
}

/** Thrown by a handler that knows retrying cannot help. Dead-letters at once. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

const definitions = new Map<string, JobDefinition>();

export function defineJob<P>(definition: JobDefinition<P>): JobDefinition<P> {
  if (definitions.has(definition.type)) throw new Error(`Job type ${definition.type} is defined twice.`);
  definitions.set(definition.type, definition as JobDefinition);
  return definition;
}

export function jobDefinition(type: string): JobDefinition | undefined {
  return definitions.get(type);
}

export function registeredQueues(): string[] {
  return [...new Set([...definitions.values()].map((definition) => definition.queue ?? 'default'))];
}

/** Exponential backoff with full jitter: 15s, 30s, 1m, 2m … capped at 1h. */
export function exponentialBackoff(attempt: number, baseMs = 15_000, capMs = 3_600_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}
