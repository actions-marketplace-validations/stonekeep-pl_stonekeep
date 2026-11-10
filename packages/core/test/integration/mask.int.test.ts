import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StonekeepError } from '../../src/index.js';
import {
  loadEngineContext,
  runMask,
  type EngineEvent,
  type MaskOptions,
} from '../../src/engine/index.js';
import {
  CONNECTOR_YAML,
  SEED_PII,
  findPii,
  loadFixture,
  loadSchema,
  sql,
  startHarness,
  type PgHarness,
} from './harness.js';

const SECRET = 'staging-mask-secret-for-tests-0001';
const TABLES = [
  'users',
  'addresses',
  'products',
  'orders',
  'order_items',
  'invoices',
  'invoice_lines',
  'login_events',
  'support_tickets',
];
const ctx = loadEngineContext(CONNECTOR_YAML);

let harness: PgHarness;
let prod: string;
let staging: string;
let events: EngineEvent[];

const options = (extra: Partial<MaskOptions> = {}): MaskOptions => ({
  config: ctx.connector.config,
  sourceUrl: prod,
  targetUrl: staging,
  secret: SECRET,
  pii: ctx.pii,
  logger: (e) => events.push(e),
  ...extra,
});

/** Every row of every table as JSON text, deterministic order. */
async function dump(url: string): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of TABLES) {
    const rows = await sql<{ j: string }>(
      url,
      `SELECT row_to_json(x)::text AS j FROM ${t} x ORDER BY 1`,
    );
    out[t] = rows.map((r) => r.j);
  }
  return out;
}

beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.stop();
});
beforeEach(async () => {
  events = [];
  prod = await harness.newDatabase();
  staging = await harness.newDatabase();
  await loadFixture(prod);
  await loadSchema(staging); // staging runs the same migrations, no data
});

describe('stonekeep mask (production -> staging)', () => {
  it('is a dry run by default: plans strategies and writes nothing', async () => {
    const r = await runMask(options());
    expect(r.dryRun).toBe(true);
    expect(await sql(staging, 'SELECT 1 FROM users')).toHaveLength(0);
    const users = r.tables.find((t) => t.table === 'users');
    expect(users?.rows).toBe(3);
    expect(users?.masked).toEqual(
      expect.arrayContaining([
        { column: 'email', strategy: 'email', source: 'datamap' },
        { column: 'full_name', strategy: 'full-name', source: 'datamap' },
        { column: 'last_login_ip', strategy: 'ip', source: 'datamap' },
        { column: 'date_of_birth', strategy: 'date', source: 'datamap' },
      ]),
    );
    expect(r.tables.find((t) => t.table === 'support_tickets')?.masked).toEqual([
      { column: 'body', strategy: 'token', source: 'config' },
    ]);
    // Parents are copied before children.
    expect(r.tables.map((t) => t.table).indexOf('users')).toBeLessThan(
      r.tables.map((t) => t.table).indexOf('orders'),
    );
  });

  it('full run: no real PII remains anywhere in staging', async () => {
    const before = await dump(prod);
    const result = await runMask(options({ dryRun: false }));
    const after = await dump(staging);

    // Same shape: every row copied.
    for (const t of TABLES) expect(after[t]?.length, t).toBe(before[t]?.length);

    // 1. No seed PII string appears in any row of any table.
    const leaks = findPii(after);
    expect(leaks).toEqual([]);

    // 2. Column-level: no PII column kept any original value.
    const piiColumns = result.tables.flatMap((t) =>
      t.masked.map((m) => [t.table, m.column] as const),
    );
    expect(piiColumns.length).toBeGreaterThanOrEqual(13);
    for (const [table, column] of piiColumns) {
      const original = new Set(
        (await sql<{ v: string | null }>(prod, `SELECT "${column}"::text AS v FROM ${table}`))
          .map((r) => r.v)
          .filter((v) => v !== null),
      );
      const masked = (
        await sql<{ v: string | null }>(staging, `SELECT "${column}"::text AS v FROM ${table}`)
      ).map((r) => r.v);
      for (const v of masked)
        expect(v !== null && original.has(v), `${table}.${column} kept an original value`).toBe(
          false,
        );
    }

    // 3. Results and logs contain no PII either.
    expect(findPii(result)).toEqual([]);
    expect(findPii(events)).toEqual([]);
  });

  it('control: with no datamap and no rules nothing is masked, and the leak check catches it', async () => {
    const config = { ...ctx.connector.config, mask: { ...ctx.connector.config.mask, columns: {} } };
    const pii = {
      ...ctx.pii,
      datamap: undefined,
      ruleSet: { ignore: [], typeAdjustments: {}, rules: [] },
    };
    await runMask(options({ dryRun: false, config, pii }));
    expect(findPii(await dump(staging))).toEqual(
      expect.arrayContaining([
        'alice.liddell@wonderland-mail.net',
        'Alice Liddell',
        '198.51.100.23',
      ]),
    );
  });

  it('preserves referential integrity, keys, identity values and non-PII data', async () => {
    await runMask(options({ dryRun: false }));
    // login_events.user_email -> users.email (an FK on a PII column) still joins.
    const orphans = await sql(
      staging,
      'SELECT e.id FROM login_events e LEFT JOIN users u ON u.email = e.user_email WHERE u.id IS NULL',
    );
    expect(orphans).toEqual([]);
    const aliceEmail = (
      await sql<{ email: string }>(staging, 'SELECT email FROM users WHERE id = 1')
    )[0]?.email;
    expect(aliceEmail).toMatch(/@example\.com$/);
    expect(
      await sql(staging, 'SELECT id FROM login_events WHERE user_email = $1 ORDER BY id', [
        aliceEmail,
      ]),
    ).toEqual([{ id: '1' }, { id: '2' }]);
    // The same source value masks to the same fake everywhere.
    const billing = (
      await sql<{ billing_email: string }>(
        staging,
        'SELECT billing_email FROM invoices WHERE id = 100',
      )
    )[0];
    expect(billing?.billing_email).toBe(aliceEmail);
    // Ids, self-references and plain data survive.
    expect(await sql(staging, 'SELECT id, manager_id FROM users ORDER BY id')).toEqual([
      { id: 1, manager_id: null },
      { id: 2, manager_id: 1 },
      { id: 3, manager_id: null },
    ]);
    expect(await sql(staging, 'SELECT id, user_id, total_cents FROM orders ORDER BY id')).toEqual(
      await sql(prod, 'SELECT id, user_id, total_cents FROM orders ORDER BY id'),
    );
    expect(await sql(staging, 'SELECT * FROM products ORDER BY sku')).toEqual(
      await sql(prod, 'SELECT * FROM products ORDER BY sku'),
    );
    // Sequences were moved past the copied ids, so staging keeps working.
    const [created] = await sql<{ id: number }>(
      staging,
      `INSERT INTO users (email, full_name) VALUES ('new@example.com', 'New') RETURNING id`,
    );
    expect(created?.id).toBe(4);
  });

  it('is deterministic for a given secret and changes with the secret', async () => {
    await runMask(options({ dryRun: false }));
    const first = await dump(staging);
    await runMask(options({ dryRun: false, truncate: true }));
    expect(await dump(staging)).toEqual(first);
    await runMask(
      options({ dryRun: false, truncate: true, secret: 'a-completely-different-secret-42' }),
    );
    expect((await dump(staging)).users).not.toEqual(first.users);
  });

  it('refuses unsafe runs', async () => {
    await runMask(options({ dryRun: false }));
    // Non-empty target without truncate.
    await expect(runMask(options({ dryRun: false }))).rejects.toThrow(/not empty/);
    // Same database as source and target.
    await expect(runMask(options({ dryRun: false, targetUrl: prod }))).rejects.toMatchObject({
      code: 'SAFETY',
    });
    // Weak secret.
    await expect(runMask(options({ secret: 'short' }))).rejects.toBeInstanceOf(StonekeepError);
    // Production was never modified.
    expect(findPii(await dump(prod))).toEqual(expect.arrayContaining([...SEED_PII]));
  });

  it('refuses a target whose schema does not match', async () => {
    await sql(staging, 'ALTER TABLE users DROP COLUMN phone');
    await expect(runMask(options({ dryRun: false }))).rejects.toThrow(
      /column "users.phone" is missing in the target/,
    );
  });
});
