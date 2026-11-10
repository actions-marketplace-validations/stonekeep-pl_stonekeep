/**
 * Transport for the generic consent endpoint.
 *
 *   GET  {endpoint}  -> { purposes: { [id]: { granted, since } }, policyVersion? }
 *   POST {endpoint}  <- { purpose, action: 'granted' | 'withdrawn', policyVersion?, source }
 *
 * The subject is never put in the URL or body: the backend identifies the
 * caller from its session (cookie / Authorization header). Logged-out visitors
 * can be identified by a random, non-personal id sent as a header.
 */

export interface PurposeConsent {
  granted: boolean;
  since?: string;
}

export interface ConsentState {
  purposes: Record<string, PurposeConsent>;
  policyVersion?: string;
}

export interface ConsentClientOptions {
  endpoint: string;
  /** Extra headers, e.g. `{ authorization: 'Bearer …' }`. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Send cookies (default `same-origin`). */
  credentials?: RequestCredentials;
  /** Identify logged-out visitors with a random id stored in localStorage. */
  anonymousId?: boolean;
  /** Storage key for the anonymous id. */
  storageKey?: string;
  fetch?: typeof fetch;
}

export const ANONYMOUS_ID_HEADER = 'x-stonekeep-consent-id';
const DEFAULT_STORAGE_KEY = 'stonekeep.consentId';

export class ConsentRequestError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ConsentRequestError';
    this.status = status;
  }
}

function randomId(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Get or create the anonymous visitor id. Returns undefined when storage is unavailable. */
export function anonymousVisitorId(storageKey = DEFAULT_STORAGE_KEY): string | undefined {
  try {
    const storage = globalThis.localStorage;
    const existing = storage.getItem(storageKey);
    if (existing && /^[A-Za-z0-9-]{16,64}$/.test(existing)) return existing;
    const id = randomId();
    storage.setItem(storageKey, id);
    return id;
  } catch {
    return undefined;
  }
}

function isState(value: unknown): value is ConsentState {
  if (typeof value !== 'object' || value === null) return false;
  const purposes = (value as { purposes?: unknown }).purposes;
  return typeof purposes === 'object' && purposes !== null;
}

export interface ConsentClient {
  load(): Promise<ConsentState>;
  record(
    purpose: string,
    action: 'granted' | 'withdrawn',
    meta: { policyVersion?: string; source: string },
  ): Promise<ConsentState | undefined>;
}

export function createConsentClient(options: ConsentClientOptions): ConsentClient {
  const doFetch =
    options.fetch ??
    ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const headers = (): Record<string, string> => {
    const extra =
      typeof options.headers === 'function' ? options.headers() : (options.headers ?? {});
    const h: Record<string, string> = { accept: 'application/json', ...extra };
    if (options.anonymousId) {
      const id = anonymousVisitorId(options.storageKey);
      if (id) h[ANONYMOUS_ID_HEADER] = id;
    }
    return h;
  };
  const request = async (init: RequestInit): Promise<unknown> => {
    let res: Response;
    try {
      res = await doFetch(options.endpoint, {
        credentials: options.credentials ?? 'same-origin',
        ...init,
      });
    } catch {
      throw new ConsentRequestError('Could not reach the consent service');
    }
    if (!res.ok)
      throw new ConsentRequestError(
        `Consent service responded with HTTP ${res.status}`,
        res.status,
      );
    if (res.status === 204) return undefined;
    try {
      return (await res.json()) as unknown;
    } catch {
      return undefined;
    }
  };

  return {
    async load() {
      const body = await request({ method: 'GET', headers: headers() });
      if (!isState(body))
        throw new ConsentRequestError('Consent service returned an unexpected response');
      return body;
    },
    async record(purpose, action, meta) {
      const body = await request({
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose,
          action,
          source: meta.source,
          ...(meta.policyVersion ? { policyVersion: meta.policyVersion } : {}),
        }),
      });
      return isState(body) ? body : undefined;
    },
  };
}
