# Architecture (Stage 1)

```text
files ──► parsers ──► SchemaField[] ──► classifier (rules JSON) ──► DataMapField[] ──► stonekeep-datamap.json
                                                                        │
                                       committed datamap + overrides ───┴──► check ──► exit 0 / 1
```

1. **Discovery** (`files.ts`). The scanner walks the scan root without following symlinks. It skips
   vendor and build directories plus any `exclude` globs, and returns sorted POSIX relative paths.
2. **Parsing** (`parsers/`). Each parser extracts identifiers and type names only:
   - `sql.ts` masks comments and string literal contents, splits statements, and replays DDL across
     migration files in natural order. That means renames and drops are reflected.
   - `prisma.ts` reads `model` / `type` blocks and skips relation fields (fields typed as another
     model).
   - `typeorm.ts` reads `@Entity` classes and their `@Column`-family decorators.
   - `schema.ts` uses the `yaml` AST, which also parses JSON and gives accurate line numbers, to walk
     JSON Schema and OpenAPI documents.
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

Field identity is `Entity.field`, which is independent of file and line. Moving a column definition
therefore doesn't break `check`.

## Invariants

- Stonekeep never reads, stores or logs data values. Only identifiers and paths appear in output.
- There's no network I/O and no telemetry.
- `scan` only writes the datamap. `--dry-run` writes nothing.
- Exit codes: `0` ok, `1` unmapped PII (policy failure), `2` usage or configuration error.

## Known limitations (Stage 1)

- SQL support covers DDL only. Views, `CREATE TABLE ... AS SELECT`, and dynamic SQL inside
  procedures aren't analysed.
- The OpenAPI parser reads component schemas only. Inline request and response bodies, and
  `parameters`, aren't analysed yet.
- If the same `Entity.field` id appears in more than one source (for example, a Prisma model and an
  OpenAPI schema both called `User`), the two are recorded as a single entry.
