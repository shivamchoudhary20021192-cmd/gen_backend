import { randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../../modules/auth/auth.types';
import { LATEST_API_VERSION, isSupportedApiVersion } from '../api/versions';
import { appsRepository } from '../apps/apps.repository';
import { clientSecretOf } from '../apps/apps.service';
import { normaliseScopes } from '../apps/scopes';
import { loadEvent } from '../events/dispatcher';
import type { DomainEvent } from '../events/subscribers';
import { allTopics, topicDefinition } from '../events/topics';
import { jobQueue } from '../jobs/queue';
import { defineJob, PermanentJobError } from '../jobs/registry';
import { metrics } from '../observability/metrics';
import { staffNotifier } from '../notifications/staffNotifier';
import { entitlements } from '../plans/entitlements';
import { assertAcceptableUrl, safeRequest, UnsafeTargetError } from '../security/safeHttp';
import { vault } from '../security/vault';
import { tenancy, type ShopContext } from '../tenancy/context';
import { newSigningSecret, signWebhook } from './signing';
import { webhooksRepository, type SubscriptionRow } from './webhooks.repository';

/**
 * Outbound webhooks: subscriptions, delivery, and the failure policy.
 *
 * Delivery contract (what an app author can rely on):
 *   - POST, JSON body, signed: X-Veylog-Hmac-Sha256 = base64 HMAC-SHA256.
 *   - At least once. X-Veylog-Event-Id is the same on every retry and across
 *     subscriptions; de-duplicate on it.
 *   - A 2xx within 5 seconds is success. Anything else is retried with
 *     exponential backoff for about 48 hours (19 attempts).
 *   - 410 Gone removes the subscription immediately.
 *   - An endpoint failing continuously for 48 hours is disabled, and the
 *     shop's staff are told.
 */

const FAILURE_WINDOW_MS = 48 * 3600_000;

export function webhookBackoff(attempt: number): number {
  const base = 10_000 * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, 6 * 3600_000);
  return capped + Math.round(Math.random() * Math.min(capped * 0.1, 60_000));
}

function presentSubscription(row: SubscriptionRow) {
  return {
    id: row.public_id,
    topic: row.topic,
    address: row.address,
    api_version: row.api_version,
    include_fields: row.include_fields ? (typeof row.include_fields === 'string' ? JSON.parse(row.include_fields) : row.include_fields) : null,
    owner: row.app_id ? 'app' : 'shop',
    status: row.status,
    disabled_reason: row.disabled_reason,
    consecutive_failures: row.consecutive_failures,
    last_success_at: row.last_success_at?.toISOString() ?? null,
    last_failure_at: row.last_failure_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

/** Which app, if any, a request speaks for — apps only ever see their own subscriptions. */
function ownerOf(principal: AuthenticatedAdmin): number | null {
  return principal.kind === 'app' ? principal.app!.appId : null;
}

async function secretFor(subscription: SubscriptionRow): Promise<string> {
  if (subscription.app_id) {
    const app = await appsRepository.findById(Number(subscription.app_id));
    if (!app) throw new PermanentJobError('The app that owns this subscription no longer exists.');
    return clientSecretOf(app);
  }
  if (!subscription.secret_ciphertext) throw new PermanentJobError('Subscription has no signing secret.');
  return vault.open(subscription.secret_ciphertext, `webhook:${subscription.public_id}`);
}

function filterFields(payload: Record<string, unknown>, includeFields: unknown): Record<string, unknown> {
  const fields = includeFields ? ((typeof includeFields === 'string' ? JSON.parse(includeFields) : includeFields) as string[]) : null;
  if (!fields || fields.length === 0) return payload;
  return Object.fromEntries(Object.entries(payload).filter(([key]) => fields.includes(key)));
}

export interface DeliveryAttempt {
  ok: boolean;
  status: number | null;
  body: string | null;
  error: string | null;
  durationMs: number;
}

/** Signs and POSTs one payload. Never throws; the caller decides what a failure means. */
export async function postSigned(
  shop: ShopContext,
  target: { address: string; topic: string; apiVersion: string; eventUuid: string; webhookId: string; occurredAt: Date; attempt: number },
  body: string,
  secret: string,
): Promise<DeliveryAttempt> {
  const started = Date.now();
  try {
    const response = await safeRequest({
      url: target.address,
      method: 'POST',
      body,
      timeoutMs: env.webhooks.timeoutMs,
      allowPrivate: env.webhooks.allowPrivateTargets,
      maxResponseBytes: 2048,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `${env.platform.name}-Webhooks/1.0`,
        'X-Veylog-Topic': target.topic,
        'X-Veylog-Hmac-Sha256': signWebhook(body, secret),
        'X-Veylog-Shop-Domain': `${shop.handle}.${env.platform.storefrontDomain}`,
        'X-Veylog-Shop-Id': shop.publicId,
        'X-Veylog-Api-Version': target.apiVersion,
        'X-Veylog-Webhook-Id': target.webhookId,
        'X-Veylog-Event-Id': target.eventUuid,
        'X-Veylog-Triggered-At': target.occurredAt.toISOString(),
        'X-Veylog-Delivery-Attempt': String(target.attempt),
      },
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      body: response.body,
      error: null,
      durationMs: response.durationMs,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      body: null,
      error: error instanceof UnsafeTargetError ? `Refused: ${error.message}` : error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }
}

async function deliver(subscription: SubscriptionRow, event: DomainEvent, attempt: number): Promise<DeliveryAttempt> {
  const shop = tenancy.current();
  const body = JSON.stringify(filterFields(event.payload, subscription.include_fields));
  const result = await postSigned(
    shop,
    {
      address: subscription.address,
      topic: event.topic,
      apiVersion: subscription.api_version,
      eventUuid: event.uuid,
      webhookId: `${event.uuid}.${subscription.public_id}`,
      occurredAt: event.occurredAt,
      attempt,
    },
    body,
    await secretFor(subscription),
  );

  await webhooksRepository.insertDelivery({
    subscriptionId: Number(subscription.id),
    eventId: event.id,
    eventUuid: event.uuid,
    topic: event.topic,
    attempt,
    status: result.ok ? 'succeeded' : 'failed',
    responseStatus: result.status,
    responseBody: result.body,
    error: result.error,
    durationMs: result.durationMs,
  });
  metrics.counter('webhook_deliveries_total', { topic: event.topic, outcome: result.ok ? 'succeeded' : 'failed' }).inc();
  metrics.histogram('webhook_delivery_seconds').observe(result.durationMs / 1000);
  return result;
}

async function disableAndTell(subscription: SubscriptionRow, reason: string): Promise<void> {
  await webhooksRepository.disable(Number(subscription.id), reason);
  await staffNotifier.notify({
    type: 'webhooks.subscription_disabled',
    severity: 'warning',
    title: `Webhook for ${subscription.topic} was turned off`,
    body: `${subscription.address} — ${reason}`,
    linkUrl: '/settings/notifications/webhooks',
    entityType: 'webhook_subscription',
    entityId: Number(subscription.id),
  });
  logger.warn('webhooks.subscription_disabled', { subscription_id: subscription.id, topic: subscription.topic, reason });
}

export const webhooksService = {
  topics(principal: AuthenticatedAdmin) {
    const granted = principal.kind === 'app' ? normaliseScopes(principal.app!.scopes).scopes : null;
    return allTopics()
      .filter((topic) => !topic.compliance)
      .map((topic) => ({
        topic: topic.topic,
        description: topic.description,
        required_scope: topic.requiredScope,
        available: granted === null || topic.requiredScope === null || granted.includes(topic.requiredScope),
      }));
  },

  async list(principal: AuthenticatedAdmin) {
    const rows = await webhooksRepository.list({ appId: ownerOf(principal) });
    return rows.map(presentSubscription);
  },

  async get(principal: AuthenticatedAdmin, publicId: string): Promise<SubscriptionRow> {
    const row = await webhooksRepository.findByPublicId(publicId);
    if (!row || (row.app_id ?? null) !== ownerOf(principal)) throw ApiError.notFound('Webhook subscription');
    return row;
  },

  async show(principal: AuthenticatedAdmin, publicId: string) {
    return presentSubscription(await this.get(principal, publicId));
  },

  async create(
    principal: AuthenticatedAdmin,
    input: { topic: string; address: string; api_version?: string; include_fields?: string[] | null },
  ) {
    const definition = topicDefinition(input.topic);
    if (!definition || definition.compliance) throw ApiError.validation({ topic: [`${input.topic} is not a topic you can subscribe to.`] });

    if (principal.kind === 'app' && definition.requiredScope) {
      const granted = normaliseScopes(principal.app!.scopes).scopes;
      if (!granted.includes(definition.requiredScope)) throw ApiError.insufficientScope([definition.requiredScope]);
    }

    const apiVersion = input.api_version ?? LATEST_API_VERSION;
    if (!isSupportedApiVersion(apiVersion)) throw ApiError.validation({ api_version: [`${apiVersion} is not a supported API version.`] });

    try {
      assertAcceptableUrl(input.address, env.webhooks.allowPrivateTargets);
    } catch (error) {
      throw ApiError.validation({ address: [error instanceof Error ? error.message : 'Invalid address.'] });
    }

    await entitlements.assertWithinLimit('webhook_subscriptions', await webhooksRepository.countActive());

    const appId = ownerOf(principal);
    let secret: string | null = null;
    let sealed: string | null = null;
    if (appId === null) secret = newSigningSecret();

    let row = await webhooksRepository.upsert({
      appId,
      topic: input.topic,
      address: input.address,
      apiVersion,
      includeFields: input.include_fields ?? null,
      secretCiphertext: null,
      createdByAdminId: principal.kind === 'staff' ? principal.id : null,
    });

    // Staff subscriptions sign with their own secret, sealed against their own
    // public id — known only now that the row exists.
    if (secret) {
      if (row.secret_ciphertext) {
        secret = null; // an existing subscription keeps the secret it already has
      } else {
        sealed = vault.seal(secret, `webhook:${row.public_id}`);
        await webhooksRepository.setSecret(Number(row.id), sealed);
        row = (await webhooksRepository.findById(Number(row.id)))!;
      }
    }

    await auditService.log({
      actorId: principal.id,
      actorLabel: principal.kind === 'app' ? principal.app!.name : principal.email,
      action: 'webhook.subscribed',
      entityType: 'webhook_subscription',
      entityId: Number(row.id),
      summary: `${input.topic} → ${input.address}`,
    });

    return { webhook: presentSubscription(row), ...(secret ? { signing_secret: secret } : {}) };
  },

  async update(
    principal: AuthenticatedAdmin,
    publicId: string,
    input: { address?: string; api_version?: string; include_fields?: string[] | null; status?: 'active' | 'disabled' },
  ) {
    const row = await this.get(principal, publicId);
    if (input.address !== undefined) {
      try {
        assertAcceptableUrl(input.address, env.webhooks.allowPrivateTargets);
      } catch (error) {
        throw ApiError.validation({ address: [error instanceof Error ? error.message : 'Invalid address.'] });
      }
    }
    if (input.api_version !== undefined && !isSupportedApiVersion(input.api_version)) {
      throw ApiError.validation({ api_version: [`${input.api_version} is not a supported API version.`] });
    }
    await webhooksRepository.update(Number(row.id), input);
    return presentSubscription((await webhooksRepository.findById(Number(row.id)))!);
  },

  async remove(principal: AuthenticatedAdmin, publicId: string): Promise<void> {
    const row = await this.get(principal, publicId);
    await webhooksRepository.remove(Number(row.id));
    await auditService.log({
      actorId: principal.id,
      actorLabel: principal.kind === 'app' ? principal.app!.name : principal.email,
      action: 'webhook.unsubscribed',
      entityType: 'webhook_subscription',
      entityId: Number(row.id),
      summary: `${row.topic} → ${row.address}`,
    });
  },

  async revealSecret(principal: AuthenticatedAdmin, publicId: string): Promise<string> {
    const row = await this.get(principal, publicId);
    if (!row.secret_ciphertext) throw ApiError.conflict('App subscriptions are signed with the app’s client secret.');
    return vault.open(row.secret_ciphertext, `webhook:${row.public_id}`);
  },

  async deliveries(principal: AuthenticatedAdmin, publicId: string, limit = 50) {
    const row = await this.get(principal, publicId);
    const rows = await webhooksRepository.listDeliveries(Number(row.id), Math.min(limit, 200));
    return rows.map((delivery) => ({
      id: delivery.id,
      event_id: delivery.event_uuid,
      topic: delivery.topic,
      attempt: delivery.attempt,
      status: delivery.status,
      response_status: delivery.response_status,
      response_body: delivery.response_body,
      error: delivery.error,
      duration_ms: delivery.duration_ms,
      created_at: delivery.created_at.toISOString(),
    }));
  },

  /** Sends a signed sample right now and reports what the endpoint said. */
  async test(principal: AuthenticatedAdmin, publicId: string) {
    const row = await this.get(principal, publicId);
    const shop = tenancy.current();
    const event: DomainEvent = {
      id: 0,
      uuid: randomUUID(),
      shopId: shop.id,
      topic: row.topic,
      resourceType: null,
      resourceId: null,
      payload: { test: true, topic: row.topic, shop: { id: shop.publicId, name: shop.name }, sent_at: new Date().toISOString() },
      actorType: 'admin',
      actorId: principal.id,
      occurredAt: new Date(),
    };
    const result = await deliver(row, event, 1);
    return { ok: result.ok, response_status: result.status, response_body: result.body, error: result.error, duration_ms: result.durationMs };
  },
};

// ── jobs ──────────────────────────────────────────────────────────────────────

defineJob<{ subscription_id: number; event_id: number }>({
  type: 'webhooks.deliver',
  queue: 'webhooks',
  shopScoped: true,
  maxAttempts: 19,
  backoff: webhookBackoff,
  timeoutMs: 30_000,
  async handler(payload, context) {
    const subscription = await webhooksRepository.findById(payload.subscription_id);
    // Deleted or switched off since the event was published: nothing to do.
    if (!subscription || subscription.status !== 'active') return;
    const event = await loadEvent(payload.event_id);
    if (!event) throw new PermanentJobError(`Event ${payload.event_id} no longer exists.`);

    const result = await deliver(subscription, event, context.attempt);

    if (result.ok) {
      await webhooksRepository.recordSuccess(Number(subscription.id));
      if (event.topic === 'app/uninstalled' && subscription.app_id) {
        await webhooksRepository.remove(Number(subscription.id));
      }
      return;
    }

    if (result.status === 410) {
      await disableAndTell(subscription, 'The endpoint answered 410 Gone.');
      return;
    }

    const failure = await webhooksRepository.recordFailure(Number(subscription.id));
    if (failure.failingForMs >= FAILURE_WINDOW_MS) {
      await disableAndTell(subscription, 'It has failed every delivery for 48 hours.');
      throw new PermanentJobError('Subscription disabled after 48 hours of failures.');
    }
    throw new Error(result.error ?? `Endpoint answered ${result.status}`);
  },
});

/**
 * Privacy requests to every installed app's compliance endpoint. One job per
 * app, so one app's broken endpoint does not hold up another's.
 */
defineJob<{ event_id: number }>({
  type: 'apps.deliver_compliance',
  queue: 'webhooks',
  shopScoped: true,
  maxAttempts: 5,
  async handler(payload) {
    const event = await loadEvent(payload.event_id);
    if (!event) return;
    for (const installation of await appsRepository.listInstallations()) {
      await jobQueue.enqueue(
        'apps.deliver_compliance_one',
        { event_id: payload.event_id, app_id: Number(installation.app_id) },
        { queue: 'webhooks', maxAttempts: 19, uniqueKey: `compliance:${event.uuid}:${installation.app_id}` },
      );
    }
  },
});

defineJob<{ event_id: number; app_id: number }>({
  type: 'apps.deliver_compliance_one',
  queue: 'webhooks',
  shopScoped: true,
  maxAttempts: 19,
  backoff: webhookBackoff,
  async handler(payload, context) {
    const app = await appsRepository.findById(payload.app_id);
    if (!app?.compliance_webhook_url) return;
    const event = await loadEvent(payload.event_id);
    if (!event) return;
    const result = await postSigned(
      tenancy.current(),
      {
        address: app.compliance_webhook_url,
        topic: event.topic,
        apiVersion: app.webhook_api_version,
        eventUuid: event.uuid,
        webhookId: `${event.uuid}.${app.public_id}`,
        occurredAt: event.occurredAt,
        attempt: context.attempt,
      },
      JSON.stringify(event.payload),
      clientSecretOf(app),
    );
    if (!result.ok) throw new Error(result.error ?? `Compliance endpoint answered ${result.status}`);
  },
});
