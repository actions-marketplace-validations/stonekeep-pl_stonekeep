import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DataMap } from '@stonekeep/core';
import {
  PrivacyGuardError,
  buildPrompt,
  buildSchemaMetadata,
  createAnthropicProvider,
  heuristicProposal,
  inspectPayload,
  runSetup,
  type FindingKind,
  type Proposal,
} from '../src/index.js';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/postgres-shop/', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fetch spy standing in for the network: records every call. */
function networkSpy(response?: unknown) {
  return vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(
      new Response(JSON.stringify(response ?? {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

const field = (entity: string, name: string): DataMap['fields'][number] => ({
  id: `${entity}.${name}`,
  entity,
  field: name,
  category: 'contact',
  rule: 'email',
  confidence: 0.9,
  source: 'sql',
  location: { file: 'schema.sql', line: 1 },
});

describe('privacy filter: detection', () => {
  it.each<[FindingKind, string]>([
    ['email', 'jane.doe@example.com'],
    ['phone', '+44 20 7946 0958'],
    ['phone', '(415) 555-0199'],
    ['ipv4', '198.51.100.23'],
    ['ipv6', '2001:db8:85a3::8a2e:370:7334'],
    ['credit_card', '4111 1111 1111 1111'],
    ['iban', 'GB82WEST12345698765432'],
    ['national_id', '123-45-6789'],
    ['date', '1990-05-04'],
    ['number_sequence', '4155550199123'],
    ['secret', 'sk_live_51HxYzAbCdEfGhIjKl'],
    ['secret', 'sk-ant-api03-abcdefghijklmnop'],
    ['secret', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghij'],
    ['url_credentials', 'postgres://admin:hunter2@db.internal/prod'],
  ])('flags %s in %s', (kind, value) => {
    expect(inspectPayload({ nested: [{ note: `value: ${value}` }] }).map((f) => f.kind)).toContain(
      kind,
    );
  });

  it('does not flag ordinary schema metadata', () => {
    const metadata = {
      entities: [
        {
          name: 'users',
          columns: [
            {
              name: 'email',
              type: 'varchar(255)',
              pii: { category: 'contact', rule: 'email', confidence: 0.95 },
            },
            { name: 'phone_number', type: 'text', pii: null },
            { name: 'last_login_ip', type: 'inet', pii: null },
            { name: 'created_at', type: 'timestamp with time zone', pii: null },
            { name: 'latitude', type: 'numeric(9,6)', pii: null },
            { name: 'invoice_id', type: 'string | null', pii: null },
          ],
        },
      ],
    };
    expect(inspectPayload(metadata)).toEqual([]);
    expect(inspectPayload(buildPrompt(metadata))).toEqual([]);
  });

  it('reports paths and kinds, never the matched value', () => {
    try {
      buildSchemaMetadata({
        datamap: { version: 1, fields: [field('users', 'alice@corp.example')] },
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PrivacyGuardError);
      expect(String(error)).not.toContain('alice@corp.example');
      expect((error as PrivacyGuardError).findings).toContainEqual({
        kind: 'identifier',
        path: '$.datamap.fields[0].field',
      });
    }
  });
});

describe('privacy filter: blocks network requests', () => {
  const proposal: Proposal = {
    subject: { table: 'users', key: 'id' },
    retain: [],
    foreignKeys: [],
    mask: [{ table: 'users', column: 'email', strategy: 'email' }],
    exclude: [],
    notes: [],
  };
  const messageResponse = (p: Proposal, stop = 'end_turn') => ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: JSON.stringify(p) }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });

  it.each([
    ['an email', 'customer jane.doe@example.com'],
    ['a phone number', 'call +1 (415) 555-0199'],
    ['an IP address', 'last seen 203.0.113.77'],
    ['a card number', '4111-1111-1111-1111'],
    ['an API key', 'sk_test_51HxYzAbCdEfGhIjKl'],
  ])('refuses to call the API when the prompt contains %s', async (_label, pii) => {
    const fetchSpy = networkSpy(messageResponse(proposal));
    const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchSpy });
    await expect(
      provider.propose({ system: 'sys', user: `Schema metadata: users.notes example "${pii}"` }),
    ).rejects.toBeInstanceOf(PrivacyGuardError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stonekeep setup stops before any request when the datamap carries PII-like identifiers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stonekeep-guard-'));
    dirs.push(dir);
    cpSync(FIXTURE, dir, { recursive: true });
    const dm = JSON.parse(readFileSync(join(dir, 'stonekeep-datamap.json'), 'utf8')) as DataMap;
    dm.fields.push(field('users', 'bob_555_0199_backup'), field('crm', '4111111111111111'));
    writeFileSync(join(dir, 'stonekeep-datamap.json'), JSON.stringify(dm));
    const fetchSpy = networkSpy(messageResponse(proposal));
    await expect(
      runSetup({
        root: dir,
        datamapPath: join(dir, 'stonekeep-datamap.json'),
        connectorPath: join(dir, 'new.yaml'),
        provider: createAnthropicProvider({ apiKey: 'test-key', fetch: fetchSpy }),
        io: { stdout: () => undefined, stderr: () => undefined },
      }),
    ).rejects.toBeInstanceOf(PrivacyGuardError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends clean metadata once, with structured outputs and server-side fallback', async () => {
    const metadata = buildSchemaMetadata({
      datamap: { version: 1, fields: [field('users', 'email')] },
    });
    const fetchSpy = networkSpy(messageResponse(heuristicProposal(metadata)));
    const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchSpy });
    const result = await provider.propose(buildPrompt(metadata));
    expect(result.subject).toEqual({ table: 'users', key: 'id' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url instanceof Request ? url.url : url?.toString()).toMatch(/\/v1\/messages/);
    const body = JSON.parse(init?.body as string) as {
      model: string;
      fallbacks: string;
      output_config: { format: { type: string; schema: object } };
      messages: { content: string }[];
    };
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.fallbacks).toBe('default');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(new Headers(init?.headers).get('anthropic-beta')).toContain(
      'server-side-fallback-2026-07-01',
    );
    expect(inspectPayload(body)).toEqual([]);
  });

  it('surfaces refusals instead of returning a partial proposal', async () => {
    const fetchSpy = networkSpy(messageResponse(proposal, 'refusal'));
    const provider = createAnthropicProvider({ apiKey: 'test-key', fetch: fetchSpy });
    await expect(provider.propose({ system: 's', user: '{"entities":[]}' })).rejects.toThrow(
      /declined/,
    );
  });
});
