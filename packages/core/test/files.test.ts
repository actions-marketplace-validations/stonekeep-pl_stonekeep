import { describe, expect, it } from 'vitest';
import { globToRegExp, listFiles } from '../src/index.js';
import { fixturePath } from './helpers.js';

describe('globToRegExp', () => {
  it.each([
    ['legacy/**', 'legacy/a/b.sql', true],
    ['legacy/**', 'src/legacy/a.sql', false],
    ['*.sql', 'deep/dir/x.sql', true],
    ['seeds', 'db/seeds/x.sql', true],
    ['db/*.sql', 'db/a.sql', true],
    ['db/*.sql', 'db/sub/a.sql', false],
    ['**/test/**', 'a/test/b.ts', true],
  ])('%s vs %s -> %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe('listFiles', () => {
  it('returns sorted POSIX paths and honours excludes', () => {
    const files = listFiles(fixturePath('typeorm-openapi'), ['legacy/**']);
    expect(files).toContain('src/entities/Customer.entity.ts');
    expect(files.some((f) => f.startsWith('legacy/'))).toBe(false);
    expect([...files].sort()).toEqual(files);
  });
});
