import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { errorMessage } from '@stonekeep/core';
import { formatReport, goldenMetadata, loadGolden, runEval } from './eval.js';
import { heuristicProvider } from './heuristic.js';
import { DEFAULT_MODEL, createAnthropicProvider } from './providers.js';

/**
 * Evaluate the setup-assistant prompt on the golden set.
 *   node dist/eval-cli.js --provider anthropic [--model claude-opus-5-5] [--runs 3] [--min 0.85] [--out report.json]
 *   node dist/eval-cli.js --provider heuristic      (offline baseline, free)
 * The anthropic provider makes real API calls (one per run) and is billed.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'heuristic' },
      model: { type: 'string', default: DEFAULT_MODEL },
      runs: { type: 'string', default: '1' },
      min: { type: 'string', default: '0.85' },
      out: { type: 'string' },
    },
  });
  const golden = loadGolden();
  const provider =
    values.provider === 'anthropic'
      ? createAnthropicProvider({ model: values.model })
      : heuristicProvider(goldenMetadata(golden));
  const runs = Math.max(1, Number(values.runs));
  const reports = [];
  for (let i = 0; i < runs; i++) {
    const r = await runEval(provider, golden);
    reports.push(r);
    process.stdout.write(`Run ${i + 1}/${runs}\n${formatReport(r)}\n`);
  }
  const mean = reports.reduce((n, r) => n + r.fieldAccuracy, 0) / reports.length;
  process.stdout.write(
    `Mean field accuracy over ${runs} run(s): ${(mean * 100).toFixed(1)}% (threshold ${(Number(values.min) * 100).toFixed(0)}%)\n`,
  );
  if (values.out) writeFileSync(values.out, `${JSON.stringify(reports, null, 2)}\n`);
  return mean >= Number(values.min) && reports.every((r) => r.validConfig) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`error: ${errorMessage(error)}\n`);
    process.exitCode = 2;
  },
);
