# Copilot instructions for Stonekeep

Stonekeep is an open-core B2B product for automated user-data compliance (export, deletion,
anonymization, consent). These rules apply to every change in this repository.

## Code

- **Strict TypeScript only.** `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
  stay enabled. **Never use `any`** (explicit or via casts like `as any`); use `unknown` plus
  narrowing, zod schemas, or precise types. Do not add `@ts-ignore` / `eslint-disable` to bypass this.
- ESM, Node 20+. Prefer the Node standard library over new dependencies.
- Validate all external input (config files, datamaps, CLI flags) with zod at the boundary.
- Classification rules live in JSON config (`packages/core/rules/default-rules.json` and user
  `stonekeep.config.json`), never hardcoded in TypeScript.

## Personal data

- **Never store, log, print, or send personal data.** Stonekeep handles identifiers (table/column/field
  names), never data values. Parsers must not extract literal values (SQL string literals are masked).
- Error messages and warnings may contain file paths and field names only — never file contents.
- No telemetry, analytics, or network calls. Stonekeep runs purely locally.
- Test fixtures use obviously fake data (`example.com`, `555-01xx` numbers).

## Safety

- **Destructive actions are dry-run by default.** Any command that deletes, anonymizes, or mutates
  user data (now or in future stages) must require an explicit opt-in flag (e.g. `--apply`) and print
  what it would do first.
- Exit codes are a contract: `0` ok, `1` policy violation (e.g. unmapped PII), `2` usage/config error.

## Tests

- **Every feature and bug fix needs tests** (vitest, in `packages/*/test`). Parser changes need a
  parser unit test; behaviour visible to CI users needs a fixture-based test.
- `pnpm lint`, `pnpm typecheck` and `pnpm test` must pass.

## Wording

- **Never claim absolute legal compliance.** Do not write "GDPR compliant", "guarantees compliance",
  or similar in code, CLI output, docs or marketing copy. Say Stonekeep _helps_ teams track and manage
  personal data, and that classification is heuristic and needs human review.
