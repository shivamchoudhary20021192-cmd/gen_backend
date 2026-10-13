import crypto from 'node:crypto';
import type { StorageDriver } from './StorageDriver';

/**
 * S3 and S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, Wasabi,
 * DigitalOcean Spaces), signed with AWS Signature Version 4.
 *
 * Hand-rolled over `fetch` for the same reason as the payment adapters: four
 * authenticated REST calls do not justify the AWS SDK's dependency tree in the
 * path of every upload. Objects are addressed path-style
 * (`{endpoint}/{bucket}/{key}`), which every S3-compatible service accepts.
 *
 * Every shop's media already lives under `shops/{shop public id}/…` (see the
 * media service), so one bucket serves the whole platform and a shop's files
 * can be listed, exported or purged by prefix.
 *
 * Configuration (environment):
 *   S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
 *   S3_ENDPOINT        — omit for AWS; e.g. https://<account>.r2.cloudflarestorage.com
 *   S3_PUBLIC_BASE_URL — the CDN or bucket URL files are served from
 */

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  publicBaseUrl: string;
}

const UNSIGNED_EMPTY = crypto.createHash('sha256').update('').digest('hex');

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** RFC 3986 encoding of each path segment, as SigV4 requires. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export function s3ConfigFromEnv(): S3Config {
  const required = (name: string) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required when STORAGE_DRIVER=s3.`);
    return value;
  };
  const region = process.env.S3_REGION?.trim() || 'us-east-1';
  const bucket = required('S3_BUCKET');
  const endpoint = (process.env.S3_ENDPOINT?.trim() || `https://s3.${region}.amazonaws.com`).replace(/\/$/, '');
  return {
    bucket,
    region,
    accessKeyId: required('S3_ACCESS_KEY_ID'),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
    endpoint,
    publicBaseUrl: (process.env.S3_PUBLIC_BASE_URL?.trim() || `${endpoint}/${bucket}`).replace(/\/$/, ''),
  };
}

/**
 * Signs one request. Exported for tests: the known-answer vectors in the AWS
 * documentation exercise exactly this function.
 */
export function signV4(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}): Record<string, string> {
  const amzDate = input.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': input.payloadHash,
  };
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  const canonicalHeaders = names.map((name) => `${name}:${String(lower[name]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...input.url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  const canonicalRequest = [input.method, input.url.pathname, query, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), input.service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class S3Driver implements StorageDriver {
  readonly name = 's3' as const;

  constructor(private readonly config: S3Config = s3ConfigFromEnv()) {}

  private objectUrl(key: string): URL {
    const clean = key.replace(/^\/+/, '');
    if (clean.split('/').some((segment) => segment === '..')) throw new Error(`Storage key escapes its prefix: ${key}`);
    return new URL(`${this.config.endpoint}/${this.config.bucket}/${encodeKey(clean)}`);
  }

  private async send(method: 'PUT' | 'GET' | 'DELETE' | 'HEAD', key: string, body?: Buffer, contentType?: string): Promise<Response> {
    const url = this.objectUrl(key);
    const payloadHash = body ? sha256Hex(body) : UNSIGNED_EMPTY;
    const headers = signV4({
      method,
      url,
      headers: {
        ...(contentType ? { 'content-type': contentType } : {}),
        // Storage keys embed a UUID, so an object's bytes never change.
        ...(method === 'PUT' ? { 'cache-control': 'public, max-age=31536000, immutable' } : {}),
      },
      payloadHash,
      region: this.config.region,
      service: 's3',
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      now: new Date(),
    });
    delete headers.host;
    return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(60_000) });
  }

  private async fail(response: Response, action: string, key: string): Promise<never> {
    const text = (await response.text()).slice(0, 300);
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP ${response.status}`;
    throw new Error(`S3 ${action} ${key} failed: ${code}`);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await this.send('PUT', key, body, contentType);
    if (!response.ok) await this.fail(response, 'put', key);
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.send('GET', key);
    if (!response.ok) await this.fail(response, 'get', key);
    return Buffer.from(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', key);
    // 204 on success; 404 means it is already gone, which is the goal.
    if (!response.ok && response.status !== 404) await this.fail(response, 'delete', key);
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.send('HEAD', key);
    if (response.status === 404) return false;
    if (!response.ok) await this.fail(response, 'head', key);
    return true;
  }

  publicUrl(key: string): string {
    return `${this.config.publicBaseUrl}/${encodeKey(key.replace(/^\/+/, ''))}`;
  }
}
