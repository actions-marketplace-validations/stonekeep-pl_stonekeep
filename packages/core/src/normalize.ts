import type { CoarseType } from './types.js';

/**
 * Normalize an identifier to lowercase snake_case so a single rule pattern
 * covers `phoneNumber`, `PhoneNumber`, `phone_number`, `PHONE-NUMBER`, ...
 * Diacritics are folded to ASCII (`imię` -> `imie`, `születési_dátum` ->
 * `szuletesi_datum`, `łódź` -> `lodz`) so Central European names match.
 */
export function normalizeName(name: string): string {
  return (
    name
      .replace(/[łŁ]/g, (c) => (c === 'ł' ? 'l' : 'L'))
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      // `HTTPServer` -> `HTTP_Server`. A lookahead, not `([A-Z]+)([A-Z][a-z])`: that pattern
      // backtracks quadratically on a long run of capitals.
      .replace(/([A-Z])(?=[A-Z][a-z])/g, '$1_')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((part) => part.length > 0)
      .join('_')
  );
}

/** Map a declared type from any supported source to a coarse type. */
export function coarseType(rawType: string | undefined): CoarseType {
  if (rawType === undefined) return 'unknown';
  // Drop `| null` and `| undefined` from a TypeScript union. Split on `|` instead of a regex with
  // `\s*` on both sides of it, which backtracks quadratically on a long run of spaces.
  const t = rawType
    .toLowerCase()
    .split('|')
    .map((part) => part.trim())
    .filter((part, i) => i === 0 || (part !== 'null' && part !== 'undefined'))
    .join(' | ');
  if (/^(bool|boolean)\b|^bit\b|tinyint\s*\(\s*1\s*\)/.test(t)) return 'boolean';
  if (/date|time|timestamp/.test(t)) return 'date';
  if (
    /^(int|integer|smallint|bigint|tinyint|mediumint|serial|bigserial|smallserial|numeric|decimal|float|double|real|number|money)\b/.test(
      t,
    )
  )
    return 'number';
  if (/^(json|jsonb|object)\b/.test(t)) return 'json';
  if (/blob|bytea|binary|bytes|buffer/.test(t)) return 'binary';
  if (/char|text|string|uuid|citext|enum|clob|inet|cidr/.test(t)) return 'string';
  return 'unknown';
}
