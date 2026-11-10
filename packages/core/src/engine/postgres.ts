import { resolve } from 'node:path';
import pg from 'pg';
import { summarizeBreach, type BreachImpact, type BreachTableImpact } from '../breach.js';
import { StonekeepError } from '../errors.js';
import { anonymizeExpression } from './anonymize.js';
import { SUBJECT_ALIAS, subjectRowsSql } from './breach.js';
import { buildExportZip, sha256Hex, writeFileAtomic, type ExportTable } from './bundle.js';
import {
  applyConfig,
  introspect,
  type Catalog,
  type ForeignKeyInfo,
  type TableInfo,
} from './catalog.js';
import type { ConnectorConfig } from './config.js';
import { buildScopes, childrenFirst, type Scope } from './graph.js';
import { resolvePiiColumns, type PiiColumn, type PiiContext } from './pii.js';
import { exportTypes, q, qList, qTuple, qt, rawTypes, sanitizeDbError } from './sql.js';
import type {
  Connector,
  DeleteMode,
  DeleteResult,
  DiscoveryResult,
  EngineLogger,
  ExportOptions,
  ExportResult,
  OperationOptions,
  SkippedColumn,
  StepAction,
  StepReport,
} from './types.js';

type Types = typeof rawTypes | typeof exportTypes;

export interface PostgresConnectorOptions {
  config: ConnectorConfig;
  /** Connection URL. Read it from the environment; never log it. */
  url: string;
  pii: PiiContext;
  logger?: EngineLogger;
}

interface PlannedStep {
  table: string;
  action: StepAction;
  columns: string[];
  reason?: string;
  /** The mutating statement. */
  sql: string;
  /** Read-only statement counting the rows `sql` would touch. */
  countSql: string;
  params: unknown[];
}

const EXPORT_FETCH = 1000;

function fkPredicate(schema: string, fk: ForeignKeyInfo, parent: Scope): string {
  return `${qTuple(fk.columns)} IN (SELECT ${qList(fk.refColumns)} FROM ${qt(schema, fk.refTable)} WHERE ${parent.predicate})`;
}

function isDbError(error: unknown): boolean {
  return error instanceof pg.DatabaseError;
}

/** Postgres implementation of the Stonekeep connector interface. */
export class PostgresConnector implements Connector {
  private readonly config: ConnectorConfig;
  private readonly url: string;
  private readonly pii: PiiContext;
  private readonly log: EngineLogger;

  constructor(options: PostgresConnectorOptions) {
    this.config = options.config;
    this.url = options.url;
    this.pii = options.pii;
    this.log = options.logger ?? (() => undefined);
  }

  private async withClient<T>(
    context: string,
    types: Types,
    fn: (client: pg.Client) => Promise<T>,
  ): Promise<T> {
    const client = new pg.Client({
      connectionString: this.url,
      types,
      application_name: 'stonekeep',
    });
    try {
      await client.connect();
      return await fn(client);
    } catch (error) {
      throw sanitizeDbError(error, context);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Run `fn` in a transaction; roll back on any error. */
  private async transaction<T>(client: pg.Client, begin: string, fn: () => Promise<T>): Promise<T> {
    await client.query(begin);
    try {
      await client.query(
        `SET LOCAL statement_timeout = ${this.config.connection.statementTimeoutMs}`,
      );
      await client.query(`SET LOCAL lock_timeout = ${this.config.connection.lockTimeoutMs}`);
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private async catalog(client: pg.Client): Promise<Catalog> {
    return applyConfig(await introspect(client, this.config.connection.schema), this.config);
  }

  private piiByTable(catalog: Catalog): { byTable: Map<string, PiiColumn[]>; unmatched: string[] } {
    const res = resolvePiiColumns(catalog, this.config, this.pii, 'anonymize');
    const byTable = new Map<string, PiiColumn[]>();
    for (const c of res.columns) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);
    return { byTable, unmatched: res.unmatchedDatamap };
  }

  /**
   * Read identifier columns of the subject row (e.g. `stripe_customer_id`)
   * so external systems can be addressed. Read-only. The returned values are
   * personal data: keep them in memory and never log them. Returns `null`
   * when the subject row does not exist (e.g. already deleted).
   */
  async lookupSubject(
    subject: string,
    columns: readonly string[],
  ): Promise<Record<string, string | null> | null> {
    if (columns.length === 0) return {};
    return this.withClient('subject lookup', rawTypes, async (client) => {
      const catalog = await this.catalog(client);
      const table = catalog.tables.get(this.config.subject.table);
      const missing = columns.filter((c) => !table?.columns.some((x) => x.name === c));
      if (missing.length > 0) {
        throw new StonekeepError(
          'CONFIG',
          `SaaS identity column(s) not found on "${this.config.subject.table}": ${missing.join(', ')}`,
        );
      }
      const r = await client.query<Record<string, string | null>>(
        `SELECT ${qList(columns)} FROM ${qt(catalog.schema, this.config.subject.table)} WHERE ${q(this.config.subject.key)} = $1 LIMIT 1`,
        [subject],
      );
      return r.rows[0] ?? null;
    });
  }

  // ---------------------------------------------------------------- discover

  async discover(options: OperationOptions = {}): Promise<DiscoveryResult> {
    return this.withClient('discover', rawTypes, async (client) => {
      const catalog = await this.catalog(client);
      const scopes = buildScopes(catalog, this.config, { stopAtRetained: true });
      const { byTable, unmatched } = this.piiByTable(catalog);
      const tables = [...catalog.tables.values()]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((t) => {
          const cfg = this.config.tables[t.name];
          const role: DiscoveryResult['tables'][number]['role'] =
            t.name === this.config.subject.table
              ? 'subject'
              : cfg?.exclude === true
                ? 'excluded'
                : cfg?.retain && scopes.has(t.name)
                  ? 'retained'
                  : scopes.has(t.name)
                    ? 'subject-data'
                    : 'unrelated';
          return {
            name: t.name,
            primaryKey: t.primaryKey,
            role,
            columns: t.columns.map((c) => {
              const p = byTable.get(t.name)?.find((x) => x.column === c.name);
              return {
                name: c.name,
                type: c.udtName,
                nullable: c.nullable,
                ...(p ? { pii: { category: p.category, rule: p.rule, source: p.source } } : {}),
              };
            }),
          };
        });
      return {
        operation: 'discover' as const,
        dryRun: options.dryRun ?? false,
        schema: catalog.schema,
        subject: { ...this.config.subject },
        tables,
        foreignKeys: catalog.foreignKeys.map((fk) => ({
          name: fk.name,
          table: fk.table,
          columns: fk.columns,
          refTable: fk.refTable,
          refColumns: fk.refColumns,
          source: fk.source,
        })),
        unmatchedDatamap: unmatched,
      };
    });
  }

  // ------------------------------------------------------------------ breach

  /**
   * Breach impact for whole tables: rows, personal data columns and distinct data
   * subjects (deduplicated across tables through foreign keys to the subject table).
   * Read-only, one REPEATABLE READ snapshot. Returns counts and identifiers only.
   */
  async assessBreach(
    tables: readonly string[],
    options: { discoveredAt?: Date } = {},
  ): Promise<BreachImpact> {
    const wanted = [...new Set(tables)];
    if (wanted.length === 0) throw new StonekeepError('CONFIG', 'name at least one affected table');
    return this.withClient('breach assessment', exportTypes, async (client) => {
      const catalog = await this.catalog(client);
      const unknown = wanted.filter((t) => !catalog.tables.has(t));
      if (unknown.length > 0) {
        throw new StonekeepError(
          'CONFIG',
          `Unknown table(s) in schema "${catalog.schema}": ${unknown.join(', ')}`,
        );
      }
      const scopes = buildScopes(catalog, this.config, { stopAtRetained: false });
      const { byTable } = this.piiByTable(catalog);
      const subject = this.config.subject;
      const memo = new Map<string, string>();
      return this.transaction(
        client,
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
        async () => {
          const impacts: BreachTableImpact[] = [];
          const linkedSql: string[] = [];
          for (const table of wanted.sort()) {
            const rows = await client.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM ${qt(catalog.schema, table)}`,
            );
            const linked = table === subject.table || (scopes.get(table)?.via.length ?? 0) > 0;
            let subjects: number | null = null;
            if (linked) {
              const sql = subjectRowsSql(catalog, scopes, subject, table, memo);
              linkedSql.push(`SELECT ${q(SUBJECT_ALIAS)} AS s FROM (${sql}) x${linkedSql.length}`);
              const r = await client.query<{ n: number }>(
                `SELECT count(DISTINCT ${q(SUBJECT_ALIAS)})::int AS n FROM (${sql}) x`,
              );
              subjects = r.rows[0]?.n ?? 0;
            }
            impacts.push({
              table,
              rows: rows.rows[0]?.n ?? 0,
              linked,
              subjects,
              columns: (byTable.get(table) ?? []).map((c) => ({
                column: c.column,
                category: c.category,
              })),
            });
            this.log({
              type: 'step',
              operation: 'breach',
              table,
              action: 'count',
              rows: rows.rows[0]?.n ?? 0,
              dryRun: true,
            });
          }
          let linkedSubjects = 0;
          if (linkedSql.length > 0) {
            const r = await client.query<{ n: number }>(
              `SELECT count(DISTINCT s)::int AS n FROM (${linkedSql.join(' UNION ')}) u`,
            );
            linkedSubjects = r.rows[0]?.n ?? 0;
          }
          return summarizeBreach({
            subjectTable: subject.table,
            tables: impacts,
            linkedSubjects,
            discoveredAt: options.discoveredAt ?? new Date(),
          });
        },
      );
    });
  }

  // ------------------------------------------------------------------ export

  async export(subject: string, options: ExportOptions = {}): Promise<ExportResult> {
    const dryRun = options.dryRun ?? false;
    if (!dryRun && options.outFile === undefined) {
      throw new StonekeepError('CONFIG', 'export requires an output file (or dryRun: true)');
    }
    const tables = await this.withClient('export', exportTypes, async (client) => {
      const catalog = await this.catalog(client);
      const scopes = [
        ...buildScopes(catalog, this.config, { stopAtRetained: false }).values(),
      ].sort((a, b) => a.depth - b.depth || (a.table < b.table ? -1 : 1));
      return this.transaction(
        client,
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
        async () => {
          const out: ExportTable[] = [];
          for (const scope of scopes) {
            const info = catalog.tables.get(scope.table);
            if (!info) continue;
            const from = `${qt(catalog.schema, scope.table)} WHERE ${scope.predicate}`;
            if (dryRun) {
              const r = await client.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM ${from}`,
                [subject],
              );
              out.push({
                table: scope.table,
                columns: [],
                rows: new Array<Record<string, unknown>>(Number(r.rows[0]?.n ?? 0)),
              });
            } else {
              const order = info.primaryKey.length > 0 ? ` ORDER BY ${qList(info.primaryKey)}` : '';
              const rows: Record<string, unknown>[] = [];
              await client.query(
                `DECLARE stonekeep_export NO SCROLL CURSOR FOR SELECT * FROM ${from}${order}`,
                [subject],
              );
              for (;;) {
                const batch = await client.query<Record<string, unknown>>(
                  `FETCH ${EXPORT_FETCH} FROM stonekeep_export`,
                );
                rows.push(...batch.rows);
                if (batch.rows.length < EXPORT_FETCH) break;
              }
              await client.query('CLOSE stonekeep_export');
              out.push({ table: scope.table, columns: info.columns.map((c) => c.name), rows });
            }
            this.log({
              type: 'step',
              operation: 'export',
              table: scope.table,
              action: 'export',
              rows: out[out.length - 1]?.rows.length ?? 0,
              dryRun,
            });
          }
          return out;
        },
      );
    });

    const report = tables.map((t) => ({ table: t.table, rows: t.rows.length }));
    const result: ExportResult = {
      operation: 'export',
      dryRun,
      tables: report,
      totalRows: report.reduce((n, t) => n + t.rows, 0),
    };
    if (dryRun || options.outFile === undefined) return result;

    const { zip } = buildExportZip(tables, options.now ?? new Date());
    const file = resolve(options.outFile);
    writeFileAtomic(file, zip);
    return { ...result, file, sha256: sha256Hex(zip), bytes: zip.byteLength };
  }

  // ------------------------------------------------------------------ delete

  /** Build the ordered statement plan for delete/anonymize. Pure: reads only the catalog. */
  private plan(
    catalog: Catalog,
    mode: DeleteMode,
    subject: string,
  ): { steps: PlannedStep[]; skipped: SkippedColumn[] } {
    const { schema } = catalog;
    const scopes = buildScopes(catalog, this.config, { stopAtRetained: true });
    const { byTable } = this.piiByTable(catalog);
    const retained = [...scopes.values()].filter((s) => this.config.tables[s.table]?.retain);
    const active = [...scopes.values()].filter((s) => !this.config.tables[s.table]?.retain);
    const activeNames = new Set(active.map((s) => s.table));
    const steps: PlannedStep[] = [];
    const skipped: SkippedColumn[] = [];
    const table = (name: string): TableInfo => {
      const t = catalog.tables.get(name);
      if (!t) throw new StonekeepError('CONFIG', `table "${name}" disappeared from the catalog`);
      return t;
    };

    // 1. Retained tables: detach from the subject (and anonymize listed columns) in one UPDATE.
    for (const scope of retained) {
      const retain = this.config.tables[scope.table]?.retain;
      if (!retain) continue;
      const info = table(scope.table);
      const links = catalog.foreignKeys.filter(
        (fk) => fk.table === scope.table && activeNames.has(fk.refTable),
      );
      const params: unknown[] = [subject];
      const sets: string[] = [];
      const linkConds: string[] = [];
      for (const fk of links) {
        const parent = scopes.get(fk.refTable);
        if (!parent) continue;
        const cond = fkPredicate(schema, fk, parent);
        linkConds.push(cond);
        for (const col of fk.columns) {
          const ref = retain.reference;
          const value = ref !== null && typeof ref === 'object' ? (ref[col] ?? null) : ref;
          const column = info.columns.find((c) => c.name === col);
          if (value === null && column && !column.nullable) {
            throw new StonekeepError(
              'CONFIG',
              `tables.${scope.table}.retain.reference: column "${scope.table}.${col}" is NOT NULL; ` +
                'set reference to an anonymous placeholder id instead of null',
            );
          }
          params.push(value);
          sets.push(`${q(col)} = CASE WHEN ${cond} THEN $${params.length} ELSE ${q(col)} END`);
        }
      }
      if (linkConds.length === 0) continue;
      const where = linkConds.join(' OR ');
      const anonymized: string[] = [];
      for (const col of retain.anonymize) {
        const column = info.columns.find((c) => c.name === col);
        const rule = byTable.get(scope.table)?.find((p) => p.column === col)?.rule ?? 'config';
        const expr = column ? anonymizeExpression(column, rule) : undefined;
        if (expr === undefined) {
          skipped.push({
            table: scope.table,
            column: col,
            reason: `type ${column?.udtName ?? 'unknown'} cannot be anonymized`,
          });
          continue;
        }
        sets.push(`${q(col)} = CASE WHEN ${where} THEN ${expr} ELSE ${q(col)} END`);
        anonymized.push(col);
      }
      steps.push({
        table: scope.table,
        action: 'retain',
        columns: [...new Set([...links.flatMap((fk) => fk.columns), ...anonymized])],
        reason: retain.reason,
        sql: `UPDATE ${qt(schema, scope.table)} SET ${sets.join(', ')} WHERE ${where}`,
        countSql: `SELECT count(*)::text AS n FROM ${qt(schema, scope.table)} WHERE ${where}`,
        params,
      });
    }

    if (mode === 'delete') {
      // 2. Detach rows outside the deletion set that reference rows being deleted
      //    (self-references, cross references). Only nullable FKs; otherwise the
      //    database's own rules apply (and a violation rolls everything back).
      const excluded = new Set(
        Object.entries(this.config.tables)
          .filter(([, t]) => t.exclude)
          .map(([n]) => n),
      );
      for (const fk of catalog.foreignKeys) {
        const parent = scopes.get(fk.refTable);
        if (!parent || !activeNames.has(fk.refTable) || excluded.has(fk.table)) continue;
        if (this.config.tables[fk.table]?.retain) continue;
        const usedForScope = scopes.get(fk.table)?.via.includes(fk) ?? false;
        if (usedForScope) continue;
        const child = table(fk.table);
        const nullable = fk.columns.every(
          (c) => child.columns.find((x) => x.name === c)?.nullable === true,
        );
        if (!nullable || fk.onDelete === 'c' || fk.onDelete === 'n') continue;
        const childScope = scopes.get(fk.table);
        const where = `${fkPredicate(schema, fk, parent)}${childScope && activeNames.has(fk.table) ? ` AND NOT (${childScope.predicate})` : ''}`;
        steps.push({
          table: fk.table,
          action: 'detach',
          columns: fk.columns,
          sql: `UPDATE ${qt(schema, fk.table)} SET ${fk.columns.map((c) => `${q(c)} = NULL`).join(', ')} WHERE ${where}`,
          countSql: `SELECT count(*)::text AS n FROM ${qt(schema, fk.table)} WHERE ${where}`,
          params: [subject],
        });
      }

      // 3. Delete children first, subject last.
      const order = childrenFirst(
        [...activeNames],
        catalog.foreignKeys,
        (t) => scopes.get(t)?.depth ?? 0,
      );
      for (const name of order) {
        const scope = scopes.get(name);
        if (!scope) continue;
        steps.push({
          table: name,
          action: 'delete',
          columns: [],
          sql: `DELETE FROM ${qt(schema, name)} WHERE ${scope.predicate}`,
          countSql: `SELECT count(*)::text AS n FROM ${qt(schema, name)} WHERE ${scope.predicate}`,
          params: [subject],
        });
      }
    } else {
      // 3'. Anonymize PII columns in place; keys stay so relations keep working.
      for (const scope of [...active].sort((a, b) => b.depth - a.depth)) {
        const info = table(scope.table);
        const sets: string[] = [];
        const columns: string[] = [];
        for (const p of byTable.get(scope.table) ?? []) {
          const column = info.columns.find((c) => c.name === p.column);
          if (!column) continue;
          const isPk = info.primaryKey.includes(column.name);
          const isFkChild = catalog.foreignKeys.some(
            (fk) => fk.table === info.name && fk.columns.includes(column.name),
          );
          const referencedBy = catalog.foreignKeys.filter(
            (fk) => fk.refTable === info.name && fk.refColumns.includes(column.name),
          );
          const reason = isPk
            ? 'primary key column'
            : isFkChild
              ? 'foreign key column (updated via its parent)'
              : referencedBy.some((fk) => fk.onUpdate !== 'c')
                ? 'referenced by a foreign key without ON UPDATE CASCADE'
                : column.generated
                  ? 'generated column'
                  : undefined;
          if (reason !== undefined) {
            skipped.push({ table: info.name, column: column.name, reason });
            continue;
          }
          const expr = anonymizeExpression(column, p.rule);
          if (expr === undefined) {
            skipped.push({
              table: info.name,
              column: column.name,
              reason: `type ${column.udtName} cannot be anonymized`,
            });
            continue;
          }
          sets.push(`${q(column.name)} = ${expr}`);
          columns.push(column.name);
        }
        if (sets.length === 0) continue;
        steps.push({
          table: scope.table,
          action: 'anonymize',
          columns,
          sql: `UPDATE ${qt(schema, scope.table)} SET ${sets.join(', ')} WHERE ${scope.predicate}`,
          countSql: `SELECT count(*)::text AS n FROM ${qt(schema, scope.table)} WHERE ${scope.predicate}`,
          params: [subject],
        });
      }
    }
    return { steps, skipped };
  }

  /**
   * Delete or anonymize everything that belongs to `subject`, honouring
   * retention rules. Dry run by default. Runs in a single transaction and is
   * idempotent: a second run affects 0 rows.
   */
  async delete(
    subject: string,
    mode: DeleteMode,
    options: OperationOptions = {},
  ): Promise<DeleteResult> {
    const dryRun = options.dryRun ?? true;
    return this.withClient(mode, rawTypes, async (client) => {
      const catalog = await this.catalog(client);
      const { steps, skipped } = this.plan(catalog, mode, subject);
      const begin = dryRun
        ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
        : 'BEGIN ISOLATION LEVEL READ COMMITTED';
      const reports = await this.transaction(client, begin, async () => {
        const out: StepReport[] = [];
        for (const step of steps) {
          let rows: number;
          try {
            if (dryRun) {
              const r = await client.query<{ n: string }>(step.countSql, [subject]);
              rows = Number(r.rows[0]?.n ?? 0);
            } else {
              rows = (await client.query(step.sql, step.params)).rowCount ?? 0;
            }
          } catch (error) {
            throw isDbError(error)
              ? sanitizeDbError(error, `${step.action} on "${step.table}"`)
              : error;
          }
          const report: StepReport = {
            table: step.table,
            action: step.action,
            rows,
            columns: step.columns,
          };
          if (step.reason !== undefined) report.reason = step.reason;
          out.push(report);
          this.log({
            type: 'step',
            operation: mode,
            table: step.table,
            action: step.action,
            rows,
            dryRun,
          });
        }
        return out;
      });
      return {
        operation: 'delete' as const,
        mode,
        dryRun,
        steps: reports,
        totalRows: reports.reduce((n, s) => n + s.rows, 0),
        skipped,
      };
    });
  }
}
