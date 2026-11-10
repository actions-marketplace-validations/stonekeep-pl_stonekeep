import pg from 'pg';
import { StonekeepError } from '../errors.js';
import {
  applyConfig,
  introspect,
  type Catalog,
  type ColumnInfo,
  type TableInfo,
} from './catalog.js';
import type { ConnectorConfig, MaskStrategy } from './config.js';
import { parentsFirst } from './graph.js';
import { resolvePiiColumns, type PiiContext } from './pii.js';
import { q, qList, qt, rawTypes, sanitizeDbError } from './sql.js';
import { Masker, defaultStrategy } from './strategies.js';
import type { EngineLogger } from './types.js';

export const MIN_MASK_SECRET_LENGTH = 16;
const MAX_PARAMS = 60_000;

export interface MaskOptions {
  config: ConnectorConfig;
  /** Production (read-only access is sufficient). */
  sourceUrl: string;
  /** Staging. Its schema must already exist (run your migrations first). */
  targetUrl: string;
  /** HMAC secret seeding the fake data (>= 16 chars). Keep it out of staging. */
  secret: string;
  pii: PiiContext;
  /** Default `true`: plan and count only, write nothing. */
  dryRun?: boolean;
  /** Empty the target tables first. Without it a non-empty target is refused. */
  truncate?: boolean;
  logger?: EngineLogger;
}

export type MaskColumnSource = 'datamap' | 'rules' | 'config' | 'foreign-key';

export interface MaskColumnReport {
  column: string;
  strategy: MaskStrategy;
  source: MaskColumnSource;
}

export interface MaskTableReport {
  table: string;
  rows: number;
  masked: MaskColumnReport[];
}

export interface MaskResult {
  operation: 'mask';
  dryRun: boolean;
  tables: MaskTableReport[];
  totalRows: number;
  skippedTables: string[];
  unmatchedDatamap: string[];
}

interface Plan {
  order: string[];
  strategies: Map<string, { strategy: MaskStrategy; source: MaskColumnSource }>;
  unmatched: string[];
}

const key = (table: string, column: string): string => `${table}.${column}`;

/** Decide a strategy per PII column and propagate it along foreign keys. */
export function planMask(source: Catalog, config: ConnectorConfig, pii: PiiContext): Plan {
  const skip = new Set(config.mask.skipTables);
  const tables = [...source.tables.keys()].filter((t) => !skip.has(t)).sort();
  const copied = new Set(tables);
  const resolution = resolvePiiColumns(source, config, pii, 'mask');
  const strategies = new Map<string, { strategy: MaskStrategy; source: MaskColumnSource }>();
  const column = (t: string, c: string): ColumnInfo | undefined =>
    source.tables.get(t)?.columns.find((x) => x.name === c);

  for (const p of resolution.columns) {
    if (!copied.has(p.table)) continue;
    const col = column(p.table, p.column);
    if (!col || col.generated) continue;
    const explicit = config.mask.columns[key(p.table, p.column)];
    const strategy = explicit ?? defaultStrategy(col, p.rule);
    if (strategy !== 'keep')
      strategies.set(key(p.table, p.column), { strategy, source: explicit ? 'config' : p.source });
  }

  // Referential integrity: both ends of a foreign key must use the same
  // deterministic strategy, otherwise joins break (and PII could leak).
  const fks = source.foreignKeys.filter((fk) => copied.has(fk.table) && copied.has(fk.refTable));
  for (let changed = true, guard = 0; changed && guard < 100; guard++) {
    changed = false;
    for (const fk of fks) {
      fk.columns.forEach((childCol, i) => {
        const parentCol = fk.refColumns[i];
        if (parentCol === undefined) return;
        const childKey = key(fk.table, childCol);
        const parentKey = key(fk.refTable, parentCol);
        const parent = strategies.get(parentKey);
        const child = strategies.get(childKey);
        if (parent && child?.strategy !== parent.strategy) {
          strategies.set(childKey, { strategy: parent.strategy, source: 'foreign-key' });
          changed = true;
        } else if (child && !parent) {
          strategies.set(parentKey, { strategy: child.strategy, source: 'foreign-key' });
          changed = true;
        }
      });
    }
  }
  return { order: parentsFirst(tables, fks), strategies, unmatched: resolution.unmatchedDatamap };
}

async function connect(url: string, context: string): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: url,
    types: rawTypes,
    application_name: 'stonekeep-mask',
  });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw sanitizeDbError(error, context);
  }
  return client;
}

async function identity(client: pg.Client): Promise<string> {
  const r = await client.query<{ id: string }>(
    `SELECT current_database() || '|' || coalesce(inet_server_port()::text, '') || '|' || pg_postmaster_start_time()::text AS id`,
  );
  return r.rows[0]?.id ?? '';
}

function insertableColumns(table: TableInfo): ColumnInfo[] {
  return table.columns.filter((c) => !c.generated);
}

/**
 * Clone a source database into a target database, replacing personal data
 * with deterministic fake values. Dry run by default.
 */
export async function runMask(options: MaskOptions): Promise<MaskResult> {
  const { config } = options;
  const dryRun = options.dryRun ?? true;
  const log: EngineLogger = options.logger ?? (() => undefined);
  if (options.secret.length < MIN_MASK_SECRET_LENGTH) {
    throw new StonekeepError(
      'SAFETY',
      `The mask secret must be at least ${MIN_MASK_SECRET_LENGTH} characters`,
    );
  }
  if (options.sourceUrl === options.targetUrl) {
    throw new StonekeepError('SAFETY', 'Refusing to mask: source and target are the same database');
  }

  const source = await connect(options.sourceUrl, 'mask (connect source)');
  let target: pg.Client | undefined;
  try {
    target = await connect(options.targetUrl, 'mask (connect target)');
    if ((await identity(source)) === (await identity(target))) {
      throw new StonekeepError(
        'SAFETY',
        'Refusing to mask: source and target resolve to the same database',
      );
    }
    const schema = config.connection.schema;
    const sourceCatalog = applyConfig(await introspect(source, schema), config);
    const targetCatalog = await introspect(target, schema);
    const plan = planMask(sourceCatalog, config, options.pii);

    const problems: string[] = [];
    for (const name of plan.order) {
      const s = sourceCatalog.tables.get(name);
      const t = targetCatalog.tables.get(name);
      if (!s) continue;
      if (!t) {
        problems.push(`table "${name}" is missing in the target`);
        continue;
      }
      for (const c of insertableColumns(s)) {
        if (!t.columns.some((x) => x.name === c.name))
          problems.push(`column "${name}.${c.name}" is missing in the target`);
      }
    }
    if (problems.length > 0) {
      throw new StonekeepError(
        'CONFIG',
        `Target schema does not match the source (run migrations on the target first):\n  - ${problems.join('\n  - ')}`,
      );
    }

    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const counts = new Map<string, number>();
    for (const name of plan.order) {
      const r = await source.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${qt(schema, name)}`,
      );
      counts.set(name, Number(r.rows[0]?.n ?? 0));
    }

    const reports: MaskTableReport[] = plan.order.map((name) => ({
      table: name,
      rows: counts.get(name) ?? 0,
      masked: [...plan.strategies.entries()]
        .filter(([k]) => k.startsWith(`${name}.`))
        .map(([k, v]) => ({
          column: k.slice(name.length + 1),
          strategy: v.strategy,
          source: v.source,
        })),
    }));
    const result: MaskResult = {
      operation: 'mask',
      dryRun,
      tables: reports,
      totalRows: reports.reduce((n, t) => n + t.rows, 0),
      skippedTables: [...config.mask.skipTables].sort(),
      unmatchedDatamap: plan.unmatched,
    };

    if (dryRun) {
      await source.query('ROLLBACK');
      for (const t of reports)
        log({
          type: 'step',
          operation: 'mask',
          table: t.table,
          action: 'copy',
          rows: t.rows,
          dryRun,
        });
      return result;
    }

    await target.query('BEGIN');
    try {
      await target.query(`SET LOCAL statement_timeout = ${config.connection.statementTimeoutMs}`);
      await target.query(`SET LOCAL lock_timeout = ${config.connection.lockTimeoutMs}`);
      const nonEmpty: string[] = [];
      for (const name of plan.order) {
        const r = await target.query<{ e: string }>(
          `SELECT EXISTS (SELECT 1 FROM ${qt(schema, name)})::text AS e`,
        );
        if (r.rows[0]?.e === 'true') nonEmpty.push(name);
      }
      if (nonEmpty.length > 0) {
        if (options.truncate !== true) {
          throw new StonekeepError(
            'SAFETY',
            `Target tables are not empty (${nonEmpty.join(', ')}). Re-run with truncate to replace their contents.`,
          );
        }
        await target.query(
          `TRUNCATE ${plan.order.map((t) => qt(schema, t)).join(', ')} RESTART IDENTITY`,
        );
      }

      const masker = new Masker(options.secret);
      for (const name of plan.order) {
        const table = sourceCatalog.tables.get(name);
        if (!table) continue;
        const rows = await copyTable(
          source,
          target,
          schema,
          table,
          sourceCatalog,
          plan,
          masker,
          config.mask.batchSize,
        );
        log({ type: 'step', operation: 'mask', table: name, action: 'copy', rows, dryRun });
      }
      await resetSequences(target, schema, plan.order, sourceCatalog);
      await target.query('COMMIT');
      await source.query('COMMIT');
    } catch (error) {
      await target.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    return result;
  } catch (error) {
    await source.query('ROLLBACK').catch(() => undefined);
    throw sanitizeDbError(error, 'mask');
  } finally {
    await source.end().catch(() => undefined);
    await target?.end().catch(() => undefined);
  }
}

async function copyTable(
  source: pg.Client,
  target: pg.Client,
  schema: string,
  table: TableInfo,
  catalog: Catalog,
  plan: Plan,
  masker: Masker,
  batchSize: number,
): Promise<number> {
  const columns = insertableColumns(table);
  const names = columns.map((c) => c.name);
  // Self-references are inserted as NULL and restored afterwards (row order is arbitrary).
  const selfFks = catalog.foreignKeys.filter(
    (fk) => fk.table === table.name && fk.refTable === table.name,
  );
  const deferred = [...new Set(selfFks.flatMap((fk) => fk.columns))];
  if (deferred.length > 0) {
    const notNull = deferred.filter((c) => columns.find((x) => x.name === c)?.nullable !== true);
    if (notNull.length > 0 || table.primaryKey.length === 0) {
      throw new StonekeepError(
        'CONFIG',
        `Cannot copy self-referencing table "${table.name}": its self-referencing columns must be nullable and it needs a primary key`,
      );
    }
  }
  const strategyOf = (c: string): MaskStrategy | undefined =>
    plan.strategies.get(key(table.name, c))?.strategy;
  const overriding = columns.some((c) => c.identity === 'ALWAYS') ? ' OVERRIDING SYSTEM VALUE' : '';
  const perBatch = Math.max(
    1,
    Math.min(batchSize, Math.floor(MAX_PARAMS / Math.max(1, names.length))),
  );
  const order = table.primaryKey.length > 0 ? ` ORDER BY ${qList(table.primaryKey)}` : '';
  const pendingSelf: (string | null)[][] = [];
  let copied = 0;

  await source.query(
    `DECLARE stonekeep_mask NO SCROLL CURSOR FOR SELECT ${qList(names)} FROM ${qt(schema, table.name)}${order}`,
  );
  for (;;) {
    const batch = await source.query<Record<string, string | null>>(
      `FETCH ${perBatch} FROM stonekeep_mask`,
    );
    if (batch.rows.length === 0) break;
    const params: (string | null)[] = [];
    const tuples: string[] = [];
    for (const row of batch.rows) {
      const masked = columns.map((c) => {
        const strategy = strategyOf(c.name);
        const value = row[c.name] ?? null;
        return strategy === undefined ? value : masker.mask(strategy, value, c);
      });
      if (deferred.length > 0) {
        const refs = deferred.map((d) => masked[names.indexOf(d)] ?? null);
        if (refs.some((v) => v !== null)) {
          pendingSelf.push([
            ...table.primaryKey.map((pk) => masked[names.indexOf(pk)] ?? null),
            ...refs,
          ]);
        }
        for (const d of deferred) masked[names.indexOf(d)] = null;
      }
      const start = params.length;
      params.push(...masked);
      tuples.push(`(${masked.map((_, i) => `$${start + i + 1}`).join(', ')})`);
    }
    await target.query(
      `INSERT INTO ${qt(schema, table.name)} (${qList(names)})${overriding} VALUES ${tuples.join(', ')}`,
      params,
    );
    copied += batch.rows.length;
  }
  await source.query('CLOSE stonekeep_mask');

  if (pendingSelf.length > 0) {
    const pkCols = table.primaryKey.map((n) => columns.find((c) => c.name === n));
    const defCols = deferred.map((n) => columns.find((c) => c.name === n));
    const allCols = [...pkCols, ...defCols];
    const width = allCols.length;
    const chunk = Math.max(1, Math.floor(MAX_PARAMS / width));
    for (let i = 0; i < pendingSelf.length; i += chunk) {
      const slice = pendingSelf.slice(i, i + chunk);
      const params: (string | null)[] = [];
      const tuples = slice.map((r) => {
        const start = params.length;
        params.push(...r);
        return `(${r.map((_, j) => `$${start + j + 1}::${q(allCols[j]?.udtName ?? 'text')}`).join(', ')})`;
      });
      const alias = allCols.map((_, j) => `c${j}`);
      const sets = deferred.map((d, j) => `${q(d)} = v.c${table.primaryKey.length + j}`).join(', ');
      const join = table.primaryKey.map((pk, j) => `t.${q(pk)} = v.c${j}`).join(' AND ');
      await target.query(
        `UPDATE ${qt(schema, table.name)} AS t SET ${sets} FROM (VALUES ${tuples.join(', ')}) AS v(${alias.join(', ')}) WHERE ${join}`,
        params,
      );
    }
  }
  return copied;
}

async function resetSequences(
  target: pg.Client,
  schema: string,
  tables: readonly string[],
  catalog: Catalog,
): Promise<void> {
  for (const name of tables) {
    const table = catalog.tables.get(name);
    if (!table) continue;
    for (const column of table.columns) {
      const r = await target.query<{ seq: string | null }>(
        'SELECT pg_get_serial_sequence($1, $2) AS seq',
        [qt(schema, name), column.name],
      );
      const seq = r.rows[0]?.seq ?? null;
      if (seq === null) continue;
      await target.query(
        `SELECT setval($1::regclass, COALESCE((SELECT max(${q(column.name)}) FROM ${qt(schema, name)}), 0) + 1, false)`,
        [seq],
      );
    }
  }
}
