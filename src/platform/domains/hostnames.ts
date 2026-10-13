import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { env } from '../../config/env';

/**
 * What a hostname is: valid or not, which registrable ("root") domain it
 * belongs to, whether it is that root (an apex) or a subdomain, and its
 * apex/www sibling.
 *
 * The root domain needs the Public Suffix List: the root of shop.example.co.uk
 * is example.co.uk, not co.uk. A subset of the multi-label suffixes most
 * stores use is built in; set PUBLIC_SUFFIX_FILE to the full list
 * (public_suffix_list.dat from publicsuffix.org) in production.
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

const BUILT_IN_SUFFIXES = [
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'gov.in',
  'com.au', 'net.au', 'org.au', 'id.au', 'co.nz', 'org.nz', 'net.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'co.kr', 'or.kr',
  'com.br', 'net.br', 'org.br', 'com.mx', 'com.ar', 'com.co', 'com.pe', 'com.cl', 'com.uy',
  'com.sg', 'com.my', 'com.ph', 'com.vn', 'co.id', 'or.id', 'co.th', 'in.th',
  'com.cn', 'com.hk', 'com.tw', 'com.tr', 'com.pk', 'com.bd', 'com.np', 'com.lk',
  'co.za', 'com.ng', 'co.ke', 'com.eg', 'com.sa', 'com.qa', 'com.kw', 'com.bh', 'co.il',
  'com.ua', 'com.pl', 'co.at', 'or.at', 'com.es', 'com.pt', 'com.gr', 'com.cy', 'co.hu',
];

let suffixes: Set<string> | null = null;

function publicSuffixes(): Set<string> {
  if (suffixes) return suffixes;
  const set = new Set(BUILT_IN_SUFFIXES);
  const file = process.env.PUBLIC_SUFFIX_FILE;
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const rule = line.trim().toLowerCase();
      // Comments, blank lines, wildcard and exception rules: the plain rules cover stores' domains.
      if (!rule || rule.startsWith('//') || rule.startsWith('*') || rule.startsWith('!')) continue;
      if (rule.includes('.')) set.add(rule);
    }
  }
  suffixes = set;
  return set;
}

/** Lower-case, no scheme, path, port or trailing dot; internationalised names in their ASCII (xn--) form. */
export function normaliseHostname(raw: string): string {
  let host = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      host = new URL(`http://${host}`).hostname;
    } catch {
      /* left as typed; validation refuses it */
    }
  }
  return host;
}

export function isValidHostname(host: string): boolean {
  if (host.length < 4 || host.length > 253 || net.isIP(host) !== 0) return false;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false;
  // The top-level label is never all digits.
  return !/^\d+$/.test(labels[labels.length - 1]);
}

/** The registrable domain: shop.example.co.uk → example.co.uk. */
export function rootDomain(host: string): string {
  const labels = host.split('.');
  const known = publicSuffixes();
  for (let take = Math.min(labels.length - 1, 3); take >= 2; take -= 1) {
    const suffix = labels.slice(-take).join('.');
    if (known.has(suffix)) return labels.slice(-(take + 1)).join('.');
  }
  return labels.slice(-2).join('.');
}

export function isApex(host: string): boolean {
  return rootDomain(host) === host;
}

/** example.com ↔ www.example.com; null for any other subdomain. */
export function siblingOf(host: string): string | null {
  if (isApex(host)) return `www.${host}`;
  if (host.startsWith('www.') && isApex(host.slice(4))) return host.slice(4);
  return null;
}

/** Whether the hostname is the platform's own (handle.<platform domain>, the edge zone). */
export function isPlatformHostname(host: string): boolean {
  const platform = env.platform.storefrontDomain;
  return host === platform || host.endsWith(`.${platform}`);
}

// ── where custom domains point ─────────────────────────────────────────────

/** The shared CNAME target: shops.<platform domain> (PLATFORM_EDGE_HOSTNAME). */
export function sharedTarget(): string {
  return (process.env.PLATFORM_EDGE_HOSTNAME ?? `shops.${env.platform.storefrontDomain}`).toLowerCase();
}

/** The zone that holds per-domain targets; the platform's DNS has *.<zone> pointing at the edge. */
export function targetZone(): string {
  return (process.env.PLATFORM_EDGE_TARGET_ZONE ?? sharedTarget()).toLowerCase();
}

/**
 * A CNAME target that belongs to one domain: d-<16 hex>.<zone>. Pointing a
 * subdomain at it proves the merchant controls that subdomain's DNS, which a
 * shared target cannot — anyone can point anything at shops.<platform>.
 */
export function newRoutingTarget(): string {
  return `d-${randomBytes(8).toString('hex')}.${targetZone()}`;
}

/** The edge's addresses, for apex domains that cannot hold a CNAME. */
export function edgeAddresses(): { ipv4: string[]; ipv6: string[] } {
  const parse = (value: string | undefined, family: 4 | 6) =>
    (value ?? '')
      .split(',')
      .map((ip) => ip.trim().toLowerCase())
      .filter((ip) => net.isIP(ip) === family);
  return { ipv4: parse(process.env.PLATFORM_EDGE_IPS, 4), ipv6: parse(process.env.PLATFORM_EDGE_IPV6, 6) };
}

/** Certificate authorities the edge issues from, for checking a domain's CAA records. */
export function certificateAuthorities(): string[] {
  return (process.env.EDGE_CERTIFICATE_AUTHORITIES ?? 'letsencrypt.org,pki.goog')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export const CHALLENGE_PREFIX = '_veylog-challenge';
