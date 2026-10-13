import crypto from 'node:crypto';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { pool } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { eventBus } from '../../platform/events/eventBus';
import { onInboundEvent } from '../../platform/integrations/inbound';
import { fromMinor, toMinor } from '../../platform/money/currency';
import { formatMoney } from '../../platform/shops/format';
import { tenancy } from '../../platform/tenancy/context';
import {
  GatewayError,
  resolveGateway,
  resolveGatewayFor,
  requireGateway,
  verifyWebhookSignature,
  type ClientConfirmation,
  type GatewayOrder,
  type GatewayPayment,
} from './gateway';
import { fromRazorpayEntity } from './gateway/RazorpayGateway';
import { paymentsRepository, type PayableOrderRow } from './payments.repository';

/**
 * Taking money online, through whichever gateway the shop connected, and the
 * rules about when an order counts as paid.
 *
 * Two things arrive claiming a payment succeeded: the browser, back from the
 * gateway's own payment UI, and the gateway's webhook. Neither is trusted on
 * its own terms.
 *
 *   - the browser's claim goes to the gateway adapter, which must prove it —
 *     Razorpay's HMAC over the order and payment ids, a server-side read of the
 *     Stripe PaymentIntent, a PayPal capture — and must refuse a payment that
 *     belongs to a different gateway order;
 *   - the webhook's claim is verified against the connection's webhook secret
 *     over the exact bytes received, in the integrations inbound pipeline (or,
 *     for the legacy Razorpay route, here).
 *
 * And in both cases the **amount is checked against the order** before anything
 * is marked paid. A verified payment still says nothing about how much was
 * paid, and a gateway order id reused or guessed would otherwise settle a
 * ₹4,000 order with a ₹1 payment.
 *
 * Everything below is idempotent: gateways retry webhooks until they get a
 * 2xx, and the browser callback races the webhook by design.
 */

/** One minor unit of tolerance, because decimals round. */
const AMOUNT_TOLERANCE_MINOR = 1;

function isOnlineOrder(order: PayableOrderRow): boolean {
  return order.payment_method !== 'cod';
}

function dueOf(order: { amount_due: string | number; grand_total: string | number }): number {
  return Number(order.amount_due) > 0 ? Number(order.amount_due) : Number(order.grand_total);
}

/** The gateway order id the browser is talking about, whatever the gateway calls it. */
function claimedGatewayOrderId(input: ClientConfirmation): string | null {
  return (
    input.gateway_order_id ??
    input.razorpay_order_id ??
    input.payment_intent ??
    input.paypal_order_id ??
    null
  );
}

/** Gateways' method names onto the vocabulary the payments table uses. */
export function normaliseMethod(method: string | null): string | null {
  if (!method) return null;
  const value = method.toLowerCase();
  const known = ['upi', 'card', 'netbanking', 'wallet', 'emi', 'paylater', 'cod', 'bank_transfer', 'paypal'];
  if (known.includes(value)) return value;
  if (['apple_pay', 'google_pay', 'link'].includes(value)) return 'wallet';
  if (['us_bank_account', 'sepa_debit', 'bacs_debit', 'ach_debit', 'ideal', 'sofort'].includes(value)) return 'bank_transfer';
  return 'other';
}

type SettleSource = 'checkout' | 'webhook';

export const onlinePaymentsService = {
  /**
   * Whether the storefront may offer online payment, and with what.
   *
   * Asked before the checkout renders the option, so nobody is walked through
   * a payment flow with nothing behind it.
   */
  async availability() {
    const resolved = await resolveGateway();
    return {
      online_enabled: resolved !== null,
      provider: resolved?.gateway.name ?? null,
      test_mode: resolved?.testMode ?? false,
      key_id: resolved?.gateway.publicKey ?? null,
    };
  },

  /**
   * Mints the gateway order the browser needs to pay.
   *
   * Returns the existing one when the shopper simply reloaded — a second
   * gateway order for the same shop order is how people end up paying twice.
   */
  async startPayment(orderNumber: string, phone: string) {
    const order = await paymentsRepository.findPayableOrder(orderNumber, phone);
    if (!order) throw ApiError.notFound('Order');

    if (!isOnlineOrder(order)) {
      throw ApiError.conflict('This order is cash on delivery. There is nothing to pay online.');
    }
    /**
     * Only an order that is waiting for payment, or whose payment failed, may
     * be paid. An allow-list rather than "not already paid": a partly refunded
     * order is `partially_refunded`, not `paid`, and must not be chargeable
     * again in full.
     */
    const PAYABLE = new Set(['pending', 'failed']);
    if (!PAYABLE.has(order.payment_status)) {
      throw ApiError.conflict(
        order.payment_status === 'paid'
          ? 'This order has already been paid.'
          : `This order's payment is "${order.payment_status}", so it cannot be paid again here. Please contact us.`,
      );
    }
    if (['cancelled', 'returned'].includes(order.order_status)) {
      throw ApiError.conflict('This order is no longer open for payment.');
    }

    const currency = order.currency;
    const dueMinor = toMinor(dueOf(order), currency);
    if (dueMinor <= 0) throw ApiError.conflict('There is nothing left to pay on this order.');
    const due = fromMinor(dueMinor, currency);

    const resolved = await requireGateway();
    const { gateway } = resolved;
    const prefill = { name: order.customer_name, contact: order.contact_phone, email: order.contact_email };

    const existing = await paymentsRepository.findOpenGatewayOrder(order.id, pool, gateway.name);
    let gatewayOrder: GatewayOrder | null = null;
    if (existing?.gateway_order_id && toMinor(Number(existing.amount), currency) === dueMinor) {
      gatewayOrder = gateway.resumeOrder
        ? await gateway.resumeOrder(existing.gateway_order_id)
        : {
            id: existing.gateway_order_id,
            amount: dueMinor,
            currency,
            status: 'created',
            receipt: order.order_number,
          };
    }

    if (!gatewayOrder) {
      const attemptNo = (await paymentsRepository.countAttempts(order.id)) + 1;
      gatewayOrder = await gateway.createOrder({
        amountMinor: dueMinor,
        currency,
        receipt: order.order_number,
        notes: { order_number: order.order_number, order_id: String(order.id), attempt: String(attemptNo) },
      });
      await paymentsRepository.createGatewayOrder({
        orderId: order.id,
        gatewayOrderId: gatewayOrder.id,
        amount: due,
        currency,
        attemptNo,
        gateway: gateway.name,
        connectionId: resolved.connectionId,
      });
      logger.info('payments.gateway_order_created', {
        order_number: order.order_number,
        gateway: gateway.name,
        gateway_order_id: gatewayOrder.id,
        amount: due,
      });
    }

    return {
      payment: {
        provider: gateway.name,
        // Kept at the top level for storefronts built against Razorpay only.
        key_id: gateway.publicKey,
        gateway_order_id: gatewayOrder.id,
        amount: due,
        amount_minor: gatewayOrder.amount,
        amount_paise: gatewayOrder.amount,
        currency: gatewayOrder.currency,
        order_number: order.order_number,
        test_mode: resolved.testMode,
        prefill,
        checkout: gateway.checkoutPayload(gatewayOrder),
      },
    };
  },

  /**
   * The browser's claim that a payment went through.
   *
   *   1. the gateway order it names must be one we minted for THIS order —
   *      otherwise proof legitimately obtained for someone else's ₹1 payment
   *      would settle this one;
   *   2. the adapter proves the claim with the gateway;
   *   3. `settle` checks the amount against what this order is owed.
   */
  async verifyCheckout(orderNumber: string, phone: string, input: ClientConfirmation) {
    const order = await paymentsRepository.findPayableOrder(orderNumber, phone);
    if (!order) throw ApiError.notFound('Order');

    const gatewayOrderId = claimedGatewayOrderId(input);
    if (!gatewayOrderId) throw ApiError.badRequest('The payment reference is missing.');

    const minted = await paymentsRepository.findPaymentByGatewayOrderId(gatewayOrderId);
    if (!minted || minted.order_id !== order.id) {
      logger.warn('payments.checkout_order_mismatch', {
        order_number: order.order_number,
        gateway_order_id: gatewayOrderId,
        belongs_to: minted?.order_id ?? null,
      });
      throw ApiError.badRequest('That payment belongs to a different order.');
    }

    const resolved = await resolveGatewayFor(minted);
    if (!resolved) {
      throw ApiError.conflict(
        'The payment provider this order was paid through is no longer connected. If money has left your account it will be matched to this order shortly.',
      );
    }

    let payment: GatewayPayment;
    try {
      payment = await resolved.gateway.confirmClientPayment(input, gatewayOrderId);
    } catch (caught) {
      if (caught instanceof GatewayError && caught.status === 400) {
        logger.warn('payments.checkout_claim_refused', {
          order_number: order.order_number,
          gateway: resolved.gateway.name,
          code: caught.code,
        });
        throw ApiError.badRequest('That payment could not be verified. Nothing has been charged to you twice.');
      }
      if (caught instanceof GatewayError) {
        // The webhook arrives regardless, so this is a delay rather than a
        // loss — and saying so stops the shopper paying a second time.
        throw ApiError.conflict(
          'We could not confirm the payment with the gateway just now. If money has left your account it will be matched to this order shortly.',
        );
      }
      throw caught;
    }

    const settled = await this.settle(payment, {
      gateway: resolved.gateway.name,
      connectionId: resolved.connectionId,
      signature: input.razorpay_signature ?? null,
      signatureVerified: true,
      source: 'checkout',
    });

    return {
      payment_status: settled.paid ? 'paid' : settled.status,
      order_number: order.order_number,
      paid: settled.paid,
      message: settled.paid ? 'Payment received.' : 'The payment has not completed. Nothing has been charged.',
    };
  },

  /**
   * Applies what the gateway says about a payment.
   *
   * The one place an order becomes paid. Called by the browser callback and by
   * every webhook path, and safe to call repeatedly with the same payment.
   */
  async settle(
    payment: GatewayPayment,
    context: {
      gateway: string;
      connectionId: number | null;
      signature: string | null;
      signatureVerified: boolean;
      source: SettleSource;
    },
  ): Promise<{ paid: boolean; status: string; orderId: number | null; paymentRowId: number | null }> {
    const mintedFor = payment.order_id
      ? await paymentsRepository.findPaymentByGatewayOrderId(payment.order_id)
      : await paymentsRepository.findPaymentByGatewayPaymentId(payment.id);

    if (!mintedFor) {
      // A payment for a gateway order this shop never created: another
      // environment sharing the account, or a restored database.
      logger.warn('payments.unknown_gateway_order', {
        gateway: context.gateway,
        gateway_order_id: payment.order_id,
        gateway_payment_id: payment.id,
        source: context.source,
      });
      return { paid: false, status: 'unknown_order', orderId: null, paymentRowId: null };
    }

    const settled = await withTransaction(async (tx) => {
      const order = await paymentsRepository.lockOrderForPayment(mintedFor.order_id, tx);
      if (!order) return { paid: false, status: 'unknown_order', orderId: null, paymentRowId: null, newlyPaid: false };

      const currency = order.currency;
      if (payment.currency && payment.currency.toUpperCase() !== currency.toUpperCase()) {
        logger.error('payments.currency_mismatch', {
          order_number: order.order_number,
          gateway_payment_id: payment.id,
          paid_currency: payment.currency,
          order_currency: currency,
        });
      }
      const paidMinor = payment.amount;
      const dueMinor = toMinor(dueOf(order), currency);

      const captured = payment.status === 'captured' || payment.captured;
      const authorized = payment.status === 'authorized';
      const failed = payment.status === 'failed';

      const paymentRowId = await paymentsRepository.upsertPaymentAttempt(
        {
          orderId: order.id,
          gateway: context.gateway,
          connectionId: context.connectionId ?? mintedFor.connection_id ?? null,
          gatewayOrderId: payment.order_id,
          gatewayPaymentId: payment.id,
          signature: context.signature,
          signatureVerified: context.signatureVerified,
          amount: fromMinor(paidMinor, currency),
          currency: payment.currency || currency,
          status: payment.status,
          method: normaliseMethod(payment.method),
          cardNetwork: payment.card_network,
          cardLast4: payment.card_last4,
          cardIssuer: payment.card_issuer,
          upiVpa: payment.upi_vpa,
          bank: payment.bank,
          wallet: payment.wallet,
          isInternational: payment.international,
          fee: fromMinor(payment.fee, currency),
          tax: fromMinor(payment.tax, currency),
          errorCode: payment.error_code,
          errorDescription: payment.error_description,
          errorSource: payment.error_source,
          errorStep: payment.error_step,
          errorReason: payment.error_reason,
          raw: payment.raw,
          authorizedAt: authorized || captured ? new Date() : null,
          capturedAt: captured ? new Date() : null,
          failedAt: failed ? new Date() : null,
        },
        tx,
      );

      if (failed) {
        await paymentsRepository.markOrderPaymentFailed(order.id, tx);
        await paymentsRepository.addOrderHistory(
          {
            orderId: order.id,
            statusType: 'payment',
            fromStatus: order.payment_status,
            toStatus: 'failed',
            note: payment.error_description ?? 'The payment did not go through.',
            isCustomerVisible: true,
          },
          tx,
        );
        await eventBus.publish(
          'orders/payment_failed',
          { order_id: order.id, order_number: order.order_number, gateway: context.gateway, error: payment.error_description ?? null },
          { resourceType: 'order', resourceId: order.id, actorType: context.source === 'webhook' ? 'system' : 'customer', tx },
        );
        return { paid: false, status: 'failed', orderId: order.id, paymentRowId, newlyPaid: false };
      }

      if (!captured) {
        // Authorised but not captured: money is on hold, not taken.
        return { paid: false, status: payment.status, orderId: order.id, paymentRowId, newlyPaid: false };
      }

      if (order.payment_status === 'paid') {
        // Already settled — the other of the two paths got here first.
        return { paid: true, status: 'paid', orderId: order.id, paymentRowId, newlyPaid: false };
      }

      // The check that makes the verification worth having.
      if (Math.abs(paidMinor - dueMinor) > AMOUNT_TOLERANCE_MINOR) {
        logger.error('payments.amount_mismatch', {
          order_number: order.order_number,
          gateway_payment_id: payment.id,
          paid_minor: paidMinor,
          due_minor: dueMinor,
          source: context.source,
        });
        await paymentsRepository.addOrderHistory(
          {
            orderId: order.id,
            statusType: 'payment',
            fromStatus: order.payment_status,
            toStatus: order.payment_status,
            // Staff-only: a discrepancy to resolve, and the order is left unpaid.
            note: `Gateway reported ${formatMoney(fromMinor(paidMinor, currency), { currency })} against ${formatMoney(fromMinor(dueMinor, currency), { currency })} due. Left unpaid for review.`,
            isCustomerVisible: false,
          },
          tx,
        );
        return { paid: false, status: 'amount_mismatch', orderId: order.id, paymentRowId, newlyPaid: false };
      }

      const paidTotal = Number(order.amount_paid) + fromMinor(paidMinor, currency);
      await paymentsRepository.markOrderPaid(
        {
          orderId: order.id,
          amountPaid: Number(paidTotal.toFixed(2)),
          amountDue: Number(Math.max(0, Number(order.grand_total) - paidTotal).toFixed(2)),
          confirm: true,
        },
        tx,
      );
      await paymentsRepository.closeStaleGatewayOrders(order.id, paymentRowId, tx);
      await paymentsRepository.addOrderHistory(
        {
          orderId: order.id,
          statusType: 'payment',
          fromStatus: order.payment_status,
          toStatus: 'paid',
          note: `${formatMoney(fromMinor(paidMinor, currency), { currency })} received${payment.method ? ` by ${payment.method}` : ''}.`,
          isCustomerVisible: true,
        },
        tx,
      );
      await paymentsRepository.addOrderHistory(
        {
          orderId: order.id,
          statusType: 'order',
          fromStatus: order.order_status,
          toStatus: 'confirmed',
          note: 'Payment confirmed.',
          isCustomerVisible: true,
        },
        tx,
      );
      await eventBus.publish(
        'orders/paid',
        {
          order_id: order.id,
          order_number: order.order_number,
          amount: fromMinor(paidMinor, currency),
          currency,
          gateway: context.gateway,
        },
        { resourceType: 'order', resourceId: order.id, actorType: context.source === 'webhook' ? 'system' : 'customer', tx },
      );

      logger.info('payments.settled', {
        order_number: order.order_number,
        gateway: context.gateway,
        gateway_payment_id: payment.id,
        amount: fromMinor(paidMinor, currency),
        source: context.source,
      });

      return { paid: true, status: 'paid', orderId: order.id, paymentRowId, newlyPaid: true };
    });

    return { paid: settled.paid, status: settled.status, orderId: settled.orderId, paymentRowId: settled.paymentRowId };
  },

  /** A gateway's word on a refund, from any webhook path. */
  async applyRefundUpdate(input: {
    gatewayRefundId: string;
    status: 'processed' | 'processing' | 'failed';
    arn: string | null;
    raw: unknown;
  }): Promise<{ handled: boolean; orderId: number | null; paymentRowId: number | null }> {
    const refund = await paymentsRepository.findRefundByGatewayId(input.gatewayRefundId);
    if (!refund) {
      logger.warn('payments.webhook_unknown_refund', { gateway_refund_id: input.gatewayRefundId });
      return { handled: false, orderId: null, paymentRowId: null };
    }
    await paymentsRepository.setRefundStatus({ refundId: refund.id, status: input.status, arn: input.arn, raw: input.raw });
    const amount = formatMoney(Number(refund.amount));
    await paymentsRepository.addOrderHistory(
      {
        orderId: refund.order_id,
        statusType: 'payment',
        fromStatus: null,
        toStatus: input.status === 'processed' ? 'refunded' : `refund_${input.status}`,
        note:
          input.status === 'processed'
            ? `Refund of ${amount} has reached the bank.`
            : input.status === 'failed'
              ? `Refund of ${amount} failed at the gateway.`
              : 'Refund is being processed.',
        isCustomerVisible: true,
      },
      pool,
    );
    return { handled: true, orderId: refund.order_id, paymentRowId: refund.payment_id };
  },

  // ── the legacy Razorpay webhook ───────────────────────────────────────────

  /**
   * Razorpay calling the pre-integrations URL (/api/v1/payments/razorpay/webhook),
   * verified against the legacy webhook secret. Shops that connected Razorpay
   * as an integration receive webhooks on their connection's own URL instead.
   *
   * The signature is verified against the raw bytes **before the body is
   * believed**; an unsigned or wrongly-signed delivery is stored and refused.
   */
  async handleLegacyRazorpayWebhook(rawBody: Buffer | string | undefined, signatureHeader: string | undefined) {
    const resolved = await resolveGatewayFor({ gateway: 'razorpay' });
    const credentials = resolved?.legacy ?? null;
    if (!credentials || !credentials.webhookSecret) {
      // With no secret there is no way to tell Razorpay's call from anyone
      // else's; accepting would make this an unauthenticated "mark paid" URL.
      logger.error('payments.webhook_secret_missing', {});
      throw ApiError.conflict('No webhook secret is configured, so webhooks cannot be verified.');
    }

    const valid = verifyWebhookSignature(rawBody, signatureHeader, credentials.webhookSecret);
    let parsed: RazorpayWebhookBody | null = null;
    try {
      parsed = JSON.parse(typeof rawBody === 'string' ? rawBody : (rawBody?.toString('utf8') ?? '')) as RazorpayWebhookBody;
    } catch {
      parsed = null;
    }

    const eventType = parsed?.event ?? 'unknown';
    const entityId = extractEntityId(parsed);
    const eventId = `${eventType}:${entityId ?? 'unknown'}`;

    if (!valid) {
      logger.warn('payments.webhook_signature_invalid', { event: eventType });
      // Keyed on a digest of the delivery, so repeats of the same rejected
      // delivery (a stale secret) collapse onto one row.
      const digest = crypto
        .createHash('sha256')
        .update(typeof rawBody === 'string' ? rawBody : (rawBody ?? Buffer.alloc(0)))
        .digest('hex')
        .slice(0, 32);
      await paymentsRepository.recordWebhookEvent({
        eventId: `invalid:${digest}`,
        eventType,
        payload: parsed,
        signature: signatureHeader ?? null,
        signatureValid: false,
        orderId: null,
      });
      throw ApiError.forbidden('Webhook signature verification failed.');
    }

    const stored = await paymentsRepository.recordWebhookEvent({
      eventId,
      eventType,
      payload: parsed,
      signature: signatureHeader ?? null,
      signatureValid: true,
      orderId: null,
    });
    if (stored === null) {
      // Seen before. Razorpay retries until it gets a 2xx; answer 200.
      logger.info('payments.webhook_replayed', { event: eventType, event_id: eventId });
      return { received: true, duplicate: true, event: eventType };
    }

    try {
      const outcome = await this.processRazorpayEvent(eventType, parsed);
      await paymentsRepository.completeWebhookEvent({
        id: stored,
        status: outcome.handled ? 'processed' : 'ignored',
        error: null,
        orderId: outcome.orderId,
        paymentId: outcome.paymentRowId,
      });
      return { received: true, duplicate: false, event: eventType, handled: outcome.handled };
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      await paymentsRepository.completeWebhookEvent({
        id: stored,
        status: 'failed',
        error: message.slice(0, 500),
        orderId: null,
        paymentId: null,
      });
      logger.error('payments.webhook_failed', { event: eventType, event_id: eventId, message });
      throw caught;
    }
  },

  async processRazorpayEvent(
    eventType: string,
    body: RazorpayWebhookBody | null,
  ): Promise<{ handled: boolean; orderId: number | null; paymentRowId: number | null }> {
    if (!body) return { handled: false, orderId: null, paymentRowId: null };

    switch (eventType) {
      case 'payment.captured':
      case 'payment.authorized':
      case 'payment.failed': {
        const entity = body.payload?.payment?.entity;
        if (!entity) return { handled: false, orderId: null, paymentRowId: null };
        const settled = await this.settle(fromRazorpayEntity(entity), {
          gateway: 'razorpay',
          connectionId: null,
          // A webhook carries no checkout signature; `signature_verified` means
          // "the browser callback proved this pair", a different claim.
          signature: null,
          signatureVerified: false,
          source: 'webhook',
        });
        return { handled: true, orderId: settled.orderId, paymentRowId: settled.paymentRowId };
      }

      case 'refund.processed':
      case 'refund.failed':
      case 'refund.speed_changed': {
        const entity = body.payload?.refund?.entity;
        if (!entity?.id) return { handled: false, orderId: null, paymentRowId: null };
        return this.applyRefundUpdate({
          gatewayRefundId: String(entity.id),
          status:
            eventType === 'refund.failed'
              ? 'failed'
              : String(entity.status ?? 'processed') === 'processed'
                ? 'processed'
                : 'processing',
          arn:
            typeof entity.acquirer_data === 'object' && entity.acquirer_data
              ? (((entity.acquirer_data as Record<string, unknown>).arn as string | null) ?? null)
              : null,
          raw: entity,
        });
      }

      default:
        // Stored, not acted on, so the log shows what is arriving.
        return { handled: false, orderId: null, paymentRowId: null };
    }
  },

  /** Whether online payment is offered at all — used by the storefront. */
  async online(): Promise<boolean> {
    return (await resolveGateway()) !== null;
  },

  // ── refunds ───────────────────────────────────────────────────────────────

  /**
   * Sends a refund to the gateway for a refund row that has already been written.
   *
   * Called after the recording transaction commits, never inside it: a network
   * call inside a transaction holds row locks for as long as the gateway takes,
   * and "we recorded a refund that did not move" is recoverable by a person
   * where "money moved and we have no record" is not.
   *
   * Goes back through the connection that took the payment, whatever the
   * shop's default gateway is today.
   */
  async sendRefund(input: {
    refundId: number;
    orderId: number;
    amount: number;
    currency?: string;
    gatewayPaymentId: string | null;
    gateway: string;
    connectionId?: number | null;
    restorePaymentStatus: string;
    orderNumber: string;
  }): Promise<{ moved: boolean; reason: string | null; gatewayRefundId: string | null }> {
    // COD, manual and store-credit refunds are settled by a person, not an API.
    if (['cod', 'manual', 'store_credit'].includes(input.gateway) || !input.gatewayPaymentId) {
      return {
        moved: false,
        reason: 'This payment was not taken through a gateway, so the refund has to be paid out by hand.',
        gatewayRefundId: null,
      };
    }

    const resolved = await resolveGatewayFor({ gateway: input.gateway, connection_id: input.connectionId ?? null });
    if (!resolved) {
      return {
        moved: false,
        reason: `The ${input.gateway} account this payment was taken through is no longer connected, so the refund was recorded but not sent.`,
        gatewayRefundId: null,
      };
    }

    const currency = input.currency ?? tenancy.current().currency;
    try {
      const refund = await resolved.gateway.createRefund({
        paymentId: input.gatewayPaymentId,
        amountMinor: toMinor(input.amount, currency),
        currency,
        idempotencyKey: `refund-${tenancy.current().id}-${input.refundId}`,
        notes: { order_number: input.orderNumber, refund_id: String(input.refundId) },
      });

      await paymentsRepository.attachGatewayRefund({
        refundId: input.refundId,
        gatewayRefundId: refund.id,
        // Most gateways answer `pending` and confirm by webhook. Saying
        // `processed` now would tell a customer their money is back before the
        // bank has it.
        status: refund.status === 'processed' ? 'processed' : 'processing',
        speed: refund.speed,
        arn: refund.arn,
        raw: refund.raw,
      });

      logger.info('payments.refund_sent', {
        order_number: input.orderNumber,
        gateway: resolved.gateway.name,
        gateway_refund_id: refund.id,
        amount: input.amount,
      });
      return { moved: true, reason: null, gatewayRefundId: refund.id };
    } catch (caught) {
      const message =
        caught instanceof GatewayError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : 'The gateway refused the refund.';

      await paymentsRepository.reverseFailedRefund({
        refundId: input.refundId,
        orderId: input.orderId,
        amount: input.amount,
        restorePaymentStatus: input.restorePaymentStatus,
        error: message,
      });
      logger.error('payments.refund_failed', { order_number: input.orderNumber, refund_id: input.refundId, message });
      return { moved: false, reason: message, gatewayRefundId: null };
    }
  },
};

// ── gateway webhooks through the integrations pipeline ───────────────────────
//
// Every payments provider translates its webhook into these platform events
// (see src/platform/integrations/providers). One handler per event type serves
// Razorpay, Stripe and PayPal alike.

for (const type of ['payment.captured', 'payment.authorized', 'payment.failed']) {
  onInboundEvent(type, async ({ data, connection }) => {
    const payment = data.payment as GatewayPayment | undefined;
    if (!payment?.id) return 'ignored';
    const settled = await onlinePaymentsService.settle(payment, {
      gateway: connection?.provider ?? String(data.gateway ?? 'unknown'),
      connectionId: connection?.id ?? null,
      signature: null,
      signatureVerified: false,
      source: 'webhook',
    });
    return settled.status === 'unknown_order' ? 'ignored' : 'processed';
  });
}

for (const type of ['refund.processed', 'refund.failed', 'refund.pending']) {
  onInboundEvent(type, async ({ data }) => {
    const refundId = typeof data.refund_id === 'string' ? data.refund_id : null;
    if (!refundId) return 'ignored';
    const outcome = await onlinePaymentsService.applyRefundUpdate({
      gatewayRefundId: refundId,
      status: type === 'refund.processed' ? 'processed' : type === 'refund.failed' ? 'failed' : 'processing',
      arn: typeof data.arn === 'string' ? data.arn : null,
      raw: data.raw ?? null,
    });
    return outcome.handled ? 'processed' : 'ignored';
  });
}

// ── shapes Razorpay sends ────────────────────────────────────────────────────

export interface RazorpayWebhookBody {
  event?: string;
  payload?: {
    payment?: { entity?: Record<string, unknown> };
    refund?: { entity?: Record<string, unknown> };
    order?: { entity?: Record<string, unknown> };
  };
}

export function extractEntityId(body: RazorpayWebhookBody | null): string | null {
  const entity = body?.payload?.payment?.entity ?? body?.payload?.refund?.entity ?? body?.payload?.order?.entity;
  const id = entity?.id;
  return typeof id === 'string' ? id : null;
}

/** Exported for the smoke suite, which drives `settle` against a fake gateway. */
export type { GatewayPayment };
export const __internals = { fromRazorpayEntity, normaliseMethod, extractEntityId };
