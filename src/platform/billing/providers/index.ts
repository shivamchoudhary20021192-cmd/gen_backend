import { env } from '../../../config/env';
import { SimulatorBillingProvider } from './simulator';
import { StripeBillingProvider } from './stripe';
import { BillingProviderError, type BillingProvider, type ChargeResult } from './types';

/**
 * Bills settled outside the platform — a bank transfer an operator marks as
 * received. Charging leaves the bill open; nothing is collected.
 */
class ManualBillingProvider implements BillingProvider {
  readonly name = 'manual';
  async setupPaymentMethod() {
    return { kind: 'none' as const, message: 'Bills for this store are settled by invoice. Contact billing support to change that.' };
  }
  async confirmPaymentMethod(): Promise<never> {
    throw new BillingProviderError('This platform bills by invoice and takes no card.');
  }
  async charge(): Promise<ChargeResult> {
    return { status: 'pending', providerPaymentId: null };
  }
  async chargeStatus(): Promise<ChargeResult> {
    return { status: 'pending', providerPaymentId: null };
  }
}

let provider: BillingProvider | null = null;

/** The platform's billing processor, chosen by PLATFORM_BILLING_PROVIDER. */
export function billingProvider(): BillingProvider {
  if (provider) return provider;
  switch (env.billing.provider) {
    case 'stripe':
      provider = new StripeBillingProvider(env.billing.stripeSecretKey, env.billing.stripePublishableKey);
      break;
    case 'simulator':
      provider = new SimulatorBillingProvider();
      break;
    default:
      provider = new ManualBillingProvider();
  }
  return provider;
}
