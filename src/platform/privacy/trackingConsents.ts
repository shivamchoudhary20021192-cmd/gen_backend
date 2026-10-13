import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { shopId } from '../tenancy/context';
import type { ConsentMethod, TrackingConsent } from './consentCookie';
import { ipPrefix, type PrivacyRegion } from './regions';

/**
 * The proof of consent: every choice a visitor makes in the banner, the
 * preferences dialog, the opt-out page or their account, as a row that is
 * never changed. GDPR Art. 7(1) asks a controller to be able to show that
 * consent was given; the DPDP Act s.6(10) puts the same burden on a data
 * fiduciary. What is kept is what that needs — when, what for, from where
 * (to the /24), under which privacy policy — and nothing that identifies
 * the visitor unless they were signed in.
 */

export interface ConsentRecordInput {
  consent: TrackingConsent;
  customerId: number | null;
  region: PrivacyRegion;
  locale: string | null;
  pagePath: string | null;
  ip: string | null;
  userAgent: string | null;
}

interface ConsentRow extends RowDataPacket {
  id: number;
  consent_id: string;
  customer_id: number | null;
  country: string | null;
  consent_required: number;
  sale_opt_out_region: number;
  analytics: number;
  marketing: number;
  preferences: number;
  sale_of_data: number;
  method: ConsentMethod;
  gpc: number;
  policy_version: number | null;
  locale: string | null;
  page_path: string | null;
  ip_prefix: string | null;
  user_agent: string | null;
  created_at: Date;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}

function present(row: ConsentRow) {
  return {
    id: Number(row.id),
    consent_id: row.consent_id,
    customer: row.customer_id
      ? { id: Number(row.customer_id), name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null, email: row.email ?? null }
      : null,
    country: row.country,
    consent_required: row.consent_required === 1,
    sale_opt_out_region: row.sale_opt_out_region === 1,
    purposes: {
      analytics: row.analytics === 1,
      marketing: row.marketing === 1,
      preferences: row.preferences === 1,
      sale_of_data: row.sale_of_data === 1,
    },
    method: row.method,
    gpc: row.gpc === 1,
    policy_version: row.policy_version,
    locale: row.locale,
    page_path: row.page_path,
    ip_prefix: row.ip_prefix,
    user_agent: row.user_agent,
    created_at: row.created_at.toISOString(),
  };
}

export const trackingConsents = {
  async record(input: ConsentRecordInput): Promise<void> {
    const { consent, region } = input;
    await execute(
      `INSERT INTO customer_tracking_consents
         (shop_id, consent_id, customer_id, country, consent_required, sale_opt_out_region,
          analytics, marketing, preferences, sale_of_data, method, gpc, policy_version,
          locale, page_path, ip_prefix, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shopId(),
        consent.id,
        input.customerId,
        region.country,
        region.consentRequired ? 1 : 0,
        region.saleOptOut ? 1 : 0,
        consent.purposes.analytics ? 1 : 0,
        consent.purposes.marketing ? 1 : 0,
        consent.purposes.preferences ? 1 : 0,
        consent.purposes.sale_of_data ? 1 : 0,
        consent.method,
        consent.gpc ? 1 : 0,
        consent.policyVersion || null,
        input.locale?.slice(0, 10) ?? null,
        input.pagePath?.slice(0, 255) ?? null,
        ipPrefix(input.ip),
        input.userAgent?.slice(0, 255) ?? null,
      ],
    );
  },

  async list(filters: { page?: number; limit?: number; method?: ConsentMethod; customer_id?: number; consent_id?: string }) {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
    const where = ['t.shop_id = ?'];
    const params: unknown[] = [shopId()];
    if (filters.method) {
      where.push('t.method = ?');
      params.push(filters.method);
    }
    if (filters.customer_id) {
      where.push('t.customer_id = ?');
      params.push(filters.customer_id);
    }
    if (filters.consent_id) {
      where.push('t.consent_id = ?');
      params.push(filters.consent_id);
    }
    const total = await queryOne<RowDataPacket & { n: number }>(`SELECT COUNT(*) AS n FROM customer_tracking_consents t WHERE ${where.join(' AND ')}`, params);
    const rows = await query<ConsentRow>(
      `SELECT t.*, c.first_name, c.last_name, c.email
         FROM customer_tracking_consents t
         LEFT JOIN customers c ON c.shop_id = t.shop_id AND c.id = t.customer_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit],
    );
    return { consents: rows.map(present), pagination: { page, limit, total: Number(total?.n ?? 0) } };
  },

  /** How visitors answered over the last N days: the share of each choice, and of each purpose allowed. */
  async stats(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await query<RowDataPacket & { method: ConsentMethod; n: number; analytics: number; marketing: number; preferences: number; sale_of_data: number }>(
      `SELECT method, COUNT(*) AS n, SUM(analytics) AS analytics, SUM(marketing) AS marketing,
              SUM(preferences) AS preferences, SUM(sale_of_data) AS sale_of_data
         FROM customer_tracking_consents
        WHERE shop_id = ? AND created_at >= ?
        GROUP BY method`,
      [shopId(), since],
    );
    const total = rows.reduce((sum, row) => sum + Number(row.n), 0);
    const sum = (key: 'analytics' | 'marketing' | 'preferences' | 'sale_of_data') => rows.reduce((acc, row) => acc + Number(row[key] ?? 0), 0);
    const share = (value: number) => (total ? Math.round((value / total) * 1000) / 10 : 0);
    const countries = await query<RowDataPacket & { country: string | null; n: number }>(
      `SELECT country, COUNT(*) AS n FROM customer_tracking_consents
        WHERE shop_id = ? AND created_at >= ? GROUP BY country ORDER BY n DESC LIMIT 8`,
      [shopId(), since],
    );
    return {
      days,
      total,
      by_method: Object.fromEntries(rows.map((row) => [row.method, Number(row.n)])),
      allowed_percent: {
        analytics: share(sum('analytics')),
        marketing: share(sum('marketing')),
        preferences: share(sum('preferences')),
        sale_of_data: share(sum('sale_of_data')),
      },
      countries: countries.map((row) => ({ country: row.country, count: Number(row.n) })),
    };
  },
};
