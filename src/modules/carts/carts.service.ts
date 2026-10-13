import { randomUUID } from 'node:crypto';
import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination, type PaginationMeta } from '../../core/pagination';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { cartsRepository, type AbandonedCartRow } from './carts.repository';
import { storefrontLink, storefrontUrl } from '../../platform/shops/urls';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId?: string;
}

const SORTABLE: Record<string, string> = {
  newest: 'c.abandoned_at DESC, c.id DESC',
  oldest: 'c.abandoned_at ASC, c.id ASC',
  value: 'live_subtotal DESC',
};

/** How long a cart sits untouched before it counts as abandoned. */
const IDLE_HOURS = 4;

function money(value: string | number | null): number {
  return value === null ? 0 : Number(Number(value).toFixed(2));
}

/** Masked the way the customer list masks — a queue is not a contact export. */
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  if (phone.length <= 4) return phone;
  return `${'•'.repeat(phone.length - 4)}${phone.slice(-4)}`;
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const head = local.slice(0, 2);
  return `${head}${'•'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}

function present(row: AbandonedCartRow, storefrontBase: string) {
  const abandonedAt = row.abandoned_at ? new Date(row.abandoned_at) : null;
  return {
    id: row.id,
    customer: {
      id: row.customer_id,
      name: row.customer_name?.trim() || null,
      phone: maskPhone(row.customer_phone),
      email: maskEmail(row.customer_email),
      /** Whether there is anyone to reach at all. */
      reachable: Boolean(row.customer_phone || row.customer_email),
    },
    item_count: Number(row.live_item_count ?? 0),
    value: money(row.live_subtotal),
    pincode: row.pincode,
    status: row.status,
    abandoned_at: abandonedAt ? abandonedAt.toISOString() : null,
    hours_since: abandonedAt ? Math.floor((Date.now() - abandonedAt.getTime()) / 3600_000) : null,
    last_contacted_at: row.recovery_email_sent_at ? row.recovery_email_sent_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
    /**
     * Only present once a recovery link has been generated. Generating it is a
     * deliberate action rather than something every list row carries, because
     * the link restores someone's bag to whoever holds it.
     */
    recovery_url: row.recovery_token ? storefrontLink(`/cart/recover/${row.recovery_token}`) : null,
  };
}


/** This shop's storefront, where a recovery link sends the customer. */
function storefrontBase(): string {
  return storefrontUrl();
}

export const cartsService = {
  async listAbandoned(
    queryParams: Record<string, unknown>,
  ): Promise<{ carts: unknown[]; pagination: PaginationMeta }> {
    const page = parsePagination(queryParams);
    const sortKey = typeof queryParams.sort === 'string' ? queryParams.sort : '';
    const orderBy = SORTABLE[sortKey] ?? SORTABLE.newest;

    const filters = {
      search: queryParams.q as string | undefined,
      minValue: queryParams.min_value as number | undefined,
      hasContact: queryParams.reachable as boolean | undefined,
      from: queryParams.from as string | undefined,
      to: queryParams.to as string | undefined,
    };

    const [rows, total, stats, recovered] = await Promise.all([
      cartsRepository.list(filters, orderBy, page.limit, page.offset),
      cartsRepository.count(filters),
      cartsRepository.stats(filters),
      cartsRepository.recoveredCount(30),
    ]);

    const base = storefrontBase();
    return {
      carts: rows.map((row) => present(row, base)),
      pagination: buildMeta(total, page),
      stats: {
        abandoned_carts: Number(stats?.carts ?? 0),
        value_at_risk: money(stats?.value ?? 0),
        recovered_last_30_days: recovered,
      },
    } as never;
  },

  async get(id: number) {
    const row = await cartsRepository.findById(id);
    if (!row) throw ApiError.notFound('Cart');
    const items = await cartsRepository.itemsFor(id);

    return {
      cart: {
        ...present(row, storefrontBase()),
        items: items.map((item) => ({
          id: item.id,
          variant_id: item.variant_id,
          sku: item.sku,
          name: item.product_name,
          slug: item.product_slug,
          variant_title: item.variant_title,
          quantity: item.quantity,
          unit_price: money(item.price),
          line_total: money(Number(item.price) * item.quantity),
          // Worth knowing before ringing someone: half of abandoned carts that
          // cannot be recovered are ones where the item has since sold out.
          in_stock: item.track_inventory === 0 || Number(item.available) >= item.quantity,
          available: item.track_inventory === 0 ? null : Number(item.available),
        })),
      },
    };
  },

  /**
   * Sweeps stale carts into the queue.
   *
   * There is no scheduler yet, so this runs when the screen is opened. The
   * alternative — a background job nothing starts — would leave a queue that is
   * permanently empty and looks broken.
   */
  async sweep(actor: AuthenticatedAdmin, meta: ActorMeta) {
    const marked = await cartsRepository.markStaleAbandoned(IDLE_HOURS);
    if (marked > 0) {
      await auditService.log({
        actorId: actor.id,
        actorLabel: actor.email,
        action: 'cart.swept',
        entityType: 'cart',
        entityId: 0,
        summary: `Marked ${marked} cart(s) abandoned after ${IDLE_HOURS}h idle`,
        context: { request_id: meta.requestId },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return { marked_abandoned: marked, idle_hours: IDLE_HOURS };
  },

  /**
   * Mints a link that restores this bag on the storefront.
   *
   * The token is a fresh UUID rather than the cart token, so a recovery link
   * shared in a WhatsApp thread can be invalidated by generating a new one
   * without destroying the cart itself.
   */
  async recoveryLink(id: number, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const row = await cartsRepository.findById(id);
    if (!row) throw ApiError.notFound('Cart');
    if (row.converted_order_id) {
      throw ApiError.conflict('This cart already became an order — there is nothing to recover.');
    }

    const token = row.recovery_token ?? randomUUID();
    if (!row.recovery_token) await cartsRepository.setRecoveryToken(id, token);

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'cart.recovery_link_created',
      entityType: 'cart',
      entityId: id,
      summary: `Generated a recovery link for cart ${id}`,
      context: { request_id: meta.requestId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { recovery_url: `${storefrontBase()}/cart/recover/${token}`, token };
  },

  /** Records that someone reached out, so two people do not chase the same cart. */
  async markContacted(id: number, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const row = await cartsRepository.findById(id);
    if (!row) throw ApiError.notFound('Cart');
    await cartsRepository.markContacted(id);

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'cart.contacted',
      entityType: 'cart',
      entityId: id,
      summary: `Marked cart ${id} as contacted`,
      context: { request_id: meta.requestId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.get(id);
  },

  async dismiss(id: number, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const row = await cartsRepository.findById(id);
    if (!row) throw ApiError.notFound('Cart');
    await cartsRepository.dismiss(id);

    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.email,
      action: 'cart.dismissed',
      entityType: 'cart',
      entityId: id,
      summary: `Dismissed abandoned cart ${id}`,
      context: { request_id: meta.requestId },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { dismissed: true };
  },

  /**
   * The storefront side of a recovery link: hands back the cart token.
   *
   * Public, so it deliberately returns nothing but the token — no customer name,
   * no email, no order history. Someone with a forwarded link gets the bag,
   * which is the point, and nothing else about the person it belonged to.
   */
  async redeemRecoveryToken(token: string) {
    const row = await cartsRepository.findByRecoveryToken(token);
    if (!row) throw ApiError.notFound('Cart');
    await cartsRepository.reactivate(row.id);
    return { token: row.token };
  },
};
