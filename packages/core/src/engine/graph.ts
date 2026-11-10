import { StonekeepError } from '../errors.js';
import type { Catalog, ForeignKeyInfo } from './catalog.js';
import type { ConnectorConfig } from './config.js';
import { q, qList, qTuple, qt } from './sql.js';

const MAX_DEPTH = 16;

export interface Scope {
  table: string;
  /** SQL boolean expression selecting the subject's rows. Uses `$1` for the subject key. */
  predicate: string;
  /** Foreign keys (this table -> an in-scope parent) that put this table in scope. */
  via: ForeignKeyInfo[];
  depth: number;
}

export interface ScopeOptions {
  /** Do not expand through retained tables (their rows are kept, so their children are too). */
  stopAtRetained: boolean;
}

/**
 * Find every table that holds rows belonging to the subject by walking
 * foreign keys outward from the subject table, and build a predicate per table.
 */
export function buildScopes(
  catalog: Catalog,
  config: ConnectorConfig,
  options: ScopeOptions,
): Map<string, Scope> {
  const { schema } = catalog;
  const excluded = new Set(
    Object.entries(config.tables)
      .filter(([, t]) => t.exclude)
      .map(([n]) => n),
  );
  const retained = new Set(
    Object.entries(config.tables)
      .filter(([, t]) => t.retain)
      .map(([n]) => n),
  );
  const scopes = new Map<string, Scope>();
  scopes.set(config.subject.table, {
    table: config.subject.table,
    predicate: `${q(config.subject.key)} = $1`,
    via: [],
    depth: 0,
  });

  let frontier = new Set([config.subject.table]);
  for (let depth = 1; frontier.size > 0 && depth <= MAX_DEPTH; depth++) {
    const expandable = (parent: string): boolean =>
      scopes.has(parent) && !(options.stopAtRetained && retained.has(parent));
    const candidates = new Set<string>();
    for (const fk of catalog.foreignKeys) {
      if (
        frontier.has(fk.refTable) &&
        expandable(fk.refTable) &&
        !scopes.has(fk.table) &&
        !excluded.has(fk.table)
      ) {
        candidates.add(fk.table);
      }
    }
    for (const table of candidates) {
      const via = catalog.foreignKeys.filter(
        (fk) => fk.table === table && fk.refTable !== table && expandable(fk.refTable),
      );
      const alternatives = via.map((fk) => {
        const parent = scopes.get(fk.refTable);
        return `${qTuple(fk.columns)} IN (SELECT ${qList(fk.refColumns)} FROM ${qt(schema, fk.refTable)} WHERE ${parent?.predicate ?? 'false'})`;
      });
      scopes.set(table, {
        table,
        predicate:
          alternatives.length === 1
            ? (alternatives[0] ?? 'false')
            : `(${alternatives.join(' OR ')})`,
        via,
        depth,
      });
    }
    frontier = candidates;
  }
  return scopes;
}

/**
 * Order tables so that every table comes before the tables it references
 * (children first). Self-references are ignored. Tables in a cycle are
 * appended deepest-first.
 */
export function childrenFirst(
  tables: readonly string[],
  foreignKeys: readonly ForeignKeyInfo[],
  depthOf: (t: string) => number = () => 0,
): string[] {
  const set = new Set(tables);
  const edges = foreignKeys.filter(
    (fk) => set.has(fk.table) && set.has(fk.refTable) && fk.table !== fk.refTable,
  );
  const remaining = new Set(tables);
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((t) => !edges.some((fk) => fk.refTable === t && remaining.has(fk.table)))
      .sort((a, b) => depthOf(b) - depthOf(a) || (a < b ? -1 : a > b ? 1 : 0));
    const next = ready.length > 0 ? ready : [...remaining].sort((a, b) => depthOf(b) - depthOf(a));
    const pick = next[0];
    if (pick === undefined) break;
    order.push(pick);
    remaining.delete(pick);
  }
  return order;
}

/** Order tables so parents come before children (for inserts). Throws on non-self cycles. */
export function parentsFirst(
  tables: readonly string[],
  foreignKeys: readonly ForeignKeyInfo[],
): string[] {
  const set = new Set(tables);
  const edges = foreignKeys.filter(
    (fk) => set.has(fk.table) && set.has(fk.refTable) && fk.table !== fk.refTable,
  );
  const remaining = new Set(tables);
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((t) => !edges.some((fk) => fk.table === t && remaining.has(fk.refTable)))
      .sort();
    if (ready.length === 0) {
      throw new StonekeepError(
        'CONFIG',
        `Foreign keys form a cycle between tables: ${[...remaining].sort().join(', ')}. ` +
          'Only self-referencing tables are supported for masking.',
      );
    }
    for (const t of ready) {
      order.push(t);
      remaining.delete(t);
    }
  }
  return order;
}
