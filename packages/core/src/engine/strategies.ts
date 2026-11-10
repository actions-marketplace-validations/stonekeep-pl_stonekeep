import { createHmac } from 'node:crypto';
import { Faker, en } from '@faker-js/faker';
import { normalizeName } from '../normalize.js';
import type { ColumnInfo } from './catalog.js';
import { fitLength, valueKind } from './coltypes.js';
import type { MaskStrategy } from './config.js';

/**
 * Deterministic fake-data generator. The same (secret, strategy, input)
 * always yields the same output, so values that join across tables (e.g. an
 * email used as a foreign key) stay consistent after masking. Seeds are
 * HMAC-SHA256 digests, so outputs cannot be reversed without the secret.
 */
export class Masker {
  private readonly secret: string;
  private readonly faker = new Faker({ locale: [en] });

  constructor(secret: string) {
    this.secret = secret;
  }

  private digest(strategy: MaskStrategy, value: string): Buffer {
    return createHmac('sha256', this.secret)
      .update(strategy)
      .update('\u0000')
      .update(value)
      .digest();
  }

  private seed(digest: Buffer): void {
    this.faker.seed([
      digest.readUInt32BE(0),
      digest.readUInt32BE(4),
      digest.readUInt32BE(8),
      digest.readUInt32BE(12),
    ]);
  }

  /** Return the masked text representation of `value` (Postgres text format), or null. */
  mask(strategy: MaskStrategy, value: string | null, column: ColumnInfo): string | null {
    if (value === null || strategy === 'keep') return value;
    if (strategy === 'null') return null;
    const d = this.digest(strategy, value);
    const hex = d.toString('hex');
    this.seed(d);
    const f = this.faker;
    const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
    let out: string;
    switch (strategy) {
      case 'email':
        // example.com is reserved (RFC 2606); the hash suffix keeps unique columns unique.
        out = `${slug(f.person.firstName())}.${slug(f.person.lastName())}.${hex.slice(0, 10)}@example.com`;
        break;
      case 'phone':
        out = `+1555${String(d.readUInt32BE(16) % 10_000_000).padStart(7, '0')}`;
        break;
      case 'first-name':
        out = f.person.firstName();
        break;
      case 'last-name':
        out = f.person.lastName();
        break;
      case 'full-name':
        out = `${f.person.firstName()} ${f.person.lastName()}`;
        break;
      case 'username':
        out = `${slug(f.person.firstName())}_${hex.slice(0, 8)}`;
        break;
      case 'ip': {
        const suffix = /\/\d+$/.exec(value)?.[0] ?? '';
        out = value.includes(':')
          ? `fd00:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}::${hex.slice(12, 16)}${suffix ? '/128' : ''}`
          : `10.${d[0] ?? 0}.${d[1] ?? 0}.${d[2] ?? 1}${suffix ? '/32' : ''}`;
        break;
      }
      case 'street':
        out = f.location.streetAddress();
        break;
      case 'city':
        out = f.location.city();
        break;
      case 'zip':
        out = f.location.zipCode('#####');
        break;
      case 'geo':
        out = String(f.location.latitude({ precision: 4 }));
        break;
      case 'date': {
        const date = f.date.birthdate({
          mode: 'age',
          min: 18,
          max: 90,
          refDate: new Date('2025-01-01T00:00:00Z'),
        });
        out = date.toISOString().slice(0, 10);
        break;
      }
      case 'number': {
        // Same number of digits as the input, first digit non-zero.
        const digits = Math.max(1, value.replace(/\D/g, '').length);
        let s = String(1 + ((d[0] ?? 0) % 9));
        for (let i = 1; i < digits; i++) s += String((d[i % d.length] ?? 0) % 10);
        out = s;
        break;
      }
      case 'uuid':
        out = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        break;
      case 'json-empty':
        out = '{}';
        break;
      case 'token':
        out = `masked_${hex.slice(0, 24)}`;
        break;
    }
    return fitLength(out, column);
  }
}

/** Pick a type-safe default strategy from the column type and the rule that flagged it. */
export function defaultStrategy(column: ColumnInfo, rule: string): MaskStrategy {
  const name = normalizeName(column.name);
  switch (valueKind(column)) {
    case 'inet':
      return 'ip';
    case 'date':
      return 'date';
    case 'number':
      return 'number';
    case 'uuid':
      return 'uuid';
    case 'boolean':
      return 'keep';
    case 'json':
      return column.nullable ? 'null' : 'json-empty';
    case 'bytes':
    case 'other':
      return column.nullable ? 'null' : 'token';
    case 'text':
      break;
  }
  switch (rule) {
    case 'email':
      return 'email';
    case 'phone':
      return 'phone';
    case 'username':
      return 'username';
    case 'person-name':
      if (/(^|_)(first|given|fore)/.test(name)) return 'first-name';
      if (/(^|_)(last|family|sur|maiden)/.test(name)) return 'last-name';
      return 'full-name';
    case 'online-identifier':
      return /(^|_)ip(_|$)|addr/.test(name) ? 'ip' : 'token';
    case 'postal-address':
      if (/zip|post_?code|postal/.test(name)) return 'zip';
      if (/(^|_)(city|town)($|_)/.test(name)) return 'city';
      if (/lat|lon|lng|geo|coord|gps/.test(name)) return 'geo';
      return 'street';
    case 'date-of-birth':
      return 'date';
    default:
      return 'token';
  }
}
