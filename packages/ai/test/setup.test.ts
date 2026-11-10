import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConnectorConfig } from '@stonekeep/core/engine';
import {
  diffLines,
  formatReport,
  goldenMetadata,
  heuristicProposal,
  heuristicProvider,
  inspectPayload,
  loadGolden,
  renderSkillMd,
  runEval,
  runSetup,
  scoreProposal,
  type Proposal,
  type ProposalProvider,
} from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/postgres-shop/', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
let dir: string;
let out: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stonekeep-setup-'));
  for (const f of ['schema.sql', 'seed.sql', 'stonekeep-datamap.json'])
    cpSync(join(FIXTURE, f), join(dir, f));
  out = '';
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const io = (answer?: string) => ({
  stdout: (t: string) => (out += t),
  stderr: (t: string) => (out += t),
  ...(answer !== undefined ? { ask: () => Promise.resolve(answer) } : {}),
});
const options = (provider: ProposalProvider | typeof heuristicProvider, answer?: string) => ({
  root: dir,
  datamapPath: join(dir, 'stonekeep-datamap.json'),
  connectorPath: join(dir, 'stonekeep.connector.yaml'),
  provider,
  io: io(answer),
});

describe('stonekeep setup (interactive diff)', () => {
  it('shows a diff and saves only after an explicit Y', async () => {
    const declined = await runSetup(options(heuristicProvider, 'n'));
    expect(declined.saved).toBe(false);
    expect(existsSync(join(dir, 'stonekeep.connector.yaml'))).toBe(false);
    expect(out).toMatch(/\+ subject:/);
    expect(out).toContain('Cancelled: nothing was saved.');

    const empty = await runSetup(options(heuristicProvider, ''));
    expect(empty.saved).toBe(false);

    const saved = await runSetup(options(heuristicProvider, 'Y'));
    expect(saved.saved).toBe(true);
    const loaded = loadConnectorConfig(join(dir, 'stonekeep.connector.yaml'));
    expect(loaded.config.subject).toEqual({ table: 'users', key: 'id' });
    expect(loaded.config.tables.invoices?.retain?.anonymize).toContain('billing_email');
    expect(loaded.config.mask.columns['users.email']).toBe('email');
  });

  it('never saves in a non-interactive session', async () => {
    const r = await runSetup(options(heuristicProvider));
    expect(r.saved).toBe(false);
    expect(out).toContain('Not an interactive terminal: nothing was saved.');
  });

  it('only sends schema metadata (names, types, classifications)', async () => {
    let sent = '';
    const spy: ProposalProvider = {
      name: 'spy',
      propose: (p) => {
        sent = p.user;
        return Promise.resolve(
          heuristicProposal({
            entities: [{ name: 'users', columns: [{ name: 'id', type: 'integer', pii: null }] }],
          }),
        );
      },
    };
    await runSetup(options(spy));
    expect(sent).toContain('"name":"users"');
    // seed.sql contains realistic personal data; none of it may leave the machine.
    for (const value of [
      'alice.liddell@wonderland-mail.net',
      'Alice Liddell',
      '198.51.100.23',
      'cus_Alice00000001',
      '1990-05-04',
    ]) {
      expect(sent).not.toContain(value);
    }
    expect(inspectPayload(sent)).toEqual([]);
  });

  it('keeps connection, SaaS and consent settings, and drops hallucinated names', async () => {
    writeFileSync(
      join(dir, 'stonekeep.connector.yaml'),
      'version: 1\nconnector: postgres\nconnection:\n  urlEnv: SHOP_DATABASE_URL\nsubject: { table: users, key: id }\nconsent:\n  secretEnv: LEDGER_SECRET\n',
    );
    const invented: Proposal = {
      ...heuristicProposal({ entities: [] }),
      subject: { table: 'users', key: 'id' },
      mask: [
        { table: 'users', column: 'email', strategy: 'email' },
        { table: 'customers_v2', column: 'email', strategy: 'email' },
      ],
    };
    await runSetup(options({ name: 'fake', propose: () => Promise.resolve(invented) }, 'Y'));
    expect(out).toContain('unknown table "customers_v2" dropped');
    const loaded = loadConnectorConfig(join(dir, 'stonekeep.connector.yaml'));
    expect(loaded.config.connection.urlEnv).toBe('SHOP_DATABASE_URL');
    expect(loaded.config.consent?.secretEnv).toBe('LEDGER_SECRET');
    expect(Object.keys(loaded.config.mask.columns)).toEqual(['users.email']);
  });

  it('diffLines marks additions and removals', () => {
    expect(diffLines('a\nb\nc\n', 'a\nc\nd\n').map((l) => `${l.op}${l.text}`)).toEqual([
      ' a',
      '-b',
      ' c',
      '+d',
    ]);
  });
});

describe('prompt evaluation (golden set)', () => {
  const golden = loadGolden();

  it('has 30 fields whose metadata passes the privacy filter', () => {
    expect(golden.fields).toHaveLength(30);
    expect(inspectPayload(goldenMetadata(golden))).toEqual([]);
  });

  it('scores a perfect proposal at 100%', async () => {
    const perfect: Proposal = {
      subject: golden.subject,
      retain: golden.retain.map((t) => ({ table: t, reason: 'tax', anonymize: [] })),
      foreignKeys: [],
      mask: golden.fields
        .filter((f) => f.expected !== 'keep')
        .map((f) => ({
          table: f.entity,
          column: f.field,
          strategy: f.expected as Proposal['mask'][number]['strategy'],
        })),
      exclude: [],
      notes: [],
    };
    const r = await runEval({ name: 'perfect', propose: () => Promise.resolve(perfect) }, golden);
    expect(r).toMatchObject({
      fieldAccuracy: 1,
      subjectCorrect: true,
      retainRecall: 1,
      validConfig: true,
      hallucinations: 0,
    });
  });

  it('measures the offline heuristic baseline and reports mismatches', async () => {
    const r = await runEval(heuristicProvider(goldenMetadata(golden)), golden);
    expect(r.subjectCorrect).toBe(true);
    expect(r.retainRecall).toBe(1);
    expect(r.fieldAccuracy).toBeGreaterThanOrEqual(0.9);
    // Judgment calls a rule cannot make (external account ids are pseudonymous identifiers).
    expect(r.fields.find((f) => f.id === 'customers.stripe_customer_id')).toMatchObject({
      expected: 'token',
      actual: 'keep',
    });
    expect(formatReport(r)).toMatch(/Field accuracy: {4}\d+\.\d%/);
  });

  it('penalises wrong strategies, hallucinations and a wrong subject', () => {
    const bad = scoreProposal(golden, {
      subject: { table: 'orders', key: 'id' },
      retain: [],
      foreignKeys: [],
      mask: [
        { table: 'customers', column: 'email', strategy: 'token' },
        { table: 'ghost', column: 'x', strategy: 'email' },
      ],
      exclude: [],
      notes: [],
    });
    expect(bad.subjectCorrect).toBe(false);
    expect(bad.retainRecall).toBe(0);
    expect(bad.hallucinations).toBe(1);
    expect(bad.fieldAccuracy).toBeLessThan(0.5);
  });
});

describe('SKILL.md', () => {
  it('tells agents what they may and may not do', () => {
    const md = renderSkillMd();
    expect(md).toMatch(/^---\nname: stonekeep\ndescription: /);
    expect(md).toContain('Never run `stonekeep delete --apply`');
    expect(md).toContain('dry_run_delete');
  });

  it('the committed SKILL.md is up to date', () => {
    expect(readFileSync(join(ROOT, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      renderSkillMd(),
    );
  });
});
