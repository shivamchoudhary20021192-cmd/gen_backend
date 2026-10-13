import tls from 'node:tls';
import { env } from '../../../config/env';
import { logger } from '../../../core/logger';
import { edgeAddresses } from '../hostnames';

/**
 * The edge: the layer in front of the application that terminates TLS for
 * every store's domain, close to the shopper. The application never holds a
 * certificate; it tells the edge which hostnames to serve and asks how their
 * certificates are doing.
 *
 *   EDGE_PROVIDER=cloudflare   Cloudflare for SaaS "custom hostnames": an
 *                              anycast network in 300+ cities, a certificate
 *                              per hostname issued and renewed by Cloudflare,
 *                              the platform's load balancers as the origin.
 *                              Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID.
 *   EDGE_PROVIDER=on_demand    a self-run edge (Caddy, Traefik, OpenResty) with
 *                              on-demand TLS: it asks GET /internal/edge/tls-allowed
 *                              before issuing a certificate on a domain's first
 *                              visit. The platform probes the domain over TLS to
 *                              see the certificate. EDGE_PROBE_ADDRESS aims the
 *                              probe at one edge node.
 *   EDGE_PROVIDER=local        development: no TLS, every domain "has" a certificate.
 */

export interface EdgeHostnameState {
  /** The provider's id for the hostname, when it has one. */
  id: string | null;
  certificate: 'none' | 'pending' | 'active' | 'failed';
  issuer: string | null;
  expiresAt: Date | null;
  /** The provider's own status word, for support ("pending_validation"). */
  detail: string | null;
}

export interface EdgeProvider {
  readonly name: string;
  /** Starts serving the hostname and getting its certificate. Idempotent. */
  attach(hostname: string, existingId: string | null): Promise<EdgeHostnameState>;
  /** Where the hostname's certificate is now. */
  state(hostname: string, id: string | null): Promise<EdgeHostnameState>;
  /** Stops serving the hostname. Idempotent; a hostname the edge does not know is fine. */
  detach(hostname: string, id: string | null): Promise<void>;
}

export class EdgeError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EdgeError';
  }
}

// ── development ─────────────────────────────────────────────────────────────

class LocalEdge implements EdgeProvider {
  readonly name = 'local';
  async attach(): Promise<EdgeHostnameState> {
    return this.state();
  }
  async state(): Promise<EdgeHostnameState> {
    return { id: null, certificate: 'active', issuer: 'Local development (no TLS)', expiresAt: new Date(Date.now() + 90 * 86_400_000), detail: 'local' };
  }
  async detach(): Promise<void> {}
}

// ── a self-run edge with on-demand TLS ─────────────────────────────────────

/**
 * Connects to the edge the way a browser would (SNI = the hostname) and reads
 * the certificate it presents. The first connection is also what makes an
 * on-demand-TLS edge issue the certificate, so probing is warming.
 */
export function probeCertificate(hostname: string, address?: string): Promise<EdgeHostnameState> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: address ?? hostname, port: 443, servername: hostname, timeout: 6_000, rejectUnauthorized: false }, () => {
      const certificate = socket.getPeerCertificate();
      const names = String(certificate.subjectaltname ?? '')
        .split(',')
        .map((entry) => entry.trim().replace(/^DNS:/, '').toLowerCase());
      const covers = names.includes(hostname) || names.some((name) => name.startsWith('*.') && hostname.endsWith(name.slice(1)) && hostname.split('.').length === name.split('.').length);
      const expiresAt = certificate.valid_to ? new Date(certificate.valid_to) : null;
      const issuer = certificate.issuer ? [certificate.issuer.O, certificate.issuer.CN].filter(Boolean).join(' · ') : null;
      socket.end();
      // Checked against the system's trusted roots, as a browser would.
      const trusted = socket.authorized;
      if (covers && trusted && expiresAt && expiresAt.getTime() > Date.now()) {
        resolve({ id: null, certificate: 'active', issuer, expiresAt, detail: 'serving' });
      } else {
        resolve({ id: null, certificate: 'pending', issuer, expiresAt, detail: covers ? String(socket.authorizationError ?? 'expired') : 'certificate does not cover the hostname yet' });
      }
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ id: null, certificate: 'pending', issuer: null, expiresAt: null, detail: 'timed out' });
    });
    socket.on('error', (error) => resolve({ id: null, certificate: 'pending', issuer: null, expiresAt: null, detail: error.message.slice(0, 120) }));
  });
}

class OnDemandTlsEdge implements EdgeProvider {
  readonly name = 'on_demand';
  async attach(hostname: string): Promise<EdgeHostnameState> {
    // Nothing to register: the edge asks /internal/edge/tls-allowed. The probe warms it.
    return this.state(hostname);
  }
  async state(hostname: string): Promise<EdgeHostnameState> {
    return probeCertificate(hostname, process.env.EDGE_PROBE_ADDRESS ?? edgeAddresses().ipv4[0]);
  }
  async detach(): Promise<void> {
    // The ask endpoint stops allowing it; the edge's certificate lapses unused.
  }
}

// ── Cloudflare for SaaS ────────────────────────────────────────────────────

interface CloudflareHostname {
  id: string;
  hostname: string;
  status: string;
  ssl?: { status?: string; certificate_authority?: string; certificates?: { issuer?: string; expires_on?: string }[]; validation_errors?: { message: string }[] };
}

const CLOUDFLARE_PENDING = new Set(['initializing', 'pending_validation', 'pending_issuance', 'pending_deployment', 'pending_cleanup', 'pending_expiration', 'staging_deployment', 'backup_issued', 'holding_deployment']);

class CloudflareEdge implements EdgeProvider {
  readonly name = 'cloudflare';
  private readonly base: string;
  constructor(
    private readonly token: string,
    zone: string,
  ) {
    this.base = `https://api.cloudflare.com/client/v4/zones/${zone}/custom_hostnames`;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base}${path}`, { ...init, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new EdgeError(`Cloudflare did not answer: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    const body = (await response.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { code: number; message: string }[] };
    if (!response.ok || body.success === false) {
      const message = body.errors?.map((error) => `${error.code} ${error.message}`).join('; ') || `HTTP ${response.status}`;
      throw new EdgeError(`Cloudflare: ${message}`, response.status >= 500 || response.status === 429);
    }
    return body.result as T;
  }

  private present(record: CloudflareHostname): EdgeHostnameState {
    const status = record.ssl?.status ?? 'initializing';
    const certificate = status === 'active' ? 'active' : CLOUDFLARE_PENDING.has(status) ? 'pending' : 'failed';
    const current = record.ssl?.certificates?.[0];
    return {
      id: record.id,
      certificate,
      issuer: current?.issuer ?? record.ssl?.certificate_authority ?? null,
      expiresAt: current?.expires_on ? new Date(current.expires_on) : null,
      detail: record.ssl?.validation_errors?.[0]?.message ?? status,
    };
  }

  private async find(hostname: string): Promise<CloudflareHostname | null> {
    const list = await this.call<CloudflareHostname[]>(`?hostname=${encodeURIComponent(hostname)}`);
    return list.find((record) => record.hostname === hostname) ?? null;
  }

  async attach(hostname: string, existingId: string | null): Promise<EdgeHostnameState> {
    if (existingId) return this.state(hostname, existingId);
    const existing = await this.find(hostname);
    if (existing) return this.present(existing);
    const created = await this.call<CloudflareHostname>('', {
      method: 'POST',
      // HTTP validation: once the domain points at the edge, Cloudflare proves control itself.
      body: JSON.stringify({ hostname, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2', http2: 'on' } } }),
    });
    return this.present(created);
  }

  async state(hostname: string, id: string | null): Promise<EdgeHostnameState> {
    const record = id ? await this.call<CloudflareHostname>(`/${id}`).catch((error) => (error instanceof EdgeError && !error.retryable ? null : Promise.reject(error))) : await this.find(hostname);
    if (!record) return { id: null, certificate: 'none', issuer: null, expiresAt: null, detail: 'not registered' };
    return this.present(record);
  }

  async detach(hostname: string, id: string | null): Promise<void> {
    const target = id ?? (await this.find(hostname))?.id;
    if (!target) return;
    await this.call(`/${target}`, { method: 'DELETE' }).catch((error) => {
      if (error instanceof EdgeError && !error.retryable) return; // already gone
      throw error;
    });
  }
}

// ── which one ───────────────────────────────────────────────────────────────

let provider: EdgeProvider | null = null;

export function edgeProvider(): EdgeProvider {
  if (provider) return provider;
  const name = (process.env.EDGE_PROVIDER ?? (env.nodeEnv === 'production' ? 'on_demand' : 'local')).toLowerCase();
  if (name === 'cloudflare') {
    const token = process.env.CLOUDFLARE_API_TOKEN;
    const zone = process.env.CLOUDFLARE_ZONE_ID;
    if (token && zone) provider = new CloudflareEdge(token, zone);
    else {
      logger.error('edge.cloudflare_unconfigured', { hint: 'set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID' });
      provider = new OnDemandTlsEdge();
    }
  } else if (name === 'on_demand') {
    provider = new OnDemandTlsEdge();
  } else {
    provider = new LocalEdge();
  }
  return provider;
}

/** For tests. */
export function useEdgeProvider(next: EdgeProvider | null): void {
  provider = next;
}
