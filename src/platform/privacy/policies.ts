import { ApiError } from '../../core/ApiError';
import { sanitizeMerchantHtml } from '../../core/merchantHtml';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import { ShopScopedCache } from '../cache/shopCache';
import { shopId } from '../tenancy/context';

/**
 * Settings → Policies: the store's legal pages, as on Shopify.
 *
 *   privacy        /policies/privacy-policy        shop.privacy_policy
 *   terms          /policies/terms-of-service      shop.terms_of_service
 *   refund         /policies/refund-policy         shop.refund_policy
 *   shipping       /policies/shipping-policy       shop.shipping_policy
 *   contact        /policies/contact-information   shop.contact_information
 *   legal_notice   /policies/legal-notice          shop.legal_notice
 *
 * Every save that changes the text is a new version, and the old text stays
 * in shop_policy_versions: a consent given under version 3 can be shown with
 * the words version 3 said. An empty policy is no policy — its page is a 404
 * and it is left out of shop.policies.
 */

export type PolicyKind = 'privacy' | 'terms' | 'refund' | 'shipping' | 'contact' | 'legal_notice';

export const POLICY_KINDS: Record<PolicyKind, { handle: string; title: string; liquid: string }> = {
  refund: { handle: 'refund-policy', title: 'Refund policy', liquid: 'refund_policy' },
  privacy: { handle: 'privacy-policy', title: 'Privacy policy', liquid: 'privacy_policy' },
  terms: { handle: 'terms-of-service', title: 'Terms of service', liquid: 'terms_of_service' },
  shipping: { handle: 'shipping-policy', title: 'Shipping policy', liquid: 'shipping_policy' },
  contact: { handle: 'contact-information', title: 'Contact information', liquid: 'contact_information' },
  legal_notice: { handle: 'legal-notice', title: 'Legal notice', liquid: 'legal_notice' },
};

export const POLICY_ORDER: PolicyKind[] = ['refund', 'privacy', 'terms', 'shipping', 'contact', 'legal_notice'];

export function isPolicyKind(value: unknown): value is PolicyKind {
  return typeof value === 'string' && value in POLICY_KINDS;
}

export function kindForHandle(handle: string): PolicyKind | null {
  return (Object.entries(POLICY_KINDS).find(([, entry]) => entry.handle === handle)?.[0] as PolicyKind | undefined) ?? null;
}

export interface Policy {
  id: number;
  kind: PolicyKind;
  handle: string;
  title: string;
  body: string;
  version: number;
  url: string;
  updated_at: string;
}

interface PolicyRow extends RowDataPacket {
  id: number;
  kind: PolicyKind;
  title: string;
  body: string;
  version: number;
  updated_at: Date;
}

/** Policies are staff-written HTML, cleaned like every other piece of it. */
export function sanitizePolicyHtml(html: string): string {
  return sanitizeMerchantHtml(html);
}

function present(row: PolicyRow): Policy {
  const kind = POLICY_KINDS[row.kind];
  return {
    id: Number(row.id),
    kind: row.kind,
    handle: kind.handle,
    title: row.title,
    body: row.body,
    version: Number(row.version),
    url: `/policies/${kind.handle}`,
    updated_at: row.updated_at.toISOString(),
  };
}

const cache = new ShopScopedCache<Policy[]>(30_000);

export const policies = {
  /** The shop's non-empty policies, in Shopify's order. */
  async list(): Promise<Policy[]> {
    return cache.get('policies', async () => {
      const rows = await query<PolicyRow>('SELECT id, kind, title, body, version, updated_at FROM shop_policies WHERE shop_id = ?', [shopId()]);
      return rows
        .filter((row) => row.body.trim() !== '')
        .map(present)
        .sort((a, b) => POLICY_ORDER.indexOf(a.kind) - POLICY_ORDER.indexOf(b.kind));
    });
  },

  async get(kind: PolicyKind): Promise<Policy | null> {
    return (await this.list()).find((policy) => policy.kind === kind) ?? null;
  },

  async byHandle(handle: string): Promise<Policy | null> {
    const kind = kindForHandle(handle);
    return kind ? this.get(kind) : null;
  },

  /** The privacy policy's version — what a consent is given under (0: there is none yet). */
  async privacyVersion(): Promise<number> {
    return (await this.get('privacy'))?.version ?? 0;
  },

  async save(kind: PolicyKind, input: { title?: string | null; body: string }, actor: { id: number | null; label: string | null }): Promise<Policy | null> {
    const body = sanitizePolicyHtml(input.body ?? '');
    const title = (input.title ?? '').trim().slice(0, 191) || POLICY_KINDS[kind].title;
    await withTransaction(async (tx) => {
      const current = await queryOne<PolicyRow>('SELECT id, kind, title, body, version, updated_at FROM shop_policies WHERE shop_id = ? AND kind = ? FOR UPDATE', [shopId(), kind], tx);
      if (current && current.body === body && current.title === title) return;
      const version = current ? Number(current.version) + 1 : 1;
      if (current) {
        await execute('UPDATE shop_policies SET title = ?, body = ?, version = ?, updated_by_admin_id = ? WHERE shop_id = ? AND id = ?', [title, body, version, actor.id, shopId(), current.id], tx);
      } else {
        await execute('INSERT INTO shop_policies (shop_id, kind, title, body, version, updated_by_admin_id) VALUES (?, ?, ?, ?, ?, ?)', [shopId(), kind, title, body, version, actor.id], tx);
      }
      await execute(
        'INSERT INTO shop_policy_versions (shop_id, kind, version, title, body, created_by_admin_id) VALUES (?, ?, ?, ?, ?, ?)',
        [shopId(), kind, version, title, body, actor.id],
        tx,
      );
    });
    cache.clear();
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'policy.updated', entityType: 'policy', entityId: null, summary: `${body ? 'Updated' : 'Cleared'} the ${POLICY_KINDS[kind].title.toLowerCase()}` });
    return this.get(kind);
  },

  /** Every policy for the admin, including empty ones, with the latest version number. */
  async forAdmin() {
    const rows = await query<PolicyRow>('SELECT id, kind, title, body, version, updated_at FROM shop_policies WHERE shop_id = ?', [shopId()]);
    return POLICY_ORDER.map((kind) => {
      const row = rows.find((candidate) => candidate.kind === kind);
      return {
        kind,
        handle: POLICY_KINDS[kind].handle,
        default_title: POLICY_KINDS[kind].title,
        title: row?.title ?? POLICY_KINDS[kind].title,
        body: row?.body ?? '',
        version: row ? Number(row.version) : 0,
        url: `/policies/${POLICY_KINDS[kind].handle}`,
        updated_at: row ? row.updated_at.toISOString() : null,
      };
    });
  },

  async versions(kind: PolicyKind) {
    const rows = await query<RowDataPacket & { version: number; title: string; body: string; created_at: Date; created_by_admin_id: number | null }>(
      'SELECT version, title, body, created_at, created_by_admin_id FROM shop_policy_versions WHERE shop_id = ? AND kind = ? ORDER BY version DESC LIMIT 50',
      [shopId(), kind],
    );
    return rows.map((row) => ({ version: Number(row.version), title: row.title, body: row.body, created_at: row.created_at.toISOString(), created_by_admin_id: row.created_by_admin_id }));
  },

  async version(kind: PolicyKind, version: number) {
    const row = await queryOne<RowDataPacket & { title: string; body: string; created_at: Date }>(
      'SELECT title, body, created_at FROM shop_policy_versions WHERE shop_id = ? AND kind = ? AND version = ?',
      [shopId(), kind, version],
    );
    if (!row) throw ApiError.notFound('Policy version');
    return { kind, version, title: row.title, body: row.body, created_at: row.created_at.toISOString() };
  },
};
