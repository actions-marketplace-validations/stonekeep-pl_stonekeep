import type { ColumnInfo } from './catalog.js';

export type ValueKind =
  'text' | 'number' | 'boolean' | 'date' | 'inet' | 'uuid' | 'json' | 'bytes' | 'other';

const KINDS: Record<string, ValueKind> = {
  text: 'text',
  varchar: 'text',
  bpchar: 'text',
  citext: 'text',
  name: 'text',
  int2: 'number',
  int4: 'number',
  int8: 'number',
  numeric: 'number',
  float4: 'number',
  float8: 'number',
  money: 'number',
  bool: 'boolean',
  date: 'date',
  timestamp: 'date',
  timestamptz: 'date',
  inet: 'inet',
  cidr: 'inet',
  uuid: 'uuid',
  json: 'json',
  jsonb: 'json',
  bytea: 'bytes',
};

export function valueKind(column: ColumnInfo): ValueKind {
  return KINDS[column.udtName] ?? 'other';
}

/** Truncate a generated value to the column's declared length. */
export function fitLength(value: string, column: ColumnInfo): string {
  return column.maxLength !== null && value.length > column.maxLength
    ? value.slice(0, column.maxLength)
    : value;
}
