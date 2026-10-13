import { execute, pool, type Executor } from '../db/pool';
import { logger } from '../core/logger';
import { publishForAudit } from '../platform/events/auditEvents';
import { tenancy } from '../platform/tenancy/context';

export interface AuditEntry {
  actorType?: 'admin' | 'customer' | 'system' | 'webhook' | 'job';
  actorId?: number | null;
  actorLabel?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: number | null;
  summary?: string | null;
  changes?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Append-only trail. Call this from the SERVICE layer with the transaction
 * connection, so the audit row commits or rolls back with the thing it
 * describes — an audit log that can disagree with reality is worse than none.
 */
export const auditService = {
  /**
   * Written against the shop in context. Events that happen before any shop
   * is chosen — signing in, a failed password — belong to no shop and are
   * written with a null shop_id; that is the one reason audit_logs.shop_id is
   * nullable, and this is the one place that writes such rows.
   */
  async log(entry: AuditEntry, exec: Executor = pool): Promise<void> {
    const shop = tenancy.currentOrNull();
    const write = () =>
      execute(
        `INSERT INTO audit_logs
           (shop_id, actor_type, actor_id, actor_label, action, entity_type, entity_id,
            summary, changes, context, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${entry.ip ? 'INET6_ATON(?)' : 'NULL'}, ?)`,
        [
          shop?.id ?? null,
          entry.actorType ?? 'admin',
          entry.actorId ?? null,
          entry.actorLabel ?? null,
          entry.action,
          entry.entityType ?? null,
          entry.entityId ?? null,
          entry.summary ?? null,
          entry.changes ? JSON.stringify(entry.changes) : null,
          entry.context ? JSON.stringify(entry.context) : null,
          ...(entry.ip ? [entry.ip] : []),
          entry.userAgent ?? null,
        ],
        exec,
      );
    try {
      if (shop) await write();
      else await tenancy.unscoped('platform-level audit entry', write);
      // The same change, as a domain event for webhooks, apps and automations,
      // in the same transaction.
      await publishForAudit(entry, exec);
    } catch (error) {
      // Never let auditing break the operation it is describing — but shout
      // about it, because a silent gap in the trail is a compliance problem.
      logger.error('audit.write_failed', { action: entry.action, error: String(error) });
    }
  },

  /**
   * Produces a { field: { from, to } } diff of only the keys that actually
   * changed, so the audit log stays readable instead of storing whole rows.
   */
  diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> | null {
    const changes: Record<string, unknown> = {};
    for (const key of Object.keys(after)) {
      const from = before[key];
      const to = after[key];
      if (to === undefined) continue;
      const normalise = (v: unknown) => (v instanceof Date ? v.toISOString() : v);
      if (JSON.stringify(normalise(from)) !== JSON.stringify(normalise(to))) {
        changes[key] = { from: normalise(from) ?? null, to: normalise(to) ?? null };
      }
    }
    return Object.keys(changes).length > 0 ? changes : null;
  },
};
