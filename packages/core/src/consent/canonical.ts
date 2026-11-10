import { createHash, createHmac } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Canonical JSON (RFC 8785 style for the value space we use): object keys
 * sorted by UTF-16 code units, no insignificant whitespace, `undefined`
 * properties dropped. Non-finite numbers are rejected.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hmacHex(key: string | Buffer, text: string): string {
  return createHmac('sha256', key).update(text, 'utf8').digest('hex');
}
