import { tenancy } from '../platform/tenancy/context';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: Level = (process.env.LOG_LEVEL as Level) ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

/**
 * Structured JSON logging. One line per event, machine-parseable, with the
 * event name as a stable key rather than an interpolated sentence — so
 * `event:"auth.login_failed"` can be alerted on without regex.
 *
 * Every line written inside a shop carries its id, so one merchant's incident
 * can be pulled out of the stream without every call site remembering to add it.
 */
function write(level: Level, event: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const shop = tenancy.currentOrNull();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(shop ? { shop_id: shop.id } : {}),
    ...context,
  });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (event: string, context?: Record<string, unknown>) => write('debug', event, context),
  info: (event: string, context?: Record<string, unknown>) => write('info', event, context),
  warn: (event: string, context?: Record<string, unknown>) => write('warn', event, context),
  error: (event: string, context?: Record<string, unknown>) => write('error', event, context),
};
