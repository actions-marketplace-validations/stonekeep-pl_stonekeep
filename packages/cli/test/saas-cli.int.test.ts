import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CONNECTOR_YAML,
  FIXTURE_DIR,
  findPii,
  loadFixture,
  startHarness,
  type PgHarness,
} from '../../core/test/integration/harness.js';
import { FakeAuth0, FakeStripe } from '../../connectors/test/fakes.js';
import { main, type Io } from '../src/index.js';
import { EXIT_PARTIAL } from '../src/engine-commands.js';

const server = setupServer();
const dir = mkdtempSync(join(tmpdir(), 'stonekeep-saas-cli-'));
const yamlPath = join(dir, 'stonekeep.connector.yaml');
let harness: PgHarness;
let url: string;
let stripe: FakeStripe;
let auth0: FakeAuth0;

beforeAll(async () => {
  harness = await startHarness();
  server.listen({ onUnhandledRequest: 'error' });
  const yaml = readFileSync(CONNECTOR_YAML, 'utf8').replace(
    'datamap: stonekeep-datamap.json',
    `datamap: ${JSON.stringify(join(FIXTURE_DIR, 'stonekeep-datamap.json'))}`,
  ).concat(`
saas:
  - type: stripe
    apiKey: env:STRIPE_API_KEY
    identity: { customerId: { column: stripe_customer_id } }
  - type: auth0
    domain: ${FakeAuth0.DOMAIN}
    credentials: { clientId: env:AUTH0_CLIENT_ID, clientSecret: env:AUTH0_CLIENT_SECRET }
    identity: { userId: { column: auth0_user_id } }
`);
  writeFileSync(yamlPath, yaml);
});
afterAll(async () => {
  server.close();
  await harness.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  url = await harness.newDatabase();
  await loadFixture(url);
  stripe = new FakeStripe().seed();
  auth0 = new FakeAuth0().seed();
  server.resetHandlers(...stripe.handlers(), ...auth0.handlers());
});

async function run(argv: string[]) {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    cwd: dir,
    env: {
      STONEKEEP_DATABASE_URL: url,
      STRIPE_API_KEY: stripe.validKey,
      AUTH0_CLIENT_ID: auth0.clientId,
      AUTH0_CLIENT_SECRET: auth0.clientSecret,
    },
  };
  const code = await main([...argv, '--connector', yamlPath], io);
  return { code, stdout, stderr };
}

describe('stonekeep delete with SaaS connectors', () => {
  it('runs Postgres, Stripe and Auth0 together and prints one report', async () => {
    const { code, stdout } = await run(['delete', '--subject', '1', '--apply']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^COMPLETED {2}delete across 3 connectors/);
    expect(stdout).toMatch(/\[stripe\] succeeded[\s\S]*retain\s+invoice\s+3\s/);
    expect(stdout).toMatch(/\[auth0\] succeeded[\s\S]*delete\s+user\s+1/);
    expect(findPii(stdout)).toEqual([]);
    expect(stdout).not.toContain(stripe.validKey);
  });

  it('exits 3 on partial failure and accepts --saas-identity for the retry', async () => {
    stripe.fail('POST /v1/customers/', 500, 99);
    const first = await run(['delete', '--subject', '1', '--apply']);
    expect(first.code).toBe(EXIT_PARTIAL);
    expect(first.stdout).toMatch(/^PARTIAL FAILURE/);
    expect(first.stdout).toContain('hint: Re-run to retry stripe');

    stripe.clearFaults();
    const retry = await run([
      'delete',
      '--subject',
      '1',
      '--apply',
      '--saas-identity',
      'stripe.customerId=cus_Alice00000001',
    ]);
    expect(retry.code).toBe(0);
    expect(stripe.customers.get('cus_Alice00000001')?.email).toBeNull();
    expect(retry.stdout).not.toContain('cus_Alice00000001');
  });

  it('rejects malformed --saas-identity values', async () => {
    const r = await run(['delete', '--subject', '1', '--saas-identity', 'stripe=cus_1']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--saas-identity must look like/);
  });
});
