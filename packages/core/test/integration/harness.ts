import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Postgres for integration tests, in order of preference:
 *  1. `STONEKEEP_TEST_DATABASE_URL` — an existing server (admin URL).
 *  2. Testcontainers (`postgres:16-alpine`) — needs a Docker-compatible runtime.
 *  3. PGlite (Postgres compiled to WASM) served over the wire protocol —
 *     fallback for machines without Docker. Set `STONEKEEP_TEST_REQUIRE_DOCKER=1`
 *     (CI does) to fail instead of falling back.
 */
export type Backend = 'external' | 'testcontainers' | 'pglite';

export interface PgHarness {
  backend: Backend;
  /** Create an empty database and return its connection URL. */
  newDatabase(): Promise<string>;
  stop(): Promise<void>;
}

export const FIXTURE_DIR = fileURLToPath(
  new URL('../../../../fixtures/postgres-shop/', import.meta.url),
);
export const CONNECTOR_YAML = `${FIXTURE_DIR}stonekeep.connector.yaml`;
const SCHEMA_SQL = readFileSync(`${FIXTURE_DIR}schema.sql`, 'utf8');
const SEED_SQL = readFileSync(`${FIXTURE_DIR}seed.sql`, 'utf8');

let counter = 0;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

function serverDatabases(adminUrl: string, backend: Backend, stop: () => Promise<void>): PgHarness {
  return {
    backend,
    async newDatabase() {
      const name = `stonekeep_test_${process.pid}_${Date.now()}_${++counter}`;
      await sql(adminUrl, `CREATE DATABASE "${name}"`);
      return withDatabase(adminUrl, name);
    },
    stop,
  };
}

async function pgliteHarness(): Promise<PgHarness> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { PGLiteSocketServer } = await import('@electric-sql/pglite-socket');
  const running: { stop: () => Promise<void> }[] = [];
  return {
    backend: 'pglite',
    async newDatabase() {
      const db = await PGlite.create();
      const server = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1' });
      await server.start();
      const port = server.getServerConn().split(':').pop() ?? '';
      running.push({
        stop: async () => {
          await server.stop();
          await db.close();
        },
      });
      return `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
    },
    async stop() {
      for (const r of running.splice(0)) await r.stop().catch(() => undefined);
    },
  };
}

export async function startHarness(): Promise<PgHarness> {
  const external = process.env.STONEKEEP_TEST_DATABASE_URL;
  if (external) return serverDatabases(external, 'external', () => Promise.resolve());
  try {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:16-alpine').start();
    return serverDatabases(container.getConnectionUri(), 'testcontainers', async () => {
      await container.stop();
    });
  } catch (error) {
    if (process.env.STONEKEEP_TEST_REQUIRE_DOCKER === '1') throw error;
    process.stderr.write(
      '[stonekeep tests] No container runtime found; using PGlite (Postgres/WASM) instead of testcontainers.\n',
    );
    return pgliteHarness();
  }
}

/** Run one statement (or a multi-statement script without params) on a short-lived connection. */
export async function sql<T extends pg.QueryResultRow = Record<string, unknown>>(
  url: string,
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query<T>(text, params);
    // Multi-statement scripts return an array of results.
    return Array.isArray(result) ? [] : result.rows;
  } finally {
    await client.end();
  }
}

export async function loadSchema(url: string): Promise<void> {
  await sql(url, SCHEMA_SQL);
}

export async function loadFixture(url: string): Promise<void> {
  await sql(url, SCHEMA_SQL);
  await sql(url, SEED_SQL);
}

/** Every personal-data value in seed.sql. None may appear in results, logs or masked output. */
export const SEED_PII = [
  'alice.liddell@wonderland-mail.net',
  'bob.marley.reggae@islandnet.org',
  'carol.danvers@starforce-hq.io',
  'Alice Liddell',
  'Bobby Marlowe',
  'Carol Danvers',
  '+44 20 7946 0958',
  '+1 (415) 555-0199',
  '+49 30 901820',
  '198.51.100.23',
  '198.51.100.24',
  '203.0.113.77',
  '192.0.2.144',
  '1990-05-04',
  '1985-02-06',
  '1979-11-30',
  '7 Rabbit Hole Lane',
  '56 Hope Road',
  '1 Hala Way',
  'OX1 3BG',
  'Oxfordshire',
  'Kingstonville',
  'Berlinchen',
  'Please call me back',
  'cus_Alice00000001',
  'cus_Bob000000002',
  'auth0|alice0001',
  'auth0|bob0002',
] as const;

/** Assert that a serialized value contains none of the seed PII strings. */
export function findPii(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return SEED_PII.filter((p) => text.includes(p));
}
