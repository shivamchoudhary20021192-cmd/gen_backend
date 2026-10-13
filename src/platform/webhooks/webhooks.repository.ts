import { randomUUID } from 'node:crypto';
import { execute, insert, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../tenancy/context';

export interface SubscriptionRow extends RowDataPacket {
  id: number;
  shop_id: number;
  public_id: string;
  app_id: number | null;
  topic: string;
  address: string;
  api_version: string;
  include_fields: unknown;
  secret_ciphertext: string | null;
  status: 'active' | 'disabled';
  disabled_reason: string | null;
  consecutive_failures: number;
  failing_since: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  created_by_admin_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface DeliveryRow extends RowDataPacket {
  id: number;
  subscription_id: number;
  event_id: number;
  event_uuid: string;
  topic: string;
  attempt: number;
  status: 'succeeded' | 'failed';
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number;
  created_at: Date;
}

export const webhooksRepository = {
  async list(filter: { appId?: number | null; topic?: string } = {}, exec?: Executor): Promise<SubscriptionRow[]> {
    const where = ['shop_id = ?'];
    const params: unknown[] = [shopId()];
    if (filter.appId === null) where.push('app_id IS NULL');
    else if (filter.appId !== undefined) {
      where.push('app_id = ?');
      params.push(filter.appId);
    }
    if (filter.topic) {
      where.push('topic = ?');
      params.push(filter.topic);
    }
    return query<SubscriptionRow>(
      `SELECT * FROM webhook_subscriptions WHERE ${where.join(' AND ')} ORDER BY topic, created_at`,
      params,
      exec,
    );
  },

  async findById(id: number, exec?: Executor): Promise<SubscriptionRow | null> {
    return queryOne<SubscriptionRow>('SELECT * FROM webhook_subscriptions WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async findByPublicId(publicId: string, exec?: Executor): Promise<SubscriptionRow | null> {
    return queryOne<SubscriptionRow>(
      'SELECT * FROM webhook_subscriptions WHERE shop_id = ? AND public_id = ?',
      [shopId(), publicId],
      exec,
    );
  },

  async countActive(exec?: Executor): Promise<number> {
    const row = await queryOne<RowDataPacket>(
      "SELECT COUNT(*) AS n FROM webhook_subscriptions WHERE shop_id = ? AND status = 'active'",
      [shopId()],
      exec,
    );
    return Number(row?.n ?? 0);
  },

  /**
   * Creates, or — when the same owner already subscribed this address to this
   * topic — re-activates and updates. Subscribing twice is not an error, it is
   * what an app does on every install.
   */
  async upsert(
    data: {
      appId: number | null;
      topic: string;
      address: string;
      apiVersion: string;
      includeFields: string[] | null;
      secretCiphertext: string | null;
      createdByAdminId: number | null;
    },
    exec?: Executor,
  ): Promise<SubscriptionRow> {
    const publicId = randomUUID();
    await execute(
      `INSERT INTO webhook_subscriptions
         (shop_id, public_id, app_id, topic, address, api_version, include_fields, secret_ciphertext, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE api_version = VALUES(api_version), include_fields = VALUES(include_fields),
                               status = 'active', disabled_reason = NULL, consecutive_failures = 0, failing_since = NULL`,
      [
        shopId(),
        publicId,
        data.appId,
        data.topic,
        data.address,
        data.apiVersion,
        data.includeFields ? JSON.stringify(data.includeFields) : null,
        data.secretCiphertext,
        data.createdByAdminId,
      ],
      exec,
    );
    const row = await queryOne<SubscriptionRow>(
      `SELECT * FROM webhook_subscriptions
        WHERE shop_id = ? AND owner_key = ? AND topic = ? AND address_hash = SHA2(?, 256)`,
      [shopId(), data.appId ?? 0, data.topic, data.address],
      exec,
    );
    return row!;
  },

  async update(
    id: number,
    fields: { address?: string; api_version?: string; include_fields?: string[] | null; status?: 'active' | 'disabled' },
    exec?: Executor,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.address !== undefined) {
      sets.push('address = ?');
      params.push(fields.address);
    }
    if (fields.api_version !== undefined) {
      sets.push('api_version = ?');
      params.push(fields.api_version);
    }
    if (fields.include_fields !== undefined) {
      sets.push('include_fields = ?');
      params.push(fields.include_fields ? JSON.stringify(fields.include_fields) : null);
    }
    if (fields.status !== undefined) {
      sets.push('status = ?');
      params.push(fields.status);
      if (fields.status === 'active') sets.push('disabled_reason = NULL, consecutive_failures = 0, failing_since = NULL');
    }
    if (sets.length === 0) return;
    await execute(`UPDATE webhook_subscriptions SET ${sets.join(', ')} WHERE shop_id = ? AND id = ?`, [...params, shopId(), id], exec);
  },

  async setSecret(id: number, secretCiphertext: string, exec?: Executor): Promise<void> {
    await execute('UPDATE webhook_subscriptions SET secret_ciphertext = ? WHERE shop_id = ? AND id = ?', [secretCiphertext, shopId(), id], exec);
  },

  async remove(id: number, exec?: Executor): Promise<boolean> {
    const result = await execute('DELETE FROM webhook_subscriptions WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
    return result.affectedRows === 1;
  },

  async disableForApp(appId: number, reason: string, exceptTopic?: string, exec?: Executor): Promise<void> {
    await execute(
      `UPDATE webhook_subscriptions SET status = 'disabled', disabled_reason = ?
        WHERE shop_id = ? AND app_id = ? ${exceptTopic ? 'AND topic <> ?' : ''}`,
      exceptTopic ? [reason, shopId(), appId, exceptTopic] : [reason, shopId(), appId],
      exec,
    );
  },

  async deleteForApp(appId: number, exec?: Executor): Promise<number> {
    const result = await execute('DELETE FROM webhook_subscriptions WHERE shop_id = ? AND app_id = ?', [shopId(), appId], exec);
    return result.affectedRows;
  },

  async recordSuccess(id: number, exec?: Executor): Promise<void> {
    await execute(
      `UPDATE webhook_subscriptions
          SET consecutive_failures = 0, failing_since = NULL, last_success_at = NOW()
        WHERE shop_id = ? AND id = ?`,
      [shopId(), id],
      exec,
    );
  },

  /** Returns how long the endpoint has been failing without a single success. */
  async recordFailure(id: number, exec?: Executor): Promise<{ failingForMs: number; consecutive: number }> {
    await execute(
      `UPDATE webhook_subscriptions
          SET consecutive_failures = consecutive_failures + 1,
              failing_since = COALESCE(failing_since, NOW()),
              last_failure_at = NOW()
        WHERE shop_id = ? AND id = ?`,
      [shopId(), id],
      exec,
    );
    const row = await queryOne<RowDataPacket>(
      `SELECT consecutive_failures, TIMESTAMPDIFF(SECOND, failing_since, NOW()) AS failing_for
         FROM webhook_subscriptions WHERE shop_id = ? AND id = ?`,
      [shopId(), id],
      exec,
    );
    return { failingForMs: Number(row?.failing_for ?? 0) * 1000, consecutive: Number(row?.consecutive_failures ?? 0) };
  },

  async disable(id: number, reason: string, exec?: Executor): Promise<void> {
    await execute(
      `UPDATE webhook_subscriptions SET status = 'disabled', disabled_reason = ? WHERE shop_id = ? AND id = ?`,
      [reason.slice(0, 255), shopId(), id],
      exec,
    );
  },

  async insertDelivery(
    data: {
      subscriptionId: number;
      eventId: number;
      eventUuid: string;
      topic: string;
      attempt: number;
      status: 'succeeded' | 'failed';
      responseStatus: number | null;
      responseBody: string | null;
      error: string | null;
      durationMs: number;
    },
    exec?: Executor,
  ): Promise<number> {
    return insert(
      `INSERT INTO webhook_deliveries
         (shop_id, subscription_id, event_id, event_uuid, topic, attempt, status, response_status, response_body, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        data.subscriptionId,
        data.eventId,
        data.eventUuid,
        data.topic,
        data.attempt,
        data.status,
        data.responseStatus,
        data.responseBody?.slice(0, 1024) ?? null,
        data.error?.slice(0, 500) ?? null,
        data.durationMs,
      ],
      exec,
    );
  },

  async listDeliveries(subscriptionId: number, limit: number, exec?: Executor): Promise<DeliveryRow[]> {
    return query<DeliveryRow>(
      `SELECT * FROM webhook_deliveries WHERE shop_id = ? AND subscription_id = ? ORDER BY id DESC LIMIT ?`,
      [shopId(), subscriptionId, limit],
      exec,
    );
  },
};
