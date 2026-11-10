import { describe, expect, it } from 'vitest';
import {
  Masker,
  childrenFirst,
  csvCell,
  defaultStrategy,
  parentsFirst,
  parseConnectorConfig,
  type ColumnInfo,
  type ForeignKeyInfo,
} from '../src/engine/index.js';

const col = (over: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name: 'email',
  dataType: 'text',
  udtName: 'text',
  nullable: true,
  maxLength: null,
  identity: null,
  generated: false,
  ...over,
});

const fk = (table: string, refTable: string): ForeignKeyInfo => ({
  name: `${table}_fk`,
  table,
  columns: ['x'],
  refTable,
  refColumns: ['id'],
  onDelete: 'a',
  onUpdate: 'a',
  source: 'database',
});

describe('connector config (zod-validated YAML)', () => {
  const minimal = 'version: 1\nconnector: postgres\nsubject: { table: users, key: id }\n';

  it('applies safe defaults', () => {
    const { config } = parseConnectorConfig(minimal);
    expect(config.connection).toMatchObject({ urlEnv: 'STONEKEEP_DATABASE_URL', schema: 'public' });
    expect(config.mask.secretEnv).toBe('STONEKEEP_MASK_SECRET');
  });

  it.each([
    ['unknown keys', `${minimal}typo: 1\n`],
    ['inline connection URLs', `${minimal}connection: { url: "postgres://u:p@h/db" }\n`],
    [
      'SQL injection in identifiers',
      'version: 1\nconnector: postgres\nsubject: { table: "users; drop table x", key: id }\n',
    ],
    ['retaining the subject table', `${minimal}tables: { users: { retain: { reason: x } } }\n`],
    [
      'bad FK references',
      `${minimal}tables: { a: { foreignKeys: [{ column: b, references: nope }] } }\n`,
    ],
    ['unknown mask strategies', `${minimal}mask: { columns: { users.email: scramble } }\n`],
  ])('rejects %s', (_, yaml) => {
    expect(() => parseConnectorConfig(yaml)).toThrow(/Invalid connector config/);
  });
});

describe('Masker', () => {
  const m = new Masker('unit-test-secret-0123456789');

  it('is deterministic per (secret, strategy, value)', () => {
    expect(m.mask('email', 'jane@corp.com', col())).toBe(m.mask('email', 'jane@corp.com', col()));
    expect(m.mask('email', 'jane@corp.com', col())).not.toBe(
      m.mask('email', 'john@corp.com', col()),
    );
    expect(new Masker('another-secret-0123456789').mask('email', 'jane@corp.com', col())).not.toBe(
      m.mask('email', 'jane@corp.com', col()),
    );
  });

  it('produces well-formed values of the right shape', () => {
    expect(m.mask('email', 'jane@corp.com', col())).toMatch(
      /^[a-z0-9]+\.[a-z0-9]+\.[0-9a-f]{10}@example\.com$/,
    );
    expect(m.mask('ip', '198.51.100.7', col())).toMatch(/^10\.\d+\.\d+\.\d+$/);
    expect(m.mask('ip', '2001:db8::1', col())).toMatch(/^fd00:/);
    expect(m.mask('date', '1990-05-04', col())).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.mask('number', '4155550199', col())).toMatch(/^[1-9]\d{9}$/);
    expect(m.mask('uuid', 'x', col())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('keeps NULLs, honours keep/null and column length limits', () => {
    expect(m.mask('email', null, col())).toBeNull();
    expect(m.mask('keep', 'x', col())).toBe('x');
    expect(m.mask('null', 'x', col())).toBeNull();
    expect(m.mask('token', 'x', col({ maxLength: 8 }))?.length).toBe(8);
  });

  it('chooses type-safe default strategies', () => {
    expect(defaultStrategy(col({ udtName: 'inet', name: 'whatever' }), 'token')).toBe('ip');
    expect(defaultStrategy(col({ udtName: 'int8', name: 'phone' }), 'phone')).toBe('number');
    expect(defaultStrategy(col({ name: 'first_name' }), 'person-name')).toBe('first-name');
    expect(defaultStrategy(col({ name: 'postal_code' }), 'postal-address')).toBe('zip');
    expect(defaultStrategy(col({ udtName: 'jsonb', nullable: false }), 'x')).toBe('json-empty');
  });
});

describe('table ordering', () => {
  const fks = [fk('orders', 'users'), fk('items', 'orders'), fk('users', 'users')];

  it('deletes children first and inserts parents first (ignoring self-references)', () => {
    expect(childrenFirst(['users', 'orders', 'items'], fks)).toEqual(['items', 'orders', 'users']);
    expect(parentsFirst(['items', 'users', 'orders'], fks)).toEqual(['users', 'orders', 'items']);
  });

  it('rejects multi-table cycles for inserts', () => {
    expect(() => parentsFirst(['a', 'b'], [fk('a', 'b'), fk('b', 'a')])).toThrow(/cycle/);
  });
});

describe('csvCell', () => {
  it.each([
    ['plain', 'plain'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['=1+1', "'=1+1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    [null, ''],
    [42, '42'],
    [{ a: 1 }, '"{""a"":1}"'],
  ])('%j -> %s', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });
});
