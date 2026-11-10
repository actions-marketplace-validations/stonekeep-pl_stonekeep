# Data engine (Stage 2)

The engine is exported from `@stonekeep/core/engine`. It's a separate entry point, so `stonekeep scan`
never loads database drivers. The engine implements this connector interface:

```ts
interface Connector {
  discover(options?: { dryRun?: boolean }): Promise<DiscoveryResult>;
  export(subject: string, options?: { dryRun?: boolean; outFile?: string }): Promise<ExportResult>;
  delete(
    subject: string,
    mode: 'delete' | 'anonymize',
    options?: { dryRun?: boolean },
  ): Promise<DeleteResult>;
}
```

`delete` defaults to `dryRun: true`, and so does `runMask`. When `dryRun` is on, they count rows
inside a read-only transaction and write nothing.

## Connector config: `stonekeep.connector.yaml`

| Key                                  | Meaning                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `connection.urlEnv`                  | Env var holding the connection URL. Inline URLs are rejected                             |
| `connection.schema`                  | Schema to work in (default `public`)                                                     |
| `connection.statementTimeoutMs`      | `SET LOCAL statement_timeout` for every transaction                                      |
| `connection.lockTimeoutMs`           | `SET LOCAL lock_timeout` for every transaction                                           |
| `subject.table`, `subject.key`       | Where a subject lives and the column that identifies it                                  |
| `datamap`                            | Path to `stonekeep-datamap.json`, relative to the YAML file                              |
| `useDatabaseForeignKeys`             | Merge foreign keys from `pg_constraint` with configured ones (default `true`)            |
| `tables.<t>.foreignKeys`             | Soft relations: `{ column, references: "parent.column" }`. Composite keys use lists      |
| `tables.<t>.retain`                  | `reason`, `reference` (`null`, a literal, or a per-column map) and `anonymize` (columns) |
| `tables.<t>.anonymize`               | Extra PII columns, in addition to the datamap and rules                                  |
| `tables.<t>.exclude`                 | Stonekeep never reads or changes this table                                              |
| `tables.<t>.primaryKey`              | Declares a key for tables that don't have one                                            |
| `mask.sourceUrlEnv` / `targetUrlEnv` | Env vars holding the production and staging URLs                                         |
| `mask.secretEnv`                     | Env var holding the HMAC secret (at least 16 characters). Don't store it on staging      |
| `mask.columns`                       | `"table.column": strategy`. Use `keep` to opt a column out of masking                    |
| `mask.skipTables`                    | Tables that aren't copied at all                                                         |

Identifiers are validated as plain SQL identifiers and are always quoted in SQL. Values are always
bound as parameters, never interpolated. The config is checked against the live catalog before
anything runs, and a table or column that doesn't exist is a configuration error.

## Which columns are personal data

Three sources are combined:

1. **The committed datamap.** `Entity.field` is matched to `table.column` by normalized name.
   Prisma's `User` matches the `users` table, for example.
2. **Live re-classification.** Every database column is checked with the same rules `stonekeep scan`
   uses. This is a safety net for columns that never appeared in a schema file the scanner read.
3. **Explicit config.** `tables.<t>.anonymize`, `retain.anonymize` and `mask.columns`.

`ignore: true` overrides in `stonekeep.config.json` apply here too.

## How subject rows are found

The engine starts from `subject.table WHERE key = $1` and walks foreign keys outward
(child → parent). Each reachable table gets a predicate built from nested `IN (SELECT …)`
subqueries. When a table is reachable over several foreign keys, the predicates are combined with
`OR`. Excluded tables are skipped. For `delete`, the walk stops at retained tables, because their
child rows are retained too. `export` includes them.

## delete, step by step

Everything below happens in one `READ COMMITTED` transaction:

1. **Retain.** For each retained table, a single `UPDATE` sets every column that links a row to the
   subject to the configured `reference`, using `CASE`, so links to other people stay intact. The
   same statement anonymizes the listed columns. This runs **first**, so an
   `ON DELETE CASCADE` can't remove retained rows.
2. **Detach.** Rows that aren't being deleted but reference rows that are have their nullable
   foreign keys set to `NULL`. Examples are a colleague's `manager_id` and cross references.
3. **Delete.** Rows are deleted children-first, and the subject row is deleted last.

In `anonymize` mode, step 3 becomes in-place anonymization of PII columns:

- Nullable columns are set to `NULL`.
- Other columns get typed random placeholders such as `anon_<hex>`, `0.0.0.0` or `1900-01-01`.
  These are random, not deterministic, so the change is irreversible.
- Primary keys, foreign key columns, and columns referenced without `ON UPDATE CASCADE` are left
  alone and listed under `skipped`.

Any database error rolls back the whole transaction. Running the operation again is safe: a second
`delete` matches 0 rows.

## export

The export reads inside a `REPEATABLE READ READ ONLY` transaction, so it's a consistent snapshot.
The ZIP contains:

- `data/<table>.json`: `{ table, columns, rows }`, with lossless types. Booleans, integers and JSON
  are native; other values are Postgres text.
- `data/<table>.csv`: RFC 4180. Cells starting with `= + - @` are prefixed with `'` to block
  spreadsheet formula injection.
- `manifest.json`: generator, timestamp, row counts, and the size and SHA-256 of every data file.
- `SHA256SUMS`: lists every file, including `manifest.json`. Check it with `sha256sum -c SHA256SUMS`.

The file is written atomically with mode `0600`. The result reports the SHA-256 of the ZIP itself.

## mask (production → staging)

1. **Safety checks.**
   - The secret must be at least 16 characters.
   - The source and target URLs must differ, and so must their server identities (database name,
     port and server start time).
   - The target schema must contain every source table and column.
   - A target that isn't empty is refused unless you pass `--truncate`.
2. **Planning.** Each PII column gets a strategy based on its type and the rule that flagged it, or
   on `mask.columns`. Strategies spread across foreign keys, so both ends of a relation always use
   the same strategy.
3. **Copy.** The source is read as one `REPEATABLE READ READ ONLY` snapshot through a cursor. Rows
   are written into a single target transaction with parents first:
   - Rows are inserted in batches with bound parameters.
   - `OVERRIDING SYSTEM VALUE` keeps identity values.
   - Self-references are filled in afterwards.
   - Sequences are reset at the end.

Strategies: `email` (`first.last.<hash>@example.com`), `phone` (`+1555…`), `first-name`,
`last-name`, `full-name`, `username`, `ip` (`10.x.y.z`, or `fd00::/8` for IPv6), `street`, `city`,
`zip`, `geo`, `date`, `number` (keeps the digit count), `uuid`, `token`, `json-empty`, `null`,
`keep`. Generated values are truncated to the column's length.

Faker is seeded with `HMAC-SHA256(secret, strategy ‖ value)`. Without the secret, a fake value
can't be linked back to the real one. With the secret, masking is repeatable, so two runs produce
identical staging data.

## Known limitations

- Only Postgres is supported, and only one schema per config.
- Foreign-key cycles between different tables aren't supported for masking. Self-references are
  supported.
- Free-text columns are only masked if they're listed in `mask.columns` or `anonymize`. Rules can't
  see personal data inside free text.
- An export holds one subject's rows in memory.
