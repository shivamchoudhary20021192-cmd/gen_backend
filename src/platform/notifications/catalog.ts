/**
 * The automatic messages a shop can send, and to whom.
 *
 * Each entry is a notification a merchant can switch on or off per channel in
 * Settings → Notifications. The words live in notification_templates (one per
 * event and channel); this list is what decides whether they are sent.
 * Defaults are what a new shop gets before touching anything: order updates
 * on, marketing off (marketing needs consent and a campaign, not a trigger).
 */

export type NotificationChannel = 'email' | 'sms' | 'whatsapp';
export type NotificationAudience = 'customer' | 'staff';

export interface NotificationDefinition {
  key: string;
  audience: NotificationAudience;
  group: 'Orders' | 'Shipping' | 'Payments' | 'Privacy' | 'Staff';
  label: string;
  description: string;
  channels: NotificationChannel[];
  defaultOn: NotificationChannel[];
}

export const NOTIFICATIONS: NotificationDefinition[] = [
  {
    key: 'order.confirmed',
    audience: 'customer',
    group: 'Orders',
    label: 'Order confirmation',
    description: 'Sent when an order is placed (cash on delivery) or paid (online).',
    channels: ['email', 'sms', 'whatsapp'],
    defaultOn: ['email', 'sms', 'whatsapp'],
  },
  {
    key: 'order.cancelled',
    audience: 'customer',
    group: 'Orders',
    label: 'Order cancelled',
    description: 'Sent when an order is cancelled, by the customer or by staff.',
    channels: ['email', 'sms', 'whatsapp'],
    defaultOn: ['email'],
  },
  {
    key: 'order.shipped',
    audience: 'customer',
    group: 'Shipping',
    label: 'Shipping confirmation',
    description: 'Sent when a shipment is booked, with the tracking link.',
    channels: ['email', 'sms', 'whatsapp'],
    defaultOn: ['email', 'sms', 'whatsapp'],
  },
  {
    key: 'order.out_for_delivery',
    audience: 'customer',
    group: 'Shipping',
    label: 'Out for delivery',
    description: 'Sent when the carrier reports the parcel is out for delivery.',
    channels: ['email', 'sms', 'whatsapp'],
    defaultOn: ['sms'],
  },
  {
    key: 'order.delivered',
    audience: 'customer',
    group: 'Shipping',
    label: 'Delivered',
    description: 'Sent when the carrier reports the parcel delivered.',
    channels: ['email', 'sms', 'whatsapp'],
    defaultOn: ['email', 'whatsapp'],
  },
  {
    key: 'payment.failed',
    audience: 'customer',
    group: 'Payments',
    label: 'Payment failed',
    description: 'Sent when an online payment for an order fails, with a link to try again.',
    channels: ['email', 'sms', 'whatsapp'],
    defaultOn: ['email'],
  },
  {
    key: 'refund.processed',
    audience: 'customer',
    group: 'Payments',
    label: 'Refund issued',
    description: 'Sent when a refund is issued on an order.',
    channels: ['email', 'sms', 'whatsapp'],
    defaultOn: ['email'],
  },
  {
    key: 'gift_card.issued',
    audience: 'customer',
    group: 'Payments',
    label: 'Gift card',
    description: 'Sends a new gift card — its code and a link to its balance — to its recipient or customer.',
    channels: ['email', 'sms', 'whatsapp'],
    defaultOn: ['email', 'sms', 'whatsapp'],
  },
  {
    key: 'privacy.request_verify',
    audience: 'customer',
    group: 'Privacy',
    label: 'Privacy request: confirm it is you',
    description: 'Sends a link to confirm a privacy request made on the storefront, so no one can ask for someone else’s data.',
    channels: ['email'],
    defaultOn: ['email'],
  },
  {
    key: 'privacy.request_received',
    audience: 'customer',
    group: 'Privacy',
    label: 'Privacy request received',
    description: 'Confirms a privacy request, with its reference and the date it will be answered by.',
    channels: ['email'],
    defaultOn: ['email'],
  },
  {
    key: 'privacy.request_completed',
    audience: 'customer',
    group: 'Privacy',
    label: 'Privacy request completed',
    description: 'Tells the requester their request is done — with a link to their data, for an access request — or why it was refused.',
    channels: ['email'],
    defaultOn: ['email'],
  },
  {
    key: 'staff.privacy_request',
    audience: 'staff',
    group: 'Staff',
    label: 'New privacy request',
    description: 'Tells staff when a customer asks to see, correct or erase their data, with the date it must be answered by.',
    channels: ['email'],
    defaultOn: ['email'],
  },
  {
    key: 'staff.comment_posted',
    audience: 'staff',
    group: 'Staff',
    label: 'New blog comment',
    description: 'Tells staff when a shopper comments on a blog post — especially one waiting for approval.',
    channels: ['email'],
    defaultOn: [],
  },
  {
    key: 'staff.order_placed',
    audience: 'staff',
    group: 'Staff',
    label: 'New order',
    description: 'Tells staff about every new order: in the admin, and by email to the addresses you list.',
    channels: ['email'],
    defaultOn: [],
  },
];

export function notificationDefinition(key: string): NotificationDefinition | undefined {
  return NOTIFICATIONS.find((definition) => definition.key === key);
}
