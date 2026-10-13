import { logger } from '../../core/logger';
import { metrics } from '../observability/metrics';

/**
 * The one way adapters talk to a provider's API.
 *
 * Every vendor call gets the same treatment: a hard timeout (a hung gateway
 * must not hold a checkout open), a bounded response, a metric per provider and
 * outcome, and errors that carry the provider's own message without ever
 * echoing the request — which is where the credentials are.
 *
 * Provider base URLs are constants in each adapter, never merchant input, so
 * this uses plain `fetch`; merchant-supplied URLs go through safeHttp instead.
 */

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }

  /** 5xx, 429 and network failures are worth retrying; 4xx are not. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface ProviderRequest {
  provider: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** Objects are sent as JSON unless `form` is set. */
  json?: unknown;
  /** application/x-www-form-urlencoded, as Twilio and Stripe expect. */
  form?: Record<string, string | number | boolean | null | undefined>;
  body?: string;
  timeoutMs?: number;
  /** Pulls a readable message out of the vendor's error shape. */
  errorMessage?: (body: unknown, status: number) => string | null;
}

export interface ProviderResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

const MAX_BODY_BYTES = 1024 * 1024;

function formEncode(form: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  return params.toString();
}

export async function providerFetch<T = unknown>(request: ProviderRequest): Promise<ProviderResponse<T>> {
  const started = Date.now();
  const headers: Record<string, string> = { Accept: 'application/json', ...request.headers };
  let body: string | undefined = request.body;
  if (request.form) {
    body = formEncode(request.form);
    headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
  } else if (request.json !== undefined) {
    body = JSON.stringify(request.json);
    headers['Content-Type'] ??= 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(request.timeoutMs ?? 15_000),
    });
  } catch (error) {
    metrics.counter('integration_requests_total', { provider: request.provider, outcome: 'network_error' }).inc();
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? `${request.provider} did not answer in time.`
      : `${request.provider} could not be reached.`;
    logger.warn('integrations.request_failed', {
      provider: request.provider,
      url: request.url.split('?')[0],
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ProviderHttpError(request.provider, 0, message);
  }

  const text = (await response.text()).slice(0, MAX_BODY_BYTES);
  let data: unknown = text;
  if (text && (response.headers.get('content-type') ?? '').includes('json')) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  metrics.counter('integration_requests_total', {
    provider: request.provider,
    outcome: response.ok ? 'ok' : `http_${Math.floor(response.status / 100)}xx`,
  }).inc();
  metrics.histogram('integration_request_seconds', { provider: request.provider }).observe((Date.now() - started) / 1000);

  if (!response.ok) {
    const message =
      request.errorMessage?.(data, response.status) ??
      `${request.provider} refused the request (HTTP ${response.status}).`;
    throw new ProviderHttpError(request.provider, response.status, message, null, data);
  }

  return { status: response.status, data: data as T, headers: response.headers };
}

/** HTTP Basic, for the providers that use it (Twilio, Razorpay, Stripe accepts it too). */
export function basicAuth(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

/** Digs a message out of the common vendor error envelopes. */
export function commonErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return typeof body === 'string' && body.length < 300 ? body : null;
  const record = body as Record<string, unknown>;
  const error = record.error as Record<string, unknown> | string | undefined;
  if (typeof error === 'string') return String(record.error_description ?? error);
  if (error && typeof error === 'object') {
    return String(error.message ?? error.description ?? error.error_description ?? error.code ?? '') || null;
  }
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const first = record.errors[0] as Record<string, unknown>;
    return String(first.message ?? first.detail ?? first.title ?? '') || null;
  }
  return (record.message as string) ?? (record.detail as string) ?? null;
}
