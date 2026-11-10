# HTTP API (Stage 5)

`@stonekeep/server` wraps the engine (Stage 2), the SaaS orchestrator (Stage 3) and the consent
ledger (Stage 4) in a Fastify API. It adds a background queue, an approval workflow, scoped API
keys, an audit log, and signed webhooks.

```bash
stonekeep-server keys create --name dpo --role dpo        # prints the key once
stonekeep-server keys create --name helpdesk --role support
stonekeep-server start --config stonekeep.server.yaml
```

Interactive docs: the OpenAPI 3.1 document is served at `GET /openapi.json`. It's generated from the
same zod schemas that validate requests.

## Endpoints

| Method & path                      | Scope              | Purpose                                                      |
| ---------------------------------- | ------------------ | ------------------------------------------------------------ |
| `POST /export`                     | `requests:export`  | Create an export request. It runs without approval           |
| `POST /delete`                     | `requests:delete`  | Create a deletion request (`mode`: `delete` or `anonymize`)  |
| `GET /requests`                    | `requests:read`    | List requests, with counts per status (for the dashboard)    |
| `GET /requests/:id`                | `requests:read`    | Detail: dry-run plan, history, result                        |
| `POST /requests/:id/approve`       | `requests:approve` | Approve a deletion. The body must be `{ "confirm": "<id>" }` |
| `POST /requests/:id/reject`        | `requests:approve` | Reject a deletion                                            |
| `GET /requests/:id/download`       | `requests:export`  | Download the export ZIP                                      |
| `POST /consent/records`            | `consent:write`    | Record a consent decision                                    |
| `POST /consent/query`              | `consent:read`     | Current status and tamper-evident history for a subject      |
| `POST /consent/evidence`           | `consent:read`     | Evidence segment (see consent.md)                            |
| `GET /me`, `GET /config`           | `requests:read`    | Caller identity and scopes; connectors and retain rules      |
| `GET /audit`, `GET /audit/verify`  | `audit:read`       | Audit log of API calls, and verification of its hash chain   |
| `GET /incidents/tables`            | `incidents:assess` | Tables and their personal data columns (see breach.md)       |
| `POST /incidents/assess`           | `incidents:assess` | Breach impact and a draft Art. 33 notification; counts only  |
| `GET /health`, `GET /openapi.json` | none               | Liveness check; the API description                          |

Subjects are always sent **in request bodies**, never in URLs. URLs end up in proxies, browser
history and logs.

## State machine

```text
export:  received ──────────────────────────────► running ──► completed | failed
delete:  received ──► awaiting_approval ──approve──► running ──► completed | failed
                              └──reject──► rejected
```

- Allowed transitions are enforced in a single table (`assertTransition`). A deletion can **only**
  reach `running` from `awaiting_approval`.
- While a deletion waits for approval, the worker computes a **dry-run plan** and stores it on the
  request. The plan shows rows per table, the SaaS connectors that will run, the retain rules
  triggered, and the ledger step. It contains counts and identifiers only.
- Approval requires the `requests:approve` scope. The body must echo the request id. **The key that
  created the request can't approve it** (four-eyes principle; set
  `approvals.allowSelfApproval: true` to allow it).
- Each transition runs in a single SQLite transaction that updates the request, appends history,
  enqueues the next job, and writes webhook deliveries to the outbox.
- Jobs are claimed atomically (`UPDATE … RETURNING`) and retried with backoff up to
  `worker.maxAttempts`. If a worker crashes, its jobs are re-queued on start.
- A request reaches `failed` if the deletion report is `partial` or `failed`. The full report is
  stored as `result`.

## Data protection in the server

- **Subject ids** are stored AES-256-GCM encrypted, and only while a job needs them. They're purged
  on every terminal state. Responses and webhooks expose only `subjectRef`, an HMAC.
- **Free-text fields** (`reason`) only accept ticket-style references, such as `TICKET-4711`. Email
  addresses and other personal data are rejected.
- **API keys** have the form `ks_<id>_<secret>`. Only an argon2id hash of the secret is stored.
  Verified keys are cached for 60 seconds, keyed by a SHA-256 of the token, so argon2 doesn't run on
  every request. Revoking a key clears the cache.
- **Rate limits** apply per key (`rateLimit.max` per `timeWindowMs`, which can be overridden per
  key). Unauthenticated callers are limited per hashed IP.
- **The audit log** stores time, key id, method, route _template_, status, request id, hashed IP and
  duration. It never stores bodies or query strings. It's append-only (SQLite triggers) and
  SHA-256-chained. Check it with `GET /audit/verify`.
- Request logging is off, and `authorization` headers are redacted if logging is enabled.

## Webhooks

```yaml
webhooks:
  - url: https://ops.example.com/hooks/stonekeep
    secretEnv: STONEKEEP_WEBHOOK_SECRET
    events: ['request.*'] # or request.completed, request.awaiting_approval, ...
```

Each state change produces the event `request.<status>`:

```http
POST /hooks/stonekeep
Stonekeep-Event: request.awaiting_approval
Stonekeep-Delivery: 2b7c…
Stonekeep-Signature: t=1767225600,v1=5f0c…

{"id":"2b7c…","type":"request.awaiting_approval","createdAt":"…",
 "data":{"request":{"id":"…","type":"delete","mode":"delete","status":"awaiting_approval","previousStatus":"received"}}}
```

`v1 = hex(HMAC-SHA256(secret, "<t>.<raw body>"))`. To verify on the receiving side:

```ts
import { verifyWebhookSignature } from '@stonekeep/server';
const ok = verifyWebhookSignature({
  payload: rawBody, // the raw body, before JSON parsing
  header: req.headers['stonekeep-signature'],
  secret: process.env.STONEKEEP_WEBHOOK_SECRET!,
  toleranceSeconds: 300, // rejects replays
});
```

Delivery details:

- Deliveries are retried with exponential backoff, up to 8 attempts.
- **Order isn't guaranteed**, because a retried delivery can arrive after a later event. Order events
  by `createdAt` and `previousStatus`.
- Payloads never contain the subject.
- Only `https` URLs are accepted, plus `http` to localhost. Set `allowInsecureWebhooks` to allow
  other `http` URLs.

## Deployment

`docker compose up --build` starts a demo Postgres (the `postgres-shop` fixture) and the API on
port 8080. Configuration is in `deploy/stonekeep.server.yaml` and `deploy/stonekeep.connector.yaml`.

- **Secrets:** `STONEKEEP_SERVER_SECRET` and `STONEKEEP_LEDGER_SECRET` must be set.
- **Storage:** state (the SQLite database, exports and the consent ledger) lives in the
  `stonekeep-data` volume.
- **Container hardening:** the container runs as a non-root user with a read-only root filesystem
  and `no-new-privileges`.
- **Keys:** create them with
  `docker compose exec stonekeep node bin/stonekeep-server.js keys create --name dpo --role dpo --config /config/stonekeep.server.yaml`.

## Tests

`packages/server/test/server.e2e.test.ts` drives the API with supertest. The full stack is real: the
Postgres engine (PGlite or testcontainers), argon2 keys, SQLite, and a local HTTP receiver that
captures webhooks. It covers:

- The approval flow, including the plan, the scope, confirmation and four-eyes checks, and
  idempotency.
- Rejection, duplicate requests, and failure paths.
- Exports and downloads.
- Webhook signatures, tampering, staleness and retries.
- Rate limiting and the audit log.
- The consent API, together with the erasure hook.
