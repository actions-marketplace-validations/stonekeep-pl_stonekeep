# Record of processing activities (ROPA)

`stonekeep ropa` writes the record that GDPR Art. 30(1) requires from a controller, in English or
Polish (_Rejestr czynności przetwarzania_). It combines two inputs:

- **`stonekeep.ropa.yaml`**: the processing activities, written and owned by the DPO (purposes, legal
  basis, data subjects, recipients, transfers, retention, security measures).
- **`stonekeep-datamap.json`**: the personal data fields found by `stonekeep scan`. Stonekeep derives
  the categories of personal data for each activity from it and lists the underlying fields in an
  appendix.

Stonekeep also lists open points: PII tables that no activity covers, entity names that don't
match the datamap, special-category or health data without an Art. 9(2) condition, transfers
without a safeguard, and activities without security measures.

> The record is a draft for the DPO to review. Data categories come from heuristic classification
> of schema names. Stonekeep does not decide purposes or legal bases, and the record does not by
> itself demonstrate compliance.

## Quick start

```bash
npx @stonekeep/cli scan                    # writes stonekeep-datamap.json
npx @stonekeep/cli ropa --init --lang pl   # writes stonekeep.ropa.yaml with every PII entity in one TODO activity
# edit stonekeep.ropa.yaml: split the TODO activity into real ones, one per purpose
npx @stonekeep/cli ropa -o rejestr.md      # Markdown in the file's language
npx @stonekeep/cli ropa --lang en --format json -o ropa.json
```

Run `stonekeep ropa --strict` in CI to fail when a new PII table appears that no activity covers.
Commit `stonekeep.ropa.yaml` and add it to `CODEOWNERS` next to the datamap, so the DPO reviews
changes.

## File format

```yaml
version: 1
language: pl # en | pl
controller:
  name: 'Sklep Przykład sp. z o.o.'
  address: 'ul. Prosta 1, 00-001 Warszawa'
  contact: 'kontakt@przyklad.pl'
  # representative: { name: ..., contact: ... }   # Art. 27, controllers outside the EU
  # jointControllers: [{ name: ..., contact: ... }]
dpo: { name: 'Jan Kowalski', contact: 'iod@przyklad.pl' }
securityMeasures: # Art. 32 measures shared by all activities
  - 'Szyfrowanie danych w spoczynku i w tranzycie'
activities:
  - id: konta-klientow
    name: 'Prowadzenie kont klientów'
    purposes: ['Rejestracja i obsługa konta']
    legalBasis: [contract] # Art. 6(1)
    specialCategoryConditions: [] # Art. 9(2), required for special-category or health data
    dataSubjects: ['Klienci sklepu']
    entities: [User] # datamap entities: tables, models, schemas
    fields: [Profile.phone] # single datamap fields, optional
    extraDataCategories: [] # data not visible in schemas, e.g. paper forms
    recipients: ['Dostawca hostingu (podmiot przetwarzający)']
    transfers: [{ country: USA, safeguard: 'Standardowe klauzule umowne 2021/914' }]
    retention: 'Do usunięcia konta, następnie 6 lat'
    # securityMeasures: [...]  # replaces the shared list for this activity
```

| Key                         | Values                                                                                                                                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `legalBasis`                | `consent`, `contract`, `legal_obligation`, `vital_interests`, `public_task`, `legitimate_interests`                                                                                                        |
| `specialCategoryConditions` | `explicit_consent`, `employment_social_security`, `vital_interests`, `non_profit_body`, `made_public`, `legal_claims`, `substantial_public_interest`, `health_care`, `public_health`, `archiving_research` |

## Options

| Option          | Meaning                                                    |
| --------------- | ---------------------------------------------------------- |
| `--init`        | Write a starter `stonekeep.ropa.yaml`; fails if one exists |
| `--ropa <file>` | Activity file (default: `<path>/stonekeep.ropa.yaml`)      |
| `--lang en\|pl` | Output language (default: the file's `language`)           |
| `--format`      | `markdown` (default) or `json`                             |
| `--date`        | "As of" date, `YYYY-MM-DD` (default: today)                |
| `-o, --out`     | Write to a file instead of stdout                          |
| `-d, --datamap` | Datamap path (default: `<path>/stonekeep-datamap.json`)    |
| `--strict`      | Exit 1 when there are open points                          |

Romanian and Hungarian output are planned next (see the [roadmap](roadmap.md)). Processor
records (Art. 30(2)) and DPIA drafts are not generated yet.
