import { StonekeepError } from '../errors.js';
import type { Catalog } from './catalog.js';
import type { Scope } from './graph.js';
import { q, qt } from './sql.js';

/** Column alias carrying the subject key; never returned to callers, only counted. */
export const SUBJECT_ALIAS = '__stonekeep_subject';

/**
 * SQL selecting every row of `table` together with the key of the data subject it
 * belongs to, by joining along the foreign keys `buildScopes` found (each scope's
 * `via` points at parents nearer the subject table, so the recursion terminates).
 * A row reachable through several paths appears once per path; callers count
 * DISTINCT subjects.
 */
export function subjectRowsSql(
  catalog: Catalog,
  scopes: ReadonlyMap<string, Scope>,
  subject: { table: string; key: string },
  table: string,
  memo: Map<string, string> = new Map(),
): string {
  const cached = memo.get(table);
  if (cached !== undefined) return cached;
  const { schema } = catalog;
  let sql: string;
  if (table === subject.table) {
    sql = `SELECT t.*, t.${q(subject.key)}::text AS ${q(SUBJECT_ALIAS)} FROM ${qt(schema, table)} t`;
  } else {
    const scope = scopes.get(table);
    if (!scope || scope.via.length === 0) {
      throw new StonekeepError('CONFIG', `table "${table}" is not linked to the subject table`);
    }
    sql = scope.via
      .map((fk) => {
        const parent = subjectRowsSql(catalog, scopes, subject, fk.refTable, memo);
        const on = fk.columns
          .map((c, i) => `c.${q(c)} = p.${q(fk.refColumns[i] ?? '')}`)
          .join(' AND ');
        return `SELECT c.*, p.${q(SUBJECT_ALIAS)} FROM ${qt(schema, table)} c JOIN (${parent}) p ON ${on}`;
      })
      .join(' UNION ALL ');
  }
  memo.set(table, sql);
  return sql;
}
