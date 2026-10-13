import { createHmac, randomBytes } from 'node:crypto';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { controlPlane, query, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import { billingRepository } from '../billing/billing.repository';
import { exchangeRate } from '../markets/fx';
import { staffNotifier } from '../notifications/staffNotifier';
import { entitlements } from '../plans/entitlements';
import { shopDirectory } from '../shops/shopDirectory';
import { shopsRepository } from '../shops/shops.repository';
import { shopId, tenancy } from '../tenancy/context';
import { shopLanguages } from '../onlineStore/languages';
import { diagnose, inspect, type Diagnosis, type DnsView } from './dns/inspect';
import { domainsRepository, type DomainRecord, type RegistrationRow } from './domains.repository';
import { edgeProvider, EdgeError, type EdgeHostnameState } from './edge/edgeProvider';
import { CHALLENGE_PREFIX, edgeAddresses, isApex, isPlatformHostname, isValidHostname, newRoutingTarget, normaliseHostname, rootDomain, siblingOf } from './hostnames';
import { nextState, type DomainNotice, type DomainStatus } from './lifecycle';
import { forgetHostRouting } from './hostRouting';
import { registrar, RegistrarError, type DnsRecordInput, type RegistrantContact } from './registrar/registrar';

/**
 * Custom domains, end to end — Shopify's Settings → Domains.
 *
 *   connect   the merchant types a domain; the platform adds it and its
 *             apex/www sibling, shows the records to create, and checks
 *             straight away and then on a backing-off schedule
 *   verify    DNS pointing at the domain's own target (or a TXT record)
 *             proves it is theirs; the edge is told to serve it and issue
 *             its certificate; the domain goes live
 *   primary   one domain is the address the store answers on; every other
 *             one (and the platform subdomain) redirects to it, keeping the path
 *   markets   a domain can belong to a market and a language instead:
 *             example.fr for France, in French
 *   move      a domain connected to another store moves with a TXT proof
 *   buy       a new domain is registered, pointed and connected in one step,
 *             and renewed on the store's bill
 *
 * The checking itself (`check`) is shared by the "Verify connection" button
 * and the sweep; `lifecycle.ts` decides what the evidence means.
 */

export interface Actor {
  id: number | null;
  label: string | null;
}

interface Snapshot {
  view: DnsView;
  diagnosis: Diagnosis;
  certificate: EdgeHostnameState | null;
}

// ── presentation ─────────────────────────────────────────────────────────────

function snapshotOf(domain: DomainRecord): Snapshot | null {
  const raw = domain.dns_snapshot;
  if (!raw) return null;
  try {
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Snapshot;
  } catch {
    return null;
  }
}

function present(domain: DomainRecord, context: { siblings: Map<number, DomainRecord>; markets: Map<number, string> }) {
  const snapshot = snapshotOf(domain);
  const pair = domain.pair_id ? context.siblings.get(domain.pair_id) : undefined;
  return {
    id: domain.id,
    hostname: domain.hostname,
    root_domain: domain.root_domain ?? domain.hostname,
    kind: domain.kind,
    source: domain.source,
    status: domain.kind === 'platform' ? 'active' : domain.status,
    is_primary: domain.is_primary === 1,
    redirect_to_primary: domain.redirect_to_primary === 1 && domain.is_primary !== 1,
    pair: pair ? { id: pair.id, hostname: pair.hostname } : null,
    market: domain.market_id ? { id: domain.market_id, name: context.markets.get(domain.market_id) ?? 'Market' } : null,
    locale: domain.locale,
    ownership: { verified: domain.verification_status === 'verified', method: domain.ownership_method },
    certificate: { status: domain.kind === 'platform' ? 'active' : domain.certificate_status, issuer: domain.certificate_issuer, expires_at: domain.certificate_expires_at },
    // What the merchant should see next to the domain.
    reason: domain.failure_reason,
    dns: domain.kind === 'custom'
      ? {
          records: snapshot?.diagnosis.expected ?? expectedWithoutCheck(domain),
          problems: snapshot?.diagnosis.problems ?? [],
          checked_at: snapshot?.view.checkedAt ?? null,
          resolvers: snapshot?.view.resolvers ?? [],
        }
      : null,
    // The legacy fields the rest of the admin reads.
    verification_status: domain.verification_status,
    ssl_status: domain.ssl_status,
    verified_at: domain.verified_at,
    last_checked_at: domain.last_checked_at,
    next_check_at: domain.next_check_at,
    created_at: domain.created_at,
  };
}

/** The records to create, before anything has been checked. */
function expectedWithoutCheck(domain: DomainRecord) {
  const edge = edgeAddresses();
  const records: { type: string; name: string; value: string; purpose: string; status: string; found: string[] }[] = [];
  if (isApex(domain.hostname) && edge.ipv4.length) {
    for (const ip of edge.ipv4) records.push({ type: 'A', name: domain.hostname, value: ip, purpose: 'Sends visitors to your store.', status: 'missing', found: [] });
  } else {
    records.push({ type: 'CNAME', name: domain.hostname, value: domain.routing_target ?? '', purpose: 'Sends visitors to your store and proves the domain is yours.', status: 'missing', found: [] });
  }
  if (domain.verification_status !== 'verified' && isApex(domain.hostname) && edge.ipv4.length) {
    records.push({ type: 'TXT', name: `${CHALLENGE_PREFIX}.${domain.hostname}`, value: `veylog-verify=${domain.verification_token}`, purpose: `Proves you own this domain (not needed once www.${domain.hostname} points to your store).`, status: 'missing', found: [] });
  }
  return records;
}

async function contextFor(domains: DomainRecord[]) {
  const siblings = new Map(domains.map((domain) => [domain.id, domain]));
  let markets = new Map<number, string>();
  if (domains.some((domain) => domain.market_id)) {
    const rows = await query<RowDataPacket & { id: number; name: string }>('SELECT id, name FROM markets WHERE shop_id = ?', [shopId()]);
    markets = new Map(rows.map((row) => [Number(row.id), row.name]));
  }
  return { siblings, markets };
}

// ── notices to the merchant ────────────────────────────────────────────────

const NOTICES: Record<DomainNotice, { severity: 'info' | 'success' | 'warning' | 'critical'; title: (host: string) => string; body: string }> = {
  connected: { severity: 'success', title: (host) => `${host} is connected`, body: 'It is live and secure (HTTPS). Make it your primary domain so shoppers see it everywhere.' },
  restored: { severity: 'success', title: (host) => `${host} is working again`, body: 'Its DNS points at your store again and its certificate is valid.' },
  misconfigured: { severity: 'critical', title: (host) => `${host} no longer points to your store`, body: 'Shoppers typing this address are not reaching your store. Check its DNS records.' },
  ssl_failed: { severity: 'warning', title: (host) => `A certificate could not be issued for ${host}`, body: 'Shoppers may see a security warning. Open the domain for what to fix.' },
  expired: { severity: 'info', title: (host) => `We stopped checking ${host}`, body: 'Its DNS was not set up within 14 days. Add the records and choose Verify connection to try again.' },
};

async function notify(domain: DomainRecord, notice: DomainNotice): Promise<void> {
  const shop = await shopDirectory.byId(domain.shop_id);
  if (!shop) return;
  const definition = NOTICES[notice];
  await tenancy.run(shop, () =>
    staffNotifier.notify({
      type: `domain.${notice}`,
      severity: definition.severity,
      title: definition.title(domain.hostname),
      body: definition.body,
      linkUrl: '/settings/domains',
      entityType: 'shop_domain',
      entityId: domain.id,
    }),
  );
}

// ── checking ─────────────────────────────────────────────────────────────────

/** Whether ownership is proven without this check: already verified, or proven by its apex/www sibling's own CNAME. */
async function provenElsewhere(domain: DomainRecord): Promise<DomainRecord['ownership_method'] | null> {
  if (domain.verification_status === 'verified') return domain.ownership_method ?? 'txt';
  if (!domain.pair_id) return null;
  const sibling = await domainsRepository.anyById(domain.pair_id);
  return sibling && sibling.shop_id === domain.shop_id && sibling.verification_status === 'verified' && (sibling.ownership_method === 'cname' || sibling.ownership_method === 'txt' || sibling.ownership_method === 'registrar') ? 'sibling' : null;
}

const SSL_STATUS: Record<DomainStatus, DomainRecord['ssl_status']> = {
  pending_dns: 'pending',
  provisioning_ssl: 'pending',
  active: 'active',
  misconfigured: 'pending',
  ssl_failed: 'failed',
  expired: 'pending',
};

/**
 * Looks at a domain's DNS and certificate and moves it along its lifecycle.
 * Used by the sweep and by "Verify connection"; `manual` revives an expired
 * domain (the merchant says they have now set it up).
 */
export async function check(domainIn: DomainRecord, options: { manual?: boolean } = {}): Promise<DomainRecord> {
  let domain = domainIn;
  if (domain.kind !== 'custom') return domain;
  if (options.manual && domain.status === 'expired') {
    await domainsRepository.update(domain.id, { status: 'pending_dns', status_changed_at: new Date(), check_attempts: 0 });
    domain = { ...domain, status: 'pending_dns', status_changed_at: new Date(), created_at: new Date() } as DomainRecord;
  }
  const proven = await provenElsewhere(domain);
  // A live domain with a settled certificate needs only its routing re-checked.
  const last = snapshotOf(domain);
  const light = !options.manual && domain.status === 'active' && domain.certificate_status === 'active' && last !== null;
  const view = await inspect(domain.hostname, light ? last!.view : null);
  const diagnosis = diagnose({ hostname: domain.hostname, routingTarget: domain.routing_target ?? '', verificationToken: domain.verification_token, ownershipProven: proven !== null }, view);
  const owned = proven !== null || diagnosis.ownership !== null;

  // The edge is only told about a domain that points here and is theirs.
  let certificate: EdgeHostnameState | null = null;
  const edge = edgeProvider();
  // A live certificate far from expiry is the edge's to renew: re-asking about it on every
  // check would spend the edge API's rate limit on answers already known.
  const settled =
    domain.status === 'active' &&
    domain.certificate_status === 'active' &&
    domain.certificate_expires_at !== null &&
    new Date(domain.certificate_expires_at).getTime() - Date.now() > 21 * 86_400_000;
  if (diagnosis.routed && owned && settled) {
    certificate = { id: domain.edge_hostname_id, certificate: 'active', issuer: domain.certificate_issuer, expiresAt: new Date(domain.certificate_expires_at!), detail: 'unchanged' };
  } else if (diagnosis.routed && owned) {
    try {
      certificate = domain.edge_hostname_id || domain.certificate_status !== 'none' ? await edge.state(domain.hostname, domain.edge_hostname_id) : await edge.attach(domain.hostname, null);
      if (certificate.certificate === 'none') certificate = await edge.attach(domain.hostname, domain.edge_hostname_id);
    } catch (error) {
      logger.warn('domains.edge_failed', { hostname: domain.hostname, error: String(error), retryable: error instanceof EdgeError ? error.retryable : null });
      certificate = { id: domain.edge_hostname_id, certificate: 'pending', issuer: null, expiresAt: null, detail: 'edge unavailable' };
    }
  }

  const outcome = nextState({
    status: domain.status,
    createdAt: domain.created_at,
    since: domain.status_changed_at ?? domain.created_at,
    attempts: domain.check_attempts,
    ownershipProven: proven !== null,
    diagnosis,
    certificate,
    now: new Date(),
  });
  if (outcome.attach) {
    try {
      certificate = await edge.attach(domain.hostname, domain.edge_hostname_id);
    } catch (error) {
      logger.warn('domains.edge_attach_failed', { hostname: domain.hostname, error: String(error) });
    }
  }

  const changed = outcome.status !== domain.status;
  const newlyVerified = outcome.ownershipProven && domain.verification_status !== 'verified';
  const now = new Date();
  await domainsRepository.update(domain.id, {
    status: outcome.status,
    verification_status: outcome.ownershipProven ? 'verified' : domain.verification_status,
    verified_at: newlyVerified ? now : domain.verified_at,
    ownership_method: newlyVerified ? (proven ?? diagnosis.ownership) : domain.ownership_method,
    ssl_status: SSL_STATUS[outcome.status],
    certificate_status: certificate?.certificate ?? domain.certificate_status,
    certificate_issuer: certificate?.issuer ?? domain.certificate_issuer,
    certificate_expires_at: certificate?.expiresAt ?? domain.certificate_expires_at,
    edge_provider: certificate ? edge.name : domain.edge_provider,
    edge_hostname_id: certificate?.id ?? domain.edge_hostname_id,
    dns_snapshot: { view, diagnosis, certificate },
    failure_reason: outcome.reason?.slice(0, 255) ?? null,
    last_checked_at: now,
    last_healthy_at: outcome.status === 'active' ? now : domain.last_healthy_at,
    check_attempts: changed ? 0 : domain.check_attempts + 1,
    status_changed_at: changed ? now : domain.status_changed_at,
    next_check_at: outcome.nextCheckMs === null ? null : new Date(now.getTime() + outcome.nextCheckMs),
    check_lease: null,
  });
  if (changed) {
    await domainsRepository.event(domain, 'status_changed', { from: domain.status, to: outcome.status, detail: { reason: outcome.reason, routed_via: diagnosis.routedVia, ownership: diagnosis.ownership, certificate: certificate?.detail ?? null } });
    logger.info('domains.status_changed', { shop_id: domain.shop_id, hostname: domain.hostname, from: domain.status, to: outcome.status });
  }
  if (newlyVerified) {
    shopDirectory.invalidate(domain.shop_id);
    forgetHostRouting(domain.shop_id);
  }
  if (outcome.notify) await notify(domain, outcome.notify).catch((error) => logger.warn('domains.notify_failed', { error: String(error) }));
  return (await domainsRepository.anyById(domain.id))!;
}

// ── the merchant's actions ─────────────────────────────────────────────────

/** A token that proves a store asked to move a domain to itself: nothing to store, nothing to guess. */
function transferToken(shop: number, hostname: string): string {
  return createHmac('sha256', `${env.auth.jwtSecret}:domain-transfer`).update(`${shop}:${hostname}`).digest('hex').slice(0, 32);
}

function cleanHostname(raw: string): string {
  const hostname = normaliseHostname(raw);
  if (!isValidHostname(hostname)) throw ApiError.validation({ hostname: ['Enter a domain such as example.com or shop.example.com.'] });
  if (isPlatformHostname(hostname)) throw ApiError.validation({ hostname: [`Addresses on ${env.platform.storefrontDomain} are assigned by the platform.`] });
  return hostname;
}

async function audit(actor: Actor, action: string, id: number, summary: string, changes?: Record<string, unknown>) {
  await auditService.log({ actorId: actor.id, actorLabel: actor.label, action, entityType: 'shop_domain', entityId: id, summary, changes });
}

function afterChange(shop: number) {
  shopDirectory.invalidate(shop);
  forgetHostRouting(shop);
}

export const domainsService = {
  async list() {
    const shop = tenancy.current();
    const domains = await domainsRepository.forShop(shop.id);
    const context = await contextFor(domains);
    const registrations = await domainsRepository.registrations(shop.id);
    return {
      domains: domains.map((domain) => present(domain, context)),
      registrations: registrations.map(presentRegistration),
      edge: { provider: edgeProvider().name, addresses: edgeAddresses() },
    };
  },

  async get(id: number) {
    const domain = await domainsRepository.byId(shopId(), id);
    if (!domain) throw ApiError.notFound('Domain');
    const all = await domainsRepository.forShop(shopId());
    const events = await domainsRepository.events(shopId(), id, 50);
    return {
      domain: present(domain, await contextFor(all)),
      events: events.map((event) => ({ id: event.id, event: event.event, from: event.from_status, to: event.to_status, detail: typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail, at: event.created_at })),
    };
  },

  /**
   * Connects a domain — and its apex/www sibling, as Shopify does: adding
   * example.com adds www.example.com too, so both addresses reach the store.
   */
  async connect(input: { hostname: string; include_sibling?: boolean }, actor: Actor) {
    const shop = tenancy.current();
    const hostname = cleanHostname(input.hostname);
    await entitlements.assertFeature('custom_domain');
    const sibling = input.include_sibling === false ? null : siblingOf(hostname);

    const existing = await domainsRepository.byHostname(hostname);
    if (existing) {
      if (existing.shop_id === shop.id) throw ApiError.conflict(`${hostname} is already connected to your store.`, 'CONFLICT');
      // Someone else's: it can move here with proof, never silently.
      throw new ApiError(409, 'DOMAIN_TAKEN', `${hostname} is connected to another store. If you own it, you can move it here by proving ownership.`, {
        transfer: { hostname, record: { type: 'TXT', name: `${CHALLENGE_PREFIX}.${hostname}`, value: `veylog-transfer=${transferToken(shop.id, hostname)}` } },
      });
    }
    const siblingFree = sibling ? !(await domainsRepository.byHostname(sibling)) : false;
    const adding = 1 + (siblingFree ? 1 : 0);
    await entitlements.assertWithinLimit('custom_domains', (await domainsRepository.countCustom(shop.id)) + adding - 1);

    const ids = await withTransaction(async (tx) => {
      const make = (host: string) =>
        domainsRepository.insertCustom({ shopId: shop.id, hostname: host, rootDomain: rootDomain(host), token: randomBytes(16).toString('hex'), routingTarget: newRoutingTarget(), source: 'connected' }, tx);
      const first = await make(hostname);
      const second = siblingFree ? await make(sibling!) : null;
      if (second) await domainsRepository.pair(first, second, tx);
      return [first, second].filter((id): id is number => id !== null);
    }, controlPlane);

    for (const id of ids) {
      const domain = (await domainsRepository.byId(shop.id, id))!;
      await domainsRepository.event(domain, 'added', { to: 'pending_dns', detail: { by: actor.label } });
      await audit(actor, 'domain.added', id, `Connected ${domain.hostname}`);
    }
    // A first look straight away: a merchant who set DNS up first sees it work at once.
    for (const id of ids) {
      const domain = (await domainsRepository.byId(shop.id, id))!;
      await check(domain).catch((error) => logger.warn('domains.first_check_failed', { hostname: domain.hostname, error: String(error) }));
    }
    afterChange(shop.id);
    return this.list();
  },

  async verifyNow(id: number) {
    const domain = await domainsRepository.byId(shopId(), id);
    if (!domain) throw ApiError.notFound('Domain');
    await check(domain, { manual: true });
    // Checking the apex also re-checks its www sibling, and the other way round.
    if (domain.pair_id) {
      const sibling = await domainsRepository.byId(shopId(), domain.pair_id);
      if (sibling) await check(sibling, { manual: true }).catch(() => undefined);
    }
    return this.get(id);
  },

  async makePrimary(id: number, actor: Actor) {
    const shop = tenancy.current();
    const domain = await domainsRepository.byId(shop.id, id);
    if (!domain) throw ApiError.notFound('Domain');
    if (domain.kind === 'custom' && domain.status !== 'active') {
      throw ApiError.conflict('A domain becomes primary once it is connected and secure.', 'INVALID_TRANSITION');
    }
    if (domain.market_id) throw ApiError.conflict('This domain belongs to a market. Remove it from the market to make it primary.', 'INVALID_TRANSITION');
    if (domain.locale) throw ApiError.conflict('This domain is a language’s home. Remove its language to make it primary.', 'INVALID_TRANSITION');
    await withTransaction((tx) => domainsRepository.setPrimary(shop.id, id, tx), controlPlane);
    // Everything else answers by redirecting here (market domains keep their own market).
    await domainsRepository.event(domain, 'primary');
    await audit(actor, 'domain.primary_changed', id, `${domain.hostname} is now the primary domain`);
    afterChange(shop.id);
    return this.list();
  },

  async update(id: number, input: { redirect_to_primary?: boolean; market_id?: number | null; locale?: string | null }, actor: Actor) {
    const shop = tenancy.current();
    const domain = await domainsRepository.byId(shop.id, id);
    if (!domain) throw ApiError.notFound('Domain');
    if (domain.kind !== 'custom') throw ApiError.conflict('The platform address cannot be changed.', 'IN_USE');
    const patch: Record<string, unknown> = {};
    if (input.redirect_to_primary !== undefined) patch.redirect_to_primary = input.redirect_to_primary ? 1 : 0;
    if (input.market_id !== undefined) {
      if (input.market_id !== null) {
        if (domain.is_primary === 1) throw ApiError.conflict('The primary domain serves every market. Assign another domain to this market.', 'INVALID_TRANSITION');
        const market = await query<RowDataPacket & { id: number }>('SELECT id FROM markets WHERE shop_id = ? AND id = ? AND is_active = 1', [shop.id, input.market_id]);
        if (!market.length) throw ApiError.validation({ market_id: ['Choose one of your active markets.'] });
        const others = (await domainsRepository.forShop(shop.id)).filter((other) => other.id !== id && Number(other.market_id) === input.market_id && other.pair_id !== id);
        if (others.length) throw ApiError.conflict(`${others[0].hostname} already serves that market.`, 'CONFLICT');
        patch.redirect_to_primary = 0;
      } else if (domain.market_id !== null) {
        // Out of its market: back to redirecting, unless it stays a language's home.
        const locale = input.locale !== undefined ? input.locale : domain.locale;
        patch.redirect_to_primary = locale ? 0 : 1;
      }
      patch.market_id = input.market_id;
    }
    if (input.locale !== undefined) {
      if (input.locale !== null) {
        if (domain.is_primary === 1) throw ApiError.conflict('The primary domain shows the store’s default language. Give the language a domain of its own.', 'INVALID_TRANSITION');
        const languages = await shopLanguages.get();
        if (!languages.published.some((language) => language.code === input.locale)) throw ApiError.validation({ locale: ['Choose a published language (Settings → Languages).'] });
        const inMarket = input.market_id !== undefined ? input.market_id !== null : domain.market_id !== null;
        if (!inMarket) {
          // A language domain (fr.example.com): one per language, and it serves rather than redirects.
          const others = (await domainsRepository.forShop(shop.id)).filter((other) => other.id !== id && other.pair_id !== id && other.market_id === null && other.locale === input.locale && other.redirect_to_primary === 0);
          if (others.length) throw ApiError.conflict(`${others[0].hostname} already serves that language.`, 'CONFLICT');
          patch.redirect_to_primary = 0;
        }
      } else if (domain.locale !== null && domain.market_id === null && input.market_id === undefined) {
        // No longer a language's home: back to sending visitors to the primary domain.
        patch.redirect_to_primary = 1;
      }
      patch.locale = input.locale;
    }
    await domainsRepository.update(id, patch);
    // The www/apex sibling follows its partner into a market or a language, redirecting to it
    // (never the primary domain, which keeps the store's default language).
    const pair = domain.pair_id ? await domainsRepository.byId(shop.id, domain.pair_id) : null;
    if (pair && pair.is_primary !== 1 && (input.market_id !== undefined || input.locale !== undefined)) {
      await domainsRepository.update(pair.id, {
        ...(input.market_id !== undefined ? { market_id: input.market_id } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.market_id !== undefined || input.locale !== undefined ? { redirect_to_primary: 1 } : {}),
      });
    }
    await domainsRepository.event(domain, 'settings', { detail: input });
    await audit(actor, 'domain.updated', id, `Changed ${domain.hostname}`, input as Record<string, unknown>);
    afterChange(shop.id);
    return this.get(id);
  },

  async remove(id: number, actor: Actor) {
    const shop = tenancy.current();
    const domain = await domainsRepository.byId(shop.id, id);
    if (!domain) throw ApiError.notFound('Domain');
    if (domain.kind !== 'custom') throw ApiError.conflict('The platform address cannot be removed.', 'IN_USE');
    if (domain.is_primary === 1) throw ApiError.conflict('Make another domain primary before removing this one.', 'IN_USE');
    try {
      await edgeProvider().detach(domain.hostname, domain.edge_hostname_id);
    } catch (error) {
      // The row goes regardless; a hostname the edge still serves but nobody owns is refused by the ask endpoint.
      logger.warn('domains.edge_detach_failed', { hostname: domain.hostname, error: String(error) });
    }
    await domainsRepository.event(domain, 'removed', { from: domain.status });
    await domainsRepository.remove(id);
    await audit(actor, 'domain.removed', id, `Removed ${domain.hostname}`);
    afterChange(shop.id);
    return { removed: true };
  },

  // ── moving a domain from another store ─────────────────────────────────

  async transferInstructions(hostnameRaw: string) {
    const hostname = cleanHostname(hostnameRaw);
    return { hostname, record: { type: 'TXT', name: `${CHALLENGE_PREFIX}.${hostname}`, value: `veylog-transfer=${transferToken(shopId(), hostname)}` } };
  },

  /** Moves a domain connected to another store here, once this store's TXT proof is in its DNS. */
  async completeTransfer(hostnameRaw: string, actor: Actor) {
    const shop = tenancy.current();
    const hostname = cleanHostname(hostnameRaw);
    const existing = await domainsRepository.byHostname(hostname);
    if (!existing) return this.connect({ hostname, include_sibling: false }, actor);
    if (existing.shop_id === shop.id) throw ApiError.conflict(`${hostname} is already connected to your store.`, 'CONFLICT');
    const view = await inspect(hostname);
    if (!view.challenge.includes(`veylog-transfer=${transferToken(shop.id, hostname)}`)) {
      throw ApiError.validation({ hostname: [`The TXT record ${CHALLENGE_PREFIX}.${hostname} was not found yet. DNS changes can take a while to show.`] });
    }
    const previousShop = existing.shop_id;
    await withTransaction(async (tx) => {
      // The old store keeps working on its platform address.
      if (existing.is_primary === 1) {
        const fallback = await domainsRepository.platformDomain(previousShop, tx);
        if (fallback) await domainsRepository.setPrimary(previousShop, fallback.id, tx);
      }
      if (existing.pair_id) await domainsRepository.update(existing.pair_id, { pair_id: null }, tx);
      await domainsRepository.update(
        existing.id,
        {
          shop_id: shop.id,
          is_primary: 0,
          pair_id: null,
          market_id: null,
          locale: null,
          redirect_to_primary: 1,
          ownership_method: 'transfer',
          verification_status: 'verified',
          verified_at: new Date(),
          routing_target: newRoutingTarget(),
          status: 'pending_dns',
          status_changed_at: new Date(),
          next_check_at: new Date(),
          check_attempts: 0,
        },
        tx,
      );
    }, controlPlane);
    const moved = (await domainsRepository.anyById(existing.id))!;
    await domainsRepository.event(moved, 'claimed', { detail: { from_shop: previousShop, to_shop: shop.id } });
    await audit(actor, 'domain.transferred_in', moved.id, `Moved ${hostname} to this store`);
    const old = await shopDirectory.byId(previousShop);
    if (old) {
      await tenancy.run(old, () =>
        staffNotifier.notify({ type: 'domain.transferred_out', severity: 'warning', title: `${hostname} was moved to another store`, body: 'Its owner proved control of its DNS and connected it elsewhere.', linkUrl: '/settings/domains' }),
      );
    }
    afterChange(previousShop);
    afterChange(shop.id);
    await check(moved).catch(() => undefined);
    return this.list();
  },

  // ── buying a domain ────────────────────────────────────────────────────

  async search(keyword: string) {
    const offers = await registrar().search(keyword.trim().slice(0, 63));
    const currency = await billingCurrency();
    const markup = 1 + Number(process.env.REGISTRAR_MARKUP_PERCENT ?? 0) / 100;
    const priced = await Promise.all(
      offers.map(async (offer) => {
        const connected = await domainsRepository.byHostname(offer.domain);
        const rate = await exchangeRate(offer.currency, currency).catch(() => null);
        const price = rate === null ? { amount: offer.price * markup, currency: offer.currency } : { amount: offer.price * markup * rate, currency };
        const renewal = rate === null ? { amount: offer.renewal * markup, currency: offer.currency } : { amount: offer.renewal * markup * rate, currency };
        return { domain: offer.domain, available: offer.available && !connected, premium: offer.premium, price: round(price), renewal: round(renewal) };
      }),
    );
    return { results: priced.sort((a, b) => Number(b.available) - Number(a.available)) };
  },

  async buy(input: { domain: string; years?: number; privacy?: boolean; contact?: RegistrantContact | null }, actor: Actor) {
    const shop = tenancy.current();
    const domain = cleanHostname(input.domain);
    if (!isApex(domain)) throw ApiError.validation({ domain: ['Buy the domain itself (example.com); subdomains come with it.'] });
    await entitlements.assertFeature('custom_domain');
    await entitlements.assertWithinLimit('custom_domains', (await domainsRepository.countCustom(shop.id)) + 1);
    if (await domainsRepository.registrationByDomain(domain)) throw ApiError.conflict(`${domain} is already registered through the platform.`, 'CONFLICT');
    if (await domainsRepository.byHostname(domain)) throw ApiError.conflict(`${domain} is already connected to a store.`, 'CONFLICT');

    const provider = registrar();
    const offer = await provider.check(domain).catch((error) => {
      throw ApiError.integrationNotConfigured('registrar', error instanceof Error ? error.message : 'The registrar is not available.');
    });
    if (!offer.available) throw ApiError.conflict(`${domain} is not available.`, 'CONFLICT');
    const years = Math.min(10, Math.max(1, input.years ?? 1));
    const currency = await billingCurrency();
    const markup = 1 + Number(process.env.REGISTRAR_MARKUP_PERCENT ?? 0) / 100;
    const rate = await exchangeRate(offer.currency, currency).catch(() => null);
    const billed = round({ amount: (offer.price + offer.renewal * (years - 1)) * markup * (rate ?? 1), currency: rate === null ? offer.currency : currency });
    const renewal = round({ amount: offer.renewal * markup * (rate ?? 1), currency: billed.currency });

    const registrationId = await domainsRepository.insertRegistration({ shopId: shop.id, domain, registrar: provider.name, years, price: billed.amount, renewal: renewal.amount, currency: billed.currency, privacy: input.privacy !== false });
    let result: { orderId: string; expiresAt: Date };
    try {
      result = await provider.register({ domain, years, price: offer.price + offer.renewal * (years - 1), privacy: input.privacy !== false, contact: input.contact ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await domainsRepository.updateRegistration(registrationId, { status: 'failed', last_error: message.slice(0, 500) });
      throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', error instanceof RegistrarError ? `${message} You have not been charged.` : 'The domain could not be registered. You have not been charged.');
    }
    await domainsRepository.updateRegistration(registrationId, { status: 'active', registrar_order_id: result.orderId, registered_at: new Date(), expires_at: result.expiresAt });

    // Connected on the spot: both addresses, ownership proven by the purchase, DNS set at the registrar.
    const ids = await withTransaction(async (tx) => {
      const make = (host: string) =>
        domainsRepository.insertCustom({ shopId: shop.id, hostname: host, rootDomain: domain, token: randomBytes(16).toString('hex'), routingTarget: newRoutingTarget(), source: 'purchased', ownershipMethod: 'registrar' }, tx);
      const apex = await make(domain);
      const www = await make(`www.${domain}`);
      await domainsRepository.pair(apex, www, tx);
      await billingRepository.addLines(shop.id, null, [{ kind: 'domain', description: `${domain} — ${years} year${years > 1 ? 's' : ''}`, currency: billed.currency, amount: billed.amount, periodStart: new Date(), periodEnd: result.expiresAt, reference: `domain:${registrationId}` }], tx);
      return [apex, www];
    }, controlPlane);
    const [apex, www] = await Promise.all(ids.map((id) => domainsRepository.byId(shop.id, id)));
    await pointAtEdge(domain, apex!, www!);
    for (const record of [apex!, www!]) await domainsRepository.event(record, 'added', { to: 'pending_dns', detail: { purchased: true, by: actor.label } });
    await audit(actor, 'domain.purchased', apex!.id, `Bought ${domain} for ${billed.amount} ${billed.currency}`, { years, registrar: provider.name });
    for (const record of [apex!, www!]) await check(record).catch(() => undefined);
    afterChange(shop.id);
    return this.list();
  },

  async setAutoRenew(registrationId: number, on: boolean, actor: Actor) {
    const registration = (await domainsRepository.registrations(shopId())).find((row) => row.id === registrationId);
    if (!registration) throw ApiError.notFound('Domain registration');
    await domainsRepository.updateRegistration(registrationId, { auto_renew: on ? 1 : 0 });
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'domain.auto_renew', entityType: 'domain_registration', entityId: registrationId, summary: `${on ? 'Turned on' : 'Turned off'} auto-renew for ${registration.domain}` });
    return this.list();
  },

  /**
   * Shopify's "Transfer to Shopify": can this connected domain's registration
   * move to the platform's registrar, and for how much (a transfer adds a year).
   */
  async transferQuote(id: number) {
    const quote = await quoteTransfer(id);
    return { domain: quote.root, eligible: quote.eligible, reason: quote.reason, price: quote.billed, registrar: registrar().name, adds_years: 1 };
  },

  /** Starts moving the registration here with the transfer code from the current provider. Billed when it completes. */
  async transferIn(id: number, input: { auth_code: string; privacy?: boolean; contact?: RegistrantContact | null }, actor: Actor) {
    const shop = tenancy.current();
    await entitlements.assertFeature('custom_domain');
    const quote = await quoteTransfer(id);
    if (!quote.eligible || !quote.billed || !quote.offer) throw ApiError.conflict(quote.reason ?? 'This domain cannot be transferred here.', 'INVALID_TRANSITION');
    const provider = registrar();
    const privacy = input.privacy !== false;
    const registrationId = await domainsRepository.insertRegistration({ shopId: shop.id, domain: quote.root, registrar: provider.name, years: 1, price: quote.billed.amount, renewal: quote.billed.amount, currency: quote.billed.currency, privacy, kind: 'transfer', status: 'transferring' });
    try {
      const { orderId } = await provider.transferIn({ domain: quote.root, authCode: input.auth_code.trim(), price: quote.offer.price, privacy, contact: input.contact ?? null });
      await domainsRepository.updateRegistration(registrationId, { registrar_order_id: orderId, transfer_checked_at: new Date() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await domainsRepository.updateRegistration(registrationId, { status: 'failed', last_error: message.slice(0, 500) });
      // The registrar refusing what was entered (a wrong code) is the merchant's to fix; anything else is ours.
      if (error instanceof RegistrarError && !error.retryable) throw ApiError.conflict(`${message} Nothing has been charged.`, 'INVALID_TRANSITION');
      throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', error instanceof RegistrarError ? `${message} Nothing has been charged.` : 'The transfer could not be started. Nothing has been charged.');
    }
    for (const record of await domainsRepository.forRoot(shop.id, quote.root)) await domainsRepository.event(record, 'transfer_requested', { detail: { registrar: provider.name, by: actor.label } });
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'domain.transfer_in_requested', entityType: 'domain_registration', entityId: registrationId, summary: `Asked to transfer ${quote.root} here (${quote.billed.amount} ${quote.billed.currency} when it completes)` });
    return this.list();
  },

  /** The code another registrar asks for to take the domain over. */
  async transferOutCode(registrationId: number, actor: Actor) {
    const registration = (await domainsRepository.registrations(shopId())).find((row) => row.id === registrationId);
    if (!registration || registration.status !== 'active') throw ApiError.notFound('Domain registration');
    const code = await registrar().authCode(registration.domain);
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'domain.transfer_code', entityType: 'domain_registration', entityId: registrationId, summary: `Revealed the transfer code for ${registration.domain}` });
    return { domain: registration.domain, auth_code: code };
  },
};

interface TransferQuoteResult {
  root: string;
  eligible: boolean;
  reason: string | null;
  /** What the registrar asks, in its currency. */
  offer: { price: number; currency: string } | null;
  /** What the store is billed. */
  billed: { amount: number; currency: string } | null;
}

async function quoteTransfer(id: number): Promise<TransferQuoteResult> {
  const shop = tenancy.current();
  const domain = await domainsRepository.byId(shop.id, id);
  if (!domain || domain.kind !== 'custom') throw ApiError.notFound('Domain');
  const root = domain.root_domain ?? rootDomain(domain.hostname);
  const refuse = (reason: string): TransferQuoteResult => ({ root, eligible: false, reason, offer: null, billed: null });
  const existing = await domainsRepository.registrationByDomain(root);
  if (existing) {
    if (existing.shop_id !== shop.id) return refuse(`${root} is registered through another store on the platform.`);
    return refuse(existing.status === 'transferring' ? `${root} is already on its way here.` : `${root} is already managed here.`);
  }
  // Connected first, so the store never goes dark while the registries hand it over.
  if (domain.status !== 'active') return refuse(`Connect ${domain.hostname} first. Once it is live here, transfer it — the store stays up throughout.`);
  const offer = await registrar()
    .transferQuote(root)
    .catch((error) => {
      throw ApiError.integrationNotConfigured('registrar', error instanceof Error ? error.message : 'The registrar is not available.');
    });
  const billed = await asBilled(offer.price, offer.currency);
  return { root, eligible: offer.eligible, reason: offer.reason, offer: { price: offer.price, currency: offer.currency }, billed };
}

/** A registrar's price as the store is billed it: with the platform's markup, in the store's billing currency. */
async function asBilled(amount: number, currency: string): Promise<{ amount: number; currency: string }> {
  const target = await billingCurrency();
  const markup = 1 + Number(process.env.REGISTRAR_MARKUP_PERCENT ?? 0) / 100;
  const rate = await exchangeRate(currency, target).catch(() => null);
  return round({ amount: amount * markup * (rate ?? 1), currency: rate === null ? currency : target });
}

function round(money: { amount: number; currency: string }) {
  return { amount: Math.round(money.amount * 100) / 100, currency: money.currency };
}

async function billingCurrency(): Promise<string> {
  const subscription = await shopsRepository.liveSubscription(shopId()).catch(() => null);
  return (subscription as { currency?: string } | null)?.currency ?? tenancy.current().currency ?? 'USD';
}

/** At purchase, the registrar's DNS for the domain points at the edge. */
async function pointAtEdge(domain: string, apex: DomainRecord, www: DomainRecord): Promise<void> {
  const edge = edgeAddresses();
  const records: DnsRecordInput[] = edge.ipv4.length
    ? [...edge.ipv4.map((ip) => ({ type: 'A' as const, host: '', value: ip })), ...edge.ipv6.map((ip) => ({ type: 'AAAA' as const, host: '', value: ip }))]
    : [{ type: 'CNAME', host: '', value: apex.routing_target ?? '' }];
  records.push({ type: 'CNAME', host: 'www', value: www.routing_target ?? '' });
  try {
    await registrar().setRecords(domain, records);
  } catch (error) {
    logger.error('domains.registrar_dns_failed', { domain, error: String(error) });
  }
}

function presentRegistration(row: RegistrationRow) {
  return {
    id: row.id,
    domain: row.domain,
    registrar: row.registrar,
    kind: row.kind,
    status: row.status,
    auto_renew: row.auto_renew === 1,
    privacy: row.privacy === 1,
    registered_at: row.registered_at,
    expires_at: row.expires_at,
    renewal: { amount: Number(row.renewal_amount), currency: row.currency },
    last_error: row.last_error,
  };
}

/** A transfer the registries have not finished after this long has failed (they take up to a week). */
const TRANSFER_GIVE_UP_MS = 10 * 86_400_000;

/**
 * Follows transfers in: asks the registrar about each one every ten minutes.
 * Completed — the registration is live here with a year added, billed on the
 * next invoice, and the store's addresses on the domain are "transferred"
 * (renewals, auto-renew and the transfer-out code now apply). Failed — the
 * merchant is told why; nothing was charged.
 */
export async function advanceTransfers(): Promise<{ completed: number; failed: number; pending: number }> {
  const counts = { completed: 0, failed: 0, pending: 0 };
  for (const registration of await domainsRepository.transfersToCheck(10, 100)) {
    const shop = await shopDirectory.byId(registration.shop_id);
    if (!shop) continue;
    await tenancy.run(shop, async () => {
      const addresses = await domainsRepository.forRoot(shop.id, registration.domain);
      const fail = async (reason: string) => {
        counts.failed += 1;
        await domainsRepository.updateRegistration(registration.id, { status: 'failed', last_error: reason.slice(0, 500), transfer_checked_at: new Date() });
        for (const record of addresses) await domainsRepository.event(record, 'transfer_failed', { detail: { reason } });
        await staffNotifier.notify({ type: 'domain.transfer_failed', severity: 'warning', title: `${registration.domain} was not transferred`, body: `${reason} Nothing was charged, and the domain still works where it is.`, linkUrl: '/settings/domains' });
      };
      let progress;
      try {
        progress = await registrar().transferStatus(registration.domain);
      } catch (error) {
        counts.pending += 1;
        await domainsRepository.updateRegistration(registration.id, { transfer_checked_at: new Date(), last_error: String(error).slice(0, 500) });
        return;
      }
      if (progress.status === 'failed') return fail(progress.reason ?? 'The transfer was not accepted.');
      if (progress.status === 'pending') {
        if (Date.now() - new Date(registration.created_at).getTime() > TRANSFER_GIVE_UP_MS) return fail('The transfer did not complete within ten days. Check that the domain is unlocked at your current provider, then start again.');
        counts.pending += 1;
        await domainsRepository.updateRegistration(registration.id, { transfer_checked_at: new Date() });
        return;
      }
      const now = new Date();
      const expiresAt = progress.expiresAt ?? new Date(now.getTime() + 365 * 86_400_000);
      await withTransaction(async (tx) => {
        await domainsRepository.updateRegistration(registration.id, { status: 'active', registered_at: now, expires_at: expiresAt, last_error: null, transfer_checked_at: now }, tx);
        await billingRepository.addLines(shop.id, null, [{ kind: 'domain', description: `${registration.domain} — transfer (one year added)`, currency: registration.currency, amount: Number(registration.price_amount), periodStart: now, periodEnd: expiresAt, reference: `domain:${registration.id}:transfer` }], tx);
        for (const record of addresses) if (record.source === 'connected') await domainsRepository.update(record.id, { source: 'transferred' }, tx);
      }, controlPlane);
      counts.completed += 1;
      for (const record of addresses) await domainsRepository.event(record, 'transferred_in', { detail: { expires_at: expiresAt.toISOString() } });
      await staffNotifier.notify({ type: 'domain.transferred_in', severity: 'info', title: `${registration.domain} is now managed here`, body: `The transfer is complete and a year was added (renews ${expiresAt.toISOString().slice(0, 10)}). Your DNS stays where it is.`, linkUrl: '/settings/domains' });
    });
  }
  return counts;
}

/** Renews what auto-renews, 30 days ahead; bills it; tells the merchant if it fails. */
export async function renewDue(): Promise<{ renewed: number; failed: number }> {
  let renewed = 0;
  let failed = 0;
  for (const registration of await domainsRepository.dueRenewals(30, 50)) {
    const shop = await shopDirectory.byId(registration.shop_id);
    if (!shop) continue;
    await tenancy.run(shop, async () => {
      try {
        const result = await registrar().renew(registration.domain, 1, Number(registration.renewal_amount));
        await withTransaction(async (tx) => {
          await domainsRepository.updateRegistration(registration.id, { expires_at: result.expiresAt, last_error: null }, tx);
          await billingRepository.addLines(shop.id, null, [{ kind: 'domain', description: `${registration.domain} — renewal`, currency: registration.currency, amount: Number(registration.renewal_amount), periodStart: registration.expires_at, periodEnd: result.expiresAt, reference: `domain:${registration.id}:renew:${result.expiresAt.toISOString().slice(0, 10)}` }], tx);
        }, controlPlane);
        renewed += 1;
      } catch (error) {
        failed += 1;
        await domainsRepository.updateRegistration(registration.id, { last_error: String(error).slice(0, 500) });
        await staffNotifier.notify({ type: 'domain.renewal_failed', severity: 'critical', title: `${registration.domain} could not be renewed`, body: `It expires on ${registration.expires_at?.toISOString().slice(0, 10)}. We will try again tomorrow.`, linkUrl: '/settings/domains' });
      }
    });
  }
  return { renewed, failed };
}
