/**
 * In-process subscribers to domain events: the notification engine sending an
 * order confirmation on orders/create, an automation reacting to a new review.
 *
 * Each subscriber receives each event in its own job, so a failing SMS
 * provider retries the SMS without re-running the email, and one slow
 * subscriber never delays another.
 */

export interface DomainEvent<P = Record<string, unknown>> {
  id: number;
  uuid: string;
  shopId: number;
  topic: string;
  resourceType: string | null;
  resourceId: number | null;
  payload: P;
  actorType: string | null;
  actorId: number | null;
  occurredAt: Date;
}

export interface Subscriber {
  name: string;
  /** Exact topics, or `orders/*` for a whole resource. */
  topics: string[];
  handle(event: DomainEvent): Promise<void>;
}

const subscribers = new Map<string, Subscriber>();

export function subscribe(subscriber: Subscriber): void {
  if (subscribers.has(subscriber.name)) throw new Error(`Subscriber ${subscriber.name} is registered twice.`);
  subscribers.set(subscriber.name, subscriber);
}

export function subscriber(name: string): Subscriber | undefined {
  return subscribers.get(name);
}

export function subscribersFor(topic: string): Subscriber[] {
  const resource = `${topic.split('/')[0]}/*`;
  return [...subscribers.values()].filter((s) => s.topics.includes(topic) || s.topics.includes(resource) || s.topics.includes('*'));
}
