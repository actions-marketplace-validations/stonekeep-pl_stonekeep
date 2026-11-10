# @stonekeep/cli

Find personal data fields in your code, keep a reviewed data map, and block unmapped PII in CI.
Polish output by default (`--lang en` for English).

```bash
npx @stonekeep/cli init        # scan, write datamap + config + ROPA template + CI workflow
npx @stonekeep/cli check       # exit 1 when a new PII field is not mapped
npx @stonekeep/cli porady      # project-specific RODO advice with article references
npx @stonekeep/cli dokumenty   # Polish document pack: information clause, procedures, letters
```

Reads SQL migrations, Prisma, TypeORM, JSON Schema and OpenAPI. Reads schema definitions only, never
data values, and sends nothing anywhere (no telemetry).

Engine commands work on one person's data in Postgres and the connected SaaS services:

| Command                                         | What it does                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| `stonekeep discover`                            | Lists tables, foreign keys and PII columns                         |
| `stonekeep export --subject-env ID --out x.zip` | One person's data as JSON + CSV with checksums                     |
| `stonekeep delete --subject-env ID [--apply]`   | Deletes or anonymises one person's data, honouring retention rules |
| `stonekeep mask [--apply]`                      | Copies production to staging with PII replaced                     |
| `stonekeep ropa` / `stonekeep breach`           | Art. 30 record and Art. 33 breach draft for UODO, in Polish        |

Destructive commands are dry runs unless you pass `--apply`.

> Stonekeep helps you track and manage personal data. Its classification is heuristic and needs human
> review. It does **not** guarantee compliance with GDPR/RODO or any other law, and it is not legal advice.

Part of [Stonekeep](https://www.npmjs.com/package/@stonekeep/cli), RODO tooling for small teams in Poland. Licence: Apache-2.0.
