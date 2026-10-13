import http from 'node:http';
import { env } from './config/env';
import { logger } from './core/logger';
import { closePool, verifyConnection } from './db/pool';
import { storefrontVersions } from './platform/cache/storefrontVersions';
import { metrics } from './platform/observability/metrics';
import { platformRuntime } from './platform/runtime';

/**
 * The dedicated background process: `npm run worker`.
 *
 * Runs exactly what an API node runs when WORKER_EMBEDDED is on — the job
 * worker, the scheduler and the event dispatcher — and nothing else. Scale it
 * independently of the API: more workers drain the queues faster, and because
 * jobs are claimed with SKIP LOCKED and schedules are slot-deduplicated, any
 * number of them can run side by side.
 *
 * A tiny HTTP listener on WORKER_PORT answers /health and /metrics so an
 * orchestrator can probe it and Prometheus can scrape queue depth.
 */

async function bootstrap(): Promise<void> {
  await verifyConnection();
  // Jobs read per-shop caches too (tax, notifications, messaging): follow changes made elsewhere.
  storefrontVersions.start();
  platformRuntime.start();

  const port = Number(process.env.WORKER_PORT ?? 0);
  let server: http.Server | null = null;
  if (port > 0) {
    server = http
      .createServer((req, res) => {
        if (req.url === '/health' || req.url === '/health/live') {
          res.writeHead(platformRuntime.running ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: platformRuntime.running ? 'ok' : 'stopping' }));
          return;
        }
        if (req.url === '/metrics') {
          const token = process.env.METRICS_TOKEN;
          if (token && req.headers.authorization !== `Bearer ${token}`) {
            res.writeHead(404).end();
            return;
          }
          void metrics.render().then((body) => {
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
            res.end(body);
          });
          return;
        }
        res.writeHead(404).end();
      })
      .listen(port, () => logger.info('worker.http_started', { port }));
  }

  logger.info('worker.process_started', { concurrency: env.worker.concurrency, pid: process.pid });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('worker.shutdown_started', { signal });
    const forced = setTimeout(() => {
      logger.error('worker.shutdown_forced', { reason: 'timeout after 60s' });
      process.exit(1);
    }, 60_000);
    forced.unref();
    try {
      await platformRuntime.stop();
      server?.close();
      await closePool();
    } finally {
      logger.info('worker.shutdown_complete');
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error('process.unhandled_rejection', { reason: String(reason) }));
}

bootstrap().catch((error) => {
  logger.error('worker.bootstrap_failed', { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
