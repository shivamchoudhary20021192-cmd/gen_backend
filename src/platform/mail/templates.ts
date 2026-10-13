import { env } from '../../config/env';
import { formatMoney } from '../shops/format';

/**
 * The platform's own emails. Plain text, short, and specific: what happened,
 * what it means for the store, and the one thing to do next. Each template
 * declares the data it needs, so a caller cannot send an invitation without
 * the link.
 */

export interface TemplateData {
  'staff.invitation': { shopName: string; inviterName: string; acceptUrl: string; expiresDays: number };
  'staff.added': { shopName: string; inviterName: string; loginUrl: string };
  'auth.password_reset': { resetUrl: string; expiresMinutes: number };
  'auth.password_changed': { at: Date };
  'billing.receipt': { shopName: string; number: string; total: number; currency: string; lines: { description: string; amount: number }[] };
  'billing.payment_failed': { shopName: string; number: string; total: number; currency: string; reason: string; nextAttempt: Date | null; billingUrl: string; graceDays: number };
  'billing.store_frozen': { shopName: string; number: string; billingUrl: string };
  'billing.store_unfrozen': { shopName: string };
  'billing.trial_ending': { shopName: string; trialEnds: Date; planName: string; price: number; currency: string; hasCard: boolean; billingUrl: string };
}

export type TemplateKey = keyof TemplateData;

export interface RenderedEmail {
  subject: string;
  body: string;
  /** Carries a secret (a reset link): its body is not kept once delivered. */
  sensitive: boolean;
}

const platform = () => env.platform.name;

function day(value: Date): string {
  return value.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function money(amount: number, currency: string): string {
  return formatMoney(amount, { currency });
}

function sign(lines: string[]): string {
  return [...lines, '', `— ${platform()}`].join('\n');
}

const TEMPLATES: { [K in TemplateKey]: (data: TemplateData[K]) => RenderedEmail } = {
  'staff.invitation': (data) => ({
    subject: `${data.inviterName} invited you to ${data.shopName}`,
    body: sign([
      `${data.inviterName} has invited you to help run ${data.shopName} on ${platform()}.`,
      '',
      `Accept the invitation and choose a password: ${data.acceptUrl}`,
      '',
      `The link works for ${data.expiresDays} days. If you were not expecting this, ignore it — nothing happens until you accept.`,
    ]),
    sensitive: true,
  }),

  'staff.added': (data) => ({
    subject: `You now have access to ${data.shopName}`,
    body: sign([
      `${data.inviterName} added you to ${data.shopName}. Sign in with your existing ${platform()} account and pick it from your stores: ${data.loginUrl}`,
    ]),
    sensitive: false,
  }),

  'auth.password_reset': (data) => ({
    subject: `Reset your ${platform()} password`,
    body: sign([
      'Someone asked to reset the password for this account. If it was you, choose a new one here:',
      '',
      data.resetUrl,
      '',
      `The link works once, for ${data.expiresMinutes} minutes. If it was not you, ignore this email: your password has not changed.`,
    ]),
    sensitive: true,
  }),

  'auth.password_changed': (data) => ({
    subject: `Your ${platform()} password was changed`,
    body: sign([
      `The password for this account was changed on ${day(data.at)}, and every other device was signed out.`,
      '',
      'If this was not you, reset your password straight away and contact support.',
    ]),
    sensitive: false,
  }),

  'billing.receipt': (data) => ({
    subject: `Receipt for ${data.shopName}: ${money(data.total, data.currency)} (${data.number})`,
    body: sign([
      `Thank you — bill ${data.number} for ${data.shopName} is paid.`,
      '',
      ...data.lines.map((line) => `  ${line.description}: ${money(line.amount, data.currency)}`),
      '',
      `Total paid: ${money(data.total, data.currency)}`,
    ]),
    sensitive: false,
  }),

  'billing.payment_failed': (data) => ({
    subject: `We could not charge your card for ${data.shopName}`,
    body: sign([
      `Bill ${data.number} for ${data.shopName} (${money(data.total, data.currency)}) could not be paid: ${data.reason}`,
      '',
      data.nextAttempt
        ? `We will try again on ${day(data.nextAttempt)}. To pay now, or to use another card: ${data.billingUrl}`
        : `We will not try again automatically. Pay it, or add another card, here: ${data.billingUrl}`,
      '',
      `If the bill stays unpaid for ${data.graceDays} days, the store is frozen until it is settled: customers cannot place orders while it is.`,
    ]),
    sensitive: false,
  }),

  'billing.store_frozen': (data) => ({
    subject: `${data.shopName} is frozen: bill ${data.number} is unpaid`,
    body: sign([
      `${data.shopName} has been frozen because bill ${data.number} is still unpaid. Customers cannot place orders, and the admin is read-only apart from Billing.`,
      '',
      `Pay the bill or add a working card and the store reopens at once: ${data.billingUrl}`,
    ]),
    sensitive: false,
  }),

  'billing.store_unfrozen': (data) => ({
    subject: `${data.shopName} is open again`,
    body: sign([`Thank you — everything owed is paid, and ${data.shopName} is taking orders again.`]),
    sensitive: false,
  }),

  'billing.trial_ending': (data) => ({
    subject: `Your ${data.shopName} trial ends on ${day(data.trialEnds)}`,
    body: sign([
      `The free trial of ${data.shopName} ends on ${day(data.trialEnds)}. After that, the ${data.planName} plan is ${money(data.price, data.currency)} a month.`,
      '',
      data.hasCard
        ? 'Your card on file will be charged then; there is nothing you need to do.'
        : `There is no card on file yet. Add one so the store keeps running: ${data.billingUrl}`,
    ]),
    sensitive: false,
  }),
};

export function renderEmail<K extends TemplateKey>(template: K, data: TemplateData[K]): RenderedEmail {
  return TEMPLATES[template](data);
}

/** An address in the merchant admin. */
export function adminUrl(path: string): string {
  return `${env.platform.adminUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
