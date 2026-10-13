import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import { ShopScopedCache } from '../cache/shopCache';
import { entitlements } from '../plans/entitlements';
import { vault } from '../security/vault';
import { tenancy } from '../tenancy/context';
import { connectionsRepository, type ConnectionRow } from './connections.repository';
import { ProviderHttpError } from './http';
import { catalog, providerManifest } from './registry';
import type { AnyProviderManifest, ConnectionContext, IntegrationCategory } from './types';

/**
 * Connecting, testing and using third-party accounts.
 *
 * Credentials enter through `connect`/`update`, are checked against the
 * provider before they are stored (a typo is caught on the settings screen,
 * not at the first checkout), and are sealed with the vault bound to this shop
 * and this connection — a sealed value copied into another shop's row does not
 * open. Nothing that leaves this module carries a secret except `context()`,
 * which hands an adapter what it needs and is never serialised.
 */

export interface Actor {
  id: number | null;
  label: string | null;
}

const contexts = new ShopScopedCache<ConnectionContext>(60_000);

function aad(publicId: string): string {
  return `integration:${tenancy.current().id}:${publicId}`;
}

function parseConfig(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
}

/** Where a provider should send its webhooks and status callbacks for this connection. */
export function inboundUrlFor(connectionPublicId: string): string {
  const shop = tenancy.current();
  return `${env.platform.publicApiUrl}/integrations/inbound/${shop.publicId}/${connectionPublicId}`;
}

function requireManifest(key: string): AnyProviderManifest {
  const manifest = providerManifest(key);
  if (!manifest) throw ApiError.badRequest(`Unknown provider "${key}".`);
  return manifest;
}

/** Keeps only declared fields, trims them, and enforces required and pattern rules. */
function cleanCredentials(
  manifest: AnyProviderManifest,
  input: Record<string, unknown>,
  previous: Record<string, string> | null,
): Record<string, string> {
  const errors: Record<string, string[]> = {};
  const clean: Record<string, string> = {};
  for (const field of manifest.credentialFields) {
    const raw = input[field.key];
    const given = typeof raw === 'string' ? raw.trim() : raw === undefined || raw === null ? '' : String(raw).trim();
    // On update, an omitted secret keeps the stored one: the form never gets
    // secrets back, so it cannot resend them.
    const value = given || previous?.[field.key] || '';
    if (!value) {
      if (field.required) errors[`credentials.${field.key}`] = [`${field.label} is required.`];
      continue;
    }
    if (field.pattern && !field.pattern.test(value)) {
      errors[`credentials.${field.key}`] = [`${field.label} does not look right.`];
      continue;
    }
    clean[field.key] = value;
  }
  if (Object.keys(errors).length > 0) throw ApiError.validation(errors, 'Some credentials are missing or malformed.');
  return clean;
}

function cleanConfig(manifest: AnyProviderManifest, input: Record<string, unknown>, previous: Record<string, unknown>) {
  const config: Record<string, unknown> = {};
  const errors: Record<string, string[]> = {};
  for (const field of manifest.configFields ?? []) {
    const value = input[field.key] !== undefined ? input[field.key] : (previous[field.key] ?? field.default);
    if (value === undefined || value === null || value === '') {
      if (field.required) errors[`config.${field.key}`] = [`${field.label} is required.`];
      continue;
    }
    if (field.type === 'boolean') config[field.key] = value === true || value === 'true' || value === 1;
    else if (field.type === 'number') config[field.key] = Number(value);
    else if (field.type === 'select' && field.options && !field.options.some((option) => option.value === value)) {
      errors[`config.${field.key}`] = [`${field.label} must be one of the listed options.`];
    } else config[field.key] = String(value).trim();
  }
  if (Object.keys(errors).length > 0) throw ApiError.validation(errors, 'Some settings are missing or invalid.');
  return config;
}

function present(row: ConnectionRow) {
  const manifest = providerManifest(row.provider);
  return {
    id: row.public_id,
    provider: row.provider,
    provider_name: manifest?.name ?? row.provider,
    category: row.category,
    channels: manifest?.channels ?? null,
    name: row.name,
    status: row.status,
    mode: row.mode,
    is_default: row.is_default === 1,
    credentials_hint: row.credentials_hint,
    config: parseConfig(row.config),
    inbound_url: manifest?.inbound ? inboundUrlFor(row.public_id) : null,
    last_verified_at: row.last_verified_at,
    last_used_at: row.last_used_at,
    last_error: row.last_error,
    available: Boolean(manifest),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function verifyOrThrow(manifest: AnyProviderManifest, context: ConnectionContext) {
  try {
    const result = await manifest.verify(context);
    if (!result.ok) {
      throw ApiError.validation(
        { credentials: [result.message ?? `${manifest.name} did not accept these credentials.`] },
        result.message ?? `${manifest.name} did not accept these credentials.`,
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof ProviderHttpError) {
      if (error.retryable) throw ApiError.upstream(`${manifest.name} could not be reached to check the credentials. Try again.`);
      throw ApiError.validation({ credentials: [error.message] }, `${manifest.name} did not accept these credentials.`);
    }
    throw error;
  }
}

export const connectionsService = {
  catalog() {
    return { providers: catalog(tenancy.current().countryCode) };
  },

  async list() {
    const rows = await connectionsRepository.list();
    return { connections: rows.map(present) };
  },

  async get(publicId: string) {
    const row = await connectionsRepository.byPublicId(publicId);
    if (!row) throw ApiError.notFound('Integration');
    const recent = await connectionsRepository.recentInbound(row.id, 20);
    return {
      connection: present(row),
      recent_webhooks: recent.map((event) => ({
        id: event.id,
        type: event.event_type,
        external_id: event.external_id,
        signature_valid: event.signature_valid === 1,
        status: event.status,
        error: event.error,
        received_at: event.received_at,
        processed_at: event.processed_at,
      })),
    };
  },

  async connect(
    input: {
      provider: string;
      name?: string;
      credentials: Record<string, unknown>;
      config?: Record<string, unknown>;
      make_default?: boolean;
    },
    actor: Actor,
  ) {
    await entitlements.assertFeature('third_party_integrations');
    const manifest = requireManifest(input.provider);
    const credentials = cleanCredentials(manifest, input.credentials ?? {}, null);
    const config = cleanConfig(manifest, input.config ?? {}, {});
    const publicId = randomUUID();
    const name = (input.name ?? '').trim() || manifest.name;

    const verified = await verifyOrThrow(manifest, {
      shopId: tenancy.current().id,
      connectionId: 0,
      publicId,
      provider: manifest.key,
      name,
      mode: manifest.detectMode?.(credentials) ?? 'live',
      credentials,
      config,
      inboundUrl: inboundUrlFor(publicId),
    });
    const mode = verified.mode ?? manifest.detectMode?.(credentials) ?? 'live';

    const id = await withTransaction(async (tx) => {
      const existingInCategory = await connectionsRepository.countInCategory(manifest.category, tx);
      const connectionId = await connectionsRepository.create(
        {
          publicId,
          provider: manifest.key,
          category: manifest.category,
          name,
          mode,
          credentialsSealed: vault.sealJson(credentials, aad(publicId)),
          credentialsHint: [manifest.hint(credentials), verified.accountLabel].filter(Boolean).join(' · ').slice(0, 160),
          config,
          adminId: actor.id,
        },
        tx,
      );
      // The first connection in a category becomes its default: a shop that
      // connects one SMS provider expects SMS to go through it.
      if (input.make_default || existingInCategory === 0) {
        await connectionsRepository.makeDefault(connectionId, manifest.category, tx);
      }
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.label,
          action: 'integration.connected',
          entityType: 'integration_connection',
          entityId: connectionId,
          summary: `Connected ${manifest.name} (${mode})`,
          context: { provider: manifest.key, category: manifest.category },
        },
        tx,
      );
      return connectionId;
    });

    logger.info('integrations.connected', { provider: manifest.key, category: manifest.category, mode });
    return this.get((await connectionsRepository.byId(id))!.public_id);
  },

  async update(
    publicId: string,
    input: {
      name?: string;
      credentials?: Record<string, unknown>;
      config?: Record<string, unknown>;
      status?: 'active' | 'disabled';
    },
    actor: Actor,
  ) {
    const row = await connectionsRepository.byPublicId(publicId);
    if (!row) throw ApiError.notFound('Integration');
    const manifest = requireManifest(row.provider);

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name.trim() || manifest.name;
    if (input.status !== undefined) patch.status = input.status;

    const previousConfig = parseConfig(row.config);
    const config = input.config ? cleanConfig(manifest, input.config, previousConfig) : previousConfig;
    if (input.config) patch.config = JSON.stringify(config);

    if (input.credentials && Object.keys(input.credentials).length > 0) {
      const previous = row.credentials_sealed
        ? vault.openJson<Record<string, string>>(row.credentials_sealed, aad(row.public_id))
        : null;
      const credentials = cleanCredentials(manifest, input.credentials, previous);
      const verified = await verifyOrThrow(manifest, {
        shopId: tenancy.current().id,
        connectionId: row.id,
        publicId: row.public_id,
        provider: row.provider,
        name: row.name,
        mode: row.mode,
        credentials,
        config,
        inboundUrl: inboundUrlFor(row.public_id),
      });
      patch.credentials_sealed = vault.sealJson(credentials, aad(row.public_id));
      patch.credentials_hint = [manifest.hint(credentials), verified.accountLabel].filter(Boolean).join(' · ').slice(0, 160);
      patch.mode = verified.mode ?? manifest.detectMode?.(credentials) ?? 'live';
      patch.last_verified_at = new Date();
      patch.last_error = null;
      if (row.status === 'error') patch.status = 'active';
    }

    await withTransaction(async (tx) => {
      await connectionsRepository.update(row.id, patch, tx);
      if (patch.status === 'disabled' && row.is_default === 1) {
        await connectionsRepository.update(row.id, { is_default: 0 }, tx);
      }
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.label,
          action: 'integration.updated',
          entityType: 'integration_connection',
          entityId: row.id,
          summary: `Updated ${manifest.name}`,
          // Which fields changed, never their values.
          changes: {
            fields: Object.keys(patch).filter((key) => key !== 'credentials_sealed'),
            credentials_rotated: Boolean(patch.credentials_sealed),
          },
        },
        tx,
      );
    });
    contexts.clear();
    return this.get(publicId);
  },

  /** Re-checks stored credentials against the provider. */
  async test(publicId: string) {
    const row = await connectionsRepository.byPublicId(publicId);
    if (!row) throw ApiError.notFound('Integration');
    const manifest = requireManifest(row.provider);
    const context = await this.context(row);
    try {
      const result = await manifest.verify(context);
      await connectionsRepository.update(row.id, {
        last_verified_at: result.ok ? new Date() : row.last_verified_at,
        last_error: result.ok ? null : (result.message ?? 'Verification failed.').slice(0, 500),
        status: result.ok ? (row.status === 'error' ? 'active' : row.status) : 'error',
      });
      contexts.clear();
      return { ok: result.ok, message: result.message ?? null, account: result.accountLabel ?? null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await connectionsRepository.update(row.id, { last_error: message.slice(0, 500) });
      return { ok: false, message, account: null };
    }
  },

  async setDefault(publicId: string, actor: Actor) {
    const row = await connectionsRepository.byPublicId(publicId);
    if (!row) throw ApiError.notFound('Integration');
    if (row.status !== 'active') throw ApiError.conflict('Only an active connection can be the default.');
    await withTransaction(async (tx) => {
      await connectionsRepository.makeDefault(row.id, row.category, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.label,
          action: 'integration.default_changed',
          entityType: 'integration_connection',
          entityId: row.id,
          summary: `${row.name} is now the default ${row.category} provider`,
        },
        tx,
      );
    });
    return this.get(publicId);
  },

  async disconnect(publicId: string, actor: Actor) {
    const row = await connectionsRepository.byPublicId(publicId);
    if (!row) throw ApiError.notFound('Integration');
    await withTransaction(async (tx) => {
      await connectionsRepository.remove(row.id, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.label,
          action: 'integration.disconnected',
          entityType: 'integration_connection',
          entityId: row.id,
          summary: `Disconnected ${row.name}`,
          context: { provider: row.provider },
        },
        tx,
      );
    });
    contexts.clear();
    return { disconnected: true };
  },

  // ── for adapters ───────────────────────────────────────────────────────────

  /** Opens a connection's credentials. Cached per shop for a minute. */
  async context(row: ConnectionRow): Promise<ConnectionContext> {
    return contexts.get(`connection:${row.id}:${new Date(row.updated_at).getTime()}`, async () => ({
      shopId: tenancy.current().id,
      connectionId: row.id,
      publicId: row.public_id,
      provider: row.provider,
      name: row.name,
      mode: row.mode,
      credentials: row.credentials_sealed
        ? vault.openJson<Record<string, string>>(row.credentials_sealed, aad(row.public_id))
        : {},
      config: parseConfig(row.config),
      inboundUrl: inboundUrlFor(row.public_id),
    }));
  },

  /** The default connection for a category, opened, with its manifest. */
  async resolveDefault(category: IntegrationCategory) {
    const row = await connectionsRepository.defaultFor(category);
    if (!row) return null;
    const manifest = providerManifest(row.provider);
    if (!manifest) return null;
    return { row, manifest, context: await this.context(row) };
  },

  /** The shop's active connection for a named provider. */
  async resolveProvider(provider: string) {
    const row = await connectionsRepository.activeForProvider(provider);
    if (!row) return null;
    const manifest = providerManifest(row.provider);
    if (!manifest) return null;
    return { row, manifest, context: await this.context(row) };
  },

  /** Records the outcome of using a connection, so the settings screen can show it. */
  async recordUse(connectionId: number, error: string | null): Promise<void> {
    await connectionsRepository.touch(connectionId, error).catch(() => undefined);
  },

  invalidate(): void {
    contexts.clear();
  },
};
