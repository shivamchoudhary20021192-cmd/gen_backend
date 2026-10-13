import { ApiError } from '../../../core/ApiError';
import { connectionsRepository } from '../../../platform/integrations/connections.repository';
import { connectionsService } from '../../../platform/integrations/connections.service';
import { providerManifest } from '../../../platform/integrations/registry';
import { loadRazorpayCredentials, warnIfLiveKeysAreInTheDatabase, type RazorpayCredentials } from './credentials';
import { RazorpayGateway } from './RazorpayGateway';
import type { PaymentGateway } from './PaymentGateway';

export * from './PaymentGateway';
export * from './signatures';
export { RazorpayGateway } from './RazorpayGateway';
export {
  loadRazorpayCredentials,
  clearCredentialsCache,
  captureMode,
  type RazorpayCredentials,
} from './credentials';

/**
 * Which gateway takes this shop's money.
 *
 * In order:
 *
 *   1. the shop's default `payments` integration — Stripe, Razorpay, PayPal or
 *      whatever the merchant connected under Settings → Integrations;
 *   2. the legacy Razorpay keys (the environment for the founding shop, or the
 *      settings table), so an installation that predates integrations keeps
 *      taking payments without anyone touching it.
 *
 * Returning `null` rather than throwing is deliberate. A shop with no gateway
 * is a normal state — it takes cash on delivery and the storefront hides the
 * online option — and that is a different thing from a gateway that is down.
 */
export interface ResolvedGateway {
  gateway: PaymentGateway;
  testMode: boolean;
  source: 'integration' | 'legacy';
  connectionId: number | null;
  /** Legacy Razorpay only: the credentials the old webhook route verifies with. */
  legacy: RazorpayCredentials | null;
}

async function fromLegacy(): Promise<ResolvedGateway | null> {
  const credentials = await loadRazorpayCredentials();
  if (!credentials) return null;
  warnIfLiveKeysAreInTheDatabase(credentials);
  return {
    gateway: new RazorpayGateway(credentials.keyId, credentials.keySecret, credentials.testMode),
    testMode: credentials.testMode,
    source: 'legacy',
    connectionId: null,
    legacy: credentials,
  };
}

export async function resolveGateway(): Promise<ResolvedGateway | null> {
  const connected = await connectionsService.resolveDefault('payments');
  if (connected?.manifest.payments) {
    return {
      gateway: connected.manifest.payments(connected.context),
      testMode: connected.context.mode === 'test',
      source: 'integration',
      connectionId: connected.row.id,
      legacy: null,
    };
  }
  return fromLegacy();
}

/**
 * The gateway a specific payment went through — for verifying its checkout
 * and for refunding it. A refund must go back through the account that took
 * the money, even if the shop has since made a different gateway its default.
 */
export async function resolveGatewayFor(payment: {
  gateway: string;
  connection_id?: number | null;
}): Promise<ResolvedGateway | null> {
  if (payment.connection_id) {
    const row = await connectionsRepository.byId(payment.connection_id);
    const manifest = row ? providerManifest(row.provider) : undefined;
    if (row && manifest?.payments) {
      const context = await connectionsService.context(row);
      return {
        gateway: manifest.payments(context),
        testMode: context.mode === 'test',
        source: 'integration',
        connectionId: row.id,
        legacy: null,
      };
    }
    return null;
  }
  if (payment.gateway === 'razorpay') {
    const legacy = await fromLegacy();
    if (legacy) return legacy;
  }
  // A payment recorded before connections existed, through a provider that is
  // now connected: use the shop's active connection for that provider.
  const connected = await connectionsService.resolveProvider(payment.gateway);
  if (connected?.manifest.payments) {
    return {
      gateway: connected.manifest.payments(connected.context),
      testMode: connected.context.mode === 'test',
      source: 'integration',
      connectionId: connected.row.id,
      legacy: null,
    };
  }
  return null;
}

/** The same, for paths that cannot proceed without one. */
export async function requireGateway(): Promise<ResolvedGateway> {
  const resolved = await resolveGateway();
  if (!resolved) {
    throw ApiError.integrationNotConfigured(
      'payments',
      'Online payment is not set up for this store. Connect a payment provider in Settings → Integrations.',
    );
  }
  return resolved;
}

/**
 * Whether online payment can be offered at all.
 *
 * The storefront asks this before it shows the option, so a shopper is never
 * walked through a checkout that cannot take their money.
 */
export async function onlinePaymentAvailable(): Promise<boolean> {
  return (await resolveGateway()) !== null;
}
