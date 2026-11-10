import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CONNECTOR_YAML,
  findPii,
  loadFixture,
  loadSchema,
  sql,
  startHarness,
  type PgHarness,
} from '../../core/test/integration/harness.js';
import { EXIT_ERROR, EXIT_OK, main, type Io } from '../src/index.js';

let harness: PgHarness;
let prod: string;
let staging: string;
const tmp = mkdtempSync(join(tmpdir(), 'stonekeep-cli-engine-'));
const transcript: string[] = [];

async function run(argv: string[], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    cwd: tmp,
    env: {
      STONEKEEP_DATABASE_URL: prod,
      STONEKEEP_SOURCE_DATABASE_URL: prod,
      STONEKEEP_TARGET_DATABASE_URL: staging,
      STONEKEEP_MASK_SECRET: 'cli-test-mask-secret-0123456789',
      ...env,
    },
  };
  const code = await main([...argv, '--connector', CONNECTOR_YAML], io);
  transcript.push(stdout, stderr);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.stop();
  rmSync(tmp, { recursive: true, force: true });
  // Nothing the CLI printed in any test may contain personal data.
  expect(findPii(transcript)).toEqual([]);
});
beforeEach(async () => {
  prod = await harness.newDatabase();
  staging = await harness.newDatabase();
  await loadFixture(prod);
  await loadSchema(staging);
});

describe('stonekeep discover / export / delete / mask', () => {
  it('discover lists roles and PII columns', async () => {
    const { code, stdout } = await run(['discover']);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(/invoices\s+retained/);
    expect(stdout).toMatch(/users\s+subject\s+PII .*email:contact/);
  });

  it('delete is a dry run unless --apply is given', async () => {
    const dry = await run(['delete', '--subject-env', 'SUBJECT'], { SUBJECT: '1' });
    expect(dry.code).toBe(EXIT_OK);
    expect(dry.stdout).toContain('DRY RUN');
    expect(dry.stdout).toMatch(/retain\s+invoices\s+1 row .*\(Invoices must be kept/);
    expect(await sql(prod, 'SELECT id FROM users WHERE id = 1')).toHaveLength(1);

    const applied = await run(['delete', '--subject', '1', '--apply']);
    expect(applied.code).toBe(EXIT_OK);
    expect(applied.stdout).toMatch(/Done: \d+ rows affected in one transaction/);
    expect(await sql(prod, 'SELECT id FROM users WHERE id = 1')).toHaveLength(0);

    const again = await run(['delete', '--subject', '1', '--apply']);
    expect(again.stdout).toContain('Done: 0 rows affected');
  });

  it('delete --mode anonymize keeps the row', async () => {
    const { code } = await run(['delete', '--subject', '1', '--mode', 'anonymize', '--apply']);
    expect(code).toBe(EXIT_OK);
    expect(
      (await sql<{ email: string }>(prod, 'SELECT email FROM users WHERE id = 1'))[0]?.email,
    ).toMatch(/^anon_/);
  });

  it('export writes the ZIP and prints its hash', async () => {
    const { code, stdout } = await run(['export', '--subject', '1', '--out', 'alice.zip']);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(/Wrote alice\.zip \(\d+ bytes, sha256 [0-9a-f]{64}\)/);
    expect(existsSync(join(tmp, 'alice.zip'))).toBe(true);
  });

  it('mask plans by default and copies with --apply', async () => {
    const dry = await run(['mask']);
    expect(dry.stdout).toMatch(/users\s+3 rows\s+mask .*email=email/);
    expect(dry.stdout).toContain('DRY RUN');
    expect(await sql(staging, 'SELECT 1 FROM users')).toHaveLength(0);

    const applied = await run(['mask', '--apply']);
    expect(applied.code).toBe(EXIT_OK);
    const rows = await sql(staging, 'SELECT row_to_json(u)::text AS j FROM users u');
    expect(rows).toHaveLength(3);
    expect(findPii(rows)).toEqual([]);
  });

  it('reports configuration problems with exit code 2 and no secrets', async () => {
    const missing = await run(['delete', '--subject', '1'], { STONEKEEP_DATABASE_URL: '' });
    expect(missing.code).toBe(EXIT_ERROR);
    expect(missing.stderr).toContain('STONEKEEP_DATABASE_URL');

    const both = await run(['delete', '--subject', '1', '--subject-env', 'X']);
    expect(both.code).toBe(EXIT_ERROR);

    const sameDb = await run(['mask', '--apply'], { STONEKEEP_TARGET_DATABASE_URL: prod });
    expect(sameDb.code).toBe(EXIT_ERROR);
    expect(sameDb.stderr).toMatch(/same database/);
    expect(sameDb.stderr).not.toContain(prod);
  });
});

describe('stonekeep breach', () => {
  it('prints the impact and a Polish Art. 33 draft without data values', async () => {
    const { code, stdout } = await run([
      'breach',
      '--tables',
      'users,addresses',
      '--tables',
      'login_events',
      '--discovered',
      '2026-11-08T09:30:00Z',
      '--lang',
      'pl',
    ]);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain('# Naruszenie ochrony danych osobowych: ocena skutków');
    expect(stdout).toContain('2026-11-11 09:30 UTC');
    expect(stdout).toContain('Przybliżona liczba osób, których dane dotyczą:** 3');
    expect(stdout).toContain('Projekt zgłoszenia do Prezesa UODO');
  });

  it('writes JSON to a file and validates input', async () => {
    const out = join(tmp, 'breach.json');
    const res = await run(['breach', '--tables', 'orders', '--json', '-o', out]);
    expect(res.code).toBe(EXIT_OK);
    expect(res.stdout).toMatch(/Wrote .*breach\.json: \d+ records, 2 data subjects/);
    expect(existsSync(out)).toBe(true);

    expect((await run(['breach'])).stderr).toMatch(/Missing --tables/);
    expect((await run(['breach', '--tables', 'nope'])).stderr).toMatch(/Unknown table/);
    expect((await run(['breach', '--tables', 'users', '--discovered', 'yesterday'])).code).toBe(
      EXIT_ERROR,
    );
  });
});
