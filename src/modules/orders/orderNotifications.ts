import { queryOne, type RowDataPacket } from '../../db/pool';
import { subscribe, type DomainEvent } from '../../platform/events/subscribers';
import { resourceSnapshot } from '../../platform/events/resourceSnapshots';
import { notificationEngine, type Recipient } from '../../platform/notifications/notificationEngine';
import { formatMoney } from '../../platform/shops/format';
import { storefrontLink } from '../../platform/shops/urls';
import { pool } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

/**
 * Order lifecycle → the messages the customer (and staff) get.
 *
 * Runs as an event subscriber, so it happens after the change commits, in its
 * own job, retried on its own if a provider is down — an SMS gateway outage
 * never fails a checkout. What is sent, and on which channels, is the shop's
 * choice in Settings → Notifications; the words are its templates.
 */

interface OrderSnapshot {
  id: number;
  order_number: string;
  currency: string;
  payment_method: string;
  total_price: number | null;
  email: string | null;
  phone: string | null;
  customer: { id: number; name: string | null } | null;
  fulfillments: { name: string; tracking_number: string | null; tracking_url: string | null; status: string }[];
}

async function orderSnapshot(event: DomainEvent): Promise<OrderSnapshot | null> {
  const payload = event.payload as Partial<OrderSnapshot> & { order_id?: number };
  if (payload.order_number && Array.isArray(payload.fulfillments)) return payload as OrderSnapshot;
  const id = payload.order_id ?? (event.resourceType === 'order' ? event.resourceId : null);
  if (!id) return null;
  return (await resourceSnapshot('order', Number(id), pool)) as OrderSnapshot | null;
}

async function recipientFor(order: OrderSnapshot): Promise<Recipient> {
  const customerId = order.customer?.id ?? null;
  const customer = customerId
    ? await queryOne<RowDataPacket & { country_code: string | null }>('SELECT country_code FROM customers WHERE shop_id = ? AND id = ?', [shopId(), customerId])
    : null;
  return { customerId, email: order.email, phone: order.phone, countryCode: customer?.country_code ?? null };
}

function baseVariables(order: OrderSnapshot, amount?: number | null): Record<string, string> {
  const name = order.customer?.name?.trim() ?? '';
  return {
    first_name: name.split(/\s+/)[0] || 'there',
    order_number: order.order_number,
    order_total: formatMoney(amount ?? order.total_price ?? 0, { currency: order.currency }),
    tracking_url: storefrontLink(`/track?order=${encodeURIComponent(order.order_number)}`),
    link: storefrontLink(`/track?order=${encodeURIComponent(order.order_number)}`),
  };
}

subscribe({
  name: 'notifications.orders',
  topics: ['orders/create', 'orders/paid', 'orders/payment_failed', 'orders/cancelled', 'fulfillments/create', 'fulfillments/update', 'refunds/create'],
  async handle(event) {
    const order = await orderSnapshot(event);
    if (!order) return;
    const recipient = await recipientFor(order);

    switch (event.topic) {
      case 'orders/create': {
        await notificationEngine.notifyStaff({
          key: 'staff.order_placed',
          title: `New order ${order.order_number}`,
          body: `${formatMoney(order.total_price ?? 0, { currency: order.currency })} · ${order.payment_method === 'cod' ? 'cash on delivery' : 'online payment'}`,
          linkUrl: `/orders/${order.id}`,
          entityType: 'order',
          entityId: order.id,
          variables: { order_number: order.order_number },
        });
        // Online orders are confirmed when the payment lands (orders/paid).
        if (order.payment_method === 'cod') {
          await notificationEngine.notifyCustomer({ key: 'order.confirmed', recipient, orderId: order.id, variables: baseVariables(order), oncePerOrder: true });
        }
        return;
      }
      case 'orders/paid':
        await notificationEngine.notifyCustomer({ key: 'order.confirmed', recipient, orderId: order.id, variables: baseVariables(order), oncePerOrder: true });
        return;
      case 'orders/payment_failed':
        await notificationEngine.notifyCustomer({
          key: 'payment.failed',
          recipient,
          orderId: order.id,
          variables: { ...baseVariables(order), link: storefrontLink(`/pay?order=${encodeURIComponent(order.order_number)}`) },
        });
        return;
      case 'orders/cancelled':
        await notificationEngine.notifyCustomer({ key: 'order.cancelled', recipient, orderId: order.id, variables: baseVariables(order), oncePerOrder: true });
        return;
      case 'fulfillments/create': {
        const latest = order.fulfillments[order.fulfillments.length - 1];
        await notificationEngine.notifyCustomer({
          key: 'order.shipped',
          recipient,
          orderId: order.id,
          variables: {
            ...baseVariables(order),
            awb: latest?.tracking_number ?? '',
            tracking_url: latest?.tracking_url ?? baseVariables(order).tracking_url,
          },
        });
        return;
      }
      case 'fulfillments/update': {
        const status = String((event.payload as { status?: string }).status ?? '');
        const key = status === 'out_for_delivery' ? 'order.out_for_delivery' : status === 'delivered' ? 'order.delivered' : null;
        if (key) await notificationEngine.notifyCustomer({ key, recipient, orderId: order.id, variables: baseVariables(order), oncePerOrder: true });
        return;
      }
      case 'refunds/create': {
        const refund = await queryOne<RowDataPacket & { amount: string }>(
          'SELECT amount FROM refunds WHERE shop_id = ? AND order_id = ? ORDER BY id DESC LIMIT 1',
          [shopId(), order.id],
        );
        await notificationEngine.notifyCustomer({
          key: 'refund.processed',
          recipient,
          orderId: order.id,
          variables: baseVariables(order, refund ? Number(refund.amount) : null),
        });
        return;
      }
      default:
        return;
    }
  },
});
