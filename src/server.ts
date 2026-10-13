import fs from 'node:fs/promises';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './core/logger';
import { closePool, verifyConnection } from './db/pool';
import { storefrontVersions } from './platform/cache/storefrontVersions';
import { jobQueue } from './platform/jobs/queue';
import { platformRuntime } from './platform/runtime';
import { themesService } from './platform/themes/themes.service';

async function bootstrap(): Promise<void> {
  // Fail at boot, not on the first upload, if the storage root is unwritable.
  if (env.storage.driver === 'local') {
    await fs.mkdir(env.storage.localRoot, { recursive: true });
  }

  // Connects every pod and loads the tenant-table list the isolation guard
  // enforces. Nothing is served until this succeeds.
  await verifyConnection();

  // The built-in theme library is code; make the table match this build.
  await themesService.syncBuiltIns().catch((error) => {
    logger.error('themes.sync_failed', { error: error instanceof Error ? error.message : String(error) });
  });

  // Shops that predate provisioning get a theme and a setup guide, once.
  await jobQueue
    .enqueue('shops.adopt_existing', {}, { shopId: null, uniqueKey: `shops.adopt_existing:${new Date().toISOString().slice(0, 10)}` })
    .catch((error) => logger.warn('shops.adopt_enqueue_failed', { error: String(error) }));

  // Keeps each shop's storefront content version current in this process, which is
  // what makes cached pages safe (and clears caches for shops changed on other pods).
  storefrontVersions.start();

  const app = createApp();

  // Background work (jobs, schedules, event dispatch) runs in this process by
  // default. With more than one API node, set WORKER_EMBEDDED=false here and
  // run `npm run worker` as its own deployment.
  if (env.worker.embedded) platformRuntime.start();

  const server = app.listen(env.port, () => {
    logger.info('server.started', {
      port: env.port,
      env: env.nodeEnv,
      admin_api: '/admin/api/:version',
      storefront_api: '/api/v1',
      platform_api: '/platform/api/v1',
      worker: env.worker.embedded ? 'embedded' : 'external',
      tenant_guard: env.tenancy.guard,
      storage_driver: env.storage.driver,
      // The absolute path media is read from and written to. If uploads 404,
      // compare this against `ls` before looking anywhere else.
      storage_root: env.storage.localRoot,
    });
  });

  // Keep-alive longer than the load balancer's idle timeout, so the balancer
  // never reuses a socket this process has just closed.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  /**
   * Graceful shutdown: stop accepting connections, let in-flight requests and
   * jobs finish, then close the pools. Without this, a deploy can cut a
   * transaction mid-write and leave a half-created product behind.
   */
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server.shutdown_started', { signal });
    server.close(async () => {
      try {
        await platformRuntime.stop();
        await closePool();
      } catch (error) {
        logger.error('server.shutdown_failed', { error: String(error) });
      }
      logger.info('server.shutdown_complete');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('server.shutdown_forced', { reason: 'timeout after 25s' });
      process.exit(1);
    }, 25_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    logger.error('process.uncaught_exception', { error: error.message, stack: error.stack });
    shutdown('uncaughtException');
  });
}

bootstrap().catch((error) => {
  logger.error('server.bootstrap_failed', {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
