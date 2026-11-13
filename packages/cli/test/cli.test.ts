import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EXIT_ERROR, EXIT_OK, EXIT_UNMAPPED, main, type Io } from '../src/index.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const BIN = fileURLToPath(new URL('../bin/stonekeep.js', import.meta.url));
const DIST = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function copyFixture(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `stonekeep-cli-${name}-`));
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  temps.push(dir);
  return dir;
}

async function run(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? {},
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

describe('stonekeep scan', () => {
  it('writes stonekeep-datamap.json with field, location, category and confidence', async () => {
    const dir = copyFixture('prisma-app');
    const { code, stdout } = await run(['scan', dir]);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain('User.email');
    expect(stdout).toMatch(/does not guarantee legal compliance/);
    const map = JSON.parse(readFileSync(join(dir, 'stonekeep-datamap.json'), 'utf8')) as {
      fields: {
        id: string;
        category: string;
        confidence: number;
        location: { file: string; line: number };
      }[];
    };
    const phone = map.fields.find((f) => f.id === 'User.phoneNumber');
    expect(phone).toMatchObject({
      category: 'contact',
      location: { file: 'prisma/schema.prisma' },
    });
    expect(phone?.confidence).toBeGreaterThan(0.5);
  });

  it('--dry-run writes nothing', async () => {
    const dir = copyFixture('prisma-app');
    const { code, stdout } = await run(['scan', dir, '--dry-run']);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain('Dry run');
    expect(existsSync(join(dir, 'stonekeep-datamap.json'))).toBe(false);
  });

  it('--json prints machine-readable output and resolves paths against cwd', async () => {
    const dir = copyFixture('prisma-app');
    const { code, stdout } = await run(['scan', '.', '--json', '--out', 'out/map.json'], {
      cwd: dir,
    });
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(stdout) as { fields: unknown[] };
    expect(parsed.fields.length).toBeGreaterThan(5);
    expect(existsSync(join(dir, 'out', 'map.json'))).toBe(true);
  });
});

describe('stonekeep check', () => {
  it('exits 0 when everything is mapped', async () => {
    const { code, stdout } = await run(['check', join(FIXTURES, 'sql-migrations')]);
    expect(code).toBe(EXIT_OK);
    expect(stdout).toMatch(/^OK/m);
  });

  it('exits 1 and names the field when unmapped PII (passport_number) is introduced', async () => {
    const dir = copyFixture('sql-migrations');
    writeFileSync(
      join(dir, 'migrations', '011_add_passport.sql'),
      'ALTER TABLE users ADD COLUMN passport_number VARCHAR(20);\n',
    );
    const { code, stdout } = await run(['check', dir]);
    expect(code).toBe(EXIT_UNMAPPED);
    expect(stdout).toContain('FAIL');
    expect(stdout).toContain('users.passport_number');
    expect(stdout).toContain('government_id');
    expect(stdout).toContain('migrations/011_add_passport.sql:1');
  });

  it('emits GitHub annotations on GitHub Actions', async () => {
    const dir = copyFixture('sql-migrations');
    writeFileSync(
      join(dir, 'migrations', '011_add_passport.sql'),
      'ALTER TABLE users ADD passport_number TEXT;\n',
    );
    const { code, stdout } = await run(['check', dir], { env: { GITHUB_ACTIONS: 'true' } });
    expect(code).toBe(EXIT_UNMAPPED);
    expect(stdout).toContain(
      '::error file=migrations/011_add_passport.sql,line=1,title=Stonekeep::',
    );
  });

  it('--format json reports unmapped fields', async () => {
    const dir = copyFixture('sql-migrations');
    writeFileSync(
      join(dir, 'migrations', '011_add_passport.sql'),
      'ALTER TABLE users ADD passport_number TEXT;\n',
    );
    const { code, stdout } = await run(['check', dir, '--format', 'json']);
    expect(code).toBe(EXIT_UNMAPPED);
    const parsed = JSON.parse(stdout) as { ok: boolean; unmapped: { id: string }[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.unmapped.map((f) => f.id)).toEqual(['users.passport_number']);
  });

  it('exits 2 when the datamap is missing', async () => {
    const dir = copyFixture('prisma-app');
    const { code, stderr } = await run(['check', dir]);
    expect(code).toBe(EXIT_ERROR);
    expect(stderr).toMatch(/Datamap not found/);
  });

  it('exits 2 on bad usage', async () => {
    expect((await run([])).code).toBe(EXIT_ERROR);
    expect((await run(['frobnicate'])).code).toBe(EXIT_ERROR);
    expect((await run(['check', '--nope'])).code).toBe(EXIT_ERROR);
    expect((await run(['check', '.', '--format', 'xml'])).code).toBe(EXIT_ERROR);
    expect((await run(['--help'])).code).toBe(EXIT_OK);
  });
});

describe.skipIf(!existsSync(DIST))('built binary (after `pnpm build`)', () => {
  it('returns exit code 1 from a real process for unmapped PII', () => {
    const dir = copyFixture('sql-migrations');
    writeFileSync(
      join(dir, 'migrations', '011_add_passport.sql'),
      'ALTER TABLE users ADD passport_number TEXT;\n',
    );
    const ok = spawnSync(process.execPath, [BIN, 'check', join(FIXTURES, 'sql-migrations')], {
      encoding: 'utf8',
    });
    expect(ok.status).toBe(0);
    const fail = spawnSync(process.execPath, [BIN, 'check', dir], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '' },
    });
    expect(fail.status).toBe(1);
    expect(fail.stdout).toContain('users.passport_number');
  });
});

describe('stonekeep ropa', () => {
  it('writes a starter file, then renders the Art. 30 record', async () => {
    const dir = copyFixture('prisma-app');
    expect((await run(['scan', dir])).code).toBe(EXIT_OK);

    const init = await run(['ropa', dir, '--init', '--lang', 'pl']);
    expect(init.code).toBe(EXIT_OK);
    const ropaFile = join(dir, 'stonekeep.ropa.yaml');
    const template = readFileSync(ropaFile, 'utf8');
    expect(template).toContain('- "Profile"');
    expect(template).toContain('- "User"');
    expect((await run(['ropa', dir, '--init'])).code).toBe(EXIT_ERROR);

    const md = await run(['ropa', dir, '--date', '2026-11-08']);
    expect(md.code).toBe(EXIT_OK);
    expect(md.stdout).toContain('# Rejestr czynności przetwarzania');
    expect(md.stdout).toContain('`User.email`');

    const en = await run(['ropa', dir, '--lang', 'en', '--format', 'json']);
    const json = JSON.parse(en.stdout) as { language: string; uncoveredEntities: string[] };
    expect(json.language).toBe('en');
    expect(json.uncoveredEntities).toEqual([]);
  });

  it('exits 1 with --strict when PII entities are not covered', async () => {
    const dir = copyFixture('prisma-app');
    await run(['scan', dir]);
    writeFileSync(
      join(dir, 'stonekeep.ropa.yaml'),
      [
        'version: 1',
        'controller: { name: Example, contact: dpo@example.com }',
        'securityMeasures: [Encryption at rest]',
        'activities:',
        '  - id: accounts',
        '    name: Customer accounts',
        '    purposes: [Provide the service]',
        '    legalBasis: [contract]',
        '    dataSubjects: [Customers]',
        '    entities: [User]',
        '    retention: Until account deletion',
        '',
      ].join('\n'),
    );
    const out = join(dir, 'ropa.md');
    const res = await run(['ropa', dir, '--strict', '-o', out]);
    expect(res.code).toBe(EXIT_UNMAPPED);
    expect(res.stderr).toContain('Entity "Profile" holds personal data');
    expect(readFileSync(out, 'utf8')).toContain('## Open points for the DPO');
    expect((await run(['ropa', dir, '--lang', 'de'])).code).toBe(EXIT_ERROR);
  });
});

describe('stonekeep init', () => {
  it('sets up a project in Polish: datamap, config, ROPA template, next steps', async () => {
    const dir = copyFixture('prisma-app');
    const res = await run(['init', dir]);
    expect(res.code).toBe(EXIT_OK);
    expect(res.stdout).toContain('Stonekeep: konfiguracja projektu');
    expect(res.stdout).toContain('Co dalej:');
    expect(res.stdout).toContain('nie gwarantuje zgodności z prawem');
    for (const f of ['stonekeep-datamap.json', 'stonekeep.config.json', 'stonekeep.ropa.yaml']) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    expect(readFileSync(join(dir, 'stonekeep.ropa.yaml'), 'utf8')).toContain('language: pl');
    // No git and no CI folder: suggest adding a workflow later.
    expect(res.stdout).toContain('--ci github');
    // The project now passes its own check, and the generated files are not scanned.
    const check = await run(['check', dir, '--format', 'json']);
    expect(check.code).toBe(EXIT_OK);
    expect((JSON.parse(check.stdout) as { filesScanned: number }).filesScanned).toBe(1);
  });

  it('never overwrites without --force, and writes nothing with --dry-run', async () => {
    const dir = copyFixture('prisma-app');
    await run(['init', dir]);
    writeFileSync(join(dir, 'stonekeep.config.json'), '{ "overrides": {} }\n');
    const again = await run(['init', dir, '--lang', 'en']);
    expect(again.stdout).toContain('skipped, file already exists');
    expect(readFileSync(join(dir, 'stonekeep.config.json'), 'utf8')).toBe('{ "overrides": {} }\n');

    const forced = await run(['init', dir, '--force', '--lang', 'en']);
    expect(forced.stdout).toContain('overwritten');
    expect(readFileSync(join(dir, 'stonekeep.config.json'), 'utf8')).toContain('minConfidence');

    const fresh = copyFixture('prisma-app');
    const dry = await run(['init', fresh, '--dry-run', '--ci', 'github', '--lang', 'en']);
    expect(dry.stdout).toContain('would be created');
    expect(existsSync(join(fresh, 'stonekeep-datamap.json'))).toBe(false);
    expect(existsSync(join(fresh, '.github'))).toBe(false);
  });

  it('writes a GitHub workflow at the repository root that checks the project folder', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'stonekeep-cli-repo-'));
    temps.push(repo);
    cpSync(join(FIXTURES, 'prisma-app'), join(repo, 'backend'), { recursive: true });
    writeFileSync(join(repo, '.git'), 'gitdir: elsewhere\n'); // a worktree-style .git file
    const res = await run(['init', join(repo, 'backend'), '--ci', 'github']);
    expect(res.code).toBe(EXIT_OK);
    const wf = readFileSync(join(repo, '.github', 'workflows', 'stonekeep.yml'), 'utf8');
    expect(wf).toContain('npx --yes @stonekeep/cli check backend');

    const gl = await run(['init', join(repo, 'backend'), '--ci', 'gitlab', '--lang', 'en']);
    expect(gl.stdout).toContain('stonekeep:\n  image: node:20');
  });

  it('explains what to do when there are no schema files', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'stonekeep-cli-empty-'));
    temps.push(empty);
    const res = await run(['init', empty]);
    expect(res.code).toBe(EXIT_ERROR);
    expect(res.stderr).toContain('Nie znaleziono plików schematów');
    expect((await run(['init', empty, '--lang', 'de'])).code).toBe(EXIT_ERROR);
  });
});

describe('stonekeep check: incomplete scans', () => {
  it('fails when a schema file cannot be parsed, unless --allow-incomplete is passed', async () => {
    const dir = copyFixture('sql-migrations');
    expect((await run(['check', dir])).code).toBe(EXIT_OK);
    writeFileSync(
      join(dir, 'migrations', '011_broken.sql'),
      'CREATE TABLE half (\n  email text,\n',
    );

    const failed = await run(['check', dir, '--format', 'text']);
    expect(failed.code).toBe(EXIT_UNMAPPED);
    expect(failed.stdout).toContain('FAIL  1 schema source could not be read');
    expect(failed.stdout).toContain('011_broken.sql');
    expect(failed.stdout).not.toContain('OK    Stonekeep check');

    const json = await run(['check', dir, '--format', 'json']);
    const parsed = JSON.parse(json.stdout) as { ok: boolean; incomplete: string[] };
    expect(parsed.ok).toBe(false);
    expect(parsed.incomplete).toHaveLength(1);

    const github = await run(['check', dir, '--format', 'github']);
    expect(github.stdout).toContain('::error title=Stonekeep::');

    const allowed = await run(['check', dir, '--allow-incomplete', '--format', 'text']);
    expect(allowed.code).toBe(EXIT_OK);
    expect(allowed.stdout).toContain('WARN  1 schema source could not be read');
  });

  it('reads a UTF-16 migration instead of skipping it', async () => {
    const dir = copyFixture('sql-migrations');
    const ddl = 'ALTER TABLE users ADD COLUMN secondary_email text;\r\n';
    writeFileSync(
      join(dir, 'migrations', '012_utf16.sql'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ddl, 'utf16le')]),
    );
    const result = await run(['check', dir, '--format', 'text']);
    expect(result.code).toBe(EXIT_UNMAPPED);
    expect(result.stdout).toContain('users.secondary_email');
  });
});

describe('stonekeep porady and dokumenty', () => {
  it('gives advice in Polish and writes the document pack without overwriting', async () => {
    const dir = copyFixture('prisma-app');
    await run(['init', dir]);

    const advice = await run(['porady', dir]);
    expect(advice.code).toBe(EXIT_OK);
    expect(advice.stdout).toContain('Porady RODO');
    expect(advice.stdout).toContain('Podstawa: art.');
    const strict = await run(['advise', dir, '--strict', '--format', 'json']);
    expect(Array.isArray(JSON.parse(strict.stdout))).toBe(true);

    const docs = await run(['dokumenty', dir, '--date', '2026-11-09']);
    expect(docs.code).toBe(EXIT_OK);
    expect(docs.stdout).toContain('Pakiet dokumentów RODO');
    expect(existsSync(join(dir, 'rodo', 'klauzula-informacyjna.md'))).toBe(true);
    expect(existsSync(join(dir, 'rodo', 'odpowiedzi', 'usuniecie-danych.md'))).toBe(true);
    // The pack is not scanned as a schema, and advice notices it now exists.
    expect((await run(['check', dir])).code).toBe(EXIT_OK);
    expect((await run(['porady', dir])).stdout).not.toContain('Przygotuj pakiet dokumentów');

    writeFileSync(join(dir, 'rodo', 'README.md'), 'moje notatki\n');
    const again = await run(['documents', dir]);
    expect(again.stdout).toContain('pominięto, plik już istnieje');
    expect(readFileSync(join(dir, 'rodo', 'README.md'), 'utf8')).toBe('moje notatki\n');
  });
});
