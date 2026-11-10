# SaaS connectors and the deletion orchestrator (Stage 3)

`@stonekeep/connectors` extends `stonekeep delete` beyond your own database. A single run erases the
subject in Postgres (the Stage 2 engine) **and** in every configured SaaS tool. All of them run in
parallel and produce one aggregated report.

## Configuration

Add a `saas:` list to `stonekeep.connector.yaml`:

```yaml
saas:
  - type: stripe
    apiKey: env:STRIPE_API_KEY # a reference, never the key itself
    identity:
      customerId: { column: stripe_customer_id } # column on the subject table
      email: { column: email } # fallback lookup
    # allowLiveMode: true          # sk_live_ keys are refused without this

  - type: auth0
    domain: acme.eu.auth0.com
    credentials:
      clientId: env:AUTH0_CLIENT_ID # M2M app with read:users + delete:users
      clientSecret: file:/run/secrets/auth0_client_secret
    # or: credentials: { token: env:AUTH0_MGMT_TOKEN }
    identity:
      userId: { column: auth0_user_id }
      email: { column: email }
```

Each plugin validates its own entry with zod. Unknown keys, unknown types, malformed hostnames,
missing identity mappings and duplicate `name`s are all rejected before any network call. To run two
instances of one plugin, give each a `name`, for example `stripe-eu`.

## Credentials

- Config only ever holds a **secret reference**, `scheme:id`. A literal value such as
  `sk_test_…` is rejected, and the error message doesn't echo it back.
  - `env:NAME` reads an environment variable.
  - `file:/path` reads a mounted secret, such as a Docker or Kubernetes secret or a CSI secret-store
    driver.
  - Other schemes can be added with `SecretResolver.register('vault', provider)`. That's how you
    connect Vault, AWS Secrets Manager or GCP Secret Manager.
- Resolved values are wrapped in `Secret`. `String()`, template literals, `JSON.stringify` and
  `util.inspect` all print `[redacted] (env:NAME)`. The value is only available through
  `reveal()`, which the HTTP layer calls when it builds the auth header.
- Key formats are checked offline:
  - Stripe keys must be `sk_` or `rk_`, so publishable keys are refused, and live keys need opt-in.
  - Auth0 client ids are checked for shape, and static tokens must be JWT-shaped.
- An online check runs before any destructive step: Stripe `GET /v1/customers?limit=1`, and the
  Auth0 token request followed by `GET /api/v2/users`.

## Resilience

The `HttpClient` handles retries and error hygiene.

**Retries**

- **429** is always retried. The wait is `Retry-After` (in seconds or as an HTTP date), then Auth0's
  `X-RateLimit-Reset` (epoch seconds), and otherwise exponential backoff with full jitter:
  `random(0, min(maxDelay, base × 2^(attempt−1)))`. If a server asks for a longer wait than
  `maxDelayMs`, the request fails instead of hanging.
- **5xx and network errors** are retried only for idempotent requests: GET, DELETE, and Stripe POSTs.
  Stripe POSTs carry a deterministic `Idempotency-Key`, so a retried write can't be applied twice.
- Defaults: 5 attempts, 500 ms base delay, 30 s maximum delay.

**What errors and logs contain**

- Errors carry the HTTP status plus a vendor machine code, such as Stripe's `code`/`type` or Auth0's
  `errorCode`. The code only gets through if it matches `^[A-Za-z0-9_.:-]{1,64}$`, whatever the
  plugin extracted.
- Response bodies, ids and query strings are never logged or reported, because vendor messages often
  echo emails. Logs record path templates such as `/v1/customers/{id}`.

## What each connector does

| Connector | Erasure                                                                                                                                                                                                                                                   | Retained                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Stripe    | Blanks `name`, `email`, `phone`, `description`, `address`, `shipping`, `preferred_locales` and every `metadata` key (`POST /v1/customers/{id}` with empty strings). Detaches payment methods and deletes tax IDs. The Customer object is **not** deleted. | Invoices are never modified. They're counted and reported as retained for tax |
| Auth0     | `DELETE /api/v2/users/{id}` for the mapped user id, or for every identity returned by `GET /api/v2/users-by-email`. A 404 means the user is already gone                                                                                                  | –                                                                             |

Both connectors are idempotent. A dry run makes GET requests only.

## Orchestration

`runDeletion()` runs in three phases:

1. **Credentials.** Every SaaS connector is verified in parallel. Any failure stops the whole run
   **before anything changes**. The report has `status: failed` and `abortedAt: credentials`.
2. **Identities.** The mapped columns, such as `stripe_customer_id` and `auth0_user_id`, are read
   from the subject row before it's deleted. The values stay in memory and are never reported.
3. **Execute.** Postgres and every SaaS connector run together with `Promise.all`. Each one is
   isolated, so one failing doesn't stop the others.

The report's `status` is:

- `completed` when nothing failed.
- `partial` when some connectors failed. The CLI exits with code **3**.
- `failed` when everything failed or the run was aborted. The CLI exits with code 2.

Each connector entry has a status, duration, steps, retained records, a note, and an error (shape
only). `hints` explains what to do next.

**Retrying a partial failure.** Every connector is idempotent, so you can re-run. If the database
step already succeeded, the subject row and its external ids are gone. In that case pass the ids
explicitly:

```bash
stonekeep delete --subject-env SUBJECT --apply --saas-identity stripe.customerId=cus_123
```

## Writing a plugin

```ts
const hubspotPlugin: SaasPlugin<HubspotConfig> = {
  type: 'hubspot',
  description: 'HubSpot: GDPR-delete the contact',
  configSchema: hubspotConfigSchema, // zod, .strict()
  async create(config, ctx) {
    const token = await ctx.secrets.resolve(config.token); // Secret
    return new HubspotConnector(config, token, ctx); // implements SaasConnector
  },
};
createDefaultRegistry().register(hubspotPlugin);
```

A `SaasConnector` needs `verifyCredentials()` and an idempotent `erase(identity, mode, { dryRun })`.
Use `HttpClient` so retries and redaction behave the same as the built-in connectors.

## Tests

`packages/connectors/test` mocks Stripe and Auth0 with MSW, using stateful fakes of the documented
endpoints. It covers:

- 429 retries, including `Retry-After`, `X-RateLimit-Reset`, backoff and give-up.
- Validation of API keys and config.
- Redaction of secrets and PII.
- Running in parallel against the real Postgres engine.
- Partial failures in both directions: Stripe failing while Postgres succeeds, and the reverse.

## Polskie i popularne usługi: PayU, Przelewy24, Mailchimp

| Typ          | Co robi przy usunięciu                                                                                            | Czego nie rusza                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `payu`       | usuwa zapisane tokeny kart klienta (`DELETE /api/v2_1/tokens/{token}`); potrzebuje e-maila i `extCustomerId`      | zamówienia i płatności (księgowość); tokenów BLIK PayU nie pozwala usunąć przez API |
| `przelewy24` | sprawdza dostęp (`/api/v1/testAccess`) i oznacza krok jako ręczny: Przelewy24 nie udostępnia API do usuwania osób | transakcje (księgowość)                                                             |
| `mailchimp`  | trwale usuwa subskrybenta z wybranych audience (`delete-permanent`)                                               | nic więcej nie jest przechowywane po stronie Stonekeep                              |

Przykład (`stonekeep.connector.yaml`):

```yaml
saas:
  - type: payu
    clientId: env:PAYU_CLIENT_ID
    clientSecret: env:PAYU_CLIENT_SECRET
    environment: sandbox # production po testach
    identity:
      email: { column: email }
      extCustomerId: { column: id }
  - type: przelewy24
    posId: '123456'
    apiKey: env:P24_API_KEY
    environment: sandbox
  - type: mailchimp
    apiKey: env:MAILCHIMP_API_KEY
    listIds: ['a1b2c3d4e5']
    identity:
      email: { column: email }
```

Stan weryfikacji: te trzy wtyczki zostały napisane na podstawie publicznej dokumentacji dostawców, ale nie były uruchamiane na prawdziwych kontach (brak kluczy). Najpierw użyj trybu próbnego (`dry run`) i środowiska sandbox. Konektor MySQL nie istnieje: silnik usuwania działa dziś na PostgreSQL.
