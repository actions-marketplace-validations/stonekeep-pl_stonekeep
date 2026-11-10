import { classify } from '../classifier.js';
import type { FieldOverride } from '../config.js';
import { normalizeName } from '../normalize.js';
import type { RuleSet } from '../rules.js';
import type { DataMap } from '../types.js';
import type { Catalog } from './catalog.js';
import type { ConnectorConfig } from './config.js';

export interface PiiContext {
  /** Committed datamap from `stonekeep scan` (primary source). */
  datamap: DataMap | undefined;
  /** Rules used to re-classify live database columns as a safety net. */
  ruleSet: RuleSet;
  minConfidence: number;
  /** stonekeep.config.json overrides; `ignore: true` entries are honoured. */
  overrides: Record<string, FieldOverride>;
}

export interface PiiColumn {
  table: string;
  column: string;
  category: string;
  rule: string;
  /** Where the decision came from. */
  source: 'datamap' | 'rules' | 'config';
}

export interface PiiResolution {
  columns: PiiColumn[];
  /** Datamap ids (SQL/ORM sources) that matched no database column. Identifiers only. */
  unmatchedDatamap: string[];
}

const DB_SOURCES = new Set(['sql', 'prisma', 'typeorm']);

function entityMatchesTable(entity: string, table: string): boolean {
  const e = normalizeName(entity);
  const t = normalizeName(table);
  return e === t || `${e}s` === t || `${e}es` === t;
}

/**
 * Decide which database columns hold personal data, combining:
 *  1. the committed datamap (mapped to tables/columns by normalized name),
 *  2. live re-classification of the catalog with the same rules as `stonekeep scan`,
 *  3. explicit config (`tables.<t>.anonymize`, `retain.anonymize`, `mask.columns`).
 */
export function resolvePiiColumns(
  catalog: Catalog,
  config: ConnectorConfig,
  ctx: PiiContext,
  purpose: 'anonymize' | 'mask',
): PiiResolution {
  const found = new Map<string, PiiColumn>();
  const key = (t: string, c: string): string => `${t}.${c}`;
  const ignored = (t: string, c: string): boolean => ctx.overrides[key(t, c)]?.ignore === true;
  const add = (col: PiiColumn): void => {
    if (!found.has(key(col.table, col.column))) found.set(key(col.table, col.column), col);
  };

  const unmatched: string[] = [];
  for (const field of ctx.datamap?.fields ?? []) {
    if (!DB_SOURCES.has(field.source)) continue;
    let matched = false;
    for (const table of catalog.tables.values()) {
      if (!entityMatchesTable(field.entity, table.name)) continue;
      const column = table.columns.find(
        (c) => normalizeName(c.name) === normalizeName(field.field),
      );
      if (!column) continue;
      matched = true;
      if (!ignored(table.name, column.name)) {
        add({
          table: table.name,
          column: column.name,
          category: field.category,
          rule: field.rule,
          source: 'datamap',
        });
      }
    }
    if (!matched) unmatched.push(field.id);
  }

  for (const table of catalog.tables.values()) {
    for (const column of table.columns) {
      if (ignored(table.name, column.name)) continue;
      const c = classify({ names: [column.name], rawType: column.udtName }, ctx.ruleSet);
      if (c && c.confidence >= ctx.minConfidence) {
        add({
          table: table.name,
          column: column.name,
          category: c.category,
          rule: c.rule,
          source: 'rules',
        });
      }
    }
  }

  for (const [tableName, t] of Object.entries(config.tables)) {
    for (const column of [...t.anonymize, ...(t.retain?.anonymize ?? [])]) {
      add({ table: tableName, column, category: 'configured', rule: 'config', source: 'config' });
    }
  }
  for (const [ref, strategy] of Object.entries(config.mask.columns)) {
    const [table = '', column = ''] = ref.split('.');
    // `keep` only opts a column out of masking; delete/anonymize still treat it as PII.
    if (strategy === 'keep') {
      if (purpose === 'mask') found.delete(key(table, column));
    } else add({ table, column, category: 'configured', rule: 'config', source: 'config' });
  }

  const columns = [...found.values()].sort((a, b) =>
    key(a.table, a.column) < key(b.table, b.column) ? -1 : 1,
  );
  return { columns, unmatchedDatamap: unmatched.sort() };
}
