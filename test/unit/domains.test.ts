import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { caaAllows, diagnose, inRange, type DnsView } from '../../src/platform/domains/dns/inspect';
import { caaValue, txtValue } from '../../src/platform/domains/dns/resolvers';
import { edgeProvider, useEdgeProvider } from '../../src/platform/domains/edge/edgeProvider';
import { isApex, isValidHostname, newRoutingTarget, normaliseHostname, rootDomain, siblingOf } from '../../src/platform/domains/hostnames';
import { nextState, schedule, type LifecycleInput } from '../../src/platform/domains/lifecycle';
import { registrar, useRegistrar } from '../../src/platform/domains/registrar/registrar';
import { languageHomes, type DomainRoute, type HostRoute } from '../../src/platform/domains/hostRouting';
import { fakeShop } from '../helpers/shop';

const EDGE_IP = '203.0.113.10';

before(() => {
  process.env.PLATFORM_EDGE_IPS = EDGE_IP;
  process.env.PLATFORM_EDGE_IPV6 = '';
});
after(() => {
  delete process.env.PLATFORM_EDGE_IPS;
  delete process.env.PLATFORM_EDGE_IPV6;
});

function view(overrides: Partial<DnsView> = {}): DnsView {
  return { hostname: 'shop.example.com', resolvers: [{ name: 'test', ok: true }], cname: [], chain: [], a: [], aaaa: [], challenge: [], caa: [], caaAt: null, agreed: true, checkedAt: new Date().toISOString(), ...overrides };
}

const TARGET = 'd-0123456789abcdef.shops.myveylog.com';

// ── hostnames ──────────────────────────────────────────────────────────────

describe('hostnames', () => {
  it('normalises what merchants paste', () => {
    assert.equal(normaliseHostname(' https://WWW.Example.com:443/shop?x=1 '), 'www.example.com');
    assert.equal(normaliseHostname('example.com.'), 'example.com');
    assert.equal(normaliseHostname('bücher.de'), 'xn--bcher-kva.de');
  });

  it('refuses what is not a hostname', () => {
    for (const bad of ['localhost', '192.168.1.1', '-bad.com', 'a..com', 'exa_mple.com', 'example.123']) assert.equal(isValidHostname(bad), false, bad);
    for (const good of ['example.com', 'shop.example.co.uk', 'xn--bcher-kva.de', 'a-b.store']) assert.equal(isValidHostname(good), true, good);
  });

  it('finds the registrable domain behind multi-label suffixes', () => {
    assert.equal(rootDomain('shop.example.co.uk'), 'example.co.uk');
    assert.equal(rootDomain('www.store.co.in'), 'store.co.in');
    assert.equal(rootDomain('a.b.example.com'), 'example.com');
    assert.ok(isApex('example.co.uk'));
    assert.ok(!isApex('www.example.co.uk'));
  });

  it('pairs an apex with its www and back, and nothing else', () => {
    assert.equal(siblingOf('example.com'), 'www.example.com');
    assert.equal(siblingOf('www.example.co.uk'), 'example.co.uk');
    assert.equal(siblingOf('shop.example.com'), null);
  });

  it('gives each domain its own routing target', () => {
    const a = newRoutingTarget();
    assert.match(a, /^d-[0-9a-f]{16}\./);
    assert.notEqual(a, newRoutingTarget());
  });
});

// ── DNS ────────────────────────────────────────────────────────────────────

describe('reading DNS answers', () => {
  it('joins split TXT strings and decodes RFC 3597 CAA', () => {
    assert.equal(txtValue('"veylog-verify=" "abc"'), 'veylog-verify=abc');
    // 0 issue "letsencrypt.org"
    const hex = Buffer.concat([Buffer.from([0, 5]), Buffer.from('issue'), Buffer.from('letsencrypt.org')]).toString('hex').match(/../g)!.join(' ');
    assert.equal(caaValue(`\\# 22 ${hex}`), '0 issue "letsencrypt.org"');
  });

  it('matches CIDR ranges', () => {
    assert.ok(inRange('23.227.38.65', '23.227.38.0/24'));
    assert.ok(!inRange('23.227.39.1', '23.227.38.0/24'));
    assert.ok(inRange('104.21.4.2', '104.16.0.0/13'));
  });

  it('reads CAA: none allows everyone, others must name the edge’s CA', () => {
    assert.ok(caaAllows([]));
    assert.ok(caaAllows(['0 issue "letsencrypt.org"'], ['letsencrypt.org']));
    assert.ok(!caaAllows(['0 issue "digicert.com"'], ['letsencrypt.org', 'pki.goog']));
    assert.ok(caaAllows(['0 iodef "mailto:x@y.z"'], ['letsencrypt.org']));
  });
});

describe('diagnosing a domain', () => {
  const domain = { hostname: 'shop.example.com', routingTarget: TARGET, verificationToken: 'tok', ownershipProven: false };

  it('a subdomain pointed at its own target is routed and proven, no TXT needed', () => {
    const result = diagnose(domain, view({ cname: [TARGET], chain: [TARGET], a: [EDGE_IP] }));
    assert.equal(result.routedVia, 'unique_cname');
    assert.equal(result.ownership, 'cname');
    assert.deepEqual(result.problems.filter((problem) => problem.severity === 'error'), []);
    assert.ok(!result.expected.some((record) => record.type === 'TXT'));
  });

  it('the shared target routes but proves nothing without the TXT record', () => {
    const shared = diagnose(domain, view({ cname: ['shops.myveylog.com'], a: [EDGE_IP] }));
    assert.equal(shared.routedVia, 'shared_cname');
    assert.equal(shared.ownership, null);
    assert.ok(shared.problems.some((problem) => problem.code === 'ownership_missing'));
    const withTxt = diagnose(domain, view({ cname: ['shops.myveylog.com'], a: [EDGE_IP], challenge: ['veylog-verify=tok'] }));
    assert.equal(withTxt.ownership, 'txt');
  });

  it('an apex on the edge IP, with a leftover A record, says which to remove', () => {
    const apex = { ...domain, hostname: 'example.com' };
    const result = diagnose(apex, view({ hostname: 'example.com', a: [EDGE_IP, '198.51.100.7'] }));
    assert.equal(result.routed, false);
    assert.match(result.problems.find((problem) => problem.code === 'extra_records')!.message, /198\.51\.100\.7/);
    assert.equal(result.expected.find((record) => record.type === 'A')!.status, 'ok');
  });

  it('recognises a store still pointing at Shopify, and a Cloudflare proxy', () => {
    const shopify = diagnose(domain, view({ a: ['23.227.38.65'] }));
    assert.match(shopify.problems[0].message, /Shopify/);
    const proxied = diagnose(domain, view({ a: ['104.21.4.2', '172.67.1.1'] }));
    assert.ok(proxied.problems.some((problem) => problem.code === 'proxied'));
  });

  it('blocks on CAA and asks for the record that fixes it', () => {
    const result = diagnose(domain, view({ cname: [TARGET], chain: [TARGET], a: [EDGE_IP], caa: ['0 issue "digicert.com"'], caaAt: 'example.com' }));
    assert.ok(result.caaBlocks);
    assert.equal(result.expected.find((record) => record.type === 'CAA')!.name, 'example.com');
  });

  it('says when DNS is still spreading, and when nothing is set yet', () => {
    assert.ok(diagnose(domain, view({ agreed: false, cname: [TARGET], chain: [TARGET] })).problems.some((problem) => problem.code === 'propagating'));
    assert.ok(diagnose(domain, view()).problems.some((problem) => problem.code === 'no_records'));
  });
});

// ── lifecycle ──────────────────────────────────────────────────────────────

describe('the domain lifecycle', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const routed = diagnose({ hostname: 'shop.example.com', routingTarget: TARGET, verificationToken: 't', ownershipProven: false }, view({ cname: [TARGET], chain: [TARGET], a: [EDGE_IP] }));
  const unrouted = diagnose({ hostname: 'shop.example.com', routingTarget: TARGET, verificationToken: 't', ownershipProven: false }, view());
  const base = (overrides: Partial<LifecycleInput>): LifecycleInput => ({ status: 'pending_dns', createdAt: now, since: now, attempts: 0, ownershipProven: false, diagnosis: unrouted, certificate: null, now, jitter: 0, ...overrides });
  const cert = (certificate: 'none' | 'pending' | 'active' | 'failed') => ({ id: 'x', certificate, issuer: null, expiresAt: new Date(now.getTime() + 60 * 86_400_000), detail: certificate });

  it('waits for DNS, checking soon and then less often', () => {
    const first = nextState(base({}));
    assert.equal(first.status, 'pending_dns');
    assert.equal(first.nextCheckMs, schedule('pending_dns', { attempts: 1, age: 0, inStatus: 0 }));
    assert.equal(schedule('pending_dns', { attempts: 0, age: 0, inStatus: 0 }), 60_000);
    assert.equal(schedule('pending_dns', { attempts: 20, age: 5 * 86_400_000, inStatus: 0 }), 6 * 3_600_000);
  });

  it('attaches to the edge once DNS points here, then goes live with the certificate', () => {
    const attaching = nextState(base({ diagnosis: routed, certificate: cert('none') }));
    assert.equal(attaching.status, 'provisioning_ssl');
    assert.ok(attaching.attach);
    const live = nextState(base({ status: 'provisioning_ssl', diagnosis: routed, certificate: cert('active') }));
    assert.equal(live.status, 'active');
    assert.equal(live.notify, 'connected');
    assert.equal(live.nextCheckMs, 6 * 3_600_000);
  });

  it('notices when a live domain stops pointing here, and when it comes back', () => {
    const broken = nextState(base({ status: 'active', ownershipProven: true, diagnosis: unrouted }));
    assert.equal(broken.status, 'misconfigured');
    assert.equal(broken.notify, 'misconfigured');
    const back = nextState(base({ status: 'misconfigured', ownershipProven: true, diagnosis: routed, certificate: cert('active') }));
    assert.equal(back.status, 'active');
    assert.equal(back.notify, 'restored');
  });

  it('gives up on a certificate after a day, and on DNS after two weeks', () => {
    const late = nextState(base({ status: 'provisioning_ssl', since: new Date(now.getTime() - 25 * 3_600_000), diagnosis: routed, certificate: cert('pending') }));
    assert.equal(late.status, 'ssl_failed');
    assert.equal(late.notify, 'ssl_failed');
    const stale = nextState(base({ createdAt: new Date(now.getTime() - 15 * 86_400_000) }));
    assert.equal(stale.status, 'expired');
    assert.equal(stale.nextCheckMs, null);
  });

  it('watches a certificate near expiry hourly', () => {
    assert.equal(schedule('active', { attempts: 0, age: 0, inStatus: 0, certificateExpiresInMs: 5 * 86_400_000 }), 3_600_000);
  });

  it('spreads checks out with jitter', () => {
    const early = schedule('active', { attempts: 0, age: 0, inStatus: 0 }, -1)!;
    const late = schedule('active', { attempts: 0, age: 0, inStatus: 0 }, 1)!;
    assert.ok(early < 6 * 3_600_000 && late > 6 * 3_600_000);
  });
});

// ── the edge and the registrar ─────────────────────────────────────────────

describe('Cloudflare for SaaS', () => {
  it('registers a custom hostname and reads its certificate', async () => {
    process.env.EDGE_PROVIDER = 'cloudflare';
    process.env.CLOUDFLARE_API_TOKEN = 'token';
    process.env.CLOUDFLARE_ZONE_ID = 'zone';
    useEdgeProvider(null);
    const calls: { url: string; method: string; body?: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body as string | undefined });
      const record = { id: 'ch_1', hostname: 'shop.example.com', status: 'pending', ssl: { status: calls.length > 2 ? 'active' : 'pending_validation', certificates: calls.length > 2 ? [{ issuer: 'GoogleTrustServices', expires_on: '2026-12-28T00:00:00Z' }] : [] } };
      const result = String(url).includes('?hostname=') ? [] : record;
      return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try {
      const edge = edgeProvider();
      assert.equal(edge.name, 'cloudflare');
      const attached = await edge.attach('shop.example.com', null);
      assert.equal(attached.certificate, 'pending');
      assert.equal(calls[1].method, 'POST');
      assert.match(calls[1].body!, /"method":"http"/);
      const state = await edge.state('shop.example.com', 'ch_1');
      assert.equal(state.certificate, 'active');
      assert.equal(state.issuer, 'GoogleTrustServices');
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.EDGE_PROVIDER;
      useEdgeProvider(null);
    }
  });
});

describe('buying a domain (sandbox registrar)', () => {
  it('searches across extensions, registers, and refuses a second registration', async () => {
    useRegistrar(null);
    const provider = registrar();
    const results = await provider.search('Asha Botanicals!');
    assert.ok(results.length >= 5);
    assert.ok(results.every((offer) => offer.domain.startsWith('ashabotanicals.')));
    const free = results.find((offer) => offer.available)!;
    const registered = await provider.register({ domain: free.domain, years: 2, price: free.price, privacy: true, contact: null });
    assert.ok(registered.expiresAt.getTime() > Date.now() + 700 * 86_400_000);
    assert.equal((await provider.check(free.domain)).available, false);
  });
});

describe('transferring a domain in (sandbox registrar)', () => {
  const saved = { dns: process.env.DNS_STATIC_FILE, file: process.env.SANDBOX_REGISTRAR_FILE, wait: process.env.SANDBOX_TRANSFER_SECONDS };
  before(() => {
    // In memory: no DNS file, no state file.
    delete process.env.DNS_STATIC_FILE;
    delete process.env.SANDBOX_REGISTRAR_FILE;
  });
  after(() => {
    for (const [key, value] of [['DNS_STATIC_FILE', saved.dns], ['SANDBOX_REGISTRAR_FILE', saved.file], ['SANDBOX_TRANSFER_SECONDS', saved.wait]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('quotes a transfer at the renewal price, and refuses premium names', async () => {
    useRegistrar(null);
    const quote = await registrar().transferQuote('ashaorganics.com');
    assert.equal(quote.eligible, true);
    assert.ok(quote.price > 0);
    const premium = await registrar().transferQuote('abc.com');
    assert.equal(premium.eligible, false);
    assert.match(premium.reason ?? '', /Premium/);
  });

  it('waits for the registries, then completes with a year added', async () => {
    useRegistrar(null);
    process.env.SANDBOX_TRANSFER_SECONDS = '3600';
    await registrar().transferIn({ domain: 'moving-in.com', authCode: 'Xy7-Qw9-Lm2', price: 16.99, privacy: true, contact: null });
    assert.equal((await registrar().transferStatus('moving-in.com')).status, 'pending');
    process.env.SANDBOX_TRANSFER_SECONDS = '0';
    const done = await registrar().transferStatus('moving-in.com');
    assert.equal(done.status, 'completed');
    assert.ok(done.expiresAt!.getTime() > Date.now() + 360 * 86_400_000);
    assert.equal((await registrar().transferQuote('moving-in.com')).eligible, false, 'now registered here');
  });

  it('refuses a short code at once, and reports a rejected one', async () => {
    useRegistrar(null);
    await assert.rejects(registrar().transferIn({ domain: 'short-code.com', authCode: 'abc', price: 16.99, privacy: true, contact: null }), /too short/);
    await registrar().transferIn({ domain: 'rejected.com', authCode: 'bad-code-123', price: 16.99, privacy: true, contact: null });
    const result = await registrar().transferStatus('rejected.com');
    assert.equal(result.status, 'failed');
    assert.match(result.reason ?? '', /rejected the transfer code/);
  });
});

// ── language domains ──────────────────────────────────────────────────────

describe('where each language lives', () => {
  const domain = (id: number, hostname: string, extra: Partial<DomainRoute> = {}): DomainRoute => ({ id, hostname, kind: 'custom', isPrimary: false, redirectToPrimary: false, marketId: null, locale: null, status: 'active', https: true, redirectTo: null, ...extra });
  const primary = domain(1, 'example.com', { isPrimary: true });
  const french = domain(2, 'fr.example.com', { locale: 'fr' });
  const france = domain(3, 'example.fr', { marketId: 9, locale: 'fr' });
  const route = (current: DomainRoute | null): HostRoute => ({ shop: fakeShop(), domain: current, primary, marketDomains: [france], languageDomains: [french] });
  const codes = ['en', 'fr', 'de'];

  it('on the primary domain: the store language at the root, a language domain for French, a folder for German', () => {
    const homes = languageHomes(route(primary), 'https://example.com', codes, 'en', 'en');
    assert.deepEqual(homes.get('en'), { origin: 'https://example.com', prefix: '' });
    assert.deepEqual(homes.get('fr'), { origin: 'https://fr.example.com', prefix: '' });
    assert.deepEqual(homes.get('de'), { origin: 'https://example.com', prefix: '/de' });
  });

  it('on the language domain: its language here, the others back on the primary domain', () => {
    const homes = languageHomes(route(french), 'https://fr.example.com', codes, 'en', 'fr');
    assert.deepEqual(homes.get('fr'), { origin: 'https://fr.example.com', prefix: '' });
    assert.deepEqual(homes.get('en'), { origin: 'https://example.com', prefix: '' });
    assert.deepEqual(homes.get('de'), { origin: 'https://example.com', prefix: '/de' });
  });

  it('on a market’s domain every language stays on it', () => {
    const homes = languageHomes(route(france), 'https://example.fr', codes, 'en', 'fr');
    assert.deepEqual(homes.get('fr'), { origin: 'https://example.fr', prefix: '' });
    assert.deepEqual(homes.get('en'), { origin: 'https://example.fr', prefix: '/en' });
  });
});
