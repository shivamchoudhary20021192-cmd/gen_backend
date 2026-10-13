import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination } from '../../core/pagination';
import { logger } from '../../core/logger';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { storage } from '../media/storage';
import { channelDelivers } from '../messaging/providers';
import { messagingService } from '../messaging/messaging.service';
import {
  reengagementRepository,
  type AudienceFilters,
  type InterestedCustomerRow,
} from './reengagement.repository';
import { storefrontLink } from '../../platform/shops/urls';
import { formatMoney } from '../../platform/shops/format';

/**
 * Reaching people who wanted something and did not buy it.
 *
 * The rule this module exists to enforce, stated once: **a message only goes to
 * someone who has opted in.** It is checked twice on purpose — when the audience
 * is built, so the screen shows an honest number, and again inside
 * `messagingService.send` at the moment of sending, so a consent withdrawn
 * between preview and send is respected. The second check is the one that
 * counts; the first is only there so nobody is surprised by the result.
 *
 * WhatsApp's own policy requires opt-in for business-initiated marketing and
 * degrades a number that ignores it until it stops delivering, and India's DPDP
 * Act 2023 requires consent for processing personal data for marketing. Neither
 * is a formality: the cost of getting it wrong is a dead WhatsApp number.
 */

/** The event key for the nudge. Its template decides the wording. */
const SAVED_EVENT = 'cart.abandoned';

function imageUrl(key: string | null): string | null {
  return key ? storage.publicUrl(key) : null;
}

function present(row: InterestedCustomerRow) {
  const contactable = row.consent_status === 'granted' && row.accepts_whatsapp_marketing === 1;
  return {
    customer: {
      id: row.public_id,
      name: row.first_name,
      // Masked in the list, as on every other customer-facing admin screen.
      // Sending does not need a human to read the number.
      phone: `${row.phone.slice(0, 2)}••••${row.phone.slice(-3)}`,
      contactable,
      /** Why not, when not — so the number on screen can be acted on. */
      reason: contactable
        ? null
        : row.consent_status === 'withdrawn'
          ? 'Opted out of WhatsApp'
          : 'Never opted in to WhatsApp',
    },
    product: {
      id: row.product_id,
      slug: row.slug,
      name: row.product_name,
      image: imageUrl(row.primary_image_key),
      price: row.price === null ? null : Number(row.price),
      in_stock: Number(row.in_stock) > 0,
    },
    interest: row.interest,
    interested_at: row.interested_at,
    last_contacted_at: row.last_contacted_at,
  };
}

function parseFilters(queryParams: Record<string, unknown>): AudienceFilters {
  return {
    interest: typeof queryParams.interest === 'string' ? queryParams.interest : undefined,
    contactableOnly: queryParams.contactable === true || queryParams.contactable === 'true',
    inStockOnly: queryParams.in_stock === true || queryParams.in_stock === 'true',
    withinDays: queryParams.within_days ? Number(queryParams.within_days) : undefined,
  };
}

export const reengagementService = {
  async list(queryParams: Record<string, unknown>) {
    const page = parsePagination(queryParams);
    const filters = parseFilters(queryParams);

    const [rows, total, summary] = await Promise.all([
      reengagementRepository.listInterested(filters, page.limit, page.offset),
      reengagementRepository.countInterested(filters),
      reengagementRepository.summary(filters),
    ]);

    return {
      audience: rows.map(present),
      pagination: buildMeta(total, page),
      summary: {
        ...summary,
        /**
         * Whether anything would actually be sent.
         *
         * Without a provider the pipeline records and does not send. The screen
         * has to say so, or someone will press Send, see a row of green ticks
         * in the log, and believe forty people were messaged.
         */
        can_send: await channelDelivers('whatsapp'),
      },
    };
  },

  /**
   * Sends the nudge to everyone in the audience who may be contacted.
   *
   * Sequential rather than parallel: these are messages to real people through
   * a provider that rate-limits, and a burst of two hundred is how an account
   * gets throttled. `limit` caps a single run so a mistake is a small mistake.
   */
  async send(
    input: { queryParams: Record<string, unknown>; limit: number; dryRun: boolean },
    actor: AuthenticatedAdmin,
    meta: { ip: string | null; userAgent: string | null; requestId: string },
  ) {
    const filters = { ...parseFilters(input.queryParams), contactableOnly: true };
    const rows = await reengagementRepository.listInterested(filters, Math.min(input.limit, 200), 0);

    if (rows.length === 0) {
      return {
        attempted: 0,
        sent: 0,
        skipped: [],
        dry_run: input.dryRun,
        message: 'Nobody in this audience has opted in to WhatsApp, so there was nobody to message.',
      };
    }

    // One message per person, not per saved product. Someone who saved four
    // things should hear from the shop once.
    const firstPerCustomer = new Map<number, InterestedCustomerRow>();
    for (const row of rows) {
      if (!firstPerCustomer.has(row.customer_id)) firstPerCustomer.set(row.customer_id, row);
    }
    const recipients = [...firstPerCustomer.values()];

    if (input.dryRun) {
      return {
        attempted: recipients.length,
        sent: 0,
        skipped: [],
        dry_run: true,
        message: `${recipients.length} ${recipients.length === 1 ? 'person' : 'people'} would be messaged.`,
      };
    }

    let sent = 0;
    const skipped: { customer: string; reason: string }[] = [];

    for (const row of recipients) {
      const outcome = await messagingService.send({
        eventKey: SAVED_EVENT,
        channel: 'whatsapp',
        to: `${row.country_code}${row.phone}`.replace('+', ''),
        variables: {
          name: row.first_name ?? 'there',
          product_name: row.product_name,
          product_url: storefrontLink(`/product/${row.slug}`),
          price: row.price === null ? '' : formatMoney(Number(row.price), { wholeUnits: true }),
        },
        customerId: row.customer_id,
      });

      if (outcome.sent) sent += 1;
      else skipped.push({ customer: row.public_id, reason: outcome.detail });
    }

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'reengagement.sent',
      entityType: 'customer',
      summary: `Sent ${sent} WhatsApp ${sent === 1 ? 'message' : 'messages'} to people who saved or carted without buying`,
      changes: { attempted: recipients.length, sent, skipped: skipped.length },
      context: { request_id: meta.requestId, filters },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    logger.info('reengagement.batch_sent', { attempted: recipients.length, sent, skipped: skipped.length });

    return {
      attempted: recipients.length,
      sent,
      skipped,
      dry_run: false,
      message: (await channelDelivers('whatsapp'))
        ? `${sent} of ${recipients.length} messaged.`
        : `${sent} ${sent === 1 ? 'message' : 'messages'} recorded. No WhatsApp provider is connected, so nothing was actually delivered.`,
    };
  },

  /** Guard for the routes: the template has to exist before anything is sent. */
  async assertTemplateReady() {
    const { messagingRepository } = await import('../messaging/messaging.repository');
    const template = await messagingRepository.findTemplate(SAVED_EVENT, 'whatsapp');
    if (!template) {
      throw ApiError.conflict(
        'There is no active WhatsApp template for this message yet. Add one in the message templates before sending.',
      );
    }
    return template;
  },
};

export { SAVED_EVENT };
