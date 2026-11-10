# AI setup assistant and MCP server (Stage 7)

## `stonekeep setup`

```bash
stonekeep setup                 # Claude (claude-opus-5-5) proposes stonekeep.connector.yaml
stonekeep setup --offline       # deterministic rule-based proposal, no network
stonekeep setup --model <id> --connector path/to.yaml --datamap path/to.json
```

The flow:

1. **Collect metadata.** The assistant reads `stonekeep-datamap.json` and the schema field list from
   the scanner, then builds **schema metadata only**: entity names, column names, type names, and
   the scanner's classification. It never reads data values, file contents or comments.
2. **Run the privacy guardrail.** Requests are blocked in two places. A blocked request makes no
   network call, and errors report the kind of finding and its JSON path, never the value.
   - **When metadata is built**, an allowlist applies. Identifiers must match
     `^[A-Za-z_][A-Za-z0-9_$.[\]-]{0,127}$`, and type names must match a similarly narrow pattern.
     Anything else fails loudly.
   - **Immediately before the API call**, `GuardedProvider` scans the exact prompt for real
     personal-data patterns: emails, phone numbers, IPv4 and IPv6 addresses, Luhn-valid card
     numbers, IBANs, SSNs, dates, long digit runs, API keys and tokens (Stripe, Anthropic, AWS,
     JWT, GitHub, Stonekeep, private keys), and URLs with credentials. The Anthropic provider can
     **only** be created already wrapped in this guard.
3. **Get a proposal.** It's produced with structured outputs (`client.beta.messages.parse` with a
   zod schema), effort `high`, and server-side refusal fallback (`fallbacks: "default"`). Refusals
   and truncated responses are reported instead of being half-applied.
4. **Validate and merge.**
   - Names that don't exist in the metadata are dropped with a warning, because models can
     hallucinate.
   - The result is validated against the connector config schema.
   - `connection`, `saas`, `consent` and other settings already in an existing file are kept as
     they are. The assistant never touches credentials or connections.
5. **Show a diff and confirm.** The proposed YAML is shown as a diff against the current file, and
   it's saved **only if you type `Y`**:
   - Any other answer, including just pressing Enter, cancels.
   - A non-interactive run never saves. It exits with code 1 when there are unsaved changes.

**Credentials.** The Anthropic SDK resolves `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an
`ant auth login` profile.

**Other providers.** Other LLM providers can be plugged in by implementing `ProposalProvider` and
wrapping it in `GuardedProvider`. Only Anthropic ships today.

### Prompt evaluation

`packages/ai/eval/golden.json` holds 30 schema fields, with types and classifications, and the
masking strategy a reviewer expects for each. It also records the expected subject table and the
tables that should be retained.

```bash
pnpm eval:ai                                                    # offline baseline (free)
pnpm --filter @stonekeep/ai run eval -- --provider anthropic --runs 3 --min 0.85 --out eval.json
```

| Metric            | Meaning                                                     |
| ----------------- | ----------------------------------------------------------- |
| Field accuracy    | Share of the 30 fields with the expected strategy           |
| Subject correct   | The proposal picked the expected subject table and key      |
| Retain recall     | Share of the expected retained tables the proposal retained |
| Valid config      | The rendered YAML passes the connector config schema        |
| Hallucinated refs | Names in the proposal that don't exist in the metadata      |
| Duration          | Time per run                                                |

**Exit code:** 1 if the mean accuracy is below `--min` or any config is invalid.

**Cost:** the Anthropic provider makes one billed request per run, about 3k input tokens.

**Baseline:** the offline heuristic scores 96.7% (29/30). Its one miss is
`customers.stripe_customer_id`. External account ids are pseudonymous identifiers that a
name-based rule can't recognise, and judgment calls like that are what the LLM is for.

The golden metadata itself goes through the privacy guard in the tests.

## MCP server (`stonekeep-mcp`)

The server runs over stdio. Example config for Cursor or Claude Code:

```json
{
  "mcpServers": {
    "stonekeep": {
      "command": "npx",
      "args": ["stonekeep-mcp"],
      "env": { "STONEKEEP_DATABASE_URL": "postgres://…" }
    }
  }
}
```

| Tool                   | What it does                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `scan_codebase`        | Scans for PII fields and lists what `stonekeep check` would fail on (unmapped and stale). Writes nothing |
| `plan_compliance_yaml` | Drafts a connector config with the offline planner and returns the YAML and a diff. Never saves          |
| `dry_run_delete`       | Previews a deletion across Postgres and the SaaS connectors. `dryRun: true` is hard-coded                |

**Safety guarantees:**

- **Read-only.** Every tool is annotated `readOnlyHint: true` and `destructiveHint: false`.
- **No deletion can run through MCP.** No tool executes a deletion or masking, approves a request,
  or writes files. Extra arguments such as `apply: true` or `dryRun: false` are ignored, and a test
  proves the database is untouched.
- **Workspace-bound.** Paths are resolved inside the workspace, so `../..` is rejected.
- **Clean output.** Results contain identifiers and counts only.

## SKILL.md

`stonekeep skill` writes `SKILL.md`, with agent-facing instructions for working in a repository that
uses Stonekeep:

- When to run `scan` and `check`.
- How to map new fields.
- What the agent may run (dry runs, the MCP tools).
- What it must never do: `--apply`, approvals, real personal data in code or prompts, secrets in
  config.

The repository's own `SKILL.md` is generated this way, and a test keeps it in sync.
