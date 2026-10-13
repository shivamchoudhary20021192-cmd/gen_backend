import type { CourierProvider } from '../../modules/shipping/courier/CourierProvider';
import type { MessageChannel, MessageProvider } from '../../modules/messaging/MessageProvider';
import type { PaymentGateway } from '../../modules/payments/gateway/PaymentGateway';
import type { TaxCalculator } from '../tax/TaxCalculator';

/**
 * The contract every third-party provider implements.
 *
 * A provider is a manifest: what it is called, which fields a merchant fills
 * in to connect it, how to check those fields actually work, how to verify the
 * webhooks it sends back, and — per category — the adapter the rest of the
 * application talks to. Everything above this file speaks in the category's
 * own interface (`MessageProvider`, `PaymentGateway`, `CourierProvider`,
 * `TaxCalculator`) and
 * never names a vendor, which is how "add Twilio" stays one file.
 */

export type IntegrationCategory = 'payments' | 'sms' | 'email' | 'whatsapp' | 'shipping' | 'tax';

export const INTEGRATION_CATEGORIES: readonly IntegrationCategory[] = ['payments', 'sms', 'email', 'whatsapp', 'shipping', 'tax'];

/** A field the merchant fills in. Secret fields are sealed and never returned. */
export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
  /** Checked before anything is sent to the provider. */
  pattern?: RegExp;
}

/** Non-secret settings, stored in clear and editable without re-entering keys. */
export interface ConfigField {
  key: string;
  label: string;
  type: 'string' | 'boolean' | 'number' | 'select';
  required?: boolean;
  options?: { value: string; label: string }[];
  default?: string | number | boolean;
  help?: string;
}

export type ConnectionMode = 'live' | 'test';

/** Everything an adapter needs, resolved for one connection in one shop. */
export interface ConnectionContext<C = Record<string, string>> {
  shopId: number;
  connectionId: number;
  publicId: string;
  provider: string;
  name: string;
  mode: ConnectionMode;
  credentials: C;
  config: Record<string, unknown>;
  /** The URL this provider should call back: status callbacks and webhooks. */
  inboundUrl: string;
}

export interface VerifyResult {
  ok: boolean;
  /** What the provider says the account is, for the merchant to recognise. */
  accountLabel?: string | null;
  /** Detected from the account itself when the keys do not say. */
  mode?: ConnectionMode;
  message?: string;
}

/** An inbound HTTP call as the verifier sees it: the exact bytes, never a re-serialisation. */
export interface InboundRequest {
  method: string;
  /** The absolute URL the provider called, as it signed it. */
  url: string;
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
  query: Record<string, string>;
}

/**
 * A provider event translated into platform terms.
 *
 * `type` is ours, not the vendor's: payment.captured, payment.failed,
 * refund.processed, message.status, shipment.status. Handlers subscribe to
 * these, so one handler serves every gateway.
 */
export interface InboundEvent {
  /** The provider's event id, or a stable hash when it has none. Deduplicates retries. */
  externalId: string;
  type: string;
  /** The vendor's own event name, for the log. */
  providerType: string;
  data: Record<string, unknown>;
}

export class InboundSignatureError extends Error {
  constructor(message = 'Signature verification failed.') {
    super(message);
    this.name = 'InboundSignatureError';
  }
}

export interface InboundSpec<C> {
  /**
   * Authenticates the call and parses it. Throws InboundSignatureError when the
   * call cannot be shown to come from the provider; nothing in the body is
   * believed before this returns.
   */
  verify(request: InboundRequest, context: ConnectionContext<C>): InboundEvent[] | Promise<InboundEvent[]>;
  /** Subscription handshakes that happen over GET (Meta's hub.challenge). */
  handshake?(query: Record<string, string>, context: ConnectionContext<C>): string | null;
  /** What to answer with, for providers that care (Twilio wants TwiML). */
  acknowledge?: { contentType: string; body: string };
}

export interface ProviderManifest<C = Record<string, string>> {
  key: string;
  name: string;
  category: IntegrationCategory;
  /** For messaging providers that carry more than one channel (Twilio: SMS and WhatsApp). */
  channels?: MessageChannel[];
  description: string;
  docsUrl: string;
  /** ISO countries this is most useful in, or '*' for everywhere. Sorting only; never a restriction. */
  countries: string[] | '*';
  credentialFields: CredentialField[];
  configFields?: ConfigField[];
  /** From the key's shape: rzp_test_…, sk_test_… */
  detectMode?(credentials: C): ConnectionMode;
  /** A recognisable, non-usable label for the credentials: "AC…91f3". */
  hint(credentials: C): string;
  /** A cheap authenticated call proving the credentials work. */
  verify(context: ConnectionContext<C>): Promise<VerifyResult>;
  inbound?: InboundSpec<C>;

  messaging?(context: ConnectionContext<C>, channel: MessageChannel): MessageProvider;
  payments?(context: ConnectionContext<C>): PaymentGateway;
  shipping?(context: ConnectionContext<C>, carrierCode: string): CourierProvider;
  tax?(context: ConnectionContext<C>): TaxCalculator;
}

/** `ProviderManifest` with its credential type erased, for the registry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProviderManifest = ProviderManifest<any>;
