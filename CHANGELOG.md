# Changelog

## 0.8.0

The scanner no longer passes by skipping. Either it reads a schema, or it says that it could not
and `check` fails.

### Upgrading

- **`check` now fails when part of the schema could not be read.** Unreadable files or directories,
  binary or oversized `.sql`/`.prisma` files, a `CREATE TABLE` whose brackets never close, and
  OpenAPI or JSON Schema files with syntax errors are listed under `incomplete` and make `check`
  exit with `1`. Fix the file, add it to `exclude` in `stonekeep.config.json`, or pass
  `--allow-incomplete` (GitHub Action input: `allow-incomplete`).
- **The scanner finds fields it used to miss** (list below). After upgrading, `check` may report
  them as unmapped. Run `stonekeep scan`, review the diff of `stonekeep-datamap.json` and commit it.

### Fields that were missed before

- SQL: column and table names with non-ASCII letters (`imię`, `płeć`, `zamówienia`).
- SQL: every statement after the first one in scripts without semicolons, and T-SQL scripts that
  separate batches with `GO`.
- SQL: `ALTER TABLE ... ADD (a int, b text)`, `CREATE TABLE ... (LIKE other)` and MySQL
  `CREATE TABLE copy LIKE original`.
- SQL: everything after a string literal that ends with a backslash (`DEFAULT 'C:\'`), and after
  quoted identifiers that contain a quote or `--`.
- SQL: files saved as UTF-16 with a byte order mark.
- TypeORM: `@Column` fields of base and embedded classes that have no `@Entity`; `.mts` and `.cts`
  files.
- OpenAPI: inline schemas under `paths` (parameters, request bodies, responses), Swagger 2 body
  parameters and response schemas. Their entity is the operation, e.g. `POST /users.request.email`.
- JSON Schema and OpenAPI in YAML: every document of a multi-document file, and schemas reached
  through anchors and aliases.

### False positives removed

- SQL: DDL inside a function body quoted with a numbered dollar tag (`$fn1$ ... $fn1$`) is no longer
  read as a real table.

### Other

- `scan` and `check` report `incomplete` in text, JSON and GitHub annotation output; the MCP server
  returns it too.
- A directory that cannot be listed no longer aborts the scan: it is reported as incomplete.
- A datamap entry is not called stale while its source file could not be read.
- New tests: 24 reliability cases, including property-based tests that feed the four parsers
  arbitrary input and require that they neither throw nor return malformed fields.
