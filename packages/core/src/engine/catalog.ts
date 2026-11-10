import type pg from 'pg';
import { StonekeepError } from '../errors.js';
import { configForeignKeys, type ConnectorConfig } from './config.js';

export interface ColumnInfo {
  name: string;
  /** information_schema data_type, e.g. `text`, `integer`, `ARRAY`, `USER-DEFINED`. */
  dataType: string;
  /** Underlying type name, e.g. `varchar`, `int4`, `inet`, `_text`. */
  udtName: string;
  nullable: boolean;
  maxLength: number | null;
  /** `ALWAYS` / `BY DEFAULT` for identity columns. */
  identity: 'ALWAYS' | 'BY DEFAULT' | null;
  generated: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
}

export interface ForeignKeyInfo {
  /** Constraint name (database) or a synthetic name (config). */
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  /** pg_constraint action codes: a=no action, r=restrict, c=cascade, n=set null, d=set default. */
  onDelete: string;
  onUpdate: string;
  source: 'database' | 'config';
}

export interface Catalog {
  schema: string;
  tables: Map<string, TableInfo>;
  foreignKeys: ForeignKeyInfo[];
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  character_maximum_length: number | string | null;
  identity_generation: string | null;
  is_generated: string;
}

interface ConstraintRow {
  conname: string;
  contype: string;
  table_name: string;
  ref_table: string | null;
  cols: string[] | string;
  ref_cols: string[] | string | null;
  confdeltype: string;
  confupdtype: string;
}

/** Parse a Postgres text array literal like `{a,"b c"}` (when not already parsed by the driver). */
function textArray(value: string[] | string | null): string[] {
  if (value === null) return [];
  if (Array.isArray(value)) return value;
  const inner = value.replace(/^\{|\}$/g, '');
  if (inner.length === 0) return [];
  return inner.split(',').map((s) => s.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1'));
}

/** Read tables, columns, primary keys and foreign keys of one schema. Never reads table data. */
export async function introspect(client: pg.Client, schema: string): Promise<Catalog> {
  const columns = await client.query<ColumnRow>(
    `SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable,
            c.character_maximum_length, c.identity_generation, c.is_generated
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`,
    [schema],
  );
  const constraints = await client.query<ConstraintRow>(
    `SELECT con.conname, con.contype, t.relname AS table_name, rt.relname AS ref_table,
            ARRAY(SELECT a.attname::text
                    FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                   ORDER BY k.ord)::text[] AS cols,
            ARRAY(SELECT a.attname::text
                    FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                   ORDER BY k.ord)::text[] AS ref_cols,
            con.confdeltype::text AS confdeltype, con.confupdtype::text AS confupdtype
       FROM pg_constraint con
       JOIN pg_class t ON t.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_class rt ON rt.oid = con.confrelid
       LEFT JOIN pg_namespace rn ON rn.oid = rt.relnamespace
      WHERE n.nspname = $1 AND con.contype IN ('p', 'f')
        AND (con.contype = 'p' OR rn.nspname = $1)
      ORDER BY con.conname`,
    [schema],
  );

  const tables = new Map<string, TableInfo>();
  for (const row of columns.rows) {
    let table = tables.get(row.table_name);
    if (!table) {
      table = { name: row.table_name, columns: [], primaryKey: [] };
      tables.set(row.table_name, table);
    }
    const identity = row.identity_generation;
    table.columns.push({
      name: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      nullable: row.is_nullable === 'YES',
      maxLength:
        row.character_maximum_length === null ? null : Number(row.character_maximum_length),
      identity: identity === 'ALWAYS' || identity === 'BY DEFAULT' ? identity : null,
      generated: row.is_generated === 'ALWAYS',
    });
  }

  const foreignKeys: ForeignKeyInfo[] = [];
  for (const row of constraints.rows) {
    const cols = textArray(row.cols);
    if (row.contype === 'p') {
      const table = tables.get(row.table_name);
      if (table) table.primaryKey = cols;
    } else if (row.ref_table !== null) {
      foreignKeys.push({
        name: row.conname,
        table: row.table_name,
        columns: cols,
        refTable: row.ref_table,
        refColumns: textArray(row.ref_cols),
        onDelete: row.confdeltype,
        onUpdate: row.confupdtype,
        source: 'database',
      });
    }
  }
  return { schema, tables, foreignKeys };
}

export function getColumn(table: TableInfo, name: string): ColumnInfo | undefined {
  return table.columns.find((c) => c.name === name);
}

/**
 * Apply connector config to a raw catalog: declared primary keys, config
 * foreign keys (merged with or replacing database ones). Validates that every
 * table/column named in config exists.
 */
export function applyConfig(raw: Catalog, config: ConnectorConfig): Catalog {
  const problems: string[] = [];
  const requireTable = (name: string, where: string): TableInfo | undefined => {
    const t = raw.tables.get(name);
    if (!t) problems.push(`${where}: table "${name}" not found in schema "${raw.schema}"`);
    return t;
  };
  const requireColumns = (
    t: TableInfo | undefined,
    cols: readonly string[],
    where: string,
  ): void => {
    if (!t) return;
    for (const c of cols) {
      if (!getColumn(t, c)) problems.push(`${where}: column "${t.name}.${c}" not found`);
    }
  };

  const tables = new Map<string, TableInfo>();
  for (const [name, t] of raw.tables)
    tables.set(name, { ...t, columns: [...t.columns], primaryKey: [...t.primaryKey] });

  const subject = requireTable(config.subject.table, 'subject.table');
  requireColumns(subject, [config.subject.key], 'subject.key');

  for (const [name, t] of Object.entries(config.tables)) {
    const info = requireTable(name, `tables.${name}`);
    if (!info) continue;
    if (t.primaryKey) {
      requireColumns(info, t.primaryKey, `tables.${name}.primaryKey`);
      const target = tables.get(name);
      if (target) target.primaryKey = [...t.primaryKey];
    }
    requireColumns(info, t.anonymize, `tables.${name}.anonymize`);
    if (t.retain) {
      requireColumns(info, t.retain.anonymize, `tables.${name}.retain.anonymize`);
      if (t.retain.reference !== null && typeof t.retain.reference === 'object') {
        requireColumns(info, Object.keys(t.retain.reference), `tables.${name}.retain.reference`);
      }
    }
  }

  const fromConfig: ForeignKeyInfo[] = configForeignKeys(config).map((fk, i) => {
    requireColumns(
      requireTable(fk.table, `tables.${fk.table}.foreignKeys`),
      fk.columns,
      `tables.${fk.table}.foreignKeys`,
    );
    requireColumns(
      requireTable(fk.refTable, `tables.${fk.table}.foreignKeys`),
      fk.refColumns,
      `tables.${fk.table}.foreignKeys`,
    );
    return {
      ...fk,
      name: `stonekeep_config_fk_${i + 1}`,
      onDelete: 'a',
      onUpdate: 'a',
      source: 'config' as const,
    };
  });

  for (const key of Object.keys(config.mask.columns)) {
    const [table = '', column = ''] = key.split('.');
    requireColumns(requireTable(table, `mask.columns.${key}`), [column], `mask.columns.${key}`);
  }

  if (problems.length > 0) {
    throw new StonekeepError(
      'CONFIG',
      `Connector config does not match the database:\n  - ${problems.join('\n  - ')}`,
    );
  }

  const dbKeys = config.useDatabaseForeignKeys ? raw.foreignKeys : [];
  const seen = new Set(dbKeys.map((fk) => `${fk.table}(${fk.columns.join(',')})->${fk.refTable}`));
  const merged = [
    ...dbKeys,
    ...fromConfig.filter((fk) => !seen.has(`${fk.table}(${fk.columns.join(',')})->${fk.refTable}`)),
  ];
  return { schema: raw.schema, tables, foreignKeys: merged };
}
