import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StonekeepError } from '../../src/index.js';
import {
  PostgresConnector,
  loadEngineContext,
  parseConnectorConfig,
  sanitizeDbError,
  sha256Hex,
  type EngineEvent,
  type ExportManifest,
} from '../../src/engine/index.js';
import {
  CONNECTOR_YAML,
  findPii,
  loadFixture,
  sql,
  startHarness,
  type PgHarness,
} from './harness.js';

let harness: PgHarness;
let url: string;
let events: EngineEvent[];
const tmp = mkdtempSync(join(tmpdir(), 'stonekeep-export-'));
const ctx = loadEngineContext(CONNECTOR_YAML);
const baseYaml = readFileSync(CONNECTOR_YAML, 'utf8');

function connector(yaml: string = baseYaml): PostgresConnector {
  const { config } = parseConnectorConfig(yaml, CONNECTOR_YAML);
  return new PostgresConnector({ config, url, pii: ctx.pii, logger: (e) => events.push(e) });
}

const count = async (table: string, where = 'true'): Promise<number> =>
  Number(
    (await sql<{ n: string }>(url, `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`))[0]
      ?.n,
  );

beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.stop();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  events = [];
  url = await harness.newDatabase();
  await loadFixture(url);
});

describe(`Postgres connector (${process.env.STONEKEEP_TEST_DATABASE_URL ? 'external' : 'auto'} backend)`, () => {
  it('loads the datamap produced by `stonekeep scan`', () => {
    expect(ctx.datamapFound).toBe(true);
    expect(ctx.pii.datamap?.fields.some((f) => f.id === 'users.email')).toBe(true);
  });

  it('discover() maps the schema, relations and PII columns without reading data', async () => {
    const d = await connector().discover();
    const role = Object.fromEntries(d.tables.map((t) => [t.name, t.role]));
    expect(role).toMatchObject({
      users: 'subject',
      addresses: 'subject-data',
      orders: 'subject-data',
      order_items: 'subject-data',
      login_events: 'subject-data',
      support_tickets: 'subject-data',
      invoices: 'retained',
      products: 'unrelated',
    });
    expect(d.foreignKeys).toContainEqual(
      expect.objectContaining({ table: 'support_tickets', refTable: 'users', source: 'config' }),
    );
    const email = d.tables.find((t) => t.name === 'users')?.columns.find((c) => c.name === 'email');
    expect(email?.pii).toMatchObject({ category: 'contact', source: 'datamap' });
    expect(findPii(d)).toEqual([]);
  });

  describe('delete', () => {
    it('is a dry run by default and changes nothing', async () => {
      const r = await connector().delete('1', 'delete');
      expect(r.dryRun).toBe(true);
      const rows = Object.fromEntries(r.steps.map((s) => [`${s.action}:${s.table}`, s.rows]));
      expect(rows).toMatchObject({
        'retain:invoices': 1,
        'detach:users': 1, // bob.manager_id -> alice
        'delete:order_items': 3,
        'delete:orders': 2,
        'delete:addresses': 1,
        'delete:login_events': 2,
        'delete:support_tickets': 2,
        'delete:users': 1,
      });
      expect(await count('users')).toBe(3);
      expect(await count('orders')).toBe(3);
    });

    it('cascades through orders -> order_items, soft references and self-references', async () => {
      const r = await connector().delete('1', 'delete', { dryRun: false });
      expect(r.dryRun).toBe(false);
      expect(r.steps.at(-1)).toMatchObject({ table: 'users', action: 'delete', rows: 1 });
      expect(r.steps[0]?.action).toBe('retain');

      expect(await count('users', 'id = 1')).toBe(0);
      expect(await count('orders', 'user_id = 1')).toBe(0);
      expect(await count('order_items', 'order_id IN (10, 11)')).toBe(0);
      expect(await count('addresses', 'user_id = 1')).toBe(0);
      expect(await count('support_tickets', 'requester_id = 1')).toBe(0); // config-only FK
      expect(await count('login_events', `user_email LIKE 'alice%'`)).toBe(0);
      // Other subjects are untouched.
      expect(await count('users')).toBe(2);
      expect(await count('orders', 'id = 12')).toBe(1);
      expect(await count('login_events')).toBe(1);
      expect((await sql(url, 'SELECT manager_id FROM users WHERE id = 2'))[0]).toEqual({
        manager_id: null,
      });
    });

    it('retains invoices: detached (null reference), listed PII anonymized, lines kept', async () => {
      await connector().delete('1', 'delete', { dryRun: false });
      const [invoice] = await sql(url, 'SELECT * FROM invoices WHERE id = 100');
      expect(invoice).toMatchObject({
        user_id: null,
        order_id: null,
        billing_email: null,
        amount_cents: 2500,
      });
      expect(await count('invoice_lines', 'invoice_id = 100')).toBe(2);
      // Bob's invoice is unaffected.
      expect((await sql(url, 'SELECT user_id, order_id FROM invoices WHERE id = 101'))[0]).toEqual({
        user_id: 2,
        order_id: 12,
      });
    });

    it('retains with an anonymous placeholder reference', async () => {
      await sql(
        url,
        `INSERT INTO users (id, email, full_name) VALUES (999, 'deleted-user@stonekeep.invalid', 'Deleted user')`,
      );
      const yaml = baseYaml.replace(
        '      reference: null',
        '      reference: { user_id: 999, order_id: null }',
      );
      await connector(yaml).delete('1', 'delete', { dryRun: false });
      expect((await sql(url, 'SELECT user_id, order_id FROM invoices WHERE id = 100'))[0]).toEqual({
        user_id: 999,
        order_id: null,
      });
    });

    it('refuses a null reference for a NOT NULL link column before writing anything', async () => {
      const yaml = baseYaml.replace(
        'tables:\n',
        'tables:\n  addresses:\n    retain:\n      reason: test\n      reference: null\n',
      );
      await expect(connector(yaml).delete('1', 'delete', { dryRun: false })).rejects.toThrow(
        /NOT NULL/,
      );
      expect(await count('users')).toBe(3);
    });

    it('is idempotent: deleting twice does not throw and affects 0 rows', async () => {
      await connector().delete('1', 'delete', { dryRun: false });
      const second = await connector().delete('1', 'delete', { dryRun: false });
      expect(second.totalRows).toBe(0);
      const third = await connector()
        .delete('no-such-subject-404', 'delete', { dryRun: false })
        .catch((e: unknown) => e);
      // A key that is not even a valid integer is a database error, reported without echoing the value.
      expect(third).toBeInstanceOf(StonekeepError);
      expect((third as Error).message).not.toContain('no-such-subject-404');
    });

    it('runs in one transaction: a failure rolls back every step', async () => {
      // Excluding login_events leaves a NO ACTION FK on users.email in place -> the final DELETE fails.
      const yaml = baseYaml.replace('tables:\n', 'tables:\n  login_events:\n    exclude: true\n');
      const error = await connector(yaml)
        .delete('1', 'delete', { dryRun: false })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(StonekeepError);
      expect((error as StonekeepError).code).toBe('DATABASE');
      expect((error as Error).message).toMatch(/23503 \(foreign_key_violation\)/);
      expect(findPii((error as Error).message)).toEqual([]);
      expect(await count('orders', 'user_id = 1')).toBe(2);
      expect(await count('order_items')).toBe(4);
      expect((await sql(url, 'SELECT user_id FROM invoices WHERE id = 100'))[0]).toEqual({
        user_id: 1,
      });
    });
  });

  describe("delete(mode: 'anonymize')", () => {
    it('replaces PII in place, keeps keys and relations, and reports skipped key columns', async () => {
      const r = await connector().delete('1', 'anonymize', { dryRun: false });
      const [alice] = await sql(url, 'SELECT * FROM users WHERE id = 1');
      expect(alice?.email).toMatch(/^anon_[0-9a-f]{32}@anonymized\.invalid$/);
      expect(alice?.full_name).toMatch(/^anon_[0-9a-f]{32}$/);
      expect(alice).toMatchObject({ phone: null, last_login_ip: null, date_of_birth: null });
      // ON UPDATE CASCADE carried the new email into login_events.
      const events = await sql<{ user_email: string; ip_address: string }>(
        url,
        'SELECT user_email, ip_address FROM login_events WHERE user_email = $1',
        [alice?.email],
      );
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.ip_address === '0.0.0.0')).toBe(true);
      const [addr] = await sql(url, 'SELECT * FROM addresses WHERE user_id = 1');
      expect(addr).toMatchObject({ postal_code: null, city: null });
      expect(String(addr?.street)).toMatch(/^anon_/);
      expect(await count('support_tickets', `requester_id = 1 AND body LIKE 'anon_%'`)).toBe(2);
      expect(await count('orders', 'user_id = 1')).toBe(2);
      expect(r.skipped).toContainEqual({
        table: 'login_events',
        column: 'user_email',
        reason: 'foreign key column (updated via its parent)',
      });
      // Alice's rows no longer contain her data; other subjects are untouched.
      const aliceRows = await sql(
        url,
        `SELECT row_to_json(u)::text AS j FROM users u WHERE id = 1
                                       UNION ALL SELECT row_to_json(a)::text FROM addresses a WHERE user_id = 1
                                       UNION ALL SELECT row_to_json(t)::text FROM support_tickets t WHERE requester_id = 1`,
      );
      expect(findPii(aliceRows)).toEqual([]);
      expect(await count('users', `email = 'bob.marley.reggae@islandnet.org'`)).toBe(1);
    });

    it('is idempotent', async () => {
      await connector().delete('1', 'anonymize', { dryRun: false });
      await expect(connector().delete('1', 'anonymize', { dryRun: false })).resolves.toMatchObject({
        mode: 'anonymize',
      });
    });
  });

  describe('export', () => {
    it('dry run counts rows and writes nothing', async () => {
      const out = join(tmp, 'dry.zip');
      const r = await connector().export('1', { dryRun: true, outFile: out });
      expect(existsSync(out)).toBe(false);
      expect(Object.fromEntries(r.tables.map((t) => [t.table, t.rows]))).toMatchObject({
        users: 1,
        orders: 2,
        order_items: 3,
        invoices: 1,
        invoice_lines: 2,
        login_events: 2,
        support_tickets: 2,
        addresses: 1,
      });
    });

    it('writes a ZIP with JSON + CSV per table and a verifiable SHA-256 manifest', async () => {
      const out = join(tmp, 'alice.zip');
      const now = new Date('2026-01-02T03:04:05Z');
      const r = await connector().export('1', { outFile: out, now });
      expect(findPii(r)).toEqual([]); // the result object itself carries no data
      const zipBytes = readFileSync(out);
      expect(r.sha256).toBe(sha256Hex(zipBytes));

      const files = unzipSync(zipBytes);
      const manifest = JSON.parse(
        strFromU8(files['manifest.json'] ?? new Uint8Array()),
      ) as ExportManifest;
      expect(manifest).toMatchObject({
        format: 'stonekeep-export',
        generatedAt: now.toISOString(),
        hashAlgorithm: 'sha256',
      });
      for (const f of manifest.files) {
        expect(sha256Hex(files[f.path] ?? new Uint8Array()), f.path).toBe(f.sha256);
      }
      const sums = strFromU8(files.SHA256SUMS ?? new Uint8Array())
        .trim()
        .split('\n');
      expect(sums).toContain(
        `${sha256Hex(files['manifest.json'] ?? new Uint8Array())}  manifest.json`,
      );

      const users = JSON.parse(strFromU8(files['data/users.json'] ?? new Uint8Array())) as {
        rows: Record<string, unknown>[];
      };
      expect(users.rows).toEqual([
        expect.objectContaining({ id: 1, email: 'alice.liddell@wonderland-mail.net' }),
      ]);
      const allText = Object.values(files)
        .map((f) => strFromU8(f))
        .join('\n');
      // Only the subject's data: nothing from Bob or Carol.
      for (const other of [
        'bob.marley.reggae@islandnet.org',
        'carol.danvers@starforce-hq.io',
        'Bobby Marlowe',
      ]) {
        expect(allText).not.toContain(other);
      }
      // CSV formula injection is neutralised.
      expect(strFromU8(files['data/support_tickets.csv'] ?? new Uint8Array())).toContain(
        `"'=HYPERLINK(""http://evil.example"",""click"")"`,
      );
      expect(Object.keys(files)).toContain('data/invoice_lines.csv');
    });
  });

  it('progress events never contain PII', async () => {
    await connector().discover();
    await connector().delete('1', 'anonymize', { dryRun: true });
    await connector().export('1', { outFile: join(tmp, 'events.zip') });
    await connector().delete('1', 'delete', { dryRun: false });
    expect(events.length).toBeGreaterThan(10);
    expect(findPii(events)).toEqual([]);
  });

  it('sanitizes real database errors (no values from DETAIL/MESSAGE)', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const error: unknown = await client
      .query(`INSERT INTO users (email, full_name) VALUES ('carol.danvers@starforce-hq.io', 'x')`)
      .catch((e: unknown) => e);
    await client.end();
    expect(String((error as pg.DatabaseError).detail)).toContain('carol.danvers'); // the raw error leaks...
    const safe = sanitizeDbError(error, 'test');
    expect(safe.message).toMatch(/23505 \(unique_violation\).*constraint "users_email_key"/); // ...ours does not
    expect(findPii(safe.message)).toEqual([]);
    expect(safe.cause).toBeUndefined();
  });

  it('rejects connector configs that do not match the database', async () => {
    const yaml = baseYaml.replace('  key: id', '  key: user_uuid');
    await expect(connector(yaml).discover()).rejects.toThrow(/column "users.user_uuid" not found/);
  });
});
