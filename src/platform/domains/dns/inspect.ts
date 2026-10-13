import { env } from '../../../config/env';
import { certificateAuthorities, CHALLENGE_PREFIX, edgeAddresses, isApex, rootDomain, sharedTarget, targetZone } from '../hostnames';
import { dnsResolvers, type DnsAnswer, type RecordType } from './resolvers';

/**
 * A domain's DNS, as the world sees it, and what it means.
 *
 * `inspect` asks every configured resolver; `diagnose` is pure — given what
 * was seen and what the domain should have, it decides whether traffic
 * reaches the edge, whether ownership is proven, and, when not, tells the
 * merchant exactly which record to add, change or remove. The admin shows
 * the same table: expected record, what is there now, ok or not.
 */

export interface DnsView {
  hostname: string;
  resolvers: { name: string; ok: boolean }[];
  /** CNAME records on the hostname itself. */
  cname: string[];
  /** The CNAME chain followed when looking up its addresses. */
  chain: string[];
  a: string[];
  aaaa: string[];
  /** TXT at _veylog-challenge.<hostname>. */
  challenge: string[];
  /** The CAA records in force (the closest ancestor's), and where they were found. */
  caa: string[];
  caaAt: string | null;
  /** Every resolver that answered saw the same addresses and CNAMEs. */
  agreed: boolean;
  checkedAt: string;
}

export interface ExpectedRecord {
  type: 'CNAME' | 'A' | 'AAAA' | 'TXT' | 'CAA';
  name: string;
  value: string;
  purpose: string;
  /** ok: present; missing: not there; wrong: something else is there; optional: nice to have. */
  status: 'ok' | 'missing' | 'wrong' | 'optional';
  found: string[];
}

export interface Problem {
  code: 'no_records' | 'wrong_target' | 'extra_records' | 'stray_ipv6' | 'proxied' | 'other_platform' | 'caa_blocks' | 'propagating' | 'ownership_missing' | 'resolvers_down';
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface Diagnosis {
  routed: boolean;
  routedVia: 'unique_cname' | 'shared_cname' | 'edge_ips' | null;
  ownership: 'txt' | 'cname' | null;
  caaBlocks: boolean;
  expected: ExpectedRecord[];
  problems: Problem[];
}

export interface DomainForDiagnosis {
  hostname: string;
  routingTarget: string;
  verificationToken: string;
  /** Ownership already proven another way (its apex/www sibling, the registrar, a transfer). */
  ownershipProven: boolean;
}

// ── what other platforms' addresses look like ──────────────────────────────

/** Cloudflare's proxy ranges: an A record here is the merchant's own Cloudflare proxy in the way. */
const CLOUDFLARE_PROXY = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];

/** Where a store that moved here often still points. */
const OTHER_PLATFORMS: { name: string; ranges: string[]; hosts: RegExp }[] = [
  { name: 'Shopify', ranges: ['23.227.38.0/24'], hosts: /(^|\.)myshopify\.com$|shops\.myshopify\.com$/ },
  { name: 'Wix', ranges: ['185.230.60.0/22'], hosts: /wixdns\.net$/ },
  { name: 'Squarespace', ranges: ['198.49.23.0/24', '198.185.159.0/24'], hosts: /squarespace\.com$/ },
  { name: 'WooCommerce hosting (WordPress.com)', ranges: ['192.0.78.0/24'], hosts: /wordpress\.com$/ },
  { name: 'Vercel', ranges: ['76.76.21.0/24'], hosts: /vercel-dns\.com$/ },
  { name: 'Netlify', ranges: ['75.2.60.0/24'], hosts: /netlify\.(app|com)$/ },
  { name: 'GoDaddy parking', ranges: ['34.102.136.0/24'], hosts: /parkingpage\.namecheap\.com$|godaddysites\.com$/ },
];

function ipv4ToNumber(ip: string): number {
  return ip.split('.').reduce((total, part) => (total << 8) + Number(part), 0) >>> 0;
}

export function inRange(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(base) & mask);
}

function platformOf(values: string[]): string | null {
  for (const platform of OTHER_PLATFORMS) {
    if (values.some((value) => platform.hosts.test(value) || platform.ranges.some((range) => inRange(value, range)))) return platform.name;
  }
  return null;
}

// ── looking ─────────────────────────────────────────────────────────────────

async function ask(name: string, type: RecordType): Promise<DnsAnswer[]> {
  return Promise.all(dnsResolvers().map((resolver) => resolver.resolve(name, type)));
}

function merge(answers: DnsAnswer[], key: 'records' | 'chain'): string[] {
  return [...new Set(answers.filter((answer) => answer.ok).flatMap((answer) => answer[key]))];
}

function sameAnswers(answers: DnsAnswer[]): boolean {
  const ok = answers.filter((answer) => answer.ok).map((answer) => [...answer.records].sort().join(','));
  return ok.every((value) => value === ok[0]);
}

/** The closest CAA records at or above the hostname (CAA is inherited from the parent). */
async function caaInForce(hostname: string): Promise<{ records: string[]; at: string | null }> {
  const labels = hostname.split('.');
  const root = rootDomain(hostname);
  for (let index = 0; index < labels.length - 1; index += 1) {
    const name = labels.slice(index).join('.');
    const found = merge(await ask(name, 'CAA'), 'records');
    if (found.length) return { records: found, at: name };
    if (name === root) break;
  }
  return { records: [], at: null };
}

/**
 * `previous` makes a light check: only the records that route traffic are
 * asked for, and the challenge TXT and CAA records are taken from the last
 * full check — which is all a live, settled domain's regular health check
 * needs, at a third of the queries.
 */
export async function inspect(hostname: string, previous?: Pick<DnsView, 'challenge' | 'caa' | 'caaAt'> | null): Promise<DnsView> {
  const [cname, a, aaaa, challenge, caa] = await Promise.all([
    ask(hostname, 'CNAME'),
    ask(hostname, 'A'),
    ask(hostname, 'AAAA'),
    previous ? Promise.resolve(null) : ask(`${CHALLENGE_PREFIX}.${hostname}`, 'TXT'),
    previous ? Promise.resolve({ records: previous.caa, at: previous.caaAt }) : caaInForce(hostname),
  ]);
  const resolvers = dnsResolvers().map((resolver, index) => ({ name: resolver.name, ok: a[index].ok || cname[index].ok }));
  return {
    hostname,
    resolvers,
    cname: merge(cname, 'records'),
    chain: merge(a, 'chain'),
    a: merge(a, 'records'),
    aaaa: merge(aaaa, 'records'),
    challenge: challenge ? merge(challenge, 'records') : previous!.challenge,
    caa: caa.records,
    caaAt: caa.at,
    agreed: sameAnswers(a) && sameAnswers(cname),
    checkedAt: new Date().toISOString(),
  };
}

// ── deciding ────────────────────────────────────────────────────────────────

/** CAA allows issuance by one of the edge's certificate authorities (no CAA at all allows any). */
export function caaAllows(records: string[], authorities: string[] = certificateAuthorities()): boolean {
  const issue = records
    .map((record) => /^\d+\s+(issue|issuewild)\s+"([^"]*)"/i.exec(record))
    .filter((match): match is RegExpExecArray => Boolean(match) && match![1].toLowerCase() === 'issue')
    .map((match) => match[2].split(';')[0].trim().toLowerCase());
  if (issue.length === 0) return true;
  return issue.some((ca) => authorities.includes(ca));
}

export function diagnose(domain: DomainForDiagnosis, view: DnsView): Diagnosis {
  const host = domain.hostname;
  const apex = isApex(host);
  const edge = edgeAddresses();
  const shared = sharedTarget();
  const platform = env.platform.storefrontDomain;
  const unique = domain.routingTarget.toLowerCase();
  const names = [...view.cname, ...view.chain];
  const problems: Problem[] = [];
  const expected: ExpectedRecord[] = [];
  const answered = view.resolvers.some((resolver) => resolver.ok);

  // Routing.
  let routedVia: Diagnosis['routedVia'] = null;
  if (names.includes(unique)) routedVia = 'unique_cname';
  // Any platform name reaches the edge (the edge routes by Host); only this domain's own target proves ownership.
  else if (names.some((name) => name === shared || name.endsWith(`.${targetZone()}`) || name === platform || name.endsWith(`.${platform}`))) routedVia = 'shared_cname';
  const ours4 = view.a.filter((ip) => edge.ipv4.includes(ip));
  const others4 = view.a.filter((ip) => !edge.ipv4.includes(ip));
  const others6 = view.aaaa.filter((ip) => !edge.ipv6.includes(ip));
  if (!routedVia && edge.ipv4.length && ours4.length && others4.length === 0 && view.cname.length === 0) routedVia = 'edge_ips';

  // A CNAME to the shared target reaches the edge but, being anyone's, proves nothing on its own.
  const txtOk = view.challenge.includes(`veylog-verify=${domain.verificationToken}`);
  const ownership: Diagnosis['ownership'] = routedVia === 'unique_cname' ? 'cname' : txtOk ? 'txt' : null;
  const ownershipProven = domain.ownershipProven || ownership !== null;

  // Stray records on a CNAME'd name are impossible; on an A-record apex they send some visitors elsewhere.
  if (!routedVia && ours4.length && others4.length) {
    const named = others4.map((ip) => {
      const owner = platformOf([ip]);
      return owner ? `${ip} (${owner})` : ip;
    });
    problems.push({ code: 'extra_records', severity: 'error', message: `Remove the A record${others4.length > 1 ? 's' : ''} pointing to ${named.join(', ')} — some visitors would be sent there instead of your store.` });
  }
  if ((routedVia === 'edge_ips' || ours4.length) && others6.length) {
    problems.push({ code: 'stray_ipv6', severity: 'error', message: `Remove the AAAA record${others6.length > 1 ? 's' : ''} pointing to ${others6.join(', ')} — phones and networks on IPv6 would miss your store.` });
  }
  const elsewhere = platformOf([...view.a, ...names]);
  if (!routedVia && elsewhere && !problems.some((problem) => problem.code === 'extra_records')) {
    problems.push({ code: 'other_platform', severity: 'error', message: `${host} still points to ${elsewhere}. Replace that record with the one below.` });
  } else if (!routedVia && others4.length && others4.every((ip) => CLOUDFLARE_PROXY.some((range) => inRange(ip, range))) && !edge.ipv4.some((ip) => CLOUDFLARE_PROXY.some((range) => inRange(ip, range)))) {
    problems.push({ code: 'proxied', severity: 'error', message: 'Your DNS is proxied by Cloudflare (orange cloud). Set the record to "DNS only" so visitors reach your store and its certificate can be issued.' });
  } else if (!routedVia && (view.a.length || view.cname.length) && !problems.some((problem) => problem.code === 'extra_records')) {
    problems.push({ code: 'wrong_target', severity: 'error', message: `${host} points to ${[...view.cname, ...view.a].join(', ')}, not to your store yet.` });
  }
  if (!routedVia && !view.a.length && !view.cname.length && answered) {
    problems.push({ code: 'no_records', severity: 'warning', message: `No records for ${host} yet. Add the record below at your domain provider — changes usually show within an hour, occasionally up to 48.` });
  }
  if (!answered) problems.push({ code: 'resolvers_down', severity: 'warning', message: 'DNS could not be checked just now. We will try again shortly.' });
  if (routedVia && !ownershipProven) {
    problems.push({ code: 'ownership_missing', severity: 'error', message: `Add the TXT record below to prove you own ${host}.` });
  }
  const caaBlocks = !caaAllows(view.caa);
  if (caaBlocks) {
    problems.push({ code: 'caa_blocks', severity: 'error', message: `The CAA records on ${view.caaAt} do not allow ${certificateAuthorities()[0]} to issue a certificate. Add the CAA record below, or remove the others.` });
  }
  if (!view.agreed && answered) problems.push({ code: 'propagating', severity: 'info', message: 'DNS servers around the world do not agree yet — your change is still spreading.' });

  // What the merchant should have: shown as a checklist.
  if (apex && edge.ipv4.length) {
    for (const ip of edge.ipv4) expected.push({ type: 'A', name: host, value: ip, purpose: 'Sends visitors to your store.', status: view.a.includes(ip) ? 'ok' : view.a.length ? 'wrong' : 'missing', found: view.a });
    for (const ip of edge.ipv6) expected.push({ type: 'AAAA', name: host, value: ip, purpose: 'IPv6 visitors (optional).', status: view.aaaa.includes(ip) ? 'ok' : 'optional', found: view.aaaa });
  } else {
    expected.push({
      type: 'CNAME',
      name: host,
      value: unique,
      purpose: apex ? 'Sends visitors to your store. At the root of a domain this needs CNAME flattening, ALIAS or ANAME at your DNS provider.' : 'Sends visitors to your store and proves the domain is yours.',
      status: routedVia === 'unique_cname' ? 'ok' : routedVia === 'shared_cname' ? 'ok' : view.cname.length || view.a.length ? 'wrong' : 'missing',
      found: view.cname.length ? view.cname : view.a,
    });
  }
  // A subdomain proves itself with its own CNAME target; the TXT record is for apexes, and for anyone using the shared target.
  const needsTxt = !domain.ownershipProven && routedVia !== 'unique_cname' && (apex || routedVia === 'shared_cname' || txtOk);
  if (needsTxt) {
    expected.push({
      type: 'TXT',
      name: `${CHALLENGE_PREFIX}.${host}`,
      value: `veylog-verify=${domain.verificationToken}`,
      purpose: apex ? `Proves you own this domain (not needed once www.${host} points to your store).` : 'Proves you own this domain.',
      status: txtOk ? 'ok' : view.challenge.length ? 'wrong' : 'missing',
      found: view.challenge,
    });
  }
  if (caaBlocks) {
    expected.push({ type: 'CAA', name: view.caaAt ?? rootDomain(host), value: `0 issue "${certificateAuthorities()[0]}"`, purpose: 'Allows your store’s certificate to be issued.', status: 'missing', found: view.caa });
  }

  return { routed: routedVia !== null, routedVia, ownership, caaBlocks, expected, problems };
}
