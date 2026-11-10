import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { check, createDataMap, loadConfig, readDataMap, scan, writeDataMap } from '../src/index.js';
import { cleanupFixtures, copyFixture, fixturePath } from './helpers.js';

afterAll(cleanupFixtures);

const PASSPORT_MIGRATION = 'ALTER TABLE users ADD COLUMN passport_number VARCHAR(20);\n';

describe('check', () => {
  it('passes when the code matches the committed datamap', () => {
    const config = loadConfig(fixturePath('sql-migrations'));
    const result = check(config, readDataMap(config.datamapPath));
    expect(result.ok).toBe(true);
    expect(result.unmapped).toEqual([]);
    expect(result.detected).toBeGreaterThan(0);
  });

  it('fails when an unmapped PII column (passport_number) is introduced', () => {
    const dir = copyFixture('sql-migrations');
    writeFileSync(join(dir, 'migrations', '011_add_passport.sql'), PASSPORT_MIGRATION);
    const config = loadConfig(dir);
    const result = check(config, readDataMap(config.datamapPath));
    expect(result.ok).toBe(false);
    expect(result.unmapped).toHaveLength(1);
    expect(result.unmapped[0]).toMatchObject({
      id: 'users.passport_number',
      category: 'government_id',
      location: { file: 'migrations/011_add_passport.sql', line: 1 },
    });
  });

  it('does not fail on a new non-PII column', () => {
    const dir = copyFixture('sql-migrations');
    writeFileSync(
      join(dir, 'migrations', '011_add_flag.sql'),
      'ALTER TABLE orders ADD COLUMN gift_wrap BOOLEAN;\n',
    );
    const config = loadConfig(dir);
    expect(check(config, readDataMap(config.datamapPath)).ok).toBe(true);
  });

  it('passes again once the datamap is regenerated with `scan`', () => {
    const dir = copyFixture('sql-migrations');
    writeFileSync(join(dir, 'migrations', '011_add_passport.sql'), PASSPORT_MIGRATION);
    const config = loadConfig(dir);
    writeDataMap(config.datamapPath, createDataMap(scan(config).fields));
    expect(check(config, readDataMap(config.datamapPath)).ok).toBe(true);
  });

  it('passes when the field is mapped through a config override', () => {
    const dir = copyFixture('sql-migrations');
    writeFileSync(join(dir, 'migrations', '011_add_passport.sql'), PASSPORT_MIGRATION);
    writeFileSync(
      join(dir, 'stonekeep.config.json'),
      JSON.stringify({ overrides: { 'users.passport_number': { category: 'government_id' } } }),
    );
    const config = loadConfig(dir);
    expect(check(config, readDataMap(config.datamapPath)).ok).toBe(true);
  });

  it('reports stale entries as warnings, and fails on them only in strict mode', () => {
    const dir = copyFixture('sql-migrations');
    writeFileSync(
      join(dir, 'migrations', '011_drop_phone.sql'),
      'ALTER TABLE users DROP COLUMN phone;\n',
    );
    const config = loadConfig(dir);
    const datamap = readDataMap(config.datamapPath);
    const lenient = check(config, datamap);
    expect(lenient.ok).toBe(true);
    expect(lenient.stale.map((f) => f.id)).toEqual(['users.phone']);
    expect(check(config, datamap, { strict: true }).ok).toBe(false);
  });

  it('reports a missing datamap as a configuration error', () => {
    const dir = copyFixture('sql-migrations');
    rmSync(join(dir, 'stonekeep-datamap.json'));
    expect(() => readDataMap(loadConfig(dir).datamapPath)).toThrow(/Datamap not found/);
  });

  it('rejects an invalid config', () => {
    const dir = copyFixture('sql-migrations');
    writeFileSync(
      join(dir, 'stonekeep.config.json'),
      JSON.stringify({ minConfidence: 2, typo: true }),
    );
    expect(() => loadConfig(dir)).toThrow(/Invalid config/);
  });
});
