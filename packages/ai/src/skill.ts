/** SKILL.md: instructions for AI coding agents working in a repository that uses Stonekeep. */
export function renderSkillMd(options: { connector?: string; datamap?: string } = {}): string {
  const connector = options.connector ?? 'stonekeep.connector.yaml';
  const datamap = options.datamap ?? 'stonekeep-datamap.json';
  return `---
name: stonekeep
description: Use when changing database schemas, migrations, ORM models or API schemas in this repository, or when asked about personal data, GDPR/CCPA requests, data deletion, exports or staging masking. Stonekeep tracks which fields hold personal data and enforces it in CI.
---

# Stonekeep in this repository

Stonekeep maps personal data (PII) in the code and runs data-subject operations (export, deletion,
anonymization, staging masking) against the database. It helps teams manage personal data; it does
not guarantee legal compliance, so never claim that it does.

## Files

| File | What it is | Who edits it |
| --- | --- | --- |
| \`${datamap}\` | Generated map of personal-data fields (field names only, no values) | \`stonekeep scan\` only; review diffs in PRs |
| \`stonekeep.config.json\` | Rules, excludes, per-field overrides | Humans; you may propose changes |
| \`${connector}\` | Database subject, relations, retention rules, masking, SaaS connectors | Humans; propose with \`stonekeep setup\` |

## When you change a schema (migration, Prisma/TypeORM model, OpenAPI/JSON Schema)

1. Run \`stonekeep scan\` and include the updated \`${datamap}\` in the same change.
2. Run \`stonekeep check\`. Exit code 1 means a personal-data field is not mapped: fix it by
   committing the regenerated datamap, or by adding an override in \`stonekeep.config.json\`
   (\`"category"\`, or \`"ignore": true\` only if the field truly is not personal data).
3. If you add a column that references the subject without a database foreign key (for example
   \`requester_id\`), add it under \`tables.<table>.foreignKeys\` in \`${connector}\`, otherwise deletions
   will miss those rows.
4. If you add a table whose records must be kept for legal reasons (invoices, payments), add a
   \`retain\` rule instead of letting deletions remove it.

## Tools you may use

- \`stonekeep scan [path]\` / \`stonekeep check [path]\`: safe, local, read-only except the datamap.
- \`stonekeep discover\`: read-only catalog view of the configured database.
- \`stonekeep delete --subject-env VAR\` **without** \`--apply\`: a dry run that shows what would be deleted
  or retained, with counts only.
- \`stonekeep mask\` **without** \`--apply\`: a dry run of the staging clone plan.
- \`stonekeep setup\`: proposes \`${connector}\` changes from schema metadata. It shows a diff and only
  saves after a human types Y. Do not answer that prompt yourself.
- MCP server (\`stonekeep-mcp\`): \`scan_codebase\`, \`plan_compliance_yaml\`, \`dry_run_delete\`. There is
  deliberately no tool that executes a deletion.

## Never

- Never run \`stonekeep delete --apply\`, \`stonekeep mask --apply\`, or approve a request through the
  Stonekeep API. Destructive operations require a human and, for deletions, a second approver.
- Never put real personal data (emails, names, ids from production) in code, tests, fixtures,
  commit messages, issue text, or prompts. Use obviously fake values (example.com, 555 numbers).
- Never write secrets into config files. Credentials are references such as \`env:STRIPE_API_KEY\`.
- Never edit \`${datamap}\` by hand or delete entries to make \`stonekeep check\` pass.
`;
}
