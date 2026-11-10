import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

export type FixtureName = 'prisma-app' | 'sql-migrations' | 'typeorm-openapi';

export function fixturePath(name: FixtureName): string {
  return join(FIXTURES, name);
}

const created: string[] = [];

/** Copy a fixture repo into a fresh temp dir so tests can mutate it. */
export function copyFixture(name: FixtureName): string {
  const dir = mkdtempSync(join(tmpdir(), `stonekeep-${name}-`));
  cpSync(fixturePath(name), dir, { recursive: true });
  created.push(dir);
  return dir;
}

export function cleanupFixtures(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
