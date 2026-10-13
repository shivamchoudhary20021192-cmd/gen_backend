import { randomUUID } from 'node:crypto';
import { BillingProviderError, type BillingProvider, type ChargeResult } from './types';

/**
 * A card processor for development and tests. Two cards exist:
 *
 *   sim_card_visa      always pays
 *   sim_card_declined  is always declined ("insufficient funds")
 *
 * so a developer can walk a store through trial end, a failed bill, a frozen
 * store and recovery without a processor account. Never used in production
 * unless someone sets PLATFORM_BILLING_PROVIDER=simulator on purpose.
 */

const CARDS: Record<string, { label: string; expires: string; declines: boolean }> = {
  sim_card_visa: { label: 'Visa •••• 4242', expires: '2030-12', declines: false },
  sim_card_declined: { label: 'Visa •••• 0002', expires: '2030-12', declines: true },
};

export class SimulatorBillingProvider implements BillingProvider {
  readonly name = 'simulator';
  private readonly charges = new Map<string, ChargeResult>();

  async setupPaymentMethod(customer: { providerCustomerId: string | null }) {
    return {
      kind: 'test_tokens' as const,
      tokens: Object.entries(CARDS).map(([token, card]) => ({ token, description: `${card.label}${card.declines ? ' — declines' : ''}` })),
      reference: `sim_setup_${randomUUID()}`,
      providerCustomerId: customer.providerCustomerId ?? `sim_cus_${randomUUID().slice(0, 12)}`,
    };
  }

  async confirmPaymentMethod(customer: { providerCustomerId: string | null }, reference: string) {
    const card = CARDS[reference];
    if (!card) throw new BillingProviderError('That test card does not exist. Use sim_card_visa or sim_card_declined.');
    return { reference, label: card.label, expires: card.expires, providerCustomerId: customer.providerCustomerId };
  }

  async charge(input: { paymentMethodRef: string; idempotencyKey: string }): Promise<ChargeResult> {
    const previous = this.charges.get(input.idempotencyKey);
    if (previous) return previous;
    const card = CARDS[input.paymentMethodRef];
    const result: ChargeResult = !card
      ? { status: 'failed', providerPaymentId: null, error: 'The card on file is no longer valid.' }
      : card.declines
        ? { status: 'failed', providerPaymentId: `sim_pay_${randomUUID()}`, error: 'Your card was declined (insufficient funds).' }
        : { status: 'succeeded', providerPaymentId: `sim_pay_${randomUUID()}` };
    this.charges.set(input.idempotencyKey, result);
    return result;
  }

  async chargeStatus(providerPaymentId: string): Promise<ChargeResult> {
    return { status: 'succeeded', providerPaymentId };
  }
}
