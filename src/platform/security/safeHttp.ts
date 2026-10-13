import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupFunction } from 'node:net';

/**
 * Outbound HTTP to addresses someone else chose — webhook endpoints, app
 * callbacks — without letting them aim us at our own network.
 *
 * The attack: register a webhook for http://169.254.169.254/latest/meta-data/
 * and let the platform fetch its own cloud credentials, or point at an
 * internal admin port. Checking the hostname before the request is not
 * enough; DNS can answer differently a second later (rebinding). So the check
 * runs inside the socket's own DNS lookup, on the exact address it is about
 * to connect to.
 *
 * Also: no redirects (a public URL that 302s to an internal one is the same
 * attack), a hard timeout, and a cap on how much of the response is read.
 */

export class UnsafeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTargetError';
  }
}

const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const value = v4ToInt(address);
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (value & mask) === (v4ToInt(base) & mask);
    });
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('ff')
    );
  }
  return true;
}

export interface SafeRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs: number;
  /** Local development only: allow localhost and private networks. */
  allowPrivate?: boolean;
  /** Read at most this much of the response body. */
  maxResponseBytes?: number;
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  durationMs: number;
}

/** Validates a URL a merchant typed, before it is saved. */
export function assertAcceptableUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeTargetError('Not a valid URL.');
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) {
    throw new UnsafeTargetError('The address must use https.');
  }
  if (url.username || url.password) throw new UnsafeTargetError('The address must not contain credentials.');
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
      throw new UnsafeTargetError('The address must be reachable on the public internet.');
    }
    if (net.isIP(host) && isPrivateAddress(host)) {
      throw new UnsafeTargetError('The address must be reachable on the public internet.');
    }
  }
  return url;
}

/**
 * Node calls a custom lookup either for one address or — with happy eyeballs,
 * the default since Node 20 — for all of them, and expects the answer in the
 * same shape. Either way every address is checked, and one private address in
 * the answer is enough to refuse: an attacker controls the whole record set.
 */
function guardedLookup(allowPrivate: boolean): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = addresses as dns.LookupAddress[];
      if (!allowPrivate && list.some((entry) => isPrivateAddress(entry.address))) {
        return callback(new UnsafeTargetError(`${hostname} resolves to a private address.`));
      }
      if (list.length === 0) return callback(new Error(`${hostname} did not resolve.`));
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }) as unknown as LookupFunction;
}

export function safeRequest(request: SafeRequest): Promise<SafeResponse> {
  const allowPrivate = request.allowPrivate ?? false;
  const url = assertAcceptableUrl(request.url, allowPrivate);
  const transport = url.protocol === 'https:' ? https : http;
  const limit = request.maxResponseBytes ?? 64 * 1024;
  const started = Date.now();

  return new Promise<SafeResponse>((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: request.method ?? 'POST',
        headers: {
          ...(request.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(request.body)) } : {}),
          ...request.headers,
        },
        lookup: guardedLookup(allowPrivate),
        timeout: request.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size >= limit) return;
          chunks.push(chunk.subarray(0, Math.max(0, limit - size)));
          size += chunk.length;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            durationMs: Date.now() - started,
          }),
        );
        res.on('error', reject);
      },
    );

    // One timer for the whole exchange, not per socket event.
    const deadline = setTimeout(() => req.destroy(new Error(`No response within ${request.timeoutMs}ms`)), request.timeoutMs);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error(`No response within ${request.timeoutMs}ms`)));
    req.on('error', reject);
    if (request.body !== undefined) req.write(request.body);
    req.end();
  });
}
