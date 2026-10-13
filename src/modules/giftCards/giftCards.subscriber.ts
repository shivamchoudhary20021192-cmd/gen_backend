import { subscribe } from '../../platform/events/subscribers';
import { logger } from '../../core/logger';
import { giftCardsService } from './giftCards.service';

/**
 * Gift cards bought on an order are issued — and sent — once it is paid.
 * Runs as its own job per event, so a slow SMS provider never holds up the
 * order confirmation, and a retry never issues a card twice.
 */
subscribe({
  name: 'gift_cards.issue_purchased',
  topics: ['orders/paid'],
  async handle(event) {
    const payload = event.payload as { id?: number; order_id?: number };
    const orderId = Number(payload.id ?? payload.order_id ?? (event.resourceType === 'order' ? event.resourceId : 0));
    if (!orderId) return;
    const issued = await giftCardsService.issueForOrder(orderId);
    if (issued) logger.info('gift_cards.issued_for_order', { order_id: orderId, issued });
  },
});
