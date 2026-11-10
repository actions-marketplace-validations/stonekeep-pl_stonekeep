import type { ColumnInfo } from './catalog.js';
import { valueKind } from './coltypes.js';

const RANDOM_HEX = `replace(gen_random_uuid()::text, '-', '')`;

function limit(expr: string, column: ColumnInfo): string {
  return column.maxLength === null ? expr : `left(${expr}, ${column.maxLength})`;
}

/**
 * SQL expression that irreversibly replaces a personal-data value in place.
 * Nullable columns become NULL. Otherwise a random (non-deterministic)
 * placeholder of the right type is used, so unique constraints still hold.
 * Returns `undefined` when the type cannot be anonymized safely.
 */
export function anonymizeExpression(column: ColumnInfo, rule: string): string | undefined {
  if (column.nullable) return 'NULL';
  switch (valueKind(column)) {
    case 'text':
      return rule === 'email'
        ? limit(`'anon_' || ${RANDOM_HEX} || '@anonymized.invalid'`, column)
        : limit(`'anon_' || ${RANDOM_HEX}`, column);
    case 'number':
      return '0';
    case 'boolean':
      return 'false';
    case 'date':
      return `'1900-01-01'`;
    case 'inet':
      return `'0.0.0.0'`;
    case 'uuid':
      return 'gen_random_uuid()';
    case 'json':
      return `'{}'`;
    case 'bytes':
      return `''::bytea`;
    case 'other':
      return undefined;
  }
}
