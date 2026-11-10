import { readFileSync } from 'node:fs';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresConnector, loadEngineContext, parseConnectorConfig } from '@stonekeep/core/engine';
import {
  CONNECTOR_YAML,
  findPii,
  loadFixture,
  sql,
  startHarness,
  type PgHarness,
} from '../../core/test/integration/harness.js';
import { ConsentLedger } from '@stonekeep/core/consent';
import {
  consentLedgerStep,
  createSaasConnectors,
  runDeletion,
  type DeletionOptions,
  type OrchestratorEvent,
  type SaasConnector,
} from '../src/index.js';
import { FakeAuth0, FakeStripe, testHttp } from './fakes.js';

const server = setupServer();
const ctx = loadEngineContext(CONNECTOR_YAML);
const baseYaml = readFileSync(CONNECTOR_YAML, 'utf8');

let harness: PgHarness;
let url: string;
let stripe: FakeStripe;
let auth0: FakeAuth0;
let env: Record<string, string>;
let events: OrchestratorEvent[];

const SAAS = [
  {
    type: 'stripe',
    apiKey: 'env:STRIPE_API_KEY',
    identity: { customerId: { column: 'stripe_customer_id' }, email: { column: 'email' } },
  },
  {
    type: 'auth0',
    domain: FakeAuth0.DOMAIN,
    credentials: { clientId: 'env:AUTH0_CLIENT_ID', clientSecret: 'env:AUTH0_CLIENT_SECRET' },
    identity: { userId: { column: 'auth0_user_id' }, email: { column: 'email' } },
  },
];

function database(yaml = baseYaml): PostgresConnector {
  return new PostgresConnector({
    config: parseConnectorConfig(yaml, CONNECTOR_YAML).config,
    url,
    pii: ctx.pii,
  });
}

async function saas(): Promise<SaasConnector[]> {
  return createSaasConnectors(SAAS, env, { http: testHttp() });
}

async function run(over: Partial<DeletionOptions> = {}) {
  return runDeletion({
    database: database(),
    saas: await saas(),
    subject: '1',
    mode: 'delete',
    dryRun: false,
    logger: (e) => events.push(e),
    ...over,
  });
}

const aliceExists = async (): Promise<boolean> =>
  (await sql(url, 'SELECT 1 FROM users WHERE id = 1')).length === 1;
const SECRETS = (): string[] => [env.STRIPE_API_KEY ?? '', env.AUTH0_CLIENT_SECRET ?? ''];

beforeAll(async () => {
  harness = await startHarness(); // before MSW patches HTTP (testcontainers talks to Docker over HTTP)
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(async () => {
  server.close();
  await harness.stop();
});
beforeEach(async () => {
  url = await harness.newDatabase();
  await loadFixture(url);
  stripe = new FakeStripe().seed();
  auth0 = new FakeAuth0().seed();
  server.resetHandlers(...stripe.handlers(), ...auth0.handlers());
  env = {
    STRIPE_API_KEY: stripe.validKey,
    AUTH0_CLIENT_ID: auth0.clientId,
    AUTH0_CLIENT_SECRET: auth0.clientSecret,
  };
  events = [];
});

describe('deletion orchestrator: Postgres + Stripe + Auth0', () => {
  it('runs every connector in parallel and aggregates one report', async () => {
    stripe.latencyMs = 120;
    auth0.latencyMs = 120;
    const report = await run();

    expect(report).toMatchObject({
      operation: 'delete',
      status: 'completed',
      dryRun: false,
      hints: [],
    });
    expect(report.connectors.map((c) => [c.connector, c.status])).toEqual([
      ['postgres', 'succeeded'],
      ['stripe', 'succeeded'],
      ['auth0', 'succeeded'],
    ]);
    // Effects everywhere.
    expect(await aliceExists()).toBe(false);
    expect(stripe.customers.get('cus_Alice00000001')?.email).toBeNull();
    expect(auth0.users.has('auth0|alice0001')).toBe(false);
    // Retention is reported for both sides.
    expect(report.connectors[0]?.database?.steps).toContainEqual(
      expect.objectContaining({ table: 'invoices', action: 'retain', rows: 1 }),
    );
    expect(report.connectors[1]?.retained).toEqual([
      expect.objectContaining({ resource: 'invoice', count: 3 }),
    ]);

    // Parallelism: Auth0 started before Stripe finished its sequence of calls.
    const stripeStart = Math.min(...stripe.requests.map((r) => r.at));
    const stripeLast = Math.max(...stripe.requests.map((r) => r.at));
    const auth0Start = Math.min(...auth0.requests.map((r) => r.at));
    expect(auth0Start).toBeLessThan(stripeLast);
    expect(stripeStart).toBeLessThan(Math.max(...auth0.requests.map((r) => r.at)));

    expect(findPii(report)).toEqual([]);
    expect(findPii(events)).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(SECRETS()[0]);
  });

  it('partial failure: the database succeeds, Stripe fails -> reported as partial with guidance', async () => {
    stripe.fail('POST /v1/customers/', 500, 99);
    const report = await run();

    expect(report.status).toBe('partial');
    const [db, s, a] = report.connectors;
    expect(db).toMatchObject({ connector: 'postgres', status: 'succeeded' });
    expect(s).toMatchObject({
      connector: 'stripe',
      status: 'failed',
      error: {
        status: 500,
        code: 'api_error',
        attempts: 4,
        message:
          'stripe: POST /v1/customers/{id} failed with HTTP 500 (api_error) after 4 attempts',
      },
    });
    expect(a).toMatchObject({ connector: 'auth0', status: 'succeeded' });
    expect(await aliceExists()).toBe(false);
    expect(report.hints.join(' ')).toMatch(/Re-run to retry stripe.*--saas-identity/);
    // The injected error body mentions an email; it must not surface.
    expect(JSON.stringify(report)).not.toContain('jane@example.com');
    expect(findPii(report)).toEqual([]);

    // Retry once Stripe recovers: the DB row is gone, so the id is passed explicitly.
    stripe.clearFaults();
    const retry = await run({ identityOverrides: { stripe: { customerId: 'cus_Alice00000001' } } });
    expect(retry.status).toBe('completed');
    expect(retry.connectors[0]?.database?.totalRows).toBe(0); // idempotent
    expect(stripe.customers.get('cus_Alice00000001')?.name).toBeNull();
  });

  it('partial failure the other way: the database rolls back, SaaS connectors still run', async () => {
    const yaml = baseYaml.replace('tables:\n', 'tables:\n  login_events:\n    exclude: true\n');
    const report = await run({ database: database(yaml) });
    expect(report.status).toBe('partial');
    expect(report.connectors[0]).toMatchObject({ status: 'failed', error: { code: 'DATABASE' } });
    expect(report.connectors[0]?.error?.message).toMatch(/foreign_key_violation/);
    expect(report.hints).toContain(
      'The database transaction was rolled back; no database rows were changed.',
    );
    expect(await aliceExists()).toBe(true);
    expect(auth0.users.has('auth0|alice0001')).toBe(false);
  });

  it('everything failing is "failed"', async () => {
    stripe.fail('POST /v1/customers/', 500, 99);
    auth0.fail('DELETE /api/v2/users/', 503, 99);
    const report = await run({
      database: database(
        baseYaml.replace('tables:\n', 'tables:\n  login_events:\n    exclude: true\n'),
      ),
    });
    expect(report.status).toBe('failed');
  });

  it('invalid credentials abort the whole run before anything changes', async () => {
    env.STRIPE_API_KEY = 'sk_test_51RevokedKey000000000';
    const report = await run();
    expect(report).toMatchObject({ status: 'failed', abortedAt: 'credentials' });
    expect(report.connectors.map((c) => [c.connector, c.status])).toEqual([
      ['postgres', 'skipped'],
      ['stripe', 'failed'],
      ['auth0', 'skipped'],
    ]);
    expect(report.connectors[1]?.error).toMatchObject({ status: 401 });
    expect(await aliceExists()).toBe(true);
    expect(stripe.requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(auth0.requests.filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('RevokedKey');
  });

  it('is a dry run by default everywhere', async () => {
    // No `dryRun` at all: the default must be a dry run.
    const report = await runDeletion({
      database: database(),
      saas: await saas(),
      subject: '1',
      mode: 'delete',
    });
    expect(report.dryRun).toBe(true);
    expect(report.status).toBe('completed');
    expect(await aliceExists()).toBe(true);
    expect(stripe.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(auth0.requests.filter((r) => r.method === 'DELETE')).toEqual([]);
    expect(report.connectors[2]?.steps).toEqual([{ action: 'delete', resource: 'user', count: 1 }]);
  });

  it('a subject without external accounts completes with notes', async () => {
    const report = await run({ subject: '3' });
    expect(report.status).toBe('completed');
    expect(report.connectors[1]?.note).toMatch(/no matching Stripe customer/);
    expect(report.connectors[2]?.note).toMatch(/no matching Auth0 user/);
  });
});

describe('erasure hook: consent ledger', () => {
  const LEDGER_SECRET = 'orchestrator-test-ledger-secret-0123456789';
  const withConsents = (): ConsentLedger => {
    const ledger = ConsentLedger.open(':memory:', { secret: LEDGER_SECRET });
    ledger.record({ subject: '1', purpose: 'analytics', action: 'granted', source: 'banner' });
    ledger.record({ subject: '2', purpose: 'analytics', action: 'granted', source: 'banner' });
    ledger.record({ subject: '1', purpose: 'marketing', action: 'granted', source: 'banner' });
    return ledger;
  };

  it('after a successful delete, keeps only the hashed id and the erasure event', async () => {
    const ledger = withConsents();
    const report = await run({ saas: [], postErasure: [consentLedgerStep(ledger)] });
    expect(report.status).toBe('completed');
    expect(report.connectors.at(-1)).toMatchObject({
      connector: 'consent-ledger',
      status: 'succeeded',
      steps: [
        { action: 'record', resource: 'erasure_event', count: 1 },
        { action: 'redact', resource: 'consent_entry', count: 2 },
      ],
    });
    expect(ledger.status('1')).toMatchObject({ erased: true, purposes: {} });
    expect(ledger.status('2').purposes.analytics?.granted).toBe(true);
    expect(ledger.verify().valid).toBe(true);
    const ev = ledger.exportEvidence('1');
    expect(ev.entries.filter((e) => e.content).map((e) => e.content?.action)).toEqual(['erased']);
    ledger.close();
  });

  it('does not touch the ledger when the database erasure fails, and only counts in a dry run', async () => {
    const ledger = withConsents();
    const failing = await run({
      saas: [],
      database: database(
        baseYaml.replace('tables:\n', 'tables:\n  login_events:\n    exclude: true\n'),
      ),
      postErasure: [consentLedgerStep(ledger)],
    });
    expect(failing.connectors.at(-1)).toMatchObject({
      connector: 'consent-ledger',
      status: 'skipped',
    });
    expect(ledger.status('1').erased).toBe(false);

    const dry = await run({ saas: [], dryRun: true, postErasure: [consentLedgerStep(ledger)] });
    expect(dry.connectors.at(-1)?.steps).toContainEqual({
      action: 'redact',
      resource: 'consent_entry',
      count: 2,
    });
    expect(ledger.verify().entries).toBe(3);
    ledger.close();
  });
});
