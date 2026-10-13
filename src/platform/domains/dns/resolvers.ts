import { promises as dns } from 'node:dns';
import { existsSync, readFileSync } from 'node:fs';
import { env } from '../../../config/env';

/**
 * How the platform looks a domain up.
 *
 * Checks ask public resolvers over DNS-over-HTTPS rather than the server's own
 * resolver: the server's cache (and any split-horizon DNS where it runs)
 * would say what one machine sees, and a merchant asking "is it working?"
 * needs what the world sees. Asking two operators (Cloudflare and Google)
 * and comparing also tells a finished change from one still propagating.
 *
 *   DNS_RESOLVERS=cloudflare,google   (production default)
 *   DNS_RESOLVERS=system              (development default: the machine's resolver)
 *   DNS_RESOLVERS=static              records from DNS_STATIC_FILE, re-read on
 *                                     every query — how tests play the merchant
 *   DNS_RESOLVERS=https://…/dns-query the platform's own resolvers (DoH JSON), for
 *                                     volumes public services would throttle
 */

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'CAA' | 'NS';

export interface DnsAnswer {
  /** false when the resolver could not answer (timeout, SERVFAIL) — not the same as "no records". */
  ok: boolean;
  records: string[];
  /** For A/AAAA lookups: the CNAME chain followed to reach the addresses. */
  chain: string[];
}

export interface DnsResolver {
  readonly name: string;
  resolve(name: string, type: RecordType): Promise<DnsAnswer>;
}

const TYPE_CODES: Record<RecordType, number> = { A: 1, NS: 2, CNAME: 5, TXT: 16, AAAA: 28, CAA: 257 };
const TIMEOUT_MS = 4_000;

const clean = (value: string) => value.trim().toLowerCase().replace(/\.$/, '');

/** TXT data as DoH returns it: one or more quoted strings, joined. */
function txtValue(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  return parts ? parts.map((part) => part.slice(1, -1).replace(/\\"/g, '"')).join('') : data;
}

/** CAA as `0 issue "letsencrypt.org"`, decoding the RFC 3597 hex form some resolvers return. */
function caaValue(data: string): string {
  const hex = /^\\#\s+\d+\s+([0-9a-f\s]+)$/i.exec(data.trim());
  if (!hex) return data.trim();
  const bytes = Buffer.from(hex[1].replace(/\s+/g, ''), 'hex');
  const flags = bytes[0];
  const tagLength = bytes[1];
  const tag = bytes.subarray(2, 2 + tagLength).toString('ascii');
  const value = bytes.subarray(2 + tagLength).toString('utf8');
  return `${flags} ${tag} "${value}"`;
}

class DohResolver implements DnsResolver {
  constructor(
    readonly name: string,
    private readonly endpoint: string,
  ) {}

  async resolve(name: string, type: RecordType): Promise<DnsAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const url = `${this.endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
      const response = await fetch(url, { headers: { Accept: 'application/dns-json' }, signal: controller.signal });
      if (!response.ok) return { ok: false, records: [], chain: [] };
      const body = (await response.json()) as { Status: number; Answer?: { type: number; data: string }[] };
      // 0 NOERROR, 3 NXDOMAIN: both are answers. Anything else is the resolver failing.
      if (body.Status !== 0 && body.Status !== 3) return { ok: false, records: [], chain: [] };
      const answers = body.Answer ?? [];
      const chain = answers.filter((answer) => answer.type === TYPE_CODES.CNAME).map((answer) => clean(answer.data));
      const records = answers
        .filter((answer) => answer.type === TYPE_CODES[type])
        .map((answer) => (type === 'TXT' ? txtValue(answer.data) : type === 'CAA' ? caaValue(answer.data) : clean(answer.data)));
      return { ok: true, records, chain: type === 'CNAME' ? [] : chain };
    } catch {
      return { ok: false, records: [], chain: [] };
    } finally {
      clearTimeout(timer);
    }
  }
}

class SystemResolver implements DnsResolver {
  readonly name = 'system';
  async resolve(name: string, type: RecordType): Promise<DnsAnswer> {
    try {
      switch (type) {
        case 'A':
          return { ok: true, records: (await dns.resolve4(name)).map(clean), chain: await this.chain(name) };
        case 'AAAA':
          return { ok: true, records: (await dns.resolve6(name)).map(clean), chain: await this.chain(name) };
        case 'CNAME':
          return { ok: true, records: (await dns.resolveCname(name)).map(clean), chain: [] };
        case 'TXT':
          return { ok: true, records: (await dns.resolveTxt(name)).map((parts) => parts.join('')), chain: [] };
        case 'CAA':
          return {
            ok: true,
            records: (await dns.resolveCaa(name)).map((record) => {
              const [tag, value] = Object.entries(record).find(([key]) => key !== 'critical') ?? ['issue', ''];
              return `${record.critical} ${tag} "${value}"`;
            }),
            chain: [],
          };
        case 'NS':
          return { ok: true, records: (await dns.resolveNs(name)).map(clean), chain: [] };
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // "No such name" and "no records of that type" are answers too.
      return { ok: code === 'ENOTFOUND' || code === 'ENODATA', records: [], chain: [] };
    }
  }

  private async chain(name: string): Promise<string[]> {
    const out: string[] = [];
    let current = name;
    for (let hop = 0; hop < 8; hop += 1) {
      const next = await dns.resolveCname(current).catch(() => [] as string[]);
      if (!next.length) break;
      current = clean(next[0]);
      out.push(current);
    }
    return out;
  }
}

/** Records from a JSON file: { "shop.example.com": { "CNAME": ["d-….shops.x.com"], "TXT": ["…"] } }. */
class StaticResolver implements DnsResolver {
  readonly name = 'static';
  constructor(private readonly file: string) {}

  private zone(): Record<string, Partial<Record<RecordType, string[]>>> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Partial<Record<RecordType, string[]>>>;
    } catch {
      return {};
    }
  }

  async resolve(name: string, type: RecordType): Promise<DnsAnswer> {
    const zone = this.zone();
    const lookup = (host: string, kind: RecordType) => (zone[clean(host)]?.[kind] ?? []).map((value) => (kind === 'TXT' || kind === 'CAA' ? value : clean(value)));
    if (type === 'A' || type === 'AAAA') {
      // Follow CNAMEs; a target outside the file answers with the edge's addresses if it is the platform's own.
      const chain: string[] = [];
      let current = clean(name);
      for (let hop = 0; hop < 8; hop += 1) {
        const next = lookup(current, 'CNAME')[0];
        if (!next) break;
        chain.push(next);
        current = next;
      }
      let records = lookup(current, type);
      if (!records.length && chain.length && (current.endsWith(`.${env.platform.storefrontDomain}`) || current === env.platform.storefrontDomain)) {
        records = (type === 'A' ? process.env.PLATFORM_EDGE_IPS : process.env.PLATFORM_EDGE_IPV6 ?? '')?.split(',').map((ip) => ip.trim()).filter(Boolean) ?? [];
      }
      return { ok: true, records, chain };
    }
    return { ok: true, records: lookup(name, type), chain: [] };
  }
}

let configured: DnsResolver[] | null = null;

export function dnsResolvers(): DnsResolver[] {
  if (configured) return configured;
  const fallback = process.env.DNS_STATIC_FILE ? 'static' : env.nodeEnv === 'production' ? 'cloudflare,google' : 'system';
  const names = (process.env.DNS_RESOLVERS ?? fallback)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  configured = names.map((name) => {
    switch (name) {
      case 'cloudflare':
        return new DohResolver('cloudflare', 'https://cloudflare-dns.com/dns-query');
      case 'google':
        return new DohResolver('google', 'https://dns.google/resolve');
      case 'static':
        return new StaticResolver(process.env.DNS_STATIC_FILE ?? 'dns-static.json');
      case 'system':
        return new SystemResolver();
      default:
        // Any other entry is a DoH JSON endpoint: the platform's own recursive resolvers at scale
        // (e.g. https://resolver.internal/dns-query), so checks do not lean on public services.
        return /^https:\/\//.test(name) ? new DohResolver(new URL(name).hostname, name) : new SystemResolver();
    }
  });
  return configured;
}

/** For tests: use these resolvers instead of the configured ones. */
export function useResolvers(resolvers: DnsResolver[] | null): void {
  configured = resolvers;
}

export { txtValue, caaValue };
