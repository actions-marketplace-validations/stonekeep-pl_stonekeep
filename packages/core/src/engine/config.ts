import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { StonekeepError, errorMessage } from '../errors.js';
import { formatZodError } from '../rules.js';

export const CONNECTOR_CONFIG_FILENAME = 'stonekeep.connector.yaml';

/** SQL identifiers accepted in config. They are always quoted when used in SQL. */
const ident = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*$/, 'must be a plain SQL identifier (letters, digits, _, $)');
const columnRef = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_$]*\.[A-Za-z_][A-Za-z0-9_$]*$/, 'must be "table.column"');
const envName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an environment variable name (UPPER_SNAKE_CASE)');
const literal = z.union([z.string(), z.number(), z.null()]);

export const MASK_STRATEGIES = [
  'email',
  'phone',
  'first-name',
  'last-name',
  'full-name',
  'username',
  'ip',
  'street',
  'city',
  'zip',
  'geo',
  'date',
  'number',
  'uuid',
  'token',
  'json-empty',
  'null',
  'keep',
] as const;
export type MaskStrategy = (typeof MASK_STRATEGIES)[number];

const foreignKeySchema = z
  .object({
    /** Column(s) in this table that reference the parent. */
    column: z.union([ident, z.array(ident).min(1)]),
    /** `parent_table.column` (for composite keys list them in the same order). */
    references: z.union([columnRef, z.array(columnRef).min(1)]),
  })
  .strict();

const retainSchema = z
  .object({
    /** Why the rows must be kept (shown in plans and reports). */
    reason: z.string().min(1),
    /**
     * Value written into the columns that link these rows to the subject:
     * `null` (default), a literal (e.g. the id of an "anonymous user" row),
     * or a per-column map.
     */
    reference: z.union([literal, z.record(ident, literal)]).default(null),
    /** Columns holding the subject's personal data that are anonymized in retained rows. */
    anonymize: z.array(ident).default([]),
  })
  .strict();

const tableSchema = z
  .object({
    /** Override/declare the primary key when the database has none. */
    primaryKey: z.array(ident).min(1).optional(),
    /** Relations not enforced by the database (soft references). */
    foreignKeys: z.array(foreignKeySchema).default([]),
    /** Legal retention: rows are kept and detached from the subject instead of deleted. */
    retain: retainSchema.optional(),
    /** Extra personal-data columns (in addition to the datamap and rules). */
    anonymize: z.array(ident).default([]),
    /** Stonekeep never reads or modifies this table for subject operations. */
    exclude: z.boolean().default(false),
  })
  .strict();

export const connectorConfigSchema = z
  .object({
    version: z.literal(1),
    connector: z.literal('postgres'),
    connection: z
      .object({
        /** Env var holding the connection URL. URLs are never stored in config. */
        urlEnv: envName.default('STONEKEEP_DATABASE_URL'),
        schema: ident.default('public'),
        statementTimeoutMs: z.number().int().positive().default(60_000),
        lockTimeoutMs: z.number().int().positive().default(10_000),
      })
      .strict()
      .default({}),
    subject: z.object({ table: ident, key: ident }).strict(),
    /** Datamap path, relative to this config file. */
    datamap: z.string().min(1).default('stonekeep-datamap.json'),
    /** Merge foreign keys discovered in the database catalog with configured ones. */
    useDatabaseForeignKeys: z.boolean().default(true),
    tables: z.record(ident, tableSchema).default({}),
    /**
     * External SaaS connectors (Stage 3). Each entry is validated by the
     * plugin named in `type` (see @stonekeep/connectors), not here.
     */
    saas: z
      .array(
        z
          .object({
            type: z.string().regex(/^[a-z][a-z0-9-]*$/, 'plugin type must be lowercase kebab-case'),
            name: z
              .string()
              .regex(/^[a-z][a-z0-9_-]*$/)
              .optional(),
          })
          .passthrough(),
      )
      .default([]),
    /** Consent ledger (Stage 4). When set, deletions record an erasure event. */
    consent: z
      .object({
        /** SQLite ledger path, relative to this config file. */
        ledger: z.string().min(1).default('stonekeep-consent.db'),
        /** Env var holding the ledger HMAC secret (>= 32 chars). */
        secretEnv: envName.default('STONEKEEP_LEDGER_SECRET'),
      })
      .strict()
      .optional(),
    mask: z
      .object({
        sourceUrlEnv: envName.default('STONEKEEP_SOURCE_DATABASE_URL'),
        targetUrlEnv: envName.default('STONEKEEP_TARGET_DATABASE_URL'),
        /** Env var with the HMAC secret that seeds deterministic fake data. */
        secretEnv: envName.default('STONEKEEP_MASK_SECRET'),
        batchSize: z.number().int().min(1).max(10_000).default(500),
        /** Explicit strategy per column; `keep` opts a column out of masking. */
        columns: z.record(columnRef, z.enum(MASK_STRATEGIES)).default({}),
        /** Tables that are not copied to the target at all. */
        skipTables: z.array(ident).default([]),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const subjectTable = cfg.tables[cfg.subject.table];
    if (subjectTable?.retain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tables', cfg.subject.table, 'retain'],
        message: 'the subject table itself cannot be retained',
      });
    }
    if (subjectTable?.exclude === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tables', cfg.subject.table, 'exclude'],
        message: 'the subject table cannot be excluded',
      });
    }
  });

export type ConnectorConfigInput = z.input<typeof connectorConfigSchema>;
export type ConnectorConfig = z.output<typeof connectorConfigSchema>;
export type TableConfig = z.output<typeof tableSchema>;
export type RetainConfig = z.output<typeof retainSchema>;

export interface LoadedConnectorConfig {
  config: ConnectorConfig;
  /** Absolute path of the YAML file (or undefined when parsed from a string). */
  file: string | undefined;
  /** Absolute datamap path resolved relative to the config file. */
  datamapPath: string;
  /** Absolute consent ledger path, when `consent` is configured. */
  ledgerPath: string | undefined;
}

export function parseConnectorConfig(yamlText: string, file?: string): LoadedConnectorConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new StonekeepError(
      'CONFIG',
      `Cannot parse ${file ?? 'connector config'}: ${errorMessage(error)}`,
    );
  }
  const parsed = connectorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StonekeepError(
      'CONFIG',
      `Invalid connector config${file !== undefined ? ` ${file}` : ''}:\n${formatZodError(parsed.error)}`,
    );
  }
  const base = file !== undefined ? dirname(file) : process.cwd();
  const rel = (p: string): string => (isAbsolute(p) ? p : resolve(base, p));
  const ledgerPath = parsed.data.consent ? rel(parsed.data.consent.ledger) : undefined;
  return { config: parsed.data, file, datamapPath: rel(parsed.data.datamap), ledgerPath };
}

export function loadConnectorConfig(path: string): LoadedConnectorConfig {
  const file = resolve(path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new StonekeepError(
      'CONFIG',
      `Cannot read connector config ${file}: ${errorMessage(error)}`,
    );
  }
  return parseConnectorConfig(text, file);
}

/** Normalized foreign key from config: `{ columns, refTable, refColumns }`. */
export function configForeignKeys(
  config: ConnectorConfig,
): { table: string; columns: string[]; refTable: string; refColumns: string[] }[] {
  const out: { table: string; columns: string[]; refTable: string; refColumns: string[] }[] = [];
  for (const [table, t] of Object.entries(config.tables)) {
    for (const fk of t.foreignKeys) {
      const columns = Array.isArray(fk.column) ? fk.column : [fk.column];
      const refs = Array.isArray(fk.references) ? fk.references : [fk.references];
      const refTables = new Set(refs.map((r) => r.split('.')[0] ?? ''));
      if (refTables.size !== 1 || refs.length !== columns.length) {
        throw new StonekeepError(
          'CONFIG',
          `tables.${table}.foreignKeys: "references" must name one parent table with one column per local column`,
        );
      }
      out.push({
        table,
        columns,
        refTable: [...refTables][0] ?? '',
        refColumns: refs.map((r) => r.split('.')[1] ?? ''),
      });
    }
  }
  return out;
}
