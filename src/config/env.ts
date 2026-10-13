import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * The directory holding package.json, found by walking up from this file.
 *
 * Not `process.cwd()`: a relative STORAGE_LOCAL_ROOT resolved against the
 * working directory points somewhere different depending on where the process
 * was started. `pm2 start` from the home directory instead of the repo makes
 * every uploaded file 404 while the files sit right there in the checkout —
 * the database says the media exists, the disk lookup happens in the wrong
 * folder, and nothing in the logs connects the two.
 *
 * Walking up rather than counting `..` segments because the depth differs
 * between `src/config/env.ts` under tsx and `dist/src/config/env.js` after a
 * build.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let depth = 0; depth < 10; depth += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const projectRoot = findProjectRoot(__dirname);

/** Absolute paths are honoured as given; relative ones hang off the project root. */
function fromProjectRoot(target: string): string {
  return path.isAbsolute(target) ? target : path.resolve(projectRoot, target);
}

// Loaded from the project root for the same reason: a bare `dotenv.config()`
// reads ./.env relative to the working directory, so starting the process from
// anywhere else silently gives you an app with no database password.
dotenv.config({ path: path.join(projectRoot, '.env') });

function required(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${key} must be a number`);
  return parsed;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const nodeEnv = process.env.NODE_ENV ?? 'development';
const isProd = nodeEnv === 'production';
const port = num('PORT', 4000);

type GuardMode = 'enforce' | 'warn' | 'off';
function guardMode(): GuardMode {
  const raw = (process.env.TENANT_GUARD ?? 'enforce').trim().toLowerCase();
  if (raw === 'enforce' || raw === 'warn' || raw === 'off') return raw;
  throw new Error(`TENANT_GUARD must be enforce, warn or off (got "${raw}")`);
}

type MailProviderName = 'log' | 'postmark' | 'sendgrid';
function mailProviderName(): MailProviderName {
  const raw = (process.env.PLATFORM_EMAIL_PROVIDER ?? 'log').trim().toLowerCase();
  if (raw !== 'log' && raw !== 'postmark' && raw !== 'sendgrid') {
    throw new Error(`PLATFORM_EMAIL_PROVIDER must be log, postmark or sendgrid (got "${raw}")`);
  }
  if (raw !== 'log' && !process.env.PLATFORM_EMAIL_API_KEY) {
    throw new Error(`PLATFORM_EMAIL_PROVIDER=${raw} needs PLATFORM_EMAIL_API_KEY.`);
  }
  return raw;
}

type BillingProviderName = 'stripe' | 'simulator' | 'manual';
function billingProviderName(): BillingProviderName {
  const raw = (process.env.PLATFORM_BILLING_PROVIDER ?? (isProd ? 'manual' : 'simulator')).trim().toLowerCase();
  if (raw !== 'stripe' && raw !== 'simulator' && raw !== 'manual') {
    throw new Error(`PLATFORM_BILLING_PROVIDER must be stripe, simulator or manual (got "${raw}")`);
  }
  if (raw === 'stripe' && (!process.env.PLATFORM_STRIPE_SECRET_KEY || !process.env.PLATFORM_STRIPE_PUBLISHABLE_KEY)) {
    throw new Error('PLATFORM_BILLING_PROVIDER=stripe needs PLATFORM_STRIPE_SECRET_KEY and PLATFORM_STRIPE_PUBLISHABLE_KEY.');
  }
  return raw;
}

export const env = {
  nodeEnv,
  isProd,
  isTest: nodeEnv === 'test',
  port,
  /**
   * Where the customer-facing storefront lives.
   *
   * Used to build links the admin hands to a customer — cart recovery today,
   * order tracking next. It has to be the public URL rather than an internal
   * one, because these end up pasted into WhatsApp.
   */
  storefrontUrl: (process.env.STOREFRONT_URL ?? 'http://localhost:5174').replace(/\/$/, ''),
  apiPrefix: process.env.API_PREFIX ?? '/admin/api/v1',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),

  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: num('DB_PORT', 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'veylog',
    connectionLimit: num('DB_CONNECTION_LIMIT', 10),
  },

  auth: {
    // In production a weak secret is a deployment bug, not a warning.
    jwtSecret: isProd ? required('JWT_SECRET') : (process.env.JWT_SECRET ?? 'dev-only-insecure-secret'),
    accessTtlMinutes: num('JWT_ACCESS_TTL_MIN', 15),
    refreshTtlDays: num('REFRESH_TTL_DAYS', 30),
    bcryptRounds: num('BCRYPT_ROUNDS', 12),
    maxLoginAttempts: num('MAX_LOGIN_ATTEMPTS', 5),
    lockoutMinutes: num('LOCKOUT_MINUTES', 15),
    tokenPepper: process.env.TOKEN_PEPPER ?? 'dev-only-pepper',
  },

  storage: {
    driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
    localRoot: fromProjectRoot(process.env.STORAGE_LOCAL_ROOT ?? './storage/media'),
    localBaseUrl: (process.env.STORAGE_LOCAL_BASE_URL ?? '/media').replace(/\/$/, ''),
    maxUploadBytes: num('MEDIA_MAX_UPLOAD_MB', 200) * 1024 * 1024,
    maxFilesPerRequest: num('MEDIA_MAX_FILES_PER_REQUEST', 20),
    /**
     * Widths and formats generated for every uploaded image. Mirrors the
     * `media.variant_widths` / `media.variant_formats` settings rows so the
     * storefront and the API agree on what exists.
     */
    variantWidths: { thumb: 160, sm: 400, md: 800, lg: 1200, xl: 1800 } as Record<string, number>,
    variantFormats: ['webp', 'avif'] as const,
    allowedMime: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/avif',
      'image/gif',
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'application/pdf',
    ] as string[],
  },

  /**
   * The platform around the shops: what it is called, where merchants sign in,
   * and which domain every shop gets a subdomain of (handle.myveylog.com).
   */
  platform: {
    name: process.env.PLATFORM_NAME ?? 'Veylog',
    storefrontDomain: (process.env.PLATFORM_STOREFRONT_DOMAIN ?? 'myveylog.com').trim().toLowerCase(),
    adminUrl: (process.env.PLATFORM_ADMIN_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    /**
     * The API's own public origin. Handed to third parties as the address to
     * call back — webhook URLs registered with Stripe, Twilio status callbacks
     * — so it must be reachable from the internet in production.
     */
    publicApiUrl: (process.env.PUBLIC_API_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    /**
     * Single-shop compatibility. A storefront request whose host matches no
     * shop domain is served by this shop instead of a 404, which is how an
     * installation that predates multi-tenancy keeps working unchanged.
     * Leave unset on a multi-shop platform.
     */
    defaultShopHandle: (process.env.DEFAULT_SHOP ?? '').trim().toLowerCase() || null,
    signupEnabled: bool('PLATFORM_SIGNUP_ENABLED', true),
  },

  tenancy: {
    guard: guardMode(),
  },

  /**
   * Apps calling the Admin API. Their rate-limit buckets live in MySQL so
   * every API node counts against the same limit; `memory` keeps them per
   * process (a single node, or tests).
   */
  apps: {
    rateLimitStore: (process.env.APP_RATE_LIMIT_STORE ?? 'database').trim().toLowerCase() === 'memory' ? ('memory' as const) : ('database' as const),
  },

  /**
   * Email from the platform itself (invitations, password resets, billing)
   * — not a shop's customer email, which goes through the shop's own
   * connection. `log` (the development default) delivers nothing and keeps
   * the message in the outbox for reading; `postmark` and `sendgrid` send
   * with the platform's own key.
   */
  mail: {
    provider: mailProviderName(),
    apiKey: process.env.PLATFORM_EMAIL_API_KEY ?? '',
    from: process.env.PLATFORM_EMAIL_FROM ?? 'no-reply@myveylog.com',
    fromName: process.env.PLATFORM_EMAIL_FROM_NAME ?? process.env.PLATFORM_NAME ?? 'Veylog',
  },

  /**
   * The platform billing its merchants. `simulator` (the development default)
   * has a working and a declining test card; `stripe` charges through the
   * platform's own Stripe account; `manual` issues bills that an operator
   * marks paid (the production default until a processor is configured).
   */
  billing: {
    provider: billingProviderName(),
    stripeSecretKey: process.env.PLATFORM_STRIPE_SECRET_KEY ?? '',
    stripePublishableKey: process.env.PLATFORM_STRIPE_PUBLISHABLE_KEY ?? '',
    /** Days a bill may stay unpaid after its first failed charge before the store is frozen. */
    graceDays: num('BILLING_GRACE_DAYS', 7),
    /**
     * Outside production the operators' API may run the billing cycle "as of"
     * another moment — Stripe's test clocks, for walking a store through trial
     * end and dunning in minutes instead of weeks.
     */
    testClock: !isProd,
  },

  /**
   * Background work. The worker runs inside the API process by default, which
   * is right for a single server; set WORKER_EMBEDDED=false on API nodes and
   * run `npm run worker` separately once there is more than one.
   */
  worker: {
    embedded: bool('WORKER_EMBEDDED', true),
    concurrency: num('WORKER_CONCURRENCY', 8),
    pollIntervalMs: num('WORKER_POLL_MS', 1000),
  },

  /**
   * Storefront page caching. Anonymous pages (no cart, no signed-in customer,
   * no preview) are cached in each API pod's memory under the shop's content
   * version, which any change to the shop bumps — see storefrontVersions.ts.
   * PAGE_CACHE_MAX_MB=0 turns the cache off. The TTL is a backstop for what no
   * write announces (a scheduled publish time passing, exchange rates).
   */
  pageCache: {
    maxMb: num('PAGE_CACHE_MAX_MB', 64),
    ttlSeconds: num('PAGE_CACHE_TTL_SECONDS', 300),
    /** How often each pod asks which shops changed. */
    versionPollMs: num('STOREFRONT_VERSION_POLL_MS', 2000),
    /** At most one version bump per shop per this long, per process. */
    bumpIntervalMs: num('STOREFRONT_VERSION_BUMP_MS', 2000),
  },

  /**
   * Webhooks the platform sends to apps and merchant endpoints. Private
   * addresses are refused unless explicitly allowed — which only makes sense in
   * local development, where the receiving app is on localhost.
   */
  webhooks: {
    allowPrivateTargets: bool('WEBHOOKS_ALLOW_PRIVATE_TARGETS', !isProd),
    timeoutMs: num('WEBHOOKS_TIMEOUT_MS', 5000),
  },

  superAdmin: {
    email: process.env.SUPERADMIN_EMAIL ?? 'admin@veylor.com',
    password: process.env.SUPERADMIN_PASSWORD ?? 'ChangeMe!2026',
    firstName: process.env.SUPERADMIN_FIRST_NAME ?? 'Super',
    lastName: process.env.SUPERADMIN_LAST_NAME ?? 'Admin',
  },
} as const;

export type Env = typeof env;
