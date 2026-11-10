import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StonekeepError, collectSchemaFields, loadConfig, readDataMap } from '@stonekeep/core';
import { parse as parseYaml } from 'yaml';
import { diffLines, renderDiff } from './diff.js';
import { buildSchemaMetadata, type SchemaMetadata } from './metadata.js';
import { buildPrompt } from './prompt.js';
import type { ProposalProvider } from './providers.js';
import { renderProposal } from './render.js';

export interface SetupIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Ask the user; resolves with their raw answer. Absent when not interactive. */
  ask?: (question: string) => Promise<string>;
  color?: boolean;
}

export interface SetupOptions {
  /** Repository root (for schema field context and stonekeep.config.json). */
  root: string;
  datamapPath: string;
  connectorPath: string;
  provider: ProposalProvider | ((metadata: SchemaMetadata) => ProposalProvider);
  io: SetupIo;
}

export interface SetupResult {
  saved: boolean;
  yaml: string;
  warnings: string[];
  changed: boolean;
}

/**
 * `stonekeep setup`: datamap -> schema metadata (guarded) -> provider ->
 * validated YAML -> diff -> explicit "Y" -> save. Never saves without an
 * explicit yes, and never in a non-interactive session.
 */
export async function runSetup(options: SetupOptions): Promise<SetupResult> {
  const { io } = options;
  const datamap = readDataMap(options.datamapPath);
  const fields = collectSchemaFields(loadConfig(options.root)).fields;
  const metadata = buildSchemaMetadata({ datamap, fields });
  const provider =
    typeof options.provider === 'function' ? options.provider(metadata) : options.provider;

  const columns = metadata.entities.reduce((n, e) => n + e.columns.length, 0);
  io.stderr(
    `Sending schema metadata only (${metadata.entities.length} entities, ${columns} columns; no data values) to ${provider.name}...\n`,
  );
  const proposal = await provider.propose(buildPrompt(metadata));

  let existingText = '';
  let existing: Record<string, unknown> | undefined;
  if (existsSync(options.connectorPath)) {
    existingText = readFileSync(options.connectorPath, 'utf8');
    const parsed: unknown = parseYaml(existingText);
    if (typeof parsed === 'object' && parsed !== null) existing = parsed as Record<string, unknown>;
  }
  const rendered = renderProposal(proposal, metadata, existing);
  for (const w of rendered.warnings) io.stderr(`warning: ${w}\n`);

  const diff = diffLines(existingText, rendered.yaml);
  const changed = diff.some((l) => l.op !== ' ');
  io.stdout(`\nProposed changes to ${options.connectorPath}:\n\n`);
  io.stdout(renderDiff(diff, io.color === true));
  if (!changed) {
    io.stdout('\nNo changes.\n');
    return { saved: false, yaml: rendered.yaml, warnings: rendered.warnings, changed };
  }
  if (rendered.warnings.some((w) => w.startsWith('invalid:'))) {
    throw new StonekeepError(
      'CONFIG',
      'The proposal is not a valid connector config; nothing was saved',
    );
  }
  if (!io.ask) {
    io.stdout(
      '\nNot an interactive terminal: nothing was saved. Re-run in a terminal to confirm.\n',
    );
    return { saved: false, yaml: rendered.yaml, warnings: rendered.warnings, changed };
  }
  const answer = (
    await io.ask('\nSave these changes? Type Y to save, anything else to cancel: ')
  ).trim();
  if (answer !== 'Y' && answer !== 'y') {
    io.stdout('Cancelled: nothing was saved.\n');
    return { saved: false, yaml: rendered.yaml, warnings: rendered.warnings, changed };
  }
  writeFileSync(options.connectorPath, rendered.yaml, 'utf8');
  io.stdout(
    `Saved ${options.connectorPath}. Review it, then run \`stonekeep discover\` to check it against the database.\n`,
  );
  return { saved: true, yaml: rendered.yaml, warnings: rendered.warnings, changed };
}
