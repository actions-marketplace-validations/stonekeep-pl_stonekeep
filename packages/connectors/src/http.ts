/**
 * Minimal resilient HTTP client for SaaS APIs.
 *
 * - Retries HTTP 429 with exponential backoff + full jitter, honouring
 *   `Retry-After` (seconds or HTTP date) and `X-RateLimit-Reset` (epoch seconds).
 * - Retries 5xx / network errors only for idempotent requests.
 * - Logs path *templates* (`/v1/customers/{id}`), never concrete ids, query
 *   strings, headers or bodies.
 * - Errors carry status and a vendor error code only, never response text,
 *   which can echo personal data.
 */

export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Longest single wait. A server asking for longer makes the request fail. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 };

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  /** Path template; `{name}` placeholders are filled from `params` (URL-encoded). */
  path: string;
  params?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  /** application/x-www-form-urlencoded body (Stripe style). */
  form?: Record<string, string>;
  json?: unknown;
  headers?: Record<string, string>;
  /** Safe to retry on 5xx/network errors. Defaults to true for GET and DELETE. */
  idempotent?: boolean;
  /** Statuses returned to the caller instead of thrown (e.g. 404). */
  allowStatus?: readonly number[];
  /** Skip the auth hook (used for the OAuth token request itself). */
  noAuth?: boolean;
}

export interface HttpResponse<T> {
  status: number;
  body: T;
  attempts: number;
}

export interface HttpEvent {
  type: 'http';
  connector: string;
  method: HttpMethod;
  /** Template only, e.g. `/api/v2/users/{id}`. */
  path: string;
  status: number | 'network-error';
  attempt: number;
  retryInMs?: number;
}

export type HttpLogger = (event: HttpEvent) => void;

export class HttpError extends Error {
  readonly connector: string;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly attempts: number;
  readonly operation: string;

  constructor(opts: {
    connector: string;
    operation: string;
    status?: number;
    code?: string;
    attempts: number;
    reason?: string;
  }) {
    const what =
      opts.status !== undefined ? `HTTP ${opts.status}` : (opts.reason ?? 'network error');
    super(
      `${opts.connector}: ${opts.operation} failed with ${what}${opts.code ? ` (${opts.code})` : ''}` +
        (opts.attempts > 1 ? ` after ${opts.attempts} attempts` : ''),
    );
    this.name = 'HttpError';
    this.connector = opts.connector;
    this.status = opts.status;
    this.code = opts.code;
    this.attempts = opts.attempts;
    this.operation = opts.operation;
  }
}

export interface HttpClientOptions {
  connector: string;
  baseUrl: string;
  /** Returns auth headers; called per attempt so refreshed tokens are used. */
  auth?: () => Promise<Record<string, string>>;
  /** Called once on 401; return true to retry with fresh credentials. */
  onUnauthorized?: () => Promise<boolean>;
  /** Extract a vendor error code from a JSON error body. */
  errorCode?: (body: unknown) => string | undefined;
  retry?: Partial<RetryPolicy>;
  timeoutMs?: number;
  logger?: HttpLogger;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Only accept short machine codes from vendor bodies, never free text. */
export function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : undefined;
}

/** Milliseconds to wait as requested by the server, if any. */
export function retryAfterMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    if (/^\d+(\.\d+)?$/.test(retryAfter.trim())) return Math.round(Number(retryAfter) * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null && /^\d+$/.test(reset.trim())) {
    const n = Number(reset);
    // Epoch seconds (Auth0, GitHub) vs. "seconds from now" (some APIs).
    return n > 1_000_000_000 ? Math.max(0, n * 1000 - now) : n * 1000;
  }
  return undefined;
}

/** Exponential backoff with full jitter: random(0, min(max, base * 2^(attempt-1))). */
export function backoffMs(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  private readonly opts: HttpClientOptions;
  private readonly policy: RetryPolicy;

  constructor(options: HttpClientOptions) {
    this.opts = options;
    this.policy = { ...DEFAULT_RETRY, ...options.retry };
  }

  private url(req: HttpRequest): string {
    const path = req.path.replace(/\{(\w+)\}/g, (_, name: string) => {
      const v = req.params?.[name];
      if (v === undefined) throw new Error(`missing path parameter ${name}`);
      return encodeURIComponent(v);
    });
    const url = new URL(path, this.opts.baseUrl);
    for (const [k, v] of Object.entries(req.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    return url.toString();
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const { connector } = this.opts;
    const operation = `${req.method} ${req.path}`;
    const sleep = this.opts.sleep ?? defaultSleep;
    const random = this.opts.random ?? Math.random;
    const now = this.opts.now ?? Date.now;
    const idempotent = req.idempotent ?? (req.method === 'GET' || req.method === 'DELETE');
    const log = this.opts.logger ?? (() => undefined);
    let reauthorized = false;

    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
      if (!req.noAuth && this.opts.auth) Object.assign(headers, await this.opts.auth());
      let body: string | undefined;
      if (req.form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(req.form).toString();
      } else if (req.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(req.json);
      }

      let response: Response;
      try {
        response = await fetch(this.url(req), {
          method: req.method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        });
      } catch {
        const canRetry = idempotent && attempt < this.policy.maxAttempts;
        const wait = canRetry ? backoffMs(attempt, this.policy, random) : undefined;
        log({
          type: 'http',
          connector,
          method: req.method,
          path: req.path,
          status: 'network-error',
          attempt,
          ...(wait !== undefined ? { retryInMs: wait } : {}),
        });
        if (wait === undefined)
          throw new HttpError({ connector, operation, attempts: attempt, reason: 'network error' });
        await sleep(wait);
        continue;
      }

      const status = response.status;
      const text = status === 204 ? '' : await response.text();
      let parsed: unknown = undefined;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = undefined; // non-JSON bodies are discarded, never surfaced
        }
      }

      if ((status >= 200 && status < 300) || req.allowStatus?.includes(status)) {
        log({ type: 'http', connector, method: req.method, path: req.path, status, attempt });
        return { status, body: parsed as T, attempts: attempt };
      }

      if (
        status === 401 &&
        !reauthorized &&
        this.opts.onUnauthorized &&
        (await this.opts.onUnauthorized())
      ) {
        reauthorized = true;
        log({
          type: 'http',
          connector,
          method: req.method,
          path: req.path,
          status,
          attempt,
          retryInMs: 0,
        });
        continue;
      }

      const retryable = status === 429 || (idempotent && status >= 500);
      let wait: number | undefined;
      if (retryable && attempt < this.policy.maxAttempts) {
        const requested = status === 429 ? retryAfterMs(response.headers, now()) : undefined;
        wait = requested ?? backoffMs(attempt, this.policy, random);
        if (wait > this.policy.maxDelayMs) wait = undefined; // server wants longer than we may wait
      }
      log({
        type: 'http',
        connector,
        method: req.method,
        path: req.path,
        status,
        attempt,
        ...(wait !== undefined ? { retryInMs: wait } : {}),
      });
      if (wait === undefined) {
        // Defence in depth: whatever a plugin extracts, only short machine codes pass.
        const code =
          safeCode(this.opts.errorCode?.(parsed)) ?? (status === 429 ? 'rate_limited' : undefined);
        throw new HttpError({
          connector,
          operation,
          status,
          attempts: attempt,
          ...(code !== undefined ? { code } : {}),
        });
      }
      await sleep(wait);
    }
  }
}
