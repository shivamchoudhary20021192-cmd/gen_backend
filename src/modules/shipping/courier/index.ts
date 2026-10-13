import { ApiError } from '../../../core/ApiError';
import { logger } from '../../../core/logger';
import { connectionsService } from '../../../platform/integrations/connections.service';
import { DummyProvider } from './DummyProvider';
import type { CourierProvider } from './CourierProvider';

export * from './CourierProvider';
export { DummyProvider };

/**
 * Picks the adapter for a carrier row.
 *
 * `shipping_carriers.api_provider` is the switch. Today every row says 'dummy'
 * or 'manual'; when the Shiprocket adapter exists, flipping that one column
 * turns it on for that carrier, with no code change anywhere above.
 *
 * The dummy is constructed with the carrier's own code so its waybills look
 * like that carrier's — a Blue Dart shipment gets an 11-digit number even in
 * the stand-in, which keeps the screens honest about field widths and formats.
 */
export function courierFor(carrier: { code: string; api_provider: string | null }): CourierProvider {
  const provider = (carrier.api_provider ?? 'dummy').toLowerCase();

  switch (provider) {
    case 'dummy':
    case 'manual':
      // 'manual' is self-ship: the operator types the waybill their own courier
      // gave them. It still goes through a provider so that shipments created
      // by hand and shipments booked through an API are the same kind of row.
      return new DummyProvider(carrier.code);

    default:
      // An unknown provider is a configuration mistake, and falling back to the
      // dummy silently would mean a carrier that looks connected and is not.
      // Loud in the log, still usable, never pretending to be live.
      logger.warn('courier.unknown_provider', { provider, carrier: carrier.code });
      return new DummyProvider(carrier.code);
  }
}

/**
 * The adapter for a carrier row, including carriers booked through a
 * connected integration (Shiprocket…).
 *
 * `shipping_carriers.api_provider` names the provider; the shop's active
 * connection for it supplies the credentials. A provider that is named but not
 * connected is refused rather than faked: a stand-in waybill for a carrier the
 * merchant believes is live would ship nothing.
 */
export async function resolveCourier(carrier: { code: string; api_provider: string | null }): Promise<CourierProvider> {
  const provider = (carrier.api_provider ?? 'dummy').toLowerCase();
  if (provider === 'dummy' || provider === 'manual') return courierFor(carrier);

  const connected = await connectionsService.resolveProvider(provider);
  if (!connected?.manifest.shipping) {
    throw ApiError.integrationNotConfigured(
      'shipping',
      `The carrier ${carrier.code} books through ${provider}, which is not connected. Connect it in Settings → Integrations.`,
    );
  }
  return connected.manifest.shipping(connected.context, carrier.code);
}

/** Fills a carrier's tracking template. Null when the carrier has none. */
export function trackingUrlFor(template: string | null, awbNumber: string | null): string | null {
  if (!template || !awbNumber) return null;
  return template.replace('{awb}', encodeURIComponent(awbNumber));
}
