import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { env } from '../../config/env';
import { logger } from '../../core/logger';
import { controlPlane } from '../../db/pods';
import { writeObserver } from '../../db/writeObserver';
import { metrics } from '../observability/metrics';
import { ShopScopedCache } from './shopCache';

/**
 * Each shop's storefront content version — the number that makes page caching
 * safe without purging anything.
 *
 *   write  Any committed write, for a shop, to a table that can change what an
 *          anonymous shopper sees bumps the shop's version (control plane,
 *          `storefront_versions`). Writes are observed at the driver
 *          (db/writeObserver.ts), so no service has to remember to announce a
 *          change — a new table is covered the day it is created. Bumps are
 *          coalesced: at most one per shop every STOREFRONT_VERSION_BUMP_MS per
 *          process, the trailing one always sent.
 *
 *   read   Cached pages are keyed by the version (pageCache.ts, and the edge
 *          worker through /internal/edge/route). After a bump nothing asks for
 *          the old keys again; they age out. No purge calls, at any scale.
 *
 *   sync   The process that made the change clears what it holds in memory for
 *          the shop at once (every ShopScopedCache, host routing). Every other
 *          API process polls for rows changed since its last look — one
 *          indexed query every STOREFRONT_VERSION_POLL_MS, however many shops
 *          there are — and clears the same for each changed shop. That is how
 *          a change made on one pod reaches the others within a couple of
 *          seconds, instead of waiting out TTLs.
 *
 * What no write announces — a product's publish time passing, exchange rates
 * refreshed by the platform — is covered by the page cache's TTL.
 */

/** Tables whose writes never change what an anonymous shopper sees: carts, orders, sessions, logs, staff. */
const NEUTRAL_TABLES = new Set([
  'storefront_versions',
  'audit_logs',
  'api_rate_buckets',
  'rate_limits',
  'jobs',
  'job_runs',
  'events',
  'maintenance_runs',
  'schema_migrations',
  'carts',
  'cart_items',
  'orders',
  'payments',
  'refunds',
  'invoices',
  'claims',
  'claim_evidence',
  'coupon_redemptions',
  'customers',
  'contact_messages',
  'newsletter_subscribers',
  'back_in_stock_requests',
  'data_requests',
  'export_jobs',
  'import_jobs',
  'inventory_movements',
  'integration_webhook_events',
  'payment_webhook_events',
  'menu_item_analytics',
  'product_views',
  'search_queries',
  'quiz_submissions',
  'number_sequences',
  'otp_requests',
  'otp_throttle',
  'lookup_value_audit',
  'media_migrations',
  'cms_revisions',
  'shop_theme_drafts',
  'shop_theme_file_versions',
  'shop_setup_tasks',
  'shop_staff',
  'shop_subscriptions',
  'domain_events',
  'domain_registrations',
  'user_sidebar_preferences',
  'app_access_tokens',
  'storefront_access_tokens',
  'oauth_authorization_codes',
  'loyalty_accounts',
  'loyalty_transactions',
  'review_invitations',
  'review_reports',
  'review_votes',
  'wishlists',
  'wishlist_items',
  // Views and clicks of announcement lines: counted on every page, shown on none.
  'announcement_stats',
]);
const NEUTRAL_PREFIXES = /^(admin_|order_|customer_|payment_|message_|messaging_|notification_|return_|shipment_|support_|ticket_|webhook_|platform_|billing_)/;

/** Whether a write to this table can change a storefront page ('*' — unknown — always can). */
export function affectsStorefront(table: string): boolean {
  if (table === '*') return true;
  return !NEUTRAL_TABLES.has(table) && !NEUTRAL_PREFIXES.test(table);
}

type ChangeListener = (shopId: number) => void;

/** Rows re-read on every poll, for writes whose timestamp lands just before the previous look. */
const OVERLAP_MS = 5_000;
const POLL_BATCH = 10_000;
const MAX_KNOWN = 200_000;

class StorefrontVersions {
  private readonly known = new Map<number, number>();
  private readonly loading = new Map<number, Promise<number>>();
  private readonly lastBumpAt = new Map<number, number>();
  private readonly scheduled = new Map<number, NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<void>>();
  /** Shops seen changing in the overlap window that this process holds no version for. */
  private readonly recent = new Map<number, number>();
  private readonly listeners: ChangeListener[] = [];
  private poller: NodeJS.Timeout | null = null;
  private watermark: Date | null = null;
  private resumeWithoutOverlap = false;
  private polling = false;

  /** A change to the shop, made in another process: clear what you hold for it. */
  onChange(listener: ChangeListener): void {
    this.listeners.push(listener);
  }

  /** Whether versions are being kept current — pages may be cached only while they are. */
  get live(): boolean {
    return this.watermark !== null && this.poller !== null;
  }

  /** From the write observer: a committed write for the shop touched these tables. */
  noteWrite(shopId: number, tables: readonly string[]): void {
    if (!tables.some(affectsStorefront)) return;
    this.clearLocal(shopId);
    this.touch(shopId);
  }

  /** Asks for a bump: now if the shop was not bumped recently, else once the interval has passed. */
  touch(shopId: number): void {
    if (this.scheduled.has(shopId)) return;
    const wait = Math.max(0, (this.lastBumpAt.get(shopId) ?? 0) + env.pageCache.bumpIntervalMs - Date.now());
    if (wait === 0) {
      this.track(this.bump(shopId));
      return;
    }
    const timer = setTimeout(() => {
      this.scheduled.delete(shopId);
      this.track(this.bump(shopId));
    }, wait);
    timer.unref?.();
    this.scheduled.set(shopId, timer);
  }

  /**
   * A change here is waiting for its (coalesced) bump: until it is sent, this
   * process renders the shop's pages fresh instead of serving cached copies.
   */
  pending(shopId: number): boolean {
    return this.scheduled.has(shopId);
  }

  /** Sends every pending bump now — before a process exits, and in tests. */
  async flush(): Promise<void> {
    for (const [shopId, timer] of this.scheduled) {
      clearTimeout(timer);
      this.scheduled.delete(shopId);
      this.track(this.bump(shopId));
    }
    await Promise.allSettled([...this.inFlight]);
  }

  /** The shop's content version as this process knows it (0: never changed since versions began). */
  async current(shopId: number): Promise<number> {
    const known = this.known.get(shopId);
    if (known !== undefined) return known;
    let loading = this.loading.get(shopId);
    if (!loading) {
      loading = this.load(shopId).finally(() => this.loading.delete(shopId));
      this.loading.set(shopId, loading);
    }
    return loading;
  }

  start(): void {
    if (this.poller || env.pageCache.versionPollMs <= 0) return;
    this.poller = setInterval(() => void this.poll(), env.pageCache.versionPollMs);
    this.poller.unref();
    void this.poll();
  }

  stop(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    this.watermark = null;
  }

  /** One look at what changed since the last; exported for tests and the sweep of a single process. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      if (!this.watermark) {
        const [rows] = await controlPlane.query<RowDataPacket[]>('SELECT UTC_TIMESTAMP(3) AS now');
        this.watermark = new Date(rows[0].now);
        // Whatever this process cached before it was polling may be stale.
        this.known.clear();
      }
      const since = new Date(this.watermark.getTime() - (this.resumeWithoutOverlap ? 0 : OVERLAP_MS));
      const [rows] = await controlPlane.query<RowDataPacket[]>(
        'SELECT shop_id, version, updated_at FROM storefront_versions WHERE updated_at >= ? ORDER BY updated_at LIMIT ?',
        [since, POLL_BATCH],
      );
      if (this.recent.size > 50_000) this.recent.clear();
      for (const row of rows) {
        const shopId = Number(row.shop_id);
        const version = Number(row.version);
        const known = this.known.get(shopId);
        if (known !== undefined) {
          if (version > known) {
            this.remember(shopId, version);
            this.changed(shopId);
          }
        } else if (this.recent.get(shopId) !== version) {
          this.recent.set(shopId, version);
          this.changed(shopId);
        }
      }
      const last = rows.length ? new Date(rows[rows.length - 1].updated_at) : null;
      if (last && last > this.watermark) this.watermark = last;
      // A full batch means more are waiting: continue from exactly where this one stopped.
      this.resumeWithoutOverlap = rows.length === POLL_BATCH;
    } catch (error) {
      logger.warn('storefront.version_poll_failed', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.polling = false;
    }
  }

  /** Forgets everything; for tests. */
  reset(): void {
    for (const timer of this.scheduled.values()) clearTimeout(timer);
    this.scheduled.clear();
    this.known.clear();
    this.recent.clear();
    this.lastBumpAt.clear();
  }

  private changed(shopId: number): void {
    metrics.counter('storefront_version_changes_seen_total', {}, 'Shops this process learned had changed elsewhere').inc();
    this.clearLocal(shopId);
  }

  /** Drops what this process holds in memory for the shop. */
  private clearLocal(shopId: number): void {
    ShopScopedCache.clearShopEverywhere(shopId);
    for (const listener of this.listeners) {
      try {
        listener(shopId);
      } catch (error) {
        logger.warn('storefront.version_listener_failed', { shop_id: shopId, error: String(error) });
      }
    }
  }

  private remember(shopId: number, version: number): void {
    if (!this.known.has(shopId) && this.known.size >= MAX_KNOWN) {
      const oldest = this.known.keys().next().value;
      if (oldest !== undefined) this.known.delete(oldest);
    }
    this.known.set(shopId, version);
  }

  private async load(shopId: number): Promise<number> {
    const [rows] = await controlPlane.query<RowDataPacket[]>('SELECT version FROM storefront_versions WHERE shop_id = ?', [shopId]);
    const version = Number(rows[0]?.version ?? 0);
    const known = this.known.get(shopId);
    if (known === undefined || version > known) this.remember(shopId, version);
    return this.known.get(shopId)!;
  }

  private async bump(shopId: number): Promise<void> {
    this.lastBumpAt.set(shopId, Date.now());
    if (this.lastBumpAt.size > MAX_KNOWN) this.lastBumpAt.clear();
    try {
      // LAST_INSERT_ID(expr) hands the new version back in the same statement.
      const [result] = await controlPlane.query<ResultSetHeader>(
        `INSERT INTO storefront_versions (shop_id, version, updated_at) VALUES (?, 1, UTC_TIMESTAMP(3))
           ON DUPLICATE KEY UPDATE version = LAST_INSERT_ID(version + 1), updated_at = UTC_TIMESTAMP(3)`,
        [shopId],
      );
      const version = Number(result.insertId) || 1;
      const known = this.known.get(shopId);
      if (known === undefined || version > known) this.remember(shopId, version);
      metrics.counter('storefront_version_bumps_total', {}, 'Storefront content versions bumped by this process').inc();
    } catch (error) {
      logger.warn('storefront.version_bump_failed', { shop_id: shopId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }
}

export const storefrontVersions = new StorefrontVersions();

function listener(shopId: number, tables: readonly string[]): void {
  storefrontVersions.noteWrite(shopId, tables);
}

// Every process that writes reports its changes — the API, workers, scripts —
// whether or not it serves pages and polls.
writeObserver.subscribe(listener);
