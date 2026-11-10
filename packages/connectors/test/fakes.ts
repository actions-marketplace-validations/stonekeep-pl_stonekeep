import { http, HttpResponse, delay, type HttpHandler } from 'msw';

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

interface Fault {
  match: (method: string, path: string) => boolean;
  status: number;
  times: number;
  headers?: Record<string, string>;
  body?: unknown;
}

abstract class FakeApi {
  readonly requests: RecordedRequest[] = [];
  private faults: Fault[] = [];
  /** Artificial latency for every response (to observe parallelism). */
  latencyMs = 0;

  clearFaults(): void {
    this.faults = [];
  }

  /** Make the next `times` matching requests fail with `status`. */
  fail(
    match: string | RegExp,
    status: number,
    times = 1,
    extra: { headers?: Record<string, string>; body?: unknown } = {},
  ): void {
    const test = (method: string, path: string): boolean => {
      const key = `${method} ${path}`;
      return typeof match === 'string' ? key.startsWith(match) : match.test(key);
    };
    this.faults.push({ match: test, status, times, ...extra });
  }

  protected async record(request: Request): Promise<{ fault?: Response; body: string; url: URL }> {
    const url = new URL(request.url);
    const body =
      request.method === 'GET' || request.method === 'DELETE' ? '' : await request.text();
    this.requests.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      at: performance.now(),
    });
    if (this.latencyMs > 0) await delay(this.latencyMs);
    const fault = this.faults.find((f) => f.times > 0 && f.match(request.method, url.pathname));
    if (fault) {
      fault.times--;
      return {
        fault: HttpResponse.json(
          (fault.body ?? {
            error: { type: 'api_error', message: 'injected failure for jane@example.com' },
          }) as Record<string, unknown>,
          {
            status: fault.status,
            ...(fault.headers ? { headers: fault.headers } : {}),
          },
        ),
        body,
        url,
      };
    }
    return { body, url };
  }

  abstract handlers(): HttpHandler[];
}

// ------------------------------------------------------------------ Stripe

export interface FakeCustomer {
  id: string;
  object: 'customer';
  email: string | null;
  name: string | null;
  phone: string | null;
  description: string | null;
  address: Record<string, string> | null;
  shipping: Record<string, unknown> | null;
  preferred_locales: string[];
  metadata: Record<string, string>;
}

export class FakeStripe extends FakeApi {
  static readonly BASE = 'https://api.stripe.com';
  validKey = 'sk_test_51StonekeepFakeKey0000000000';
  customers = new Map<string, FakeCustomer>();
  invoices: {
    id: string;
    customer: string;
    customer_email: string;
    amount_due: number;
    status: string;
  }[] = [];
  paymentMethods: { id: string; customer: string | null; billing_details: { email: string } }[] =
    [];
  taxIds: { id: string; customer: string; value: string }[] = [];

  seed(): this {
    const alice: FakeCustomer = {
      id: 'cus_Alice00000001',
      object: 'customer',
      email: 'alice.liddell@wonderland-mail.net',
      name: 'Alice Liddell',
      phone: '+44 20 7946 0958',
      description: 'VIP since 2024',
      address: { line1: '7 Rabbit Hole Lane', postal_code: 'OX1 3BG', country: 'GB' },
      shipping: { name: 'Alice Liddell', address: { line1: '7 Rabbit Hole Lane' } },
      preferred_locales: ['en-GB'],
      metadata: { crm_id: 'alice-crm-1', segment: 'vip' },
    };
    this.customers.set(alice.id, alice);
    this.customers.set('cus_Bob000000002', {
      ...alice,
      id: 'cus_Bob000000002',
      email: 'bob.marley.reggae@islandnet.org',
      name: 'Bobby Marlowe',
      metadata: {},
    });
    for (let i = 1; i <= 3; i++) {
      this.invoices.push({
        id: `in_alice_${i}`,
        customer: alice.id,
        customer_email: alice.email ?? '',
        amount_due: 1000 * i,
        status: 'paid',
      });
    }
    this.invoices.push({
      id: 'in_bob_1',
      customer: 'cus_Bob000000002',
      customer_email: 'bob.marley.reggae@islandnet.org',
      amount_due: 999,
      status: 'paid',
    });
    this.paymentMethods.push(
      {
        id: 'pm_alice_card',
        customer: alice.id,
        billing_details: { email: 'alice.liddell@wonderland-mail.net' },
      },
      {
        id: 'pm_alice_sepa',
        customer: alice.id,
        billing_details: { email: 'alice.liddell@wonderland-mail.net' },
      },
    );
    this.taxIds.push({ id: 'txi_alice_vat', customer: alice.id, value: 'GB123456789' });
    return this;
  }

  private authorized(request: Request): boolean {
    return request.headers.get('authorization') === `Bearer ${this.validKey}`;
  }

  private static list(items: readonly { id: string }[], url: URL): Record<string, unknown> {
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const after = url.searchParams.get('starting_after');
    const start = after ? items.findIndex((i) => i.id === after) + 1 : 0;
    const page = items.slice(start, start + limit);
    return { object: 'list', data: page, has_more: start + limit < items.length };
  }

  handlers(): HttpHandler[] {
    const b = FakeStripe.BASE;
    const guard = async (request: Request): Promise<{ res?: Response; body: string; url: URL }> => {
      const { fault, body, url } = await this.record(request);
      if (fault) return { res: fault, body, url };
      if (!this.authorized(request)) {
        return {
          res: HttpResponse.json(
            {
              error: {
                type: 'invalid_request_error',
                message: `Invalid API Key provided: ${request.headers.get('authorization') ?? ''}`,
              },
            },
            { status: 401 },
          ),
          body,
          url,
        };
      }
      return { body, url };
    };
    const missing = (): Response =>
      HttpResponse.json(
        {
          error: {
            type: 'invalid_request_error',
            code: 'resource_missing',
            message: 'No such customer',
          },
        },
        { status: 404 },
      );

    return [
      http.get(`${b}/v1/customers/:id/payment_methods`, async ({ request, params }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        return HttpResponse.json(
          FakeStripe.list(
            this.paymentMethods.filter((p) => p.customer === params.id),
            g.url,
          ),
        );
      }),
      http.get(`${b}/v1/customers/:id/tax_ids`, async ({ request, params }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        return HttpResponse.json(
          FakeStripe.list(
            this.taxIds.filter((t) => t.customer === params.id),
            g.url,
          ),
        );
      }),
      http.delete(`${b}/v1/customers/:customer/tax_ids/:id`, async ({ request, params }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        const before = this.taxIds.length;
        this.taxIds = this.taxIds.filter((t) => t.id !== params.id);
        return before === this.taxIds.length
          ? missing()
          : HttpResponse.json({ id: params.id, deleted: true });
      }),
      http.get(`${b}/v1/customers/:id`, async ({ request, params }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        const c = this.customers.get(String(params.id));
        return c ? HttpResponse.json({ ...c }) : missing();
      }),
      http.get(`${b}/v1/customers`, async ({ request }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        const email = g.url.searchParams.get('email');
        const all = [...this.customers.values()].filter((c) => email === null || c.email === email);
        return HttpResponse.json(FakeStripe.list(all, g.url));
      }),
      http.post(`${b}/v1/customers/:id`, async ({ request, params }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        const c = this.customers.get(String(params.id));
        if (!c) return missing();
        for (const [k, v] of new URLSearchParams(g.body)) {
          const meta = /^metadata\[(.+)\]$/.exec(k);
          if (meta?.[1] !== undefined) {
            if (v === '') Reflect.deleteProperty(c.metadata, meta[1]);
            else c.metadata[meta[1]] = v;
          } else if (k === 'preferred_locales') {
            c.preferred_locales = v === '' ? [] : [v];
          } else if (k in c && k !== 'id' && k !== 'object') {
            (c as unknown as Record<string, unknown>)[k] = v === '' ? null : v;
          } else {
            return HttpResponse.json(
              { error: { type: 'invalid_request_error', code: 'parameter_unknown' } },
              { status: 400 },
            );
          }
        }
        return HttpResponse.json({ ...c });
      }),
      http.get(`${b}/v1/invoices`, async ({ request }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        const customer = g.url.searchParams.get('customer');
        return HttpResponse.json(
          FakeStripe.list(
            this.invoices.filter((i) => i.customer === customer),
            g.url,
          ),
        );
      }),
      http.post(`${b}/v1/payment_methods/:id/detach`, async ({ request, params }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        const pm = this.paymentMethods.find((p) => p.id === params.id);
        if (!pm) return missing();
        pm.customer = null;
        return HttpResponse.json(pm);
      }),
      // Anything Stonekeep must never call (deleting customers/invoices, voiding...).
      http.all(`${b}/*`, async ({ request }) => {
        await this.record(request);
        return HttpResponse.json(
          { error: { type: 'invalid_request_error', code: 'unexpected_call' } },
          { status: 418 },
        );
      }),
    ];
  }
}

// ------------------------------------------------------------------- Auth0

export class FakeAuth0 extends FakeApi {
  static readonly DOMAIN = 'stonekeep-test.eu.auth0.com';
  static readonly BASE = `https://${FakeAuth0.DOMAIN}`;
  clientId = 'StonekeepM2MClient0001';
  clientSecret = 'super-secret-client-secret-value';
  /** Static Management API token (a JWT-shaped string). */
  staticToken = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJrZXlzdG9uZSJ9.c2lnbmF0dXJl';
  users = new Map<string, { user_id: string; email: string }>();
  tokensIssued = 0;
  private readonly tokens = new Set<string>();

  seed(): this {
    this.users.set('auth0|alice0001', {
      user_id: 'auth0|alice0001',
      email: 'alice.liddell@wonderland-mail.net',
    });
    this.users.set('google-oauth2|alice-g', {
      user_id: 'google-oauth2|alice-g',
      email: 'alice.liddell@wonderland-mail.net',
    });
    this.users.set('auth0|bob0002', {
      user_id: 'auth0|bob0002',
      email: 'bob.marley.reggae@islandnet.org',
    });
    return this;
  }

  revokeTokens(): void {
    this.tokens.clear();
  }

  handlers(): HttpHandler[] {
    const b = FakeAuth0.BASE;
    const guard = async (request: Request): Promise<{ res?: Response; url: URL }> => {
      const { fault, url } = await this.record(request);
      if (fault) return { res: fault, url };
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      if (!this.tokens.has(token) && token !== this.staticToken) {
        return {
          res: HttpResponse.json(
            { statusCode: 401, error: 'Unauthorized', message: 'Invalid token' },
            { status: 401 },
          ),
          url,
        };
      }
      return { url };
    };
    return [
      http.post(`${b}/oauth/token`, async ({ request }) => {
        const { fault, body } = await this.record(request);
        if (fault) return fault;
        const json = JSON.parse(body) as Record<string, string>;
        if (
          json.client_id !== this.clientId ||
          json.client_secret !== this.clientSecret ||
          json.grant_type !== 'client_credentials'
        ) {
          return HttpResponse.json(
            { error: 'access_denied', error_description: 'Unauthorized' },
            { status: 401 },
          );
        }
        if (json.audience !== `${b}/api/v2/`)
          return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
        const token = `m2m-token-${++this.tokensIssued}`;
        this.tokens.add(token);
        return HttpResponse.json({ access_token: token, expires_in: 86_400, token_type: 'Bearer' });
      }),
      http.get(`${b}/api/v2/users-by-email`, async ({ request }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        const email = g.url.searchParams.get('email');
        return HttpResponse.json([...this.users.values()].filter((u) => u.email === email));
      }),
      http.get(`${b}/api/v2/users/:id`, async ({ request, params }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        const u = this.users.get(String(params.id));
        return u
          ? HttpResponse.json(u)
          : HttpResponse.json(
              { statusCode: 404, error: 'Not Found', errorCode: 'inexistent_user' },
              { status: 404 },
            );
      }),
      http.get(`${b}/api/v2/users`, async ({ request }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        return HttpResponse.json([...this.users.values()].slice(0, 1));
      }),
      http.delete(`${b}/api/v2/users/:id`, async ({ request, params }) => {
        const g = await guard(request);
        if (g.res) return g.res;
        const existed = this.users.delete(String(params.id));
        return existed
          ? new HttpResponse(null, { status: 204 })
          : HttpResponse.json(
              { statusCode: 404, error: 'Not Found', errorCode: 'inexistent_user' },
              { status: 404 },
            );
      }),
    ];
  }
}

/** Fast, deterministic HTTP settings for tests: no real waiting, recorded sleeps. */
export function testHttp(sleeps: number[] = []) {
  return {
    retry: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 5_000 },
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
  };
}
