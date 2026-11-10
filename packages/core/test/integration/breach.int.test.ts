import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StonekeepError, renderBreachMarkdown } from '../../src/index.js';
import {
  PostgresConnector,
  loadEngineContext,
  parseConnectorConfig,
} from '../../src/engine/index.js';
import { CONNECTOR_YAML, loadFixture, sql, startHarness, type PgHarness } from './harness.js';

let harness: PgHarness;
let url: string;
const ctx = loadEngineContext(CONNECTOR_YAML);

function connector(): PostgresConnector {
  const { config } = parseConnectorConfig(readFileSync(CONNECTOR_YAML, 'utf8'), CONNECTOR_YAML);
  return new PostgresConnector({ config, url, pii: ctx.pii });
}
const discoveredAt = new Date('2026-11-08T09:30:00Z');

beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.stop();
});
beforeEach(async () => {
  url = await harness.newDatabase();
  await loadFixture(url);
});

describe('PostgresConnector.assessBreach', () => {
  it('counts records and distinct subjects through foreign keys', async () => {
    const impact = await connector().assessBreach(['addresses', 'orders', 'login_events'], {
      discoveredAt,
    });
    const byTable = Object.fromEntries(impact.tables.map((t) => [t.table, t]));

    expect(byTable.addresses).toMatchObject({ rows: 3, linked: true, subjects: 3 });
    // Orders belong to users 1 and 2 only.
    expect(byTable.orders).toMatchObject({ linked: true, subjects: 2 });
    // login_events links through the email foreign key.
    expect(byTable.login_events?.linked).toBe(true);
    expect(impact.subjects.linked).toBe(3);
    expect(impact.records).toBe(impact.tables.reduce((n, t) => n + t.rows, 0));
    expect(impact.notifyBy).toBe('2026-11-11T09:30:00.000Z');
    expect(impact.categories.map((c) => c.category)).toEqual(
      expect.arrayContaining(['location', 'online_identifier']),
    );
  });

  it('deduplicates subjects across tables and walks several levels', async () => {
    const impact = await connector().assessBreach(['order_items', 'orders'], { discoveredAt });
    expect(impact.tables.find((t) => t.table === 'order_items')?.subjects).toBe(2);
    expect(impact.subjects.linked).toBe(2);
    // No personal data columns in order data.
    expect(impact.risk).toBe('low');
  });

  it('rates credentials and contact data, and reports unlinked tables', async () => {
    await sql(url, 'CREATE TABLE newsletter (email TEXT, password_hash TEXT)');
    await sql(
      url,
      "INSERT INTO newsletter VALUES ('a@example.test', 'x'), ('b@example.test', 'y')",
    );
    const impact = await connector().assessBreach(['users', 'newsletter'], { discoveredAt });
    expect(impact.tables.find((t) => t.table === 'newsletter')).toMatchObject({
      linked: false,
      subjects: null,
      rows: 2,
    });
    expect(impact.subjects).toEqual({ linked: 3, unlinkedRows: 2, min: 3, max: 5 });
    expect(impact.risk).toBe('high');
    expect(impact.highRiskCategories).toContain('credential');

    const md = renderBreachMarkdown(impact, { language: 'pl' });
    expect(md).toContain('od 3 do 5');
    expect(md).toContain('Wysokie ryzyko');
    expect(md).toContain('2026-11-11 09:30 UTC');
    // Counts and identifiers only.
    expect(md).not.toContain('a@example.test');
    expect(md).not.toContain('alice');
  });

  it('rejects unknown tables', async () => {
    await expect(connector().assessBreach(['nope'])).rejects.toBeInstanceOf(StonekeepError);
    await expect(connector().assessBreach([])).rejects.toThrow(/at least one/);
  });
});
