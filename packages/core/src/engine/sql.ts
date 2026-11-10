import pg from 'pg';
import { StonekeepError } from '../errors.js';

/** Quote an SQL identifier. Every identifier Stonekeep emits goes through this. */
export function q(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function qt(schema: string, table: string): string {
  return `${q(schema)}.${q(table)}`;
}

export function qList(columns: readonly string[]): string {
  return columns.map(q).join(', ');
}

/** `(a, b)` for composite keys, `a` for single columns. */
export function qTuple(columns: readonly string[]): string {
  return columns.length === 1 ? q(columns[0] ?? '') : `(${qList(columns)})`;
}

const RAW = (value: string): string => value;

/**
 * Type parsers that return Postgres' text representation for every type.
 * Used when copying data so values round-trip exactly (dates, numerics,
 * arrays, json, bytea, ranges ...) without JS conversion.
 */
export const rawTypes = { getTypeParser: (): ((value: string) => string) => RAW };

const EXPORT_PARSERS: Record<number, (value: string) => unknown> = {
  16: (v) => v === 't', // bool
  21: Number, // int2
  23: Number, // int4
  700: Number, // float4
  701: Number, // float8
  114: (v) => JSON.parse(v) as unknown, // json
  3802: (v) => JSON.parse(v) as unknown, // jsonb
};

/** Type parsers for exports: natural JSON types where lossless, text otherwise. */
export const exportTypes = {
  getTypeParser: (oid: number): ((value: string) => unknown) => EXPORT_PARSERS[oid] ?? RAW,
};

const CONDITION_NAMES: Record<string, string> = {
  '23503': 'foreign_key_violation',
  '23505': 'unique_violation',
  '23502': 'not_null_violation',
  '23514': 'check_violation',
  '22001': 'string_data_right_truncation',
  '22P02': 'invalid_text_representation',
  '22007': 'invalid_datetime_format',
  '40001': 'serialization_failure',
  '40P01': 'deadlock_detected',
  '55P03': 'lock_not_available',
  '57014': 'query_canceled',
  '42P01': 'undefined_table',
  '42703': 'undefined_column',
  '42501': 'insufficient_privilege',
  '25006': 'read_only_sql_transaction',
  '28P01': 'invalid_password',
  '3D000': 'invalid_catalog_name',
};

/**
 * Convert any database/driver error into a StonekeepError WITHOUT the
 * server message or detail — those can echo data values, e.g.
 * `Key (email)=(jane@example.com) already exists`. Only the SQLSTATE and
 * identifiers (table, column, constraint) are kept. The original error is
 * deliberately not attached as `cause`.
 */
export function sanitizeDbError(error: unknown, context: string): StonekeepError {
  if (error instanceof StonekeepError) return error;
  if (error instanceof pg.DatabaseError) {
    const code = error.code ?? 'unknown';
    const parts = [
      `Database error ${code}${CONDITION_NAMES[code] ? ` (${CONDITION_NAMES[code]})` : ''} during ${context}`,
    ];
    if (error.table) parts.push(`table "${error.table}"`);
    if (error.column) parts.push(`column "${error.column}"`);
    if (error.constraint) parts.push(`constraint "${error.constraint}"`);
    return new StonekeepError('DATABASE', parts.join(', '));
  }
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  return new StonekeepError(
    'DATABASE',
    `Database connection or driver error during ${context}${code ? ` (${code})` : ''}`,
  );
}
