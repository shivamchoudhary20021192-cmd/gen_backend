import { controlPlane, execute, insert, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import type { ShopStatus } from '../tenancy/context';

/**
 * The control-plane side of shops: the shop row itself, its domains, its
 * subscription, its staff memberships and its organisation. Everything here
 * reads and writes `controlPlane`, never a pod — these rows exist before the
 * shop has any tenant data and outlive it when it closes.
 */

export interface ShopRow extends RowDataPacket {
  id: number;
  public_id: string;
  handle: string;
  name: string;
  email: string | null;
  phone: string | null;
  organization_id: number | null;
  owner_user_id: number | null;
  pod_id: number;
  plan_id: number | null;
  status: ShopStatus;
  status_reason: string | null;
  vertical: string;
  country_code: string;
  currency: string;
  timezone: string;
  locale: string;
  weight_unit: 'g' | 'kg' | 'lb' | 'oz';
  tax_engine: string;
  storefront_password_enabled: number;
  storefront_password_hash: string | null;
  provisioned_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DomainRow extends RowDataPacket {
  id: number;
  shop_id: number;
  hostname: string;
  kind: 'platform' | 'custom';
  is_primary: number;
  verification_status: 'pending' | 'verified' | 'failed';
  verification_token: string;
  verified_at: Date | null;
  ssl_status: 'pending' | 'active' | 'failed';
  redirect_to_primary: number;
  last_checked_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
}

export interface PlanRow extends RowDataPacket {
  id: number;
  handle: string;
  name: string;
  tagline: string | null;
  price_amount: string;
  currency: string;
  billing_interval: 'month' | 'year';
  trial_days: number;
  transaction_fee_bps: number;
  limits: unknown;
  features: unknown;
  is_public: number;
  is_active: number;
  sort_order: number;
}

export interface SubscriptionRow extends RowDataPacket {
  id: number;
  shop_id: number;
  plan_id: number;
  status: 'trialing' | 'active' | 'past_due' | 'frozen' | 'cancelled';
  price_amount: string;
  currency: string;
  billing_interval: 'month' | 'year';
  trial_ends_at: Date | null;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: number;
  cancelled_at: Date | null;
  provider: string;
  provider_subscription_id: string | null;
  created_at: Date;
}

export const shopsRepository = {
  async byId(id: number, exec: Executor = controlPlane): Promise<ShopRow | null> {
    return queryOne<ShopRow>('SELECT * FROM shops WHERE id = ? LIMIT 1', [id], exec);
  },

  async byHandle(handle: string, exec: Executor = controlPlane): Promise<ShopRow | null> {
    return queryOne<ShopRow>('SELECT * FROM shops WHERE handle = ? LIMIT 1', [handle], exec);
  },

  async handleTaken(handle: string, exec: Executor = controlPlane): Promise<boolean> {
    const row = await queryOne<RowDataPacket & { id: number }>('SELECT id FROM shops WHERE handle = ? LIMIT 1', [handle], exec);
    return row !== null;
  },

  /** The pod a new shop goes to: accepting, active, and the least full. */
  async podForNewShop(exec: Executor = controlPlane): Promise<number> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      `SELECT p.id
         FROM pods p
         LEFT JOIN shops s ON s.pod_id = p.id AND s.status <> 'closed'
        WHERE p.status = 'active' AND p.accepts_new_shops = 1
        GROUP BY p.id, p.capacity
       HAVING COUNT(s.id) < p.capacity
        ORDER BY COUNT(s.id) / p.capacity ASC, p.id ASC
        LIMIT 1`,
      [],
      exec,
    );
    return row ? Number(row.id) : 1;
  },

  async planByHandle(handle: string, exec: Executor = controlPlane): Promise<PlanRow | null> {
    return queryOne<PlanRow>('SELECT * FROM plans WHERE handle = ? AND is_active = 1 LIMIT 1', [handle], exec);
  },

  /** Retired plans too: for operators editing or reactivating one. */
  async planByHandleAny(handle: string, exec: Executor = controlPlane): Promise<PlanRow | null> {
    return queryOne<PlanRow>('SELECT * FROM plans WHERE handle = ? LIMIT 1', [handle], exec);
  },

  async planById(id: number, exec: Executor = controlPlane): Promise<PlanRow | null> {
    return queryOne<PlanRow>('SELECT * FROM plans WHERE id = ? LIMIT 1', [id], exec);
  },

  async publicPlans(exec: Executor = controlPlane): Promise<PlanRow[]> {
    return query<PlanRow>('SELECT * FROM plans WHERE is_active = 1 AND is_public = 1 ORDER BY sort_order, price_amount', [], exec);
  },

  async allPlans(exec: Executor = controlPlane): Promise<PlanRow[]> {
    return query<PlanRow>('SELECT * FROM plans ORDER BY sort_order, id', [], exec);
  },

  async createOrganization(data: { publicId: string; name: string; ownerUserId: number; email: string | null; countryCode: string }, exec: Executor): Promise<number> {
    return insert(
      'INSERT INTO organizations (public_id, name, owner_user_id, billing_email, country_code) VALUES (?, ?, ?, ?, ?)',
      [data.publicId, data.name, data.ownerUserId, data.email, data.countryCode],
      exec,
    );
  },

  async organizationOf(ownerUserId: number, exec: Executor = controlPlane): Promise<number | null> {
    const row = await queryOne<RowDataPacket & { id: number }>(
      'SELECT id FROM organizations WHERE owner_user_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1',
      [ownerUserId],
      exec,
    );
    return row ? Number(row.id) : null;
  },

  async createShop(
    data: {
      publicId: string;
      handle: string;
      name: string;
      email: string | null;
      phone: string | null;
      organizationId: number;
      ownerUserId: number;
      podId: number;
      planId: number;
      vertical: string;
      countryCode: string;
      currency: string;
      timezone: string;
      locale: string;
      weightUnit: string;
      taxEngine: string;
    },
    exec: Executor,
  ): Promise<number> {
    return insert(
      `INSERT INTO shops
         (public_id, handle, name, email, phone, organization_id, owner_user_id, pod_id, plan_id, status,
          vertical, country_code, currency, timezone, locale, weight_unit, tax_engine)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.publicId,
        data.handle,
        data.name,
        data.email,
        data.phone,
        data.organizationId,
        data.ownerUserId,
        data.podId,
        data.planId,
        data.vertical,
        data.countryCode,
        data.currency,
        data.timezone,
        data.locale,
        data.weightUnit,
        data.taxEngine,
      ],
      exec,
    );
  },

  async update(id: number, patch: Record<string, unknown>, exec: Executor = controlPlane): Promise<void> {
    const columns = Object.keys(patch);
    if (columns.length === 0) return;
    await execute(
      `UPDATE shops SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((column) => patch[column]), id],
      exec,
    );
  },

  async addOwner(shopId: number, adminUserId: number, exec: Executor): Promise<void> {
    await execute(
      `INSERT INTO shop_staff (shop_id, admin_user_id, is_owner, has_full_access, status, joined_at)
       VALUES (?, ?, 1, 1, 'active', NOW())`,
      [shopId, adminUserId],
      exec,
    );
  },

  async transferOwnership(shopId: number, fromUserId: number, toUserId: number, exec: Executor): Promise<void> {
    // The generated owner_marker allows one owner per shop, so the old owner
    // steps down before the new one steps up, inside one transaction.
    await execute('UPDATE shop_staff SET is_owner = 0 WHERE shop_id = ? AND admin_user_id = ?', [shopId, fromUserId], exec);
    await execute(
      "UPDATE shop_staff SET is_owner = 1, has_full_access = 1, status = 'active' WHERE shop_id = ? AND admin_user_id = ?",
      [shopId, toUserId],
      exec,
    );
    await execute('UPDATE shops SET owner_user_id = ? WHERE id = ?', [toUserId, shopId], exec);
  },

  async staffMember(shopId: number, adminUserId: number, exec: Executor = controlPlane) {
    return queryOne<RowDataPacket & { status: string; is_owner: number }>(
      'SELECT status, is_owner FROM shop_staff WHERE shop_id = ? AND admin_user_id = ? LIMIT 1',
      [shopId, adminUserId],
      exec,
    );
  },

  // ── domains ───────────────────────────────────────────────────────────────

  async domains(shopId: number, exec: Executor = controlPlane): Promise<DomainRow[]> {
    return query<DomainRow>('SELECT * FROM shop_domains WHERE shop_id = ? ORDER BY is_primary DESC, kind, hostname', [shopId], exec);
  },

  async domainById(shopId: number, id: number, exec: Executor = controlPlane): Promise<DomainRow | null> {
    return queryOne<DomainRow>('SELECT * FROM shop_domains WHERE shop_id = ? AND id = ? LIMIT 1', [shopId, id], exec);
  },

  async domainByHostname(hostname: string, exec: Executor = controlPlane): Promise<DomainRow | null> {
    return queryOne<DomainRow>('SELECT * FROM shop_domains WHERE hostname = ? LIMIT 1', [hostname], exec);
  },

  async addDomain(
    data: { shopId: number; hostname: string; kind: 'platform' | 'custom'; primary: boolean; verified: boolean; token: string },
    exec: Executor = controlPlane,
  ): Promise<number> {
    return insert(
      `INSERT INTO shop_domains
         (shop_id, hostname, root_domain, kind, status, source, is_primary, verification_status, verification_token, ownership_method,
          verified_at, ssl_status, certificate_status, next_check_at, status_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${data.verified ? 'NOW()' : 'NULL'}, ?, ?, ?, NOW())`,
      [
        data.shopId,
        data.hostname,
        data.hostname,
        data.kind,
        // The platform address is live from the start, under the platform's wildcard certificate.
        data.kind === 'platform' ? 'active' : 'pending_dns',
        data.kind === 'platform' ? 'platform' : 'connected',
        data.primary ? 1 : 0,
        data.verified ? 'verified' : 'pending',
        data.token,
        data.kind === 'platform' ? 'platform' : null,
        data.verified ? 'active' : 'pending',
        data.kind === 'platform' ? 'active' : 'none',
        data.kind === 'platform' ? null : new Date(),
      ],
      exec,
    );
  },

  async updateDomain(id: number, patch: Record<string, unknown>, exec: Executor = controlPlane): Promise<void> {
    const columns = Object.keys(patch);
    if (columns.length === 0) return;
    await execute(
      `UPDATE shop_domains SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((column) => patch[column]), id],
      exec,
    );
  },

  async setPrimaryDomain(shopId: number, domainId: number, exec: Executor): Promise<void> {
    await execute('UPDATE shop_domains SET is_primary = 0 WHERE shop_id = ?', [shopId], exec);
    await execute('UPDATE shop_domains SET is_primary = 1 WHERE shop_id = ? AND id = ?', [shopId, domainId], exec);
  },

  async removeDomain(shopId: number, id: number, exec: Executor = controlPlane): Promise<void> {
    await execute("DELETE FROM shop_domains WHERE shop_id = ? AND id = ? AND kind = 'custom' AND is_primary = 0", [shopId, id], exec);
  },

  async countCustomDomains(shopId: number, exec: Executor = controlPlane): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      "SELECT COUNT(*) AS total FROM shop_domains WHERE shop_id = ? AND kind = 'custom'",
      [shopId],
      exec,
    );
    return Number(row?.total ?? 0);
  },

  async pendingDomains(limit: number, exec: Executor = controlPlane): Promise<DomainRow[]> {
    return query<DomainRow>(
      `SELECT * FROM shop_domains
        WHERE kind = 'custom' AND verification_status IN ('pending','failed')
          AND created_at > DATE_SUB(NOW(), INTERVAL 14 DAY)
          AND (last_checked_at IS NULL OR last_checked_at < DATE_SUB(NOW(), INTERVAL 4 MINUTE))
        ORDER BY last_checked_at IS NOT NULL, last_checked_at
        LIMIT ?`,
      [limit],
      exec,
    );
  },

  // ── subscriptions ─────────────────────────────────────────────────────────

  async liveSubscription(shopId: number, exec: Executor = controlPlane): Promise<SubscriptionRow | null> {
    return queryOne<SubscriptionRow>(
      "SELECT * FROM shop_subscriptions WHERE shop_id = ? AND status <> 'cancelled' ORDER BY id DESC LIMIT 1",
      [shopId],
      exec,
    );
  },

  async createSubscription(
    data: {
      shopId: number;
      planId: number;
      status: SubscriptionRow['status'];
      price: number;
      currency: string;
      interval: 'month' | 'year';
      trialEndsAt: Date | null;
      periodStart: Date;
      periodEnd: Date;
      provider: string;
    },
    exec: Executor,
  ): Promise<number> {
    return insert(
      `INSERT INTO shop_subscriptions
         (shop_id, plan_id, status, price_amount, currency, billing_interval, trial_ends_at,
          current_period_start, current_period_end, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.shopId,
        data.planId,
        data.status,
        data.price,
        data.currency,
        data.interval,
        data.trialEndsAt,
        data.periodStart,
        data.periodEnd,
        data.provider,
      ],
      exec,
    );
  },

  async cancelSubscription(id: number, exec: Executor): Promise<void> {
    await execute("UPDATE shop_subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE id = ?", [id], exec);
  },

  async updateSubscription(id: number, patch: Record<string, unknown>, exec: Executor = controlPlane): Promise<void> {
    const columns = Object.keys(patch);
    if (columns.length === 0) return;
    await execute(
      `UPDATE shop_subscriptions SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((column) => patch[column]), id],
      exec,
    );
  },

  // ── platform administration ───────────────────────────────────────────────

  async search(
    filters: { q?: string; status?: string; planId?: number; podId?: number; limit: number; offset: number },
    exec: Executor = controlPlane,
  ) {
    const where: string[] = ['1 = 1'];
    const params: unknown[] = [];
    if (filters.q) {
      where.push('(s.handle LIKE ? OR s.name LIKE ? OR s.email LIKE ? OR d.hostname LIKE ?)');
      const like = `%${filters.q}%`;
      params.push(like, like, like, like);
    }
    if (filters.status) {
      where.push('s.status = ?');
      params.push(filters.status);
    }
    if (filters.planId) {
      where.push('s.plan_id = ?');
      params.push(filters.planId);
    }
    if (filters.podId) {
      where.push('s.pod_id = ?');
      params.push(filters.podId);
    }
    const rows = await query<ShopRow & { plan_handle: string | null; primary_domain: string | null; owner_email: string | null }>(
      `SELECT s.*, p.handle AS plan_handle,
              (SELECT pd.hostname FROM shop_domains pd WHERE pd.shop_id = s.id AND pd.is_primary = 1 LIMIT 1) AS primary_domain,
              a.email AS owner_email
         FROM shops s
         LEFT JOIN plans p ON p.id = s.plan_id
         LEFT JOIN admin_users a ON a.id = s.owner_user_id
         LEFT JOIN shop_domains d ON d.shop_id = s.id
        WHERE ${where.join(' AND ')}
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT ? OFFSET ?`,
      [...params, filters.limit, filters.offset],
      exec,
    );
    const total = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(DISTINCT s.id) AS total FROM shops s LEFT JOIN shop_domains d ON d.shop_id = s.id WHERE ${where.join(' AND ')}`,
      params,
      exec,
    );
    return { rows, total: Number(total?.total ?? 0) };
  },

  async statusCounts(exec: Executor = controlPlane) {
    return query<RowDataPacket & { status: string; total: number }>('SELECT status, COUNT(*) AS total FROM shops GROUP BY status', [], exec);
  },
};
