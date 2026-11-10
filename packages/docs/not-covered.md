# What Stonekeep does NOT do

Stonekeep helps you find, map and govern personal data. It is a tool for the people responsible for
compliance, not a replacement for them.

- **It does not guarantee compliance** with GDPR, national implementing acts (for example in Poland,
  Romania or Hungary), CCPA or any other law. Classification is heuristic and needs human review.
- **It does not give legal advice.** Fines, deadlines and legal bases quoted anywhere must be
  checked against the official text of the law or with your DPO.
- **It does not read data values.** `scan` and `check` read schema definitions only. Fields whose
  names do not look personal (for example `notes`, `data` or `uwagi`) are not detected.
- **It does not analyse application code yet.** PII in logs, transfers to third parties and
  field-to-reader maps are on the [roadmap](roadmap.md).
- **It does not delete anything without `--apply`.** Destructive commands are dry runs by default;
  take a backup before applying them.
- **It does not phone home.** There is no telemetry.

## Language coverage

Built-in rules match English field names and common Polish, Romanian and Hungarian ones, plus
national ID names from Czechia, Slovakia, Bulgaria, Croatia, Slovenia and the Baltics. Diacritics
are folded first, so `imię` and `imie` match the same rule. Field names in other languages, and
abbreviations specific to your team, need [`extraRules`](rules.md#customising). To correct a wrong
result, use `overrides` in `stonekeep.config.json` or an inline `stonekeep-ignore` comment.
