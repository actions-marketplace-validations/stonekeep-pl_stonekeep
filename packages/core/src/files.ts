import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compareStrings } from './text.js';

/** Directories that never contain first-party schema definitions. */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  // CI configuration (workflows are YAML, not data schemas).
  '.github',
  '.gitlab',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'vendor',
  '.venv',
  'venv',
  'target',
];

/**
 * Convert a gitignore-style glob to a RegExp over POSIX relative paths.
 * `**` spans directories, `*` and `?` stay within a segment. A pattern without
 * a `/` matches at any depth.
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const anchored = pattern.startsWith('/') || pattern.replace(/\/$/, '').includes('/');
  pattern = pattern.replace(/^\//, '').replace(/\/$/, '');
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern.charAt(i);
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`);
}

/** Recursively list files under `root` as sorted POSIX relative paths. Symlinks are not followed. */
export function listFiles(root: string, exclude: readonly string[] = []): string[] {
  const excluded = exclude.map(globToRegExp);
  const skipDirs = new Set(DEFAULT_EXCLUDED_DIRS);
  const isExcluded = (rel: string): boolean => excluded.some((re) => re.test(rel));
  const out: string[] = [];

  const walk = (dirAbs: string, dirRel: string): void => {
    const entries = readdirSync(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || isExcluded(rel)) continue;
        walk(join(dirAbs, entry.name), rel);
      } else if (entry.isFile() && !isExcluded(rel)) {
        out.push(rel);
      }
    }
  };
  walk(root, '');
  return out.sort(compareStrings);
}
