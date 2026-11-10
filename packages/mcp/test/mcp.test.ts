import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findPii,
  loadFixture,
  sql,
  startHarness,
  type PgHarness,
} from '../../core/test/integration/harness.js';
import { TOOL_NAMES, createStonekeepMcpServer } from '../src/index.js';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
let workspace: string;
let harness: PgHarness;
let dbUrl: string;

async function connect(env: Record<string, string> = {}): Promise<Client> {
  const server = createStonekeepMcpServer({ cwd: workspace, env });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; data: unknown; text: string }> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text: string }[];
  const text = content[0]?.text ?? '';
  let data: unknown = undefined;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    data = undefined;
  }
  return { isError: res.isError === true, data, text };
}

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'stonekeep-mcp-'));
  cpSync(join(FIXTURES, 'postgres-shop'), join(workspace, 'shop'), { recursive: true });
  cpSync(join(FIXTURES, 'sql-migrations'), join(workspace, 'migrations-app'), { recursive: true });
  harness = await startHarness();
  dbUrl = await harness.newDatabase();
  await loadFixture(dbUrl);
});
afterAll(async () => {
  await harness.stop();
  rmSync(workspace, { recursive: true, force: true });
});

describe('Stonekeep MCP server', () => {
  it('exposes exactly scan_codebase, plan_compliance_yaml and dry_run_delete, all read-only', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.inputSchema.properties ?? {}).not.toHaveProperty('apply');
      expect(t.inputSchema.properties ?? {}).not.toHaveProperty('dryRun');
    }
    // No tool executes deletions, masking, approvals or writes.
    const actionable = tools.filter((t) => !t.name.startsWith('dry_run_'));
    expect(
      actionable.some((t) =>
        /(^|_)(delete|apply|execute|approve|mask|write|save)(_|$)/.test(t.name),
      ),
    ).toBe(false);
    expect(client.getInstructions()).toMatch(/no tool that executes a deletion/);
  });

  it('scan_codebase finds personal data and reports what stonekeep check would fail on', async () => {
    const client = await connect();
    writeFileSync(
      join(workspace, 'migrations-app', 'migrations', '011_passport.sql'),
      'ALTER TABLE users ADD COLUMN passport_number TEXT;\n',
    );
    const { isError, data } = await call(client, 'scan_codebase', { path: 'migrations-app' });
    expect(isError).toBe(false);
    const result = data as {
      personalDataFields: { id: string }[];
      datamap: { unmapped: string[] };
    };
    expect(result.personalDataFields.map((f) => f.id)).toEqual(
      expect.arrayContaining(['users.email', 'users.phone']),
    );
    expect(result.datamap.unmapped).toEqual(['users.passport_number']);
  });

  it('refuses paths outside the workspace', async () => {
    const client = await connect();
    const r = await call(client, 'scan_codebase', { path: '../..' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/outside the workspace/);
  });

  it('plan_compliance_yaml drafts a valid config and does not write it', async () => {
    const client = await connect();
    const { isError, data } = await call(client, 'plan_compliance_yaml', {
      path: 'shop',
      connector: 'shop/stonekeep.connector.yaml',
    });
    expect(isError).toBe(false);
    const plan = data as { yaml: string; diff: string; saved: boolean };
    expect(plan.saved).toBe(false);
    expect(plan.yaml).toMatch(/subject:\n {2}table: users\n {2}key: id/);
    expect(plan.yaml).toMatch(/invoices:\n\s+retain:/);
    expect(plan.diff).toMatch(/^[ +-] /m);
    // The existing hand-written file is untouched.
    expect(readFileSync(join(workspace, 'shop', 'stonekeep.connector.yaml'), 'utf8')).toBe(
      readFileSync(join(FIXTURES, 'postgres-shop', 'stonekeep.connector.yaml'), 'utf8'),
    );
    expect(findPii(plan)).toEqual([]);
  });

  it('dry_run_delete previews a deletion and can never execute one', async () => {
    const client = await connect({ STONEKEEP_DATABASE_URL: dbUrl });
    // An agent trying to force execution: extra arguments are ignored, the run is still a dry run.
    const { isError, data } = await call(client, 'dry_run_delete', {
      subject: '1',
      connector: 'shop/stonekeep.connector.yaml',
      apply: true,
      dryRun: false,
    });
    expect(isError).toBe(false);
    const report = data as {
      dryRun: boolean;
      status: string;
      connectors: {
        connector: string;
        database?: { steps: { table: string; action: string; rows: number }[] };
      }[];
    };
    expect(report.dryRun).toBe(true);
    expect(report.status).toBe('completed');
    expect(report.connectors[0]?.database?.steps).toContainEqual(
      expect.objectContaining({ table: 'users', action: 'delete', rows: 1 }),
    );
    expect(await sql(dbUrl, 'SELECT id FROM users WHERE id = 1')).toHaveLength(1);
    expect(findPii(report)).toEqual([]);
    expect(existsSync(join(workspace, 'shop', 'stonekeep-consent.db'))).toBe(false);
  });

  it('reports configuration problems as tool errors without leaking secrets', async () => {
    const client = await connect();
    const r = await call(client, 'dry_run_delete', {
      subject: '1',
      connector: 'shop/stonekeep.connector.yaml',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/STONEKEEP_DATABASE_URL/);
  });
});
