import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { logger } from '../../../core/logger';

/**
 * Buying a domain for a store — Shopify's "Buy new domain".
 *
 * The platform is a reseller: a registrar holds the registration, the
 * platform manages it (renewals on the store's bill, DNS pointed at the edge
 * at purchase, a transfer code on request). One interface, so the registrar
 * can change without the flow changing:
 *
 *   REGISTRAR=sandbox   development and tests: deterministic availability and
 *                       prices, instant registration; DNS goes into the
 *                       DNS_STATIC_FILE the checks read, so a bought domain
 *                       walks through connection exactly as a real one does.
 *                       A transfer in completes SANDBOX_TRANSFER_SECONDS (60)
 *                       after it is asked for; a code starting "bad" is
 *                       rejected by the "losing registrar".
 *   REGISTRAR=namecom   Name.com's reseller API v4 (NAMECOM_USERNAME,
 *                       NAMECOM_TOKEN; NAMECOM_API_URL=https://api.dev.name.com
 *                       for their test environment)
 */

export interface DomainOffer {
  domain: string;
  available: boolean;
  premium: boolean;
  /** First-year price and yearly renewal, in `currency`. */
  price: number;
  renewal: number;
  currency: string;
}

export interface RegistrantContact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  organization?: string | null;
}

export interface DnsRecordInput {
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT';
  /** '' for the domain itself, 'www' for www.<domain>. */
  host: string;
  value: string;
  ttl?: number;
}

/** Whether a domain registered elsewhere can move here, and what it costs (a transfer adds a year). */
export interface TransferQuote {
  domain: string;
  eligible: boolean;
  /** Why not, in words a merchant can act on. */
  reason: string | null;
  price: number;
  currency: string;
}

export interface TransferProgress {
  status: 'pending' | 'completed' | 'failed';
  reason: string | null;
  expiresAt: Date | null;
}

export interface RegistrarProvider {
  readonly name: string;
  search(keyword: string): Promise<DomainOffer[]>;
  check(domain: string): Promise<DomainOffer>;
  register(input: { domain: string; years: number; price: number; privacy: boolean; contact: RegistrantContact | null }): Promise<{ orderId: string; expiresAt: Date }>;
  setRecords(domain: string, records: DnsRecordInput[]): Promise<void>;
  renew(domain: string, years: number, price: number): Promise<{ expiresAt: Date }>;
  authCode(domain: string): Promise<string>;
  transferQuote(domain: string): Promise<TransferQuote>;
  /** Asks the registry to move the domain here; the losing registrar has days to let it go. */
  transferIn(input: { domain: string; authCode: string; price: number; privacy: boolean; contact: RegistrantContact | null }): Promise<{ orderId: string }>;
  transferStatus(domain: string): Promise<TransferProgress>;
}

export class RegistrarError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RegistrarError';
  }
}

/** The extensions offered in a search, most wanted first. */
const SEARCH_TLDS = ['com', 'store', 'shop', 'in', 'co.in', 'co', 'net', 'online', 'io', 'co.uk'];

// ── sandbox ────────────────────────────────────────────────────────────────

const SANDBOX_PRICES: Record<string, [number, number]> = {
  com: [12.99, 14.99],
  net: [13.99, 15.99],
  store: [4.99, 49.99],
  shop: [3.99, 34.99],
  in: [7.99, 9.99],
  'co.in': [5.99, 7.99],
  co: [11.99, 29.99],
  online: [2.99, 34.99],
  io: [39.99, 49.99],
  'co.uk': [8.99, 10.99],
};

const TAKEN = new Set(['google', 'amazon', 'shopify', 'veylog', 'example', 'test', 'store', 'shop']);

class SandboxRegistrar implements RegistrarProvider {
  readonly name = 'sandbox';
  private readonly registered = new Map<string, Date>();

  async check(domain: string): Promise<DomainOffer> {
    const [label, ...rest] = domain.split('.');
    const tld = rest.join('.');
    const [price, renewal] = SANDBOX_PRICES[tld] ?? [14.99, 16.99];
    // Deterministic: the same name is always available or always taken.
    const hash = createHash('sha1').update(domain).digest()[0];
    const available = !TAKEN.has(label) && !this.registered.has(domain) && hash % 4 !== 0;
    const premium = label.length <= 3;
    return { domain, available, premium, price: premium ? price * 40 : price, renewal: premium ? renewal * 10 : renewal, currency: 'USD' };
  }

  async search(keyword: string): Promise<DomainOffer[]> {
    const label = keyword.toLowerCase().replace(/\.[a-z.]+$/, '').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 63);
    if (!label) return [];
    const exact = keyword.includes('.') ? [keyword.toLowerCase()] : [];
    const names = [...new Set([...exact, ...SEARCH_TLDS.map((tld) => `${label}.${tld}`)])];
    return Promise.all(names.map((domain) => this.check(domain)));
  }

  async register(input: { domain: string; years: number }): Promise<{ orderId: string; expiresAt: Date }> {
    const offer = await this.check(input.domain);
    if (!offer.available) throw new RegistrarError(`${input.domain} is not available.`);
    const expiresAt = new Date(Date.now() + input.years * 365 * 86_400_000);
    this.registered.set(input.domain, expiresAt);
    return { orderId: `sandbox-${randomUUID()}`, expiresAt };
  }

  /** Writes the records where the platform's DNS checks look in development. */
  async setRecords(domain: string, records: DnsRecordInput[]): Promise<void> {
    const file = process.env.DNS_STATIC_FILE;
    if (!file) return;
    const zone = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8') || '{}') as Record<string, Record<string, string[]>>) : {};
    for (const record of records) {
      const name = record.host ? `${record.host}.${domain}` : domain;
      zone[name] = { ...(zone[name] ?? {}), [record.type]: [...new Set([...(zone[name]?.[record.type] ?? []).filter(() => record.type === 'TXT'), record.value])] };
    }
    writeFileSync(file, JSON.stringify(zone, null, 2));
  }

  async renew(domain: string, years: number): Promise<{ expiresAt: Date }> {
    const current = this.registered.get(domain) ?? new Date();
    const expiresAt = new Date(Math.max(current.getTime(), Date.now()) + years * 365 * 86_400_000);
    this.registered.set(domain, expiresAt);
    return { expiresAt };
  }

  async authCode(): Promise<string> {
    return randomBytes(8).toString('base64url');
  }

  /**
   * Transfers asked for, kept in a file beside DNS_STATIC_FILE (or
   * SANDBOX_REGISTRAR_FILE) when there is one, so the worker that follows a
   * transfer sees what the API process asked for; in memory otherwise.
   */
  private readonly memory = new Map<string, { at: number; authCode: string }>();

  private stateFile(): string | null {
    const explicit = process.env.SANDBOX_REGISTRAR_FILE;
    if (explicit) return explicit;
    const dns = process.env.DNS_STATIC_FILE;
    return dns ? dns.replace(/(\.json)?$/, '.registrar.json') : null;
  }

  private readonly transfers = {
    read: (): Map<string, { at: number; authCode: string }> => {
      const file = this.stateFile();
      if (!file) return this.memory;
      try {
        return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, { at: number; authCode: string }>));
      } catch {
        return new Map();
      }
    },
    write: (state: Map<string, { at: number; authCode: string }>) => {
      const file = this.stateFile();
      if (file) writeFileSync(file, JSON.stringify(Object.fromEntries(state), null, 1));
    },
    get: (domain: string) => this.transfers.read().get(domain),
    set: (domain: string, value: { at: number; authCode: string }) => {
      const state = this.transfers.read();
      state.set(domain, value);
      this.transfers.write(state);
    },
    delete: (domain: string) => {
      const state = this.transfers.read();
      state.delete(domain);
      this.transfers.write(state);
    },
  };

  async transferQuote(domain: string): Promise<TransferQuote> {
    const [label, ...rest] = domain.split('.');
    const [, renewal] = SANDBOX_PRICES[rest.join('.')] ?? [14.99, 16.99];
    if (this.registered.has(domain)) return { domain, eligible: false, reason: `${domain} is already registered here.`, price: renewal, currency: 'USD' };
    if (label.length <= 3) return { domain, eligible: false, reason: 'Premium domains cannot be transferred here. Keep it where it is — it stays connected.', price: renewal, currency: 'USD' };
    return { domain, eligible: true, reason: null, price: renewal, currency: 'USD' };
  }

  async transferIn(input: { domain: string; authCode: string }): Promise<{ orderId: string }> {
    if (input.authCode.trim().length < 6) throw new RegistrarError('That transfer code is too short. Copy the whole code from your current provider.');
    this.transfers.set(input.domain, { at: Date.now(), authCode: input.authCode });
    return { orderId: `sandbox-transfer-${randomUUID()}` };
  }

  async transferStatus(domain: string): Promise<TransferProgress> {
    const transfer = this.transfers.get(domain);
    // A restarted sandbox has forgotten the request: treat it as long done.
    const waited = transfer ? Date.now() - transfer.at : Number.POSITIVE_INFINITY;
    if (transfer?.authCode.toLowerCase().startsWith('bad')) {
      this.transfers.delete(domain);
      return { status: 'failed', reason: 'Your current provider rejected the transfer code. Get a new code from them and try again.', expiresAt: null };
    }
    if (waited < Number(process.env.SANDBOX_TRANSFER_SECONDS ?? 60) * 1000) return { status: 'pending', reason: null, expiresAt: null };
    this.transfers.delete(domain);
    const expiresAt = new Date(Date.now() + 365 * 86_400_000);
    this.registered.set(domain, expiresAt);
    return { status: 'completed', reason: null, expiresAt };
  }
}

// ── Name.com (API v4) ──────────────────────────────────────────────────────

class NameComRegistrar implements RegistrarProvider {
  readonly name = 'namecom';
  constructor(
    private readonly username: string,
    private readonly token: string,
    private readonly base: string,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, {
        ...init,
        headers: { Authorization: `Basic ${Buffer.from(`${this.username}:${this.token}`).toString('base64')}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new RegistrarError(`The registrar did not answer: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    const body = (await response.json().catch(() => ({}))) as T & { message?: string; details?: string };
    if (!response.ok) throw new RegistrarError(`Registrar: ${body.message ?? `HTTP ${response.status}`}${body.details ? ` (${body.details})` : ''}`, response.status >= 500 || response.status === 429);
    return body;
  }

  private offer(result: { domainName: string; purchasable?: boolean; premium?: boolean; purchasePrice?: number; renewalPrice?: number }): DomainOffer {
    return {
      domain: result.domainName,
      available: Boolean(result.purchasable),
      premium: Boolean(result.premium),
      price: Number(result.purchasePrice ?? 0),
      renewal: Number(result.renewalPrice ?? result.purchasePrice ?? 0),
      currency: 'USD',
    };
  }

  async search(keyword: string): Promise<DomainOffer[]> {
    const body = await this.call<{ results?: { domainName: string; purchasable?: boolean; premium?: boolean; purchasePrice?: number; renewalPrice?: number }[] }>('/v4/domains:search', {
      method: 'POST',
      body: JSON.stringify({ keyword, tldFilter: SEARCH_TLDS, timeout: 3000 }),
    });
    return (body.results ?? []).map((result) => this.offer(result));
  }

  async check(domain: string): Promise<DomainOffer> {
    const body = await this.call<{ results?: { domainName: string; purchasable?: boolean; premium?: boolean; purchasePrice?: number; renewalPrice?: number }[] }>('/v4/domains:checkAvailability', {
      method: 'POST',
      body: JSON.stringify({ domainNames: [domain] }),
    });
    const result = body.results?.find((entry) => entry.domainName === domain);
    return result ? this.offer(result) : { domain, available: false, premium: false, price: 0, renewal: 0, currency: 'USD' };
  }

  async register(input: { domain: string; years: number; price: number; privacy: boolean; contact: RegistrantContact | null }): Promise<{ orderId: string; expiresAt: Date }> {
    const contact = input.contact
      ? { firstName: input.contact.firstName, lastName: input.contact.lastName, companyName: input.contact.organization ?? undefined, address1: input.contact.address1, city: input.contact.city, state: input.contact.state, zip: input.contact.zip, country: input.contact.country, phone: input.contact.phone, email: input.contact.email }
      : undefined;
    const body = await this.call<{ order?: number; domain?: { expireDate?: string } }>('/v4/domains', {
      method: 'POST',
      body: JSON.stringify({
        // Renewals are the platform's job (on the store's bill), not the registrar's autorenew.
        domain: { domainName: input.domain, privacyEnabled: input.privacy, autorenewEnabled: false, ...(contact ? { contacts: { registrant: contact, admin: contact, tech: contact, billing: contact } } : {}) },
        purchasePrice: input.price,
        years: input.years,
      }),
    });
    return { orderId: String(body.order ?? ''), expiresAt: body.domain?.expireDate ? new Date(body.domain.expireDate) : new Date(Date.now() + input.years * 365 * 86_400_000) };
  }

  async setRecords(domain: string, records: DnsRecordInput[]): Promise<void> {
    for (const record of records) {
      await this.call(`/v4/domains/${encodeURIComponent(domain)}/records`, {
        method: 'POST',
        body: JSON.stringify({ host: record.host, type: record.type, answer: record.value, ttl: record.ttl ?? 300 }),
      });
    }
  }

  async renew(domain: string, years: number, price: number): Promise<{ expiresAt: Date }> {
    const body = await this.call<{ domain?: { expireDate?: string } }>(`/v4/domains/${encodeURIComponent(domain)}:renew`, { method: 'POST', body: JSON.stringify({ purchasePrice: price, years }) });
    return { expiresAt: body.domain?.expireDate ? new Date(body.domain.expireDate) : new Date(Date.now() + years * 365 * 86_400_000) };
  }

  async authCode(domain: string): Promise<string> {
    const body = await this.call<{ authCode?: string }>(`/v4/domains/${encodeURIComponent(domain)}:getAuthCode`);
    if (!body.authCode) throw new RegistrarError('The registrar did not return a transfer code.');
    return body.authCode;
  }

  async transferQuote(domain: string): Promise<TransferQuote> {
    const body = await this.call<{ transferPrice?: number; renewalPrice?: number; premium?: boolean }>(`/v4/domains/${encodeURIComponent(domain)}:getPricing?years=1`);
    const price = Number(body.transferPrice ?? body.renewalPrice ?? 0);
    if (body.premium) return { domain, eligible: false, reason: 'Premium domains cannot be transferred here. Keep it where it is — it stays connected.', price, currency: 'USD' };
    if (!price) return { domain, eligible: false, reason: 'This extension cannot be transferred here.', price, currency: 'USD' };
    return { domain, eligible: true, reason: null, price, currency: 'USD' };
  }

  async transferIn(input: { domain: string; authCode: string; price: number; privacy: boolean }): Promise<{ orderId: string }> {
    const body = await this.call<{ order?: number }>('/v4/transfers', {
      method: 'POST',
      body: JSON.stringify({ domainName: input.domain, authCode: input.authCode, privacyEnabled: input.privacy, purchasePrice: input.price }),
    });
    return { orderId: String(body.order ?? '') };
  }

  async transferStatus(domain: string): Promise<TransferProgress> {
    const body = await this.call<{ status?: string; statusDetails?: string }>(`/v4/transfers/${encodeURIComponent(domain)}`);
    const status = (body.status ?? '').toLowerCase();
    if (status === 'completed' || status === 'complete') {
      const registered = await this.call<{ expireDate?: string }>(`/v4/domains/${encodeURIComponent(domain)}`).catch(() => ({ expireDate: undefined }));
      return { status: 'completed', reason: null, expiresAt: registered.expireDate ? new Date(registered.expireDate) : null };
    }
    if (/fail|cancel|reject|denied/.test(status)) return { status: 'failed', reason: body.statusDetails ?? 'The transfer was not accepted.', expiresAt: null };
    return { status: 'pending', reason: null, expiresAt: null };
  }
}

// ── which one ───────────────────────────────────────────────────────────────

let provider: RegistrarProvider | null = null;

export function registrar(): RegistrarProvider {
  if (provider) return provider;
  const name = (process.env.REGISTRAR ?? 'sandbox').toLowerCase();
  if (name === 'namecom' && process.env.NAMECOM_USERNAME && process.env.NAMECOM_TOKEN) {
    provider = new NameComRegistrar(process.env.NAMECOM_USERNAME, process.env.NAMECOM_TOKEN, (process.env.NAMECOM_API_URL ?? 'https://api.name.com').replace(/\/$/, ''));
  } else {
    if (name !== 'sandbox') logger.error('registrar.unconfigured', { requested: name, using: 'sandbox' });
    provider = new SandboxRegistrar();
  }
  return provider;
}

export function useRegistrar(next: RegistrarProvider | null): void {
  provider = next;
}
