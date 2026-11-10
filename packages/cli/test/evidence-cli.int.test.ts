import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConsentLedger } from '@stonekeep/core/consent';
import {
  CONNECTOR_YAML,
  FIXTURE_DIR,
  loadFixture,
  startHarness,
  type PgHarness,
} from '../../core/test/integration/harness.js';
import { main, type Io } from '../src/index.js';

const SECRET = 'cli-evidence-test-ledger-secret-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'stonekeep-evidence-cli-'));
const yamlPath = join(dir, 'stonekeep.connector.yaml');
let ledgerPath: string;
let harness: PgHarness;
let url: string;
let n = 0;

beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  url = await harness.newDatabase();
  await loadFixture(url);
  ledgerPath = join(dir, `ledger-${++n}.db`);
  writeFileSync(
    yamlPath,
    readFileSync(CONNECTOR_YAML, 'utf8')
      .replace(
        'datamap: stonekeep-datamap.json',
        `datamap: ${JSON.stringify(join(FIXTURE_DIR, 'stonekeep-datamap.json'))}`,
      )
      .concat(
        `\nconsent:\n  ledger: ${JSON.stringify(ledgerPath)}\n  secretEnv: STONEKEEP_LEDGER_SECRET\n`,
      ),
  );
  const ledger = ConsentLedger.open(ledgerPath, { secret: SECRET });
  ledger.record({
    subject: '1',
    purpose: 'analytics',
    action: 'granted',
    policyVersion: 'v3',
    source: 'banner',
  });
  ledger.record({ subject: '2', purpose: 'marketing', action: 'granted', source: 'banner' });
  ledger.record({ subject: '1', purpose: 'marketing', action: 'withdrawn', source: 'settings' });
  ledger.close();
});

async function run(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    cwd: dir,
    env: { STONEKEEP_DATABASE_URL: url, STONEKEEP_LEDGER_SECRET: SECRET },
  };
  return { code: await main([...argv, '--connector', yamlPath], io), stdout, stderr };
}

describe('stonekeep evidence', () => {
  it('exports a verifiable chain segment and detects edits to it', async () => {
    const exp = await run(['evidence', 'export', '1', '--out', 'alice.json']);
    expect(exp.code).toBe(0);
    expect(exp.stdout).toMatch(
      /Wrote alice\.json: 2 of the subject's entries, 1 hidden, head seq 3/,
    );
    const file = join(dir, 'alice.json');
    expect(readFileSync(file, 'utf8')).not.toMatch(/"subject":\s*"1"/);

    expect((await run(['evidence', 'verify', 'alice.json'])).stdout).toMatch(/^VALID/);

    const tampered = JSON.parse(readFileSync(file, 'utf8')) as {
      entries: { content?: { action: string } }[];
    };
    const withdrawal = tampered.entries.find((e) => e.content?.action === 'withdrawn');
    if (withdrawal?.content) withdrawal.content.action = 'granted';
    writeFileSync(file, JSON.stringify(tampered));
    const bad = await run(['evidence', 'verify', 'alice.json']);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/^INVALID/);
  });

  it('verify-ledger passes on an intact ledger', async () => {
    const r = await run(['evidence', 'verify-ledger']);
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout).toMatch(/VALID {2}consent ledger: 3 entries, signed head at seq 3/);
  });

  it('stonekeep delete records the erasure in the ledger (erasure hook)', async () => {
    const del = await run(['delete', '--subject', '1', '--apply']);
    expect(del.code).toBe(0);
    expect(del.stdout).toMatch(
      /\[consent-ledger\] succeeded[\s\S]*record\s+erasure_event\s+1[\s\S]*redact\s+consent_entry\s+2/,
    );
    const ledger = ConsentLedger.open(ledgerPath, { secret: SECRET });
    expect(ledger.status('1')).toMatchObject({ erased: true, purposes: {} });
    expect(ledger.verify().valid).toBe(true);
    ledger.close();
    expect((await run(['evidence', 'verify-ledger'])).code).toBe(0);
  });

  it('reports a missing ledger secret by variable name', async () => {
    let stderr = '';
    const io: Io = { stdout: () => undefined, stderr: (t) => (stderr += t), cwd: dir, env: {} };
    expect(await main(['evidence', 'verify-ledger', '--connector', yamlPath], io)).toBe(2);
    expect(stderr).toContain('STONEKEEP_LEDGER_SECRET');
  });
});
