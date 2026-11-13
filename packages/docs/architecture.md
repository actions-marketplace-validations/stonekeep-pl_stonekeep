# Architecture (Stage 1)

```text
files ──► parsers ──► SchemaField[] ──► classifier (rules JSON) ──► DataMapField[] ──► stonekeep-datamap.json
                                                                        │
                                       committed datamap + overrides ───┴──► check ──► exit 0 / 1
```

1. **Discovery** (`files.ts`). The scanner walks the scan root without following symlinks. It skips
   vendor and build directories plus any `exclude` globs, and returns sorted POSIX relative paths.
   Files are read as UTF-8, or as UTF-16 when they start with a byte order mark (SQL Server tools
   save scripts that way).
2. **Parsing** (`parsers/`). Each parser extracts identifiers and type names only:
   - `sql.ts` masks comments and string literal contents, splits statements, and replays DDL across
     migration files in natural order. That means renames and drops are reflected. Statements are
     split on `;`, on a T-SQL `GO` line, and where a new `CREATE`/`ALTER`/`DROP TABLE` starts a
     line, so scripts without semicolons are read in full. Identifiers may contain any letters
     (`imię`, `płeć`). `CREATE TABLE ... LIKE` copies the columns of the original table.
   - `prisma.ts` reads `model` / `type` blocks and skips relation fields (fields typed as another
     model).
   - `typeorm.ts` reads every class that has `@Column`-family decorators: entities, and also base
     and embedded classes without `@Entity`, because their columns end up in real tables.
   - `schema.ts` uses the `yaml` AST, which also parses JSON and gives accurate line numbers, to walk
     JSON Schema and OpenAPI documents. It reads every document of a multi-document YAML file,
     follows anchors and aliases, and for OpenAPI also reads the inline schemas under `paths`:
     parameters, request bodies and responses. Those fields get the operation as their entity, for
     example `POST /users.request.email` or `GET /users/{id}.query.email`.
3. **Classification** (`classifier.ts`). Candidate names (the property name, plus the mapped column
   name if there is one) are normalized to snake_case. The global `ignore` patterns and each rule's
   `exclude` patterns are applied, then the best-matching rule wins. A JSON Schema `format`, such as
   `email` or `ipv4`, can also trigger a rule. Scores are adjusted by coarse type; for example,
   boolean flags score lower.
4. **Overrides** (`stonekeep.config.json`). Per-field `category` or `ignore` decisions take priority
   over the automatic classification.
5. **Datamap** (`datamap.ts`). The datamap is sorted, contains no timestamps, and is validated with
   zod when read back.
6. **Check** (`check.ts`):
   - `unmapped` = detected fields that are in neither the datamap nor the overrides. These are
     blocking.
   - `stale` = datamap entries that are no longer in the code. These are warnings.
   - `changed` = fields whose category differs from the datamap. These are warnings.

7. **Incomplete scans fail the check.** When a schema source cannot be read or parsed (an
   unreadable file or directory, a binary or oversized `.sql`/`.prisma` file, a `CREATE TABLE` whose
   brackets never close, an OpenAPI or JSON Schema file with syntax errors), the scanner lists it
   under `incomplete` and `check` exits with `1`. A check that skipped part of the schema cannot
   say that all personal data is mapped. Fix the file, add it to `exclude`, or pass
   `--allow-incomplete`.

Field identity is `Entity.field`, which is independent of file and line. Moving a column definition
therefore doesn't break `check`.

## Invariants

- Stonekeep never reads, stores or logs data values. Only identifiers and paths appear in output.
- There's no network I/O and no telemetry.
- `scan` only writes the datamap. `--dry-run` writes nothing.
- Exit codes: `0` ok, `1` unmapped PII or an incomplete scan (policy failure), `2` usage or
  configuration error.

## Known limitations (Stage 1)

- SQL support covers DDL only. Views, `CREATE TABLE ... AS SELECT`, and dynamic SQL inside
  procedures aren't analysed.
- OpenAPI `$ref`s are not followed. A referenced schema is read where it is defined (under
  `components.schemas`), not again at each place that points to it.
- In a SQL string literal, a backslash right before the closing quote is read the standard SQL way
  (an ordinary character) when a comma, bracket, semicolon or line end follows. A MySQL script that
  relies on `\'` in exactly that position can be misread.
- If the same `Entity.field` id appears in more than one source (for example, a Prisma model and an
  OpenAPI schema both called `User`), the two are recorded as a single entry.
