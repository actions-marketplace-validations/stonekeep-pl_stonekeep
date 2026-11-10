# Stonekeep

Stonekeep is an open-core toolkit that helps engineering teams **find, map and govern personal data**.
It's built to support export, deletion, anonymization and consent workflows.

What's included:

| Stage | Capability                                                                                                                                                                                                | Docs                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1     | **Scanner and CI check.** Find PII fields in SQL, Prisma, TypeORM and JSON/OpenAPI schemas, and block unmapped PII in pull requests                                                                       | below                                        |
| 2     | **Data engine.** Export, delete or anonymize one person's data in Postgres, honouring retention rules; mask production into staging                                                                       | [engine.md](packages/docs/engine.md)         |
| 3     | **SaaS connectors.** Stripe and Auth0 plugins with secret references and 429 retries. `stonekeep delete` runs the database and every SaaS connector in parallel and prints one report                     | [connectors.md](packages/docs/connectors.md) |
| 4     | **Consent.** A tamper-evident SQLite consent ledger, verifiable evidence exports and an erasure hook, plus a React SDK (`useConsent`, `<ConsentBanner>`)                                                  | [consent.md](packages/docs/consent.md)       |
| 5     | **HTTP API.** Fastify with OpenAPI 3.1, a job queue, approval-gated deletions, scoped argon2 API keys, rate limits, an audit log and signed webhooks. Includes a Dockerfile and docker-compose            | [server.md](packages/docs/server.md)         |
| 6     | **Console.** A web UI for DPOs and support staff: request queue, impact review, approve/reject with a typed confirmation, and a consent viewer                                                            | [ui.md](packages/docs/ui.md)                 |
| 7     | **AI setup assistant and MCP server.** `stonekeep setup` drafts the connector config from schema metadata behind a privacy guardrail; the MCP server gives coding agents read-only tools; plus `SKILL.md` | [ai.md](packages/docs/ai.md)                 |

Built for the Polish market: small teams and solo developers who carry RODO duties without a
privacy department. The console opens in Polish, documents (Art. 30 record, Art. 33 breach draft for
UODO) come in Polish, and field-name rules recognise Polish names such as `pesel`, `nip`, `imie` and
`nazwisko`. See the [roadmap](packages/docs/roadmap.md) and [what Stonekeep does not
do](packages/docs/not-covered.md).

To try it on any project, run `npx @stonekeep/cli init`. No account, no server, no telemetry.

**Licensing (open core).** The CLI and its libraries (`@stonekeep/cli`, `core`, `connectors`, `ai`,
`mcp`, `react`) are free under Apache-2.0 and published on npm. The HTTP API with the console
(`packages/server`, `packages/ui`) is commercial: it is licensed with the "Zespół" and "Software house"
plans under the Stonekeep Commercial License, installs on your own or your client's server, and is
not part of this repository (see [stonekeep.pl](https://stonekeep.pl)).

> Stonekeep helps you track and manage personal data. Its classification is heuristic and needs human
> review. It does **not** guarantee compliance with GDPR, CCPA or any other law.

- **Local only.** There's no telemetry. `scan` and `check` read schema definitions and never read
  data values. String literals in SQL migrations are masked before parsing, so seed data is never
  picked up. The engine commands connect only to the databases named in your connector config.
  Their output contains identifiers and counts, never data values or the subject's key.
- **Destructive actions are dry runs by default.** `delete` and `mask` change nothing unless you pass
  `--apply`.
- **Rules are config, not code.** Classification uses regex and heuristic rules defined in
  [`packages/core/rules/default-rules.json`](packages/core/rules/default-rules.json). You can extend
  or replace them per repository.

## Supported sources

| Source            | Files                           | Notes                                                                                            |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| SQL migrations    | `**/*.sql`                      | Replays `CREATE TABLE`, `ALTER TABLE ADD/DROP/RENAME/CHANGE`, `DROP TABLE` in natural file order |
| Prisma            | `**/*.prisma`                   | Models and composite types, `@map`; relation fields are skipped                                  |
| TypeORM           | `**/*.ts` containing `@Entity(` | `@Column` family decorators, `name` and `type` options                                           |
| JSON Schema       | `**/*.json`, `**/*.y{a,}ml`     | `properties`, `$defs`/`definitions`, nested objects and arrays, `format`                         |
| OpenAPI / Swagger | `**/*.json`, `**/*.y{a,}ml`     | `components.schemas` (v3) and `definitions` (v2)                                                 |

## Quick start

One command sets up a project (Polish output by default; add `--lang en` for English):

```bash
npx @stonekeep/cli init        # scan, write datamap + config + ROPA template + CI workflow, print next steps
git add . && git commit -m "Add Stonekeep"
```

`init` never overwrites existing files (use `--force`), detects GitHub or GitLab, and finds the
repository root when the project lives in a subfolder. The step-by-step version:

```bash
pnpm add -D @stonekeep/cli        # or run from this repo: node packages/cli/bin/stonekeep.js
npx @stonekeep/cli scan                # writes stonekeep-datamap.json
git add stonekeep-datamap.json && git commit -m "Add Stonekeep datamap"
npx @stonekeep/cli check               # exit 0 when every detected PII field is mapped
```

Then, for a team without a legal department:

```bash
npx @stonekeep/cli porady      # project-specific RODO advice with article references (--lang en for English)
npx @stonekeep/cli dokumenty   # Polish document pack in ./rodo: information clause, procedures, letters, checklists
```

Polish quick start: [szybki-start.md](packages/docs/szybki-start.md). Advice, templates and legal
sources: [prawo.md](packages/docs/prawo.md).

### `stonekeep scan [path]`

Scans `path` (default `.`) and writes `stonekeep-datamap.json`:

```json
{
  "version": 1,
  "fields": [
    {
      "id": "users.email",
      "entity": "users",
      "field": "email",
      "category": "contact",
      "rule": "email",
      "confidence": 0.95,
      "source": "sql",
      "location": { "file": "migrations/001_init.sql", "line": 4 }
    }
  ]
}
```

The output is deterministic: it's sorted and contains no timestamps, so a diff only shows real
changes. Options:

- `--out <file>`: write the datamap somewhere else.
- `--config <file>`: use a different config file.
- `--dry-run`: don't write anything.
- `--json`: print machine-readable output.

### `stonekeep check [path]`

Re-scans the code and compares it with the committed datamap.

| Situation                                                            | Result                           |
| -------------------------------------------------------------------- | -------------------------------- |
| PII field in code, missing from the datamap **and** config overrides | **exit 1** (blocks the PR)       |
| Datamap entry no longer in code / category changed                   | warning (exit 1 with `--strict`) |
| Everything mapped                                                    | exit 0                           |
| Missing datamap, invalid config, bad flags                           | exit 2                           |

Options:

- `--datamap <file>`: compare against a different datamap.
- `--format text|json|github`: choose the output format. The default is `github` when
  `GITHUB_ACTIONS=true`, which adds inline PR annotations, and `text` otherwise.
- `--strict`: also fail on stale entries and category changes.

## CI/CD integration

The datamap is a reviewed, committed artifact. When a pull request adds a column such as
`passport_number`, `stonekeep check` fails until the author takes one of two actions:

1. **Map it.** Run `stonekeep scan` and commit the updated `stonekeep-datamap.json`. The new PII then
   appears in the PR diff, where a privacy or security owner can review it.
2. **Override it.** Add an entry to `stonekeep.config.json`: either a `category`, or `"ignore": true`
   if it isn't personal data.

Make the review step mandatory by adding the datamap and config to `CODEOWNERS`:

```text
# .github/CODEOWNERS
stonekeep-datamap.json  @your-org/privacy
stonekeep.config.json   @your-org/privacy
```

### GitHub Action and Code Scanning

[Stonekeep PII check](https://github.com/marketplace/actions/stonekeep-pii-check) runs the check in a
pull request, adds inline annotations on the line that introduced unmapped personal data and writes
`stonekeep.sarif` for GitHub Code Scanning.

```yaml
# .github/workflows/stonekeep.yml
name: Stonekeep
on: [pull_request]
permissions:
  contents: read
  security-events: write # only for the SARIF upload
jobs:
  pii-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: stonekeep-pl/stonekeep@v0
      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: stonekeep.sarif
```

| Input     | Default  | Meaning                                                    |
| --------- | -------- | ---------------------------------------------------------- |
| `path`    | `.`      | Directory to scan                                          |
| `strict`  | `false`  | Also fail on stale datamap entries and category changes    |
| `sarif`   | `true`   | Write `stonekeep.sarif` for Code Scanning                  |
| `version` | `latest` | `@stonekeep/cli` version to run (pin it, e.g. `0.7.0`)     |

The action runs locally on the runner and reads schema definitions only, never data values.

Use `stonekeep check --format sarif` directly in other CI systems. To suppress one field, put a
`stonekeep-ignore` comment on its line or the line above.

### GitHub Actions

```yaml
# .github/workflows/stonekeep.yml
name: Stonekeep
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  pii-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx --yes @stonekeep/cli check
```

On GitHub Actions, unmapped fields show up as inline `::error` annotations on the migration or schema
line that introduced them. To block merges, mark the `pii-check` job as a **required status check**
in your branch protection rules for `main`.

### GitLab CI

```yaml
stonekeep:
  image: node:20
  script:
    - npx --yes @stonekeep/cli check --format text
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
```

### Pre-commit / local

```bash
npx @stonekeep/cli check || echo "Run 'npx @stonekeep/cli scan' and commit stonekeep-datamap.json"
```

For other tools, use `--format json` to get a machine-readable report. Any non-zero exit code should
fail the pipeline.

## Configuration: `stonekeep.config.json`

This file is optional and lives at the scan root.

```json
{
  "datamap": "stonekeep-datamap.json",
  "minConfidence": 0.5,
  "exclude": ["legacy/**", "**/*.test.ts"],
  "extraRules": [
    {
      "id": "loyalty-card",
      "category": "financial",
      "match": [{ "pattern": "(^|_)loyalty_card(_number)?$", "confidence": 0.9 }]
    }
  ],
  "overrides": {
    "Contact.name": { "category": "identity", "note": "Contact person name" },
    "Customer.plan": { "ignore": true, "note": "Subscription tier, not personal data" }
  }
}
```

| Key             | Meaning                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| `datamap`       | Datamap path, relative to the scan root                                                      |
| `minConfidence` | Fields that score below this aren't reported (default `0.5`)                                 |
| `exclude`       | Gitignore-style globs to skip. `node_modules`, `dist`, `.git` and similar are always skipped |
| `rulesFile`     | **Replace** the built-in rules with your own rules file                                      |
| `extraRules`    | Add rules. A rule with the same `id` as a built-in rule replaces it                          |
| `overrides`     | Per-field decisions keyed by datamap id (`Entity.field`). An override counts as "mapped"     |

Rules are matched against the normalized field name, so `phoneNumber`, `PhoneNumber` and
`phone_number` all become `phone_number`. See [packages/docs/rules.md](packages/docs/rules.md) for
the rule format.

## Data engine (Stage 2)

The engine works on one **subject**: a row in your users table, plus every row that belongs to it
through foreign keys. It's configured with `stonekeep.connector.yaml`, which is validated against a
zod schema:

```yaml
version: 1
connector: postgres
connection:
  urlEnv: STONEKEEP_DATABASE_URL # the URL is read from this env var, never stored in config
subject: { table: users, key: id }
tables:
  support_tickets:
    foreignKeys: # relations the database doesn't enforce
      - { column: requester_id, references: users.id }
  invoices:
    retain: # keep these rows, detached from the person
      reason: Invoices must be kept for 10 years (tax law)
      reference: null # or an anonymous placeholder id, e.g. { user_id: 0 }
      anonymize: [billing_email]
mask:
  columns: { support_tickets.body: token }
```

| Command                                         | What it does                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `stonekeep discover`                            | Lists tables, foreign keys, PII columns and each table's role for the subject  |
| `stonekeep export --subject-env ID --out x.zip` | Writes a ZIP of `data/<table>.json` + `.csv`, `manifest.json` and `SHA256SUMS` |
| `stonekeep delete --subject-env ID [--apply]`   | Deletes the subject's rows children-first. Retained tables are detached first  |
| `stonekeep delete --mode anonymize ...`         | Replaces PII in place and keeps rows and keys                                  |
| `stonekeep mask [--apply] [--truncate]`         | Copies production to staging with names, emails, IPs and other PII replaced    |

Every operation runs in a single transaction, and any error rolls it back. `delete` is idempotent: a
second run affects 0 rows. Database errors are reported by SQLSTATE and constraint name only,
because the raw Postgres message and detail fields can include data values.

Masking uses deterministic fake data. Faker is seeded with HMAC-SHA256 of a secret
(`STONEKEEP_MASK_SECRET`) and the original value. The same input always produces the same fake, so
foreign keys and joins on PII columns, such as an email column referenced by another table, still
match. Primary keys, identity values and non-PII data are copied unchanged, and sequences are reset
on the target.

[packages/docs/engine.md](packages/docs/engine.md) covers the full configuration, how subject rows
are found, retention semantics and safety checks.

## Repository layout

```text
packages/core        Scanner, classifier, datamap, check (`@stonekeep/core`);
                     data engine: export, delete, mask (`@stonekeep/core/engine`);
                     consent ledger (`@stonekeep/core/consent`)
packages/connectors  SaaS plugin registry (Stripe, Auth0), resilient HTTP, deletion orchestrator
packages/cli         `stonekeep` command-line interface
packages/react       Consent SDK for React apps
packages/ai          Setup assistant, privacy guardrail, prompt evaluation
packages/mcp         MCP server for AI coding agents (`stonekeep-mcp`)
packages/docs        Documentation
fixtures/            Fixture repos used by the tests (incl. postgres-shop for the engine)
```

## Development

Requires Node 20+ and pnpm 10.

```bash
pnpm install
pnpm test        # vitest (runs against source; no build needed)
pnpm lint
pnpm typecheck
pnpm build
pnpm eval:ai     # setup-assistant prompt evaluation (offline baseline)
```

The engine integration tests (`*.int.test.ts`) run against real Postgres. They pick the first
backend that's available:

1. **`STONEKEEP_TEST_DATABASE_URL`**: an existing server, using an admin URL. The tests create
   throwaway databases on it.
2. **Testcontainers**: `postgres:16-alpine`. This needs Docker or another compatible container
   runtime.
3. **PGlite**: Postgres compiled to WASM, used when no container runtime is found. CI sets
   `STONEKEEP_TEST_REQUIRE_DOCKER=1`, so CI always uses testcontainers.

Contributor rules, including no `any`, no personal data in logs, dry-run by default for destructive
actions, and tests for every feature, are in
[.github/copilot-instructions.md](.github/copilot-instructions.md).
