import { readFileSync } from 'node:fs';
import { connectorConfigSchema } from '@stonekeep/core/engine';
import { assertSafeToSend } from './guard.js';
import type { SchemaMetadata } from './metadata.js';
import { buildPrompt } from './prompt.js';
import type { Proposal } from './proposal.js';
import type { ProposalProvider } from './providers.js';
import { renderProposal } from './render.js';

export interface GoldenField {
  entity: string;
  field: string;
  type: string;
  rule: string | null;
  category?: string;
  expected: string;
}

export interface GoldenSet {
  subject: { table: string; key: string };
  retain: string[];
  fields: GoldenField[];
}

export const GOLDEN_PATH = new URL('../eval/golden.json', import.meta.url);

export function loadGolden(path: URL | string = GOLDEN_PATH): GoldenSet {
  return JSON.parse(readFileSync(path, 'utf8')) as GoldenSet;
}

/** The metadata the model sees for the golden set: names, types, classifications. */
export function goldenMetadata(golden: GoldenSet): SchemaMetadata {
  const entities = new Map<string, SchemaMetadata['entities'][number]>();
  for (const f of golden.fields) {
    let e = entities.get(f.entity);
    if (!e) {
      e = { name: f.entity, columns: [] };
      entities.set(f.entity, e);
    }
    e.columns.push({
      name: f.field,
      type: f.type,
      pii:
        f.rule === null
          ? null
          : { category: f.category ?? 'unknown', rule: f.rule, confidence: 0.9 },
    });
  }
  return { entities: [...entities.values()] };
}

export interface FieldResult {
  id: string;
  expected: string;
  actual: string;
  ok: boolean;
}

export interface EvalReport {
  provider: string;
  fields: FieldResult[];
  /** Share of the 30 fields whose strategy matches the golden answer. */
  fieldAccuracy: number;
  subjectCorrect: boolean;
  retainRecall: number;
  /** Retained tables that are not in the golden set. */
  retainExtra: string[];
  validConfig: boolean;
  hallucinations: number;
  durationMs: number;
}

/** Score one provider run against the golden set. */
export function scoreProposal(
  golden: GoldenSet,
  proposal: Proposal,
  provider = 'unknown',
  durationMs = 0,
): EvalReport {
  const metadata = goldenMetadata(golden);
  const strategy = new Map(proposal.mask.map((m) => [`${m.table}.${m.column}`, m.strategy]));
  const fields = golden.fields.map((f): FieldResult => {
    const id = `${f.entity}.${f.field}`;
    const actual = strategy.get(id) ?? 'keep';
    return { id, expected: f.expected, actual, ok: actual === f.expected };
  });
  const rendered = renderProposal(proposal, metadata);
  const retained = proposal.retain.map((r) => r.table);
  return {
    provider,
    fields,
    fieldAccuracy: fields.filter((f) => f.ok).length / fields.length,
    subjectCorrect:
      proposal.subject.table === golden.subject.table &&
      proposal.subject.key === golden.subject.key,
    retainRecall:
      golden.retain.length === 0
        ? 1
        : golden.retain.filter((t) => retained.includes(t)).length / golden.retain.length,
    retainExtra: retained.filter((t) => !golden.retain.includes(t)),
    validConfig: connectorConfigSchema.safeParse(rendered.config).success,
    hallucinations: rendered.warnings.filter((w) => w.includes('unknown')).length,
    durationMs,
  };
}

/** Run a provider on the golden set. The prompt goes through the privacy guard like a real run. */
export async function runEval(
  provider: ProposalProvider,
  golden: GoldenSet = loadGolden(),
): Promise<EvalReport> {
  const prompt = buildPrompt(goldenMetadata(golden));
  assertSafeToSend(prompt);
  const start = performance.now();
  const proposal = await provider.propose(prompt);
  return scoreProposal(golden, proposal, provider.name, Math.round(performance.now() - start));
}

export function formatReport(r: EvalReport): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  const misses = r.fields.filter((f) => !f.ok);
  return [
    `Provider:          ${r.provider}`,
    `Field accuracy:    ${pct(r.fieldAccuracy)} (${r.fields.length - misses.length}/${r.fields.length})`,
    `Subject correct:   ${r.subjectCorrect ? 'yes' : 'no'}`,
    `Retain recall:     ${pct(r.retainRecall)}${r.retainExtra.length ? ` (extra: ${r.retainExtra.join(', ')})` : ''}`,
    `Valid config:      ${r.validConfig ? 'yes' : 'no'}`,
    `Hallucinated refs: ${r.hallucinations}`,
    `Duration:          ${r.durationMs} ms`,
    ...(misses.length
      ? [
          '',
          'Mismatches:',
          ...misses.map(
            (m) => `  ${m.id.padEnd(32)} expected ${m.expected.padEnd(11)} got ${m.actual}`,
          ),
        ]
      : []),
    '',
  ].join('\n');
}
