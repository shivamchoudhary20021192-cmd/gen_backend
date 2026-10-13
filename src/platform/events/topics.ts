/**
 * Every event the platform emits, and who may hear it.
 *
 * Topic names follow Shopify's `resource/action` convention so an app author
 * who has integrated with one can read this list without a glossary. Each
 * names the scope an app needs to subscribe: an app that cannot read orders
 * through the API must not be able to read them by webhook either.
 *
 * `compliance` topics are the privacy requests every public app must handle
 * (Shopify's mandatory GDPR webhooks). They are sent whether or not an app
 * subscribed, to every app installed on the shop.
 */

export interface TopicDefinition {
  topic: string;
  description: string;
  /** Scope an app needs to subscribe. Null: any installed app may. */
  requiredScope: string | null;
  compliance?: boolean;
}

const TOPICS: TopicDefinition[] = [
  { topic: 'orders/create', description: 'An order was placed', requiredScope: 'read_orders' },
  { topic: 'orders/updated', description: 'An order changed', requiredScope: 'read_orders' },
  { topic: 'orders/paid', description: 'An order was paid in full', requiredScope: 'read_orders' },
  { topic: 'orders/payment_failed', description: 'An online payment for an order failed', requiredScope: 'read_orders' },
  { topic: 'orders/cancelled', description: 'An order was cancelled', requiredScope: 'read_orders' },
  { topic: 'orders/fulfilled', description: 'Every item in an order was shipped', requiredScope: 'read_orders' },
  { topic: 'refunds/create', description: 'A refund was issued', requiredScope: 'read_orders' },
  { topic: 'fulfillments/create', description: 'A shipment was created', requiredScope: 'read_fulfillments' },
  { topic: 'fulfillments/update', description: 'A shipment’s tracking changed', requiredScope: 'read_fulfillments' },
  { topic: 'returns/request', description: 'A customer asked to return items', requiredScope: 'read_orders' },
  { topic: 'products/create', description: 'A product was created', requiredScope: 'read_products' },
  { topic: 'products/update', description: 'A product changed', requiredScope: 'read_products' },
  { topic: 'products/delete', description: 'A product was deleted', requiredScope: 'read_products' },
  { topic: 'collections/create', description: 'A collection was created', requiredScope: 'read_products' },
  { topic: 'collections/update', description: 'A collection changed', requiredScope: 'read_products' },
  { topic: 'collections/delete', description: 'A collection was deleted', requiredScope: 'read_products' },
  { topic: 'inventory_levels/update', description: 'Stock at a location changed', requiredScope: 'read_inventory' },
  { topic: 'customers/create', description: 'A customer account was created', requiredScope: 'read_customers' },
  { topic: 'customers/update', description: 'A customer changed', requiredScope: 'read_customers' },
  { topic: 'customers/delete', description: 'A customer was deleted', requiredScope: 'read_customers' },
  { topic: 'carts/create', description: 'A cart was created', requiredScope: 'read_orders' },
  { topic: 'carts/update', description: 'A cart changed', requiredScope: 'read_orders' },
  { topic: 'checkouts/abandoned', description: 'A cart was left without buying', requiredScope: 'read_orders' },
  { topic: 'discounts/create', description: 'A discount was created', requiredScope: 'read_discounts' },
  { topic: 'discounts/update', description: 'A discount changed', requiredScope: 'read_discounts' },
  { topic: 'discounts/delete', description: 'A discount was deleted', requiredScope: 'read_discounts' },
  { topic: 'reviews/create', description: 'A review was submitted', requiredScope: 'read_reviews' },
  { topic: 'themes/publish', description: 'A theme was published', requiredScope: 'read_themes' },
  { topic: 'themes/update', description: 'A theme changed', requiredScope: 'read_themes' },
  { topic: 'shop/update', description: 'Store details changed', requiredScope: null },
  { topic: 'app/uninstalled', description: 'This app was removed from the store', requiredScope: null },
  {
    topic: 'customers/data_request',
    description: 'A customer asked for the data held about them',
    requiredScope: null,
    compliance: true,
  },
  { topic: 'customers/redact', description: 'A customer asked to be erased', requiredScope: null, compliance: true },
  { topic: 'shop/redact', description: 'The store closed; erase its data', requiredScope: null, compliance: true },
];

const BY_TOPIC = new Map(TOPICS.map((definition) => [definition.topic, definition]));

export type Topic = (typeof TOPICS)[number]['topic'];

export function topicDefinition(topic: string): TopicDefinition | undefined {
  return BY_TOPIC.get(topic);
}

export function allTopics(): readonly TopicDefinition[] {
  return TOPICS;
}

export function isComplianceTopic(topic: string): boolean {
  return BY_TOPIC.get(topic)?.compliance === true;
}
