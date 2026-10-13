import { execute, insert, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../tenancy/context';

export interface ConnectionRow extends RowDataPacket {
  id: number;
  shop_id: number;
  public_id: string;
  provider: string;
  category: string;
  name: string;
  status: 'active' | 'disabled' | 'error';
  mode: 'live' | 'test';
  is_default: number;
  credentials_sealed: string | null;
  credentials_hint: string | null;
  config: unknown;
  last_verified_at: Date | null;
  last_used_at: Date | null;
  last_error: string | null;
  created_by_admin_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface InboundEventRow extends RowDataPacket {
  id: number;
  shop_id: number;
  connection_id: number | null;
  provider: string;
  external_id: string;
  event_type: string | null;
  signature_valid: number;
  status: 'received' | 'processed' | 'ignored' | 'failed';
  attempts: number;
  payload: unknown;
  error: string | null;
  received_at: Date;
  processed_at: Date | null;
}

export const connectionsRepository = {
  async list(exec: Executor = pool): Promise<ConnectionRow[]> {
    return query<ConnectionRow>(
      'SELECT * FROM integration_connections WHERE shop_id = ? ORDER BY category, is_default DESC, name',
      [shopId()],
      exec,
    );
  },

  async byPublicId(publicId: string, exec: Executor = pool): Promise<ConnectionRow | null> {
    return queryOne<ConnectionRow>(
      'SELECT * FROM integration_connections WHERE shop_id = ? AND public_id = ? LIMIT 1',
      [shopId(), publicId],
      exec,
    );
  },

  async byId(id: number, exec: Executor = pool): Promise<ConnectionRow | null> {
    return queryOne<ConnectionRow>('SELECT * FROM integration_connections WHERE shop_id = ? AND id = ? LIMIT 1', [
      shopId(),
      id,
    ], exec);
  },

  /** The connection a category uses when nothing names one. Active only. */
  async defaultFor(category: string, exec: Executor = pool): Promise<ConnectionRow | null> {
    return queryOne<ConnectionRow>(
      `SELECT * FROM integration_connections
        WHERE shop_id = ? AND category = ? AND status = 'active'
        ORDER BY is_default DESC, id
        LIMIT 1`,
      [shopId(), category],
      exec,
    );
  },

  /** The shop's active connection for a named provider (the sender row names providers). */
  async activeForProvider(provider: string, exec: Executor = pool): Promise<ConnectionRow | null> {
    return queryOne<ConnectionRow>(
      `SELECT * FROM integration_connections
        WHERE shop_id = ? AND provider = ? AND status = 'active'
        ORDER BY is_default DESC, id
        LIMIT 1`,
      [shopId(), provider],
      exec,
    );
  },

  async countInCategory(category: string, exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>(
      "SELECT COUNT(*) AS total FROM integration_connections WHERE shop_id = ? AND category = ? AND status <> 'disabled'",
      [shopId(), category],
      exec,
    );
    return Number(row?.total ?? 0);
  },

  async create(
    data: {
      publicId: string;
      provider: string;
      category: string;
      name: string;
      mode: 'live' | 'test';
      credentialsSealed: string;
      credentialsHint: string;
      config: Record<string, unknown>;
      adminId: number | null;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO integration_connections
         (shop_id, public_id, provider, category, name, status, mode, is_default,
          credentials_sealed, credentials_hint, config, last_verified_at, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?, NOW(), ?)`,
      [
        shopId(),
        data.publicId,
        data.provider,
        data.category,
        data.name,
        data.mode,
        data.credentialsSealed,
        data.credentialsHint,
        JSON.stringify(data.config),
        data.adminId,
      ],
      exec,
    );
  },

  async update(id: number, patch: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const columns = Object.keys(patch);
    if (columns.length === 0) return;
    await execute(
      `UPDATE integration_connections SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')}
        WHERE shop_id = ? AND id = ?`,
      [...columns.map((column) => patch[column]), shopId(), id],
      exec,
    );
  },

  /** One default per category: clear the others, then set this one, in the caller's transaction. */
  async makeDefault(id: number, category: string, exec: Executor = pool): Promise<void> {
    await execute('UPDATE integration_connections SET is_default = 0 WHERE shop_id = ? AND category = ? AND id <> ?', [
      shopId(),
      category,
      id,
    ], exec);
    await execute('UPDATE integration_connections SET is_default = 1 WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async remove(id: number, exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM integration_connections WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async touch(id: number, error: string | null, exec: Executor = pool): Promise<void> {
    await execute(
      'UPDATE integration_connections SET last_used_at = NOW(), last_error = ? WHERE shop_id = ? AND id = ?',
      [error ? error.slice(0, 500) : null, shopId(), id],
      exec,
    );
  },

  // ── inbound events ─────────────────────────────────────────────────────────

  /** Stores an inbound event once. Returns null when this external id was seen before. */
  async recordInbound(
    data: {
      connectionId: number | null;
      provider: string;
      externalId: string;
      eventType: string | null;
      signatureValid: boolean;
      payload: unknown;
      status: InboundEventRow['status'];
      error?: string | null;
    },
    exec: Executor = pool,
  ): Promise<number | null> {
    const result = await execute(
      `INSERT IGNORE INTO integration_webhook_events
         (shop_id, connection_id, provider, external_id, event_type, signature_valid, status, payload, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.connectionId,
        data.provider,
        data.externalId.slice(0, 190),
        data.eventType,
        data.signatureValid ? 1 : 0,
        data.status,
        JSON.stringify(data.payload ?? null),
        data.error ?? null,
      ],
      exec,
    );
    return result.affectedRows === 1 ? result.insertId : null;
  },

  async inboundById(id: number, exec: Executor = pool): Promise<InboundEventRow | null> {
    return queryOne<InboundEventRow>('SELECT * FROM integration_webhook_events WHERE shop_id = ? AND id = ?', [
      shopId(),
      id,
    ], exec);
  },

  async finishInbound(
    id: number,
    status: 'processed' | 'ignored' | 'failed',
    error: string | null,
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `UPDATE integration_webhook_events
          SET status = ?, error = ?, attempts = attempts + 1,
              processed_at = CASE WHEN ? IN ('processed','ignored') THEN NOW(3) ELSE processed_at END
        WHERE shop_id = ? AND id = ?`,
      [status, error ? error.slice(0, 1000) : null, status, shopId(), id],
      exec,
    );
  },

  async recentInbound(connectionId: number, limit: number, exec: Executor = pool): Promise<InboundEventRow[]> {
    return query<InboundEventRow>(
      `SELECT id, shop_id, connection_id, provider, external_id, event_type, signature_valid, status, attempts,
              NULL AS payload, error, received_at, processed_at
         FROM integration_webhook_events
        WHERE shop_id = ? AND connection_id = ?
        ORDER BY id DESC
        LIMIT ?`,
      [shopId(), connectionId, limit],
      exec,
    );
  },
};
