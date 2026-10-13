import { randomUUID } from 'node:crypto';
import { controlPlane, execute, insert, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import type { DomainStatus } from './lifecycle';

/**
 * shop_domains and its companions, on the control plane: a hostname is
 * resolved to a shop before any pod is involved, and the checking sweep runs
 * across every shop at once.
 */

export interface DomainRecord extends RowDataPacket {
  id: number;
  shop_id: number;
  hostname: string;
  root_domain: string | null;
  pair_id: number | null;
  kind: 'platform' | 'custom';
  status: DomainStatus;
  source: 'platform' | 'connected' | 'purchased' | 'transferred';
  is_primary: number;
  verification_status: 'pending' | 'verified' | 'failed';
  verification_token: string;
  routing_target: string | null;
  ownership_method: 'txt' | 'cname' | 'sibling' | 'registrar' | 'platform' | 'transfer' | null;
  verified_at: Date | null;
  ssl_status: 'pending' | 'active' | 'failed';
  redirect_to_primary: number;
  last_checked_at: Date | null;
  failure_reason: string | null;
  dns_snapshot: unknown;
  edge_provider: string | null;
  edge_hostname_id: string | null;
  certificate_status: 'none' | 'pending' | 'active' | 'failed';
  certificate_issuer: string | null;
  certificate_expires_at: Date | null;
  market_id: number | null;
  locale: string | null;
  check_attempts: number;
  next_check_at: Date | null;
  status_changed_at: Date | null;
  last_healthy_at: Date | null;
  created_at: Date;
}

export interface DomainEventRow extends RowDataPacket {
  id: number;
  event: string;
  from_status: string | null;
  to_status: string | null;
  detail: unknown;
  created_at: Date;
  hostname: string;
}

export interface RegistrationRow extends RowDataPacket {
  id: number;
  shop_id: number;
  domain: string;
  registrar: string;
  registrar_order_id: string | null;
  kind: 'registration' | 'transfer';
  status: 'pending' | 'transferring' | 'active' | 'expired' | 'transferred_out' | 'failed';
  years: number;
  price_amount: string;
  renewal_amount: string;
  currency: string;
  auto_renew: number;
  privacy: number;
  registered_at: Date | null;
  expires_at: Date | null;
  last_error: string | null;
  transfer_checked_at: Date | null;
  created_at: Date;
}

const db = controlPlane;

export const domainsRepository = {
  async forShop(shopId: number, exec: Executor = db): Promise<DomainRecord[]> {
    return query<DomainRecord>('SELECT * FROM shop_domains WHERE shop_id = ? ORDER BY is_primary DESC, kind DESC, root_domain, hostname', [shopId], exec);
  },

  async byId(shopId: number, id: number, exec: Executor = db): Promise<DomainRecord | null> {
    return queryOne<DomainRecord>('SELECT * FROM shop_domains WHERE shop_id = ? AND id = ? LIMIT 1', [shopId, id], exec);
  },

  async anyById(id: number, exec: Executor = db): Promise<DomainRecord | null> {
    return queryOne<DomainRecord>('SELECT * FROM shop_domains WHERE id = ? LIMIT 1', [id], exec);
  },

  async byHostname(hostname: string, exec: Executor = db): Promise<DomainRecord | null> {
    return queryOne<DomainRecord>('SELECT * FROM shop_domains WHERE hostname = ? LIMIT 1', [hostname], exec);
  },

  async countCustom(shopId: number, exec: Executor = db): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>("SELECT COUNT(*) AS total FROM shop_domains WHERE shop_id = ? AND kind = 'custom'", [shopId], exec);
    return Number(row?.total ?? 0);
  },

  async insertCustom(
    input: { shopId: number; hostname: string; rootDomain: string; token: string; routingTarget: string; source: 'connected' | 'purchased'; ownershipMethod?: DomainRecord['ownership_method'] },
    exec: Executor = db,
  ): Promise<number> {
    return insert(
      `INSERT INTO shop_domains
         (shop_id, hostname, root_domain, kind, status, source, is_primary, verification_status, verification_token, routing_target,
          ownership_method, ssl_status, redirect_to_primary, next_check_at, status_changed_at)
       VALUES (?, ?, ?, 'custom', 'pending_dns', ?, 0, ?, ?, ?, ?, 'pending', 1, NOW(), NOW())`,
      [input.shopId, input.hostname, input.rootDomain, input.source, input.ownershipMethod ? 'verified' : 'pending', input.token, input.routingTarget, input.ownershipMethod ?? null],
      exec,
    );
  },

  async pair(a: number, b: number, exec: Executor = db): Promise<void> {
    await execute('UPDATE shop_domains SET pair_id = ? WHERE id = ?', [b, a], exec);
    await execute('UPDATE shop_domains SET pair_id = ? WHERE id = ?', [a, b], exec);
  },

  async update(id: number, patch: Record<string, unknown>, exec: Executor = db): Promise<void> {
    const columns = Object.keys(patch);
    if (!columns.length) return;
    await execute(
      `UPDATE shop_domains SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((column) => {
        const value = patch[column];
        return value !== null && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value;
      }), id],
      exec,
    );
  },

  async setPrimary(shopId: number, id: number, exec: Executor): Promise<void> {
    // The domain stepping down starts redirecting to the new primary (a market's domain keeps its market).
    await execute('UPDATE shop_domains SET is_primary = 0, redirect_to_primary = IF(market_id IS NULL, 1, redirect_to_primary) WHERE shop_id = ? AND is_primary = 1', [shopId], exec);
    await execute('UPDATE shop_domains SET is_primary = 1, redirect_to_primary = 0 WHERE shop_id = ? AND id = ?', [shopId, id], exec);
  },

  async platformDomain(shopId: number, exec: Executor = db): Promise<DomainRecord | null> {
    return queryOne<DomainRecord>("SELECT * FROM shop_domains WHERE shop_id = ? AND kind = 'platform' ORDER BY id LIMIT 1", [shopId], exec);
  },

  async remove(id: number, exec: Executor = db): Promise<void> {
    await execute('UPDATE shop_domains SET pair_id = NULL WHERE pair_id = ?', [id], exec);
    await execute("DELETE FROM shop_domains WHERE id = ? AND kind = 'custom'", [id], exec);
  },

  /**
   * Claims up to `limit` domains that are due, for this worker alone.
   *
   * One UPDATE marks the batch with a lease id and pushes its next check a few
   * minutes out; a second SELECT reads what this worker got. Two workers can
   * never claim the same row (the UPDATE is atomic), and a worker that dies
   * mid-batch loses nothing: the rows come due again when the lease runs out.
   */
  async claimDue(limit: number, leaseMinutes = 5, exec: Executor = db): Promise<DomainRecord[]> {
    const lease = randomUUID();
    await execute(
      `UPDATE shop_domains
          SET check_lease = ?, next_check_at = DATE_ADD(NOW(), INTERVAL ? MINUTE)
        WHERE kind = 'custom' AND next_check_at IS NOT NULL AND next_check_at <= NOW()
        ORDER BY next_check_at
        LIMIT ?`,
      [lease, leaseMinutes, limit],
      exec,
    );
    return query<DomainRecord>('SELECT * FROM shop_domains WHERE check_lease = ?', [lease], exec);
  },

  // ── history ───────────────────────────────────────────────────────────────

  async event(domain: Pick<DomainRecord, 'id' | 'shop_id' | 'hostname'>, event: string, fields: { from?: string | null; to?: string | null; detail?: unknown } = {}, exec: Executor = db): Promise<void> {
    await execute(
      'INSERT INTO domain_events (domain_id, shop_id, hostname, event, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [domain.id, domain.shop_id, domain.hostname, event, fields.from ?? null, fields.to ?? null, fields.detail === undefined ? null : JSON.stringify(fields.detail)],
      exec,
    );
  },

  async events(shopId: number, domainId: number, limit = 50, exec: Executor = db): Promise<DomainEventRow[]> {
    return query<DomainEventRow>('SELECT id, event, from_status, to_status, detail, created_at, hostname FROM domain_events WHERE shop_id = ? AND domain_id = ? ORDER BY id DESC LIMIT ?', [shopId, domainId, limit], exec);
  },

  // ── the platform's view ───────────────────────────────────────────────────

  async statusCounts(exec: Executor = db): Promise<{ status: string; total: number }[]> {
    return query<RowDataPacket & { status: string; total: number }>("SELECT status, COUNT(*) AS total FROM shop_domains WHERE kind = 'custom' GROUP BY status", [], exec);
  },

  async search(filters: { status?: string; q?: string; limit: number; offset: number }, exec: Executor = db) {
    const where = ["d.kind = 'custom'"];
    const params: unknown[] = [];
    if (filters.status) {
      where.push('d.status = ?');
      params.push(filters.status);
    }
    if (filters.q) {
      where.push('(d.hostname LIKE ? OR s.handle LIKE ?)');
      params.push(`%${filters.q}%`, `%${filters.q}%`);
    }
    const rows = await query<DomainRecord & { shop_handle: string; shop_name: string }>(
      `SELECT d.*, s.handle AS shop_handle, s.name AS shop_name FROM shop_domains d JOIN shops s ON s.id = d.shop_id
        WHERE ${where.join(' AND ')} ORDER BY d.status_changed_at DESC, d.id DESC LIMIT ? OFFSET ?`,
      [...params, filters.limit, filters.offset],
      exec,
    );
    return rows;
  },

  // ── purchased domains ─────────────────────────────────────────────────────

  async registrations(shopId: number, exec: Executor = db): Promise<RegistrationRow[]> {
    return query<RegistrationRow>('SELECT * FROM domain_registrations WHERE shop_id = ? ORDER BY created_at DESC', [shopId], exec);
  },

  /** A registration the platform holds or is acquiring for the domain (failed attempts do not count). */
  async registrationByDomain(domain: string, exec: Executor = db): Promise<RegistrationRow | null> {
    return queryOne<RegistrationRow>("SELECT * FROM domain_registrations WHERE domain = ? AND status <> 'failed' LIMIT 1", [domain], exec);
  },

  async insertRegistration(
    input: { shopId: number; domain: string; registrar: string; years: number; price: number; renewal: number; currency: string; privacy: boolean; kind?: 'registration' | 'transfer'; status?: 'pending' | 'transferring' },
    exec: Executor = db,
  ): Promise<number> {
    // A failed attempt at the same domain makes way for this one (the domain is unique).
    await execute("DELETE FROM domain_registrations WHERE domain = ? AND status = 'failed'", [input.domain], exec);
    return insert(
      `INSERT INTO domain_registrations (shop_id, domain, registrar, kind, status, years, price_amount, renewal_amount, currency, auto_renew, privacy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [input.shopId, input.domain, input.registrar, input.kind ?? 'registration', input.status ?? 'pending', input.years, input.price, input.renewal, input.currency, input.privacy ? 1 : 0],
      exec,
    );
  },

  /** Transfers in flight not asked about for a while — across every shop, for the transfers job. */
  async transfersToCheck(everyMinutes: number, limit: number, exec: Executor = db): Promise<RegistrationRow[]> {
    return query<RegistrationRow>(
      `SELECT * FROM domain_registrations
        WHERE status = 'transferring' AND (transfer_checked_at IS NULL OR transfer_checked_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE))
        ORDER BY transfer_checked_at IS NOT NULL, transfer_checked_at LIMIT ?`,
      [everyMinutes, limit],
      exec,
    );
  },

  /** The store's addresses on a registrable domain: example.com and www.example.com, shop.example.com… */
  async forRoot(shopId: number, rootDomain: string, exec: Executor = db): Promise<DomainRecord[]> {
    return query<DomainRecord>("SELECT * FROM shop_domains WHERE shop_id = ? AND root_domain = ? AND kind = 'custom'", [shopId, rootDomain], exec);
  },

  async updateRegistration(id: number, patch: Record<string, unknown>, exec: Executor = db): Promise<void> {
    const columns = Object.keys(patch);
    if (!columns.length) return;
    await execute(`UPDATE domain_registrations SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE id = ?`, [...columns.map((column) => patch[column]), id], exec);
  },

  /** Registrations to renew: auto-renew on, expiring within the window. */
  async dueRenewals(withinDays: number, limit: number, exec: Executor = db): Promise<RegistrationRow[]> {
    return query<RegistrationRow>(
      "SELECT * FROM domain_registrations WHERE status = 'active' AND auto_renew = 1 AND expires_at <= DATE_ADD(NOW(), INTERVAL ? DAY) ORDER BY expires_at LIMIT ?",
      [withinDays, limit],
      exec,
    );
  },
};
