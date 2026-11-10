import { inspect } from 'node:util';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HttpClient,
  HttpError,
  Secret,
  backoffMs,
  createDefaultRegistry,
  createSaasConnectors,
  defaultSecretResolver,
  retryAfterMs,
  type HttpEvent,
  type SaasConnector,
} from '../src/index.js';
import { FakeAuth0, FakeStripe, testHttp } from './fakes.js';

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

let stripe: FakeStripe;
let auth0: FakeAuth0;
let sleeps: number[];
let events: HttpEvent[];
let env: Record<string, string>;

beforeEach(() => {
  stripe = new FakeStripe().seed();
  auth0 = new FakeAuth0().seed();
  server.use(...stripe.handlers(), ...auth0.handlers());
  sleeps = [];
  events = [];
  env = {
    STRIPE_API_KEY: stripe.validKey,
    AUTH0_CLIENT_ID: auth0.clientId,
    AUTH0_CLIENT_SECRET: auth0.clientSecret,
    AUTH0_TOKEN: auth0.staticToken,
  };
});

const stripeEntry = (over: Record<string, unknown> = {}) => ({
  type: 'stripe',
  apiKey: 'env:STRIPE_API_KEY',
  identity: { customerId: { column: 'stripe_customer_id' }, email: { column: 'email' } },
  ...over,
});
const auth0Entry = (over: Record<string, unknown> = {}) => ({
  type: 'auth0',
  domain: FakeAuth0.DOMAIN,
  credentials: { clientId: 'env:AUTH0_CLIENT_ID', clientSecret: 'env:AUTH0_CLIENT_SECRET' },
  identity: { userId: { column: 'auth0_user_id' }, email: { column: 'email' } },
  ...over,
});

async function create(entries: unknown[]): Promise<SaasConnector[]> {
  return createSaasConnectors(entries, env, {
    http: testHttp(sleeps),
    logger: (e) => events.push(e),
  });
}

/** Everything a connector could leak, gathered for assertions. */
const secretsAndPii = () => [
  stripe.validKey,
  auth0.clientSecret,
  auth0.staticToken,
  'alice.liddell@wonderland-mail.net',
  'cus_Alice00000001',
  'auth0|alice0001',
];
const leaks = (value: unknown): string[] => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return secretsAndPii().filter((s) => text.includes(s) || text.includes(encodeURIComponent(s)));
};

describe('secrets', () => {
  it('Secret never prints its value', () => {
    const s = new Secret('sk_test_supersecret', 'env:STRIPE_API_KEY');
    for (const rendered of [
      String(s),
      // Template interpolation is the most common accidental leak; test it explicitly.
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      `${s}`,
      JSON.stringify({ s }),
      inspect(s),
      inspect({ nested: { s } }),
    ]) {
      expect(rendered).not.toContain('supersecret');
      expect(rendered).toContain('env:STRIPE_API_KEY');
    }
    expect(s.reveal()).toBe('sk_test_supersecret');
  });

  it('rejects literal credentials in config and names only the reference when missing', async () => {
    const resolver = defaultSecretResolver({});
    await expect(resolver.resolve('sk_test_51Pasted')).rejects.toThrow(/Invalid secret reference/);
    await expect(resolver.resolve('sk_test_51Pasted')).rejects.not.toThrow(/sk_test_51Pasted/);
    await expect(resolver.resolve('env:MISSING_KEY')).rejects.toThrow(
      'Secret env:MISSING_KEY is not set',
    );
    await expect(resolver.resolve('vault:kv/stripe')).rejects.toThrow(
      /No secret provider registered for "vault:"/,
    );
  });

  it('supports pluggable secret managers', async () => {
    const resolver = defaultSecretResolver({}).register('vault', {
      get: (id) => Promise.resolve(id === 'kv/stripe' ? 'from-vault' : undefined),
    });
    expect((await resolver.resolve('vault:kv/stripe')).reveal()).toBe('from-vault');
  });
});

describe('HttpClient retries', () => {
  const client = (logger?: (e: HttpEvent) => void) =>
    new HttpClient({
      connector: 'test',
      baseUrl: 'https://api.example.test',
      ...testHttp(sleeps),
      ...(logger ? { logger } : {}),
    });

  it('parses Retry-After (seconds, HTTP date) and X-RateLimit-Reset (epoch seconds)', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }), now)).toBe(2000);
    expect(retryAfterMs(new Headers({ 'retry-after': 'Thu, 01 Jan 2026 00:00:03 GMT' }), now)).toBe(
      3000,
    );
    expect(retryAfterMs(new Headers({ 'x-ratelimit-reset': String(now / 1000 + 4) }), now)).toBe(
      4000,
    );
    expect(retryAfterMs(new Headers(), now)).toBeUndefined();
  });

  it('backs off exponentially with full jitter, capped', () => {
    const policy = { maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 1000 };
    expect([1, 2, 3, 4, 5].map((a) => backoffMs(a, policy, () => 1))).toEqual([
      100, 200, 400, 800, 1000,
    ]);
    expect(backoffMs(3, policy, () => 0.5)).toBe(200);
  });

  it('retries 429 until success, using exponential backoff when no Retry-After is sent', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.example.test/things', () => {
        calls++;
        return calls < 3 ? HttpResponse.json({}, { status: 429 }) : HttpResponse.json({ ok: true });
      }),
    );
    const r = await client((e) => events.push(e)).request<{ ok: boolean }>({
      method: 'GET',
      path: '/things',
    });
    expect(r).toMatchObject({ status: 200, attempts: 3, body: { ok: true } });
    expect(sleeps).toEqual([100, 200]);
    expect(events.map((e) => e.status)).toEqual([429, 429, 200]);
  });

  it('honours Retry-After on 429', async () => {
    let calls = 0;
    server.use(
      http.post('https://api.example.test/things', () =>
        ++calls === 1
          ? HttpResponse.json({}, { status: 429, headers: { 'retry-after': '3' } })
          : HttpResponse.json({}),
      ),
    );
    await client().request({ method: 'POST', path: '/things', json: {} });
    expect(sleeps).toEqual([3000]);
  });

  it('gives up after maxAttempts with a rate_limited error', async () => {
    server.use(
      http.get('https://api.example.test/things', () => HttpResponse.json({}, { status: 429 })),
    );
    const error = await client()
      .request({ method: 'GET', path: '/things' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', attempts: 4 });
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('does not wait longer than maxDelayMs when the server asks for more', async () => {
    server.use(
      http.get('https://api.example.test/things', () =>
        HttpResponse.json({}, { status: 429, headers: { 'retry-after': '600' } }),
      ),
    );
    await expect(client().request({ method: 'GET', path: '/things' })).rejects.toMatchObject({
      attempts: 1,
    });
    expect(sleeps).toEqual([]);
  });

  it('retries 5xx only for idempotent requests', async () => {
    let calls = 0;
    server.use(
      http.post('https://api.example.test/things', () => {
        calls++;
        return HttpResponse.json({}, { status: 503 });
      }),
    );
    await expect(
      client().request({ method: 'POST', path: '/things', json: {} }),
    ).rejects.toMatchObject({ status: 503, attempts: 1 });
    expect(calls).toBe(1);
    await expect(
      client().request({ method: 'POST', path: '/things', json: {}, idempotent: true }),
    ).rejects.toMatchObject({ attempts: 4 });
  });

  it('retries network errors for GET', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.example.test/things', () =>
        ++calls < 2 ? HttpResponse.error() : HttpResponse.json({ ok: 1 }),
      ),
    );
    await expect(client().request({ method: 'GET', path: '/things' })).resolves.toMatchObject({
      attempts: 2,
    });
  });

  it('never puts response text, ids or query values in errors or logs', async () => {
    server.use(
      http.get('https://api.example.test/users/:id', () =>
        HttpResponse.json(
          {
            error: {
              message: 'No user jane@example.com',
              code: 'not found because jane@example.com',
            },
          },
          { status: 400 },
        ),
      ),
    );
    const c = new HttpClient({
      connector: 'test',
      baseUrl: 'https://api.example.test',
      errorCode: (b) => JSON.stringify(b),
      ...testHttp(sleeps),
      logger: (e) => events.push(e),
    });
    const error = await c
      .request({
        method: 'GET',
        path: '/users/{id}',
        params: { id: 'jane@example.com' },
        query: { email: 'jane@example.com' },
      })
      .catch((e: unknown) => e);
    expect(String(error)).toBe('HttpError: test: GET /users/{id} failed with HTTP 400');
    expect(JSON.stringify(events)).not.toContain('jane');
  });
});

describe('registry and API key validation', () => {
  it('lists the built-in plugins', () => {
    expect(
      createDefaultRegistry()
        .list()
        .map((p) => p.type),
    ).toEqual(['stripe', 'auth0', 'payu', 'przelewy24', 'mailchimp']);
  });

  it.each([
    ['unknown type', { type: 'salesforce' }, /unknown connector type "salesforce"/],
    [
      'a literal API key',
      stripeEntry({ apiKey: 'sk_test_51Pasted0000000000' }),
      /literal secrets are not allowed/,
    ],
    [
      'missing identity mapping',
      stripeEntry({ identity: {} }),
      /map at least one of customerId or email/,
    ],
    ['a bad Auth0 domain', auth0Entry({ domain: 'https://evil/' }), /must be a hostname/],
    ['unknown keys', stripeEntry({ webhookSecret: 'env:X' }), /Unrecognized key/],
  ])('rejects %s before any request', async (_, entry, message) => {
    await expect(create([entry])).rejects.toThrow(message);
    expect([...stripe.requests, ...auth0.requests]).toEqual([]);
  });

  it('validates key formats offline and never echoes the key', async () => {
    env.STRIPE_API_KEY = 'pk_test_publishableKey000000';
    const err = await create([stripeEntry()]).catch((e: unknown) => e);
    expect(String(err)).toMatch(/env:STRIPE_API_KEY is not a Stripe secret or restricted key/);
    expect(String(err)).not.toContain('pk_test_publishableKey');
  });

  it('refuses live-mode Stripe keys unless allowed', async () => {
    env.STRIPE_API_KEY = 'sk_live_51RealLiveKey0000000000';
    await expect(create([stripeEntry()])).rejects.toThrow(/live-mode key; set allowLiveMode: true/);
    await expect(create([stripeEntry({ allowLiveMode: true })])).resolves.toHaveLength(1);
  });

  it('reports missing env vars by name', async () => {
    delete env.AUTH0_CLIENT_SECRET;
    await expect(create([auth0Entry()])).rejects.toThrow(
      /Secret env:AUTH0_CLIENT_SECRET is not set/,
    );
  });

  it('rejects duplicate connector names', async () => {
    await expect(create([stripeEntry(), stripeEntry()])).rejects.toThrow(
      /duplicate connector name\(s\): stripe/,
    );
    await expect(create([stripeEntry(), stripeEntry({ name: 'stripe-eu' })])).resolves.toHaveLength(
      2,
    );
  });

  it('detects invalid credentials online (401) without leaking them', async () => {
    env.STRIPE_API_KEY = 'sk_test_51WrongKey00000000000';
    const [connector] = await create([stripeEntry()]);
    const error = await connector?.verifyCredentials().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, code: 'invalid_request_error' });
    expect(String(error)).not.toContain('WrongKey');
  });
});

describe('Stripe connector', () => {
  it('anonymizes the customer, detaches payment methods and tax ids, and retains invoices', async () => {
    const [c] = await create([stripeEntry()]);
    const out = await c?.erase({ customerId: 'cus_Alice00000001' }, 'delete', { dryRun: false });
    expect(out).toEqual({
      status: 'succeeded',
      steps: [
        { action: 'anonymize', resource: 'customer', count: 1 },
        { action: 'detach', resource: 'payment_method', count: 2 },
        { action: 'delete', resource: 'tax_id', count: 1 },
      ],
      retained: [
        {
          resource: 'invoice',
          count: 3,
          reason: 'Invoices are retained as accounting records for tax compliance',
        },
      ],
    });
    const alice = stripe.customers.get('cus_Alice00000001');
    expect(alice).toMatchObject({
      email: null,
      name: null,
      phone: null,
      description: null,
      address: null,
      shipping: null,
      preferred_locales: [],
    });
    expect(alice?.metadata).toEqual({ stonekeep_anonymized: 'true' });
    expect(stripe.paymentMethods.every((p) => p.customer === null)).toBe(true);
    expect(stripe.taxIds).toEqual([]);
    // Invoices are untouched and nothing was deleted or voided.
    expect(stripe.invoices.filter((i) => i.customer === 'cus_Alice00000001')).toHaveLength(3);
    expect(
      stripe.requests.some(
        (r) =>
          r.path.includes('/invoices/') ||
          (r.method === 'DELETE' &&
            r.path.startsWith('/v1/customers/cus_') &&
            !r.path.includes('tax_ids')),
      ),
    ).toBe(false);
    // Bob is untouched.
    expect(stripe.customers.get('cus_Bob000000002')?.name).toBe('Bobby Marlowe');
    // Every write carries an idempotency key.
    expect(
      stripe.requests
        .filter((r) => r.method === 'POST')
        .every((r) => /^stonekeep-[0-9a-f]{40}$/.test(r.headers['idempotency-key'] ?? '')),
    ).toBe(true);
    expect(leaks(out)).toEqual([]);
    expect(leaks(events)).toEqual([]);
  });

  it('finds customers by email when no id is mapped', async () => {
    const [c] = await create([stripeEntry()]);
    const out = await c?.erase({ email: 'alice.liddell@wonderland-mail.net' }, 'anonymize', {
      dryRun: false,
    });
    expect(out?.steps[0]).toEqual({ action: 'anonymize', resource: 'customer', count: 1 });
    expect(stripe.customers.get('cus_Alice00000001')?.email).toBeNull();
  });

  it('dry run only reads', async () => {
    const [c] = await create([stripeEntry()]);
    const out = await c?.erase({ customerId: 'cus_Alice00000001' }, 'delete', { dryRun: true });
    expect(out?.steps).toContainEqual({ action: 'detach', resource: 'payment_method', count: 2 });
    expect(stripe.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(stripe.customers.get('cus_Alice00000001')?.email).toBe(
      'alice.liddell@wonderland-mail.net',
    );
  });

  it('is idempotent and handles a missing customer', async () => {
    const [c] = await create([stripeEntry()]);
    await c?.erase({ customerId: 'cus_Alice00000001' }, 'delete', { dryRun: false });
    const again = await c?.erase({ customerId: 'cus_Alice00000001' }, 'delete', { dryRun: false });
    expect(again?.status).toBe('succeeded');
    const none = await c?.erase({ customerId: 'cus_DoesNotExist00' }, 'delete', { dryRun: false });
    expect(none).toMatchObject({
      status: 'succeeded',
      note: expect.stringMatching(/no matching Stripe customer/) as unknown,
    });
    expect(await c?.erase({}, 'delete', { dryRun: false })).toMatchObject({ status: 'skipped' });
  });

  it('retries when Stripe rate-limits a write', async () => {
    stripe.fail('POST /v1/customers/cus_Alice', 429, 2, {
      headers: { 'retry-after': '1' },
      body: { error: { type: 'invalid_request_error', code: 'rate_limit' } },
    });
    const [c] = await create([stripeEntry()]);
    await expect(
      c?.erase({ customerId: 'cus_Alice00000001' }, 'delete', { dryRun: false }),
    ).resolves.toMatchObject({ status: 'succeeded' });
    expect(sleeps).toEqual([1000, 1000]);
    const writes = stripe.requests.filter(
      (r) => r.method === 'POST' && r.path === '/v1/customers/cus_Alice00000001',
    );
    expect(writes).toHaveLength(3);
    // The same idempotency key is reused on retries.
    expect(new Set(writes.map((w) => w.headers['idempotency-key'])).size).toBe(1);
  });
});

describe('Auth0 connector', () => {
  it('gets an M2M token and deletes every identity linked to the email', async () => {
    const [c] = await create([auth0Entry()]);
    const out = await c?.erase({ email: 'alice.liddell@wonderland-mail.net' }, 'delete', {
      dryRun: false,
    });
    expect(out).toEqual({
      status: 'succeeded',
      steps: [{ action: 'delete', resource: 'user', count: 2 }],
      retained: [],
    });
    expect([...auth0.users.keys()]).toEqual(['auth0|bob0002']);
    expect(auth0.tokensIssued).toBe(1); // cached across calls
    const token = auth0.requests.find((r) => r.path === '/oauth/token');
    expect(JSON.parse(token?.body ?? '{}')).toMatchObject({
      grant_type: 'client_credentials',
      audience: `${FakeAuth0.BASE}/api/v2/`,
    });
    expect(leaks(out)).toEqual([]);
    expect(leaks(events)).toEqual([]);
  });

  it('deletes by user id, and a second run is a no-op (404 is fine)', async () => {
    const [c] = await create([auth0Entry()]);
    await c?.erase({ userId: 'auth0|alice0001' }, 'delete', { dryRun: false });
    const again = await c?.erase({ userId: 'auth0|alice0001' }, 'delete', { dryRun: false });
    expect(again).toMatchObject({ status: 'succeeded', steps: [{ count: 0 }] });
  });

  it('accepts a static Management API token and validates its shape', async () => {
    const [c] = await create([auth0Entry({ credentials: { token: 'env:AUTH0_TOKEN' } })]);
    await c?.erase({ userId: 'auth0|alice0001' }, 'delete', { dryRun: false });
    expect(auth0.users.has('auth0|alice0001')).toBe(false);
    env.AUTH0_TOKEN = 'not-a-jwt';
    await expect(
      create([auth0Entry({ credentials: { token: 'env:AUTH0_TOKEN' } })]),
    ).rejects.toThrow(/not a JWT/);
  });

  it('refreshes a revoked token once', async () => {
    const [c] = await create([auth0Entry()]);
    await c?.verifyCredentials();
    auth0.revokeTokens();
    await c?.erase({ userId: 'auth0|alice0001' }, 'delete', { dryRun: false });
    expect(auth0.tokensIssued).toBe(2);
  });

  it('waits for X-RateLimit-Reset on 429', async () => {
    const reset = String(Math.ceil(Date.now() / 1000) + 2);
    auth0.fail('DELETE /api/v2/users/', 429, 1, {
      headers: { 'x-ratelimit-reset': reset },
      body: { statusCode: 429, error: 'Too Many Requests', errorCode: 'too_many_requests' },
    });
    const [c] = await create([auth0Entry()]);
    await c?.erase({ userId: 'auth0|alice0001' }, 'delete', { dryRun: false });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(500);
    expect(sleeps[0]).toBeLessThanOrEqual(3000);
  });

  it('rejects bad client credentials', async () => {
    env.AUTH0_CLIENT_SECRET = 'wrong';
    const [c] = await create([auth0Entry()]);
    await expect(c?.verifyCredentials()).rejects.toMatchObject({
      status: 401,
      code: 'access_denied',
    });
  });
});
