import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { env } from '../../config/env';
import { logger } from '../../core/logger';
import { rateLimit } from '../../middleware/rateLimit';
import { jobQueue } from '../jobs/queue';
import { defineJob, PermanentJobError } from '../jobs/registry';
import { metrics } from '../observability/metrics';
import { shopDirectory } from '../shops/shopDirectory';
import { tenancy } from '../tenancy/context';
import { connectionsRepository, type ConnectionRow, type InboundEventRow } from './connections.repository';
import { connectionsService } from './connections.service';
import { providerManifest } from './registry';
import { InboundSignatureError, type InboundEvent, type InboundRequest } from './types';

/**
 * Webhooks and status callbacks from providers.
 *
 * Every connection has its own URL:
 *
 *   POST {PUBLIC_API_URL}/integrations/inbound/{shop public id}/{connection public id}
 *
 * which names the shop and the connection, so the verifier knows exactly which
 * secret to check against before believing anything in the body. The pipeline:
 *
 *   1. find the shop and the connection (404 for either, same response);
 *   2. the provider verifies the signature over the exact bytes received and
 *      translates the payload into platform events (payment.captured…);
 *   3. each event is stored once — the provider's event id is unique per shop,
 *      so retries of the same delivery are acknowledged and dropped;
 *   4. processing is a job, so the provider gets its 200 in milliseconds and a
 *      slow handler never causes a retry storm.
 *
 * Handlers subscribe by platform event type with `onInboundEvent`; one handler
 * serves every gateway that emits that type.
 */

export interface InboundContext {
  event: InboundEventRow;
  data: Record<string, unknown>;
  connection: ConnectionRow | null;
}

export type InboundOutcome = 'processed' | 'ignored';
type Handler = (context: InboundContext) => Promise<InboundOutcome>;

const handlers = new Map<string, Handler[]>();

export function onInboundEvent(type: string, handler: Handler): void {
  handlers.set(type, [...(handlers.get(type) ?? []), handler]);
}

function headersOf(req: Request): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
  }
  return out;
}

function queryOf(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.query)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

async function locate(req: Request) {
  const { shop: shopRef, connection: connectionRef } = req.params as { shop: string; connection: string };
  if (!/^[0-9a-f-]{36}$/i.test(shopRef) || !/^[0-9a-f-]{36}$/i.test(connectionRef)) return null;
  const shop = await shopDirectory.byPublicId(shopRef);
  if (!shop || shop.status === 'closed') return null;
  return { shop, connectionRef };
}

async function enqueueProcessing(eventId: number): Promise<void> {
  await jobQueue.enqueue(
    'integrations.process_inbound',
    { event_id: eventId },
    { queue: 'integrations', maxAttempts: 12, uniqueKey: `inbound:${tenancy.current().id}:${eventId}` },
  );
}

export const inboundRoutes = Router();

const inboundLimit = rateLimit({ bucket: 'integrations.inbound', max: 1200, windowSeconds: 60 });

inboundRoutes.get('/inbound/:shop/:connection', inboundLimit, async (req: Request, res: Response) => {
  try {
    const located = await locate(req);
    if (!located) return void res.status(404).json({ error: 'not_found' });
    await tenancy.run(located.shop, async () => {
      const connection = await connectionsRepository.byPublicId(located.connectionRef);
      const manifest = connection ? providerManifest(connection.provider) : undefined;
      if (!connection || !manifest?.inbound?.handshake) return void res.status(404).json({ error: 'not_found' });
      const answer = manifest.inbound.handshake(queryOf(req), await connectionsService.context(connection));
      if (answer === null) return void res.status(403).json({ error: 'forbidden' });
      res.status(200).type('text/plain').send(answer);
    });
  } catch (error) {
    logger.error('integrations.handshake_failed', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'server_error' });
  }
});

inboundRoutes.post('/inbound/:shop/:connection', inboundLimit, async (req: Request, res: Response) => {
  try {
    const located = await locate(req);
    if (!located) return void res.status(404).json({ error: 'not_found' });

    await tenancy.run(located.shop, async () => {
      const connection = await connectionsRepository.byPublicId(located.connectionRef);
      const manifest = connection ? providerManifest(connection.provider) : undefined;
      if (!connection || !manifest?.inbound) return void res.status(404).json({ error: 'not_found' });

      const rawBody = req.rawBody ?? Buffer.alloc(0);
      const request: InboundRequest = {
        method: req.method,
        // The URL as the provider was given it, which is what Twilio signs.
        url: `${env.platform.publicApiUrl}${req.originalUrl}`,
        rawBody,
        headers: headersOf(req),
        query: queryOf(req),
      };

      let events: InboundEvent[];
      try {
        events = await manifest.inbound.verify(request, await connectionsService.context(connection));
      } catch (error) {
        const rejected = error instanceof InboundSignatureError;
        metrics.counter('integration_webhooks_total', { provider: connection.provider, outcome: rejected ? 'rejected' : 'error' }).inc();
        await connectionsRepository.recordInbound({
          connectionId: connection.id,
          provider: connection.provider,
          externalId: `rejected:${createHash('sha256').update(rawBody).digest('hex')}`,
          eventType: null,
          signatureValid: false,
          payload: null,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        logger.warn('integrations.webhook_rejected', { provider: connection.provider, reason: rejected ? 'signature' : 'parse' });
        return void res.status(rejected ? 401 : 400).json({ error: rejected ? 'invalid_signature' : 'invalid_payload' });
      }

      let accepted = 0;
      for (const event of events) {
        const eventId = await connectionsRepository.recordInbound({
          connectionId: connection.id,
          provider: connection.provider,
          externalId: event.externalId,
          eventType: event.type,
          signatureValid: true,
          payload: { provider_type: event.providerType, data: event.data },
          status: 'received',
        });
        if (eventId === null) continue; // a retry of something already stored
        accepted += 1;
        await enqueueProcessing(eventId).catch((enqueueError) => {
          // Left in 'received'; the maintenance sweep re-enqueues it.
          logger.error('integrations.enqueue_failed', { event_id: eventId, error: String(enqueueError) });
        });
      }
      metrics.counter('integration_webhooks_total', { provider: connection.provider, outcome: 'accepted' }).inc(accepted);

      const ack = manifest.inbound.acknowledge;
      if (ack) res.status(200).type(ack.contentType).send(ack.body);
      else res.status(200).json({ received: events.length, accepted });
    });
  } catch (error) {
    logger.error('integrations.inbound_failed', { error: error instanceof Error ? error.message : String(error) });
    // A 5xx makes the provider retry, which is what should happen when we failed.
    res.status(500).json({ error: 'server_error' });
  }
});

defineJob<{ event_id: number }>({
  type: 'integrations.process_inbound',
  queue: 'integrations',
  shopScoped: true,
  maxAttempts: 12,
  timeoutMs: 60_000,
  async handler(payload) {
    const event = await connectionsRepository.inboundById(payload.event_id);
    if (!event) throw new PermanentJobError(`Inbound event ${payload.event_id} no longer exists.`);
    if (event.status === 'processed' || event.status === 'ignored') return;

    const stored = (typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload) as {
      data?: Record<string, unknown>;
    } | null;
    const subscribed = handlers.get(event.event_type ?? '') ?? [];
    if (subscribed.length === 0) {
      await connectionsRepository.finishInbound(event.id, 'ignored', null);
      return;
    }

    const connection = event.connection_id ? await connectionsRepository.byId(event.connection_id) : null;
    try {
      let processed = false;
      for (const handler of subscribed) {
        const outcome = await handler({ event, data: stored?.data ?? {}, connection });
        processed ||= outcome === 'processed';
      }
      await connectionsRepository.finishInbound(event.id, processed ? 'processed' : 'ignored', null);
    } catch (error) {
      await connectionsRepository.finishInbound(event.id, 'failed', error instanceof Error ? error.message : String(error));
      throw error;
    }
  },
});
