import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  buildSchemaMetadata,
  diffLines,
  heuristicProposal,
  renderDiff,
  renderProposal,
} from '@stonekeep/ai';
import { createSaasConnectors, runDeletion } from '@stonekeep/connectors';
import {
  StonekeepError,
  VERSION,
  check,
  collectSchemaFields,
  createDataMap,
  errorMessage,
  loadConfig,
  readDataMap,
  scan,
} from '@stonekeep/core';
import { createPostgresConnector, loadEngineContext } from '@stonekeep/core/engine';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

type Env = Readonly<Record<string, string | undefined>>;

export interface StonekeepMcpOptions {
  /** Workspace root. Tools cannot read outside it. */
  cwd: string;
  env: Env;
}

export const TOOL_NAMES = ['scan_codebase', 'plan_compliance_yaml', 'dry_run_delete'] as const;

const INSTRUCTIONS = `Stonekeep maps personal data in this codebase and plans data-subject operations.
Use scan_codebase after changing schemas or migrations, plan_compliance_yaml to draft stonekeep.connector.yaml, and dry_run_delete to preview a deletion.
These tools never change data or files. There is intentionally no tool that executes a deletion: a human runs and approves deletions.
Stonekeep helps manage personal data; it does not guarantee legal compliance.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): CallToolResult {
  // Stonekeep errors are sanitized by design; anything else is reduced to its type.
  const message =
    error instanceof StonekeepError
      ? error.message
      : `Unexpected ${error instanceof Error ? error.name : 'error'}: ${error instanceof Error ? errorMessage(error).slice(0, 200) : ''}`;
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Resolve a user-supplied path and refuse anything outside the workspace. */
function inside(cwd: string, path: string | undefined): string {
  const abs = resolve(cwd, path ?? '.');
  const rel = relative(cwd, abs);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new StonekeepError('SAFETY', 'Path is outside the workspace');
  return abs;
}

/** The Stonekeep MCP server. Every tool is read-only; none executes a deletion. */
export function createStonekeepMcpServer(options: StonekeepMcpOptions): McpServer {
  const { cwd, env } = options;
  const server = new McpServer(
    { name: 'stonekeep', version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    'scan_codebase',
    {
      title: 'Scan codebase for personal data',
      description:
        'Scan SQL migrations, Prisma, TypeORM and JSON/OpenAPI schemas for personal-data fields (rule-based, local). ' +
        'Returns the fields found and, if stonekeep-datamap.json exists, which ones are not mapped yet (what `stonekeep check` would fail on). Writes nothing.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Directory to scan, relative to the workspace (default ".")'),
      },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    ({ path }) => {
      try {
        const root = inside(cwd, path);
        const config = loadConfig(root);
        const result = scan(config);
        const datamap = existsSync(config.datamapPath)
          ? readDataMap(config.datamapPath)
          : undefined;
        const checked = datamap ? check(config, datamap) : undefined;
        return json({
          filesScanned: result.filesScanned,
          personalDataFields: result.fields.map((f) => ({
            id: f.id,
            category: f.category,
            rule: f.rule,
            confidence: f.confidence,
            location: `${f.location.file}:${f.location.line}`,
          })),
          datamap: datamap
            ? {
                path: relative(cwd, config.datamapPath),
                unmapped: checked?.unmapped.map((f) => f.id) ?? [],
                stale: checked?.stale.map((f) => f.id) ?? [],
              }
            : {
                path: null,
                hint: 'No stonekeep-datamap.json yet: run `stonekeep scan` to create it.',
              },
          warnings: result.warnings,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'plan_compliance_yaml',
    {
      title: 'Draft stonekeep.connector.yaml',
      description:
        'Draft a Stonekeep connector config (subject table, retain rules, soft foreign keys, masking strategies) from schema metadata ' +
        'using deterministic rules, and show it as a diff against the existing file. Returns YAML for review; never writes it. ' +
        'Uses names and types only; no data values are read.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Project root relative to the workspace (default ".")'),
        connector: z
          .string()
          .optional()
          .describe('Existing connector config to diff against (default stonekeep.connector.yaml)'),
      },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    ({ path, connector }) => {
      try {
        const root = inside(cwd, path);
        const config = loadConfig(root);
        const datamap = existsSync(config.datamapPath)
          ? readDataMap(config.datamapPath)
          : createDataMap(scan(config).fields);
        const metadata = buildSchemaMetadata({
          datamap,
          fields: collectSchemaFields(config).fields,
        });
        const connectorPath = inside(
          cwd,
          connector ?? relative(cwd, resolve(root, 'stonekeep.connector.yaml')),
        );
        const existingText = existsSync(connectorPath) ? readFileSync(connectorPath, 'utf8') : '';
        const existing: unknown = existingText ? parseYaml(existingText) : undefined;
        const rendered = renderProposal(
          heuristicProposal(metadata),
          metadata,
          typeof existing === 'object' && existing !== null
            ? (existing as Record<string, unknown>)
            : undefined,
        );
        return json({
          file: relative(cwd, connectorPath),
          saved: false,
          yaml: rendered.yaml,
          diff: renderDiff(diffLines(existingText, rendered.yaml), false),
          warnings: rendered.warnings,
          nextStep:
            'Show this to the user. They should review it and save it themselves, or run `stonekeep setup` to confirm interactively.',
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    'dry_run_delete',
    {
      title: 'Preview a deletion (dry run only)',
      description:
        'Preview what `stonekeep delete` would do for one subject across the database and configured SaaS connectors: rows per table, ' +
        'retained records, connectors involved. ALWAYS a dry run; this tool cannot delete or change anything. ' +
        'The report contains identifiers and counts only.',
      inputSchema: {
        subject: z.string().min(1).max(512).describe('Subject key, e.g. a user id'),
        mode: z.enum(['delete', 'anonymize']).optional(),
        connector: z
          .string()
          .optional()
          .describe(
            'Connector config relative to the workspace (default stonekeep.connector.yaml)',
          ),
      },
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    async ({ subject, mode, connector }) => {
      try {
        const ctx = loadEngineContext(inside(cwd, connector ?? 'stonekeep.connector.yaml'));
        const report = await runDeletion({
          database: createPostgresConnector(ctx, env),
          saas: await createSaasConnectors(ctx.connector.config.saas, env),
          subject,
          mode: mode ?? 'delete',
          dryRun: true, // hard-coded: agents can never execute a deletion through Stonekeep
        });
        return json({
          ...report,
          note: 'Dry run: nothing was changed. A human must run `stonekeep delete --apply` or approve it in the Stonekeep console.',
        });
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
