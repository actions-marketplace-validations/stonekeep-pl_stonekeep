import { parseArgs } from 'node:util';
import { relative, resolve } from 'node:path';
import {
  StonekeepError,
  VERSION,
  check,
  createDataMap,
  errorMessage,
  loadConfig,
  readDataMap,
  scan,
  toSarif,
  writeDataMap,
  type CheckResult,
  type DataMapField,
} from '@stonekeep/core';
import { runEngineCommand } from './engine-commands.js';
import { runEvidenceCommand } from './evidence-commands.js';
import { runAiCommand } from './ai-commands.js';
import { runInitCommand } from './init-command.js';
import { runRopaCommand } from './ropa-commands.js';
import { runAdviceCommand, runDocumentsCommand } from './rodo-commands.js';

const ENGINE_COMMANDS = new Set(['discover', 'export', 'delete', 'mask', 'breach']);

export const EXIT_OK = 0;
export const EXIT_UNMAPPED = 1;
export const EXIT_ERROR = 2;

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Interactive prompt; only present when stdin is a terminal. */
  ask?: (question: string) => Promise<string>;
  color?: boolean;
}

async function askTerminal(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const defaultIo = (): Io => ({
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  cwd: process.cwd(),
  env: process.env,
  ...(process.stdin.isTTY ? { ask: askTerminal } : {}),
  color: process.stdout.isTTY && !('NO_COLOR' in process.env),
});

const DISCLAIMER =
  'Note: classification is heuristic and needs human review. Stonekeep helps you track personal data; it does not guarantee legal compliance.';

const HELP = `stonekeep ${VERSION} — find personal data fields in your schemas and keep them mapped.

Usage:
  stonekeep init [path]      Start here: scan, write datamap, config, ROPA template and CI workflow
  stonekeep scan [path]      Detect PII fields and write stonekeep-datamap.json
  stonekeep check [path]     Fail (exit 1) if the code has PII fields missing from the datamap
  stonekeep porady [path]    RODO advice for this project, with article references (alias: advise)
  stonekeep dokumenty [path] Polish RODO document pack in ./rodo: information clause, procedures, letters (alias: documents)
  stonekeep ropa [path]      Write the GDPR Art. 30 record of processing from stonekeep.ropa.yaml + datamap
  stonekeep discover         Show tables, relations and PII columns of the configured database
  stonekeep export           Export one subject's data as a ZIP (JSON + CSV + SHA-256 manifest)
  stonekeep delete           Delete (or --mode anonymize) one subject's data, honouring retain rules
  stonekeep mask             Clone production into staging with personal data replaced by fakes
  stonekeep breach --tables a,b   Breach impact (records, data subjects, categories) + Art. 33 draft
  stonekeep evidence export <subject>   Verifiable consent history (JSON chain segment)
  stonekeep evidence verify <file>      Verify an exported evidence segment
  stonekeep evidence verify-ledger      Verify the whole consent ledger (chain + signed head)
  stonekeep setup            Propose stonekeep.connector.yaml with AI from schema metadata (diff + confirm)
  stonekeep skill            Write SKILL.md (instructions for AI coding agents)

Options (scan):
  -c, --config <file>    Config file (default: <path>/stonekeep.config.json, optional)
  -o, --out <file>       Datamap output path (default: <path>/stonekeep-datamap.json)
      --dry-run          Print results without writing the datamap
      --json             Print machine-readable JSON

Options (check):
  -c, --config <file>    Config file
  -d, --datamap <file>   Datamap to compare against (default: <path>/stonekeep-datamap.json)
      --format <fmt>     text | json | github | sarif (default: github on GitHub Actions, else text)
      --strict           Also fail on stale entries and category changes

Options (init):
      --lang <l>         pl | en (default: pl)
      --ci <ci>          auto | github | gitlab | none (default: auto-detect)
      --force            Overwrite files that already exist
      --dry-run          Show what would be written

Options (porady):
      --lang <l>         pl | en (default: pl)
      --format <fmt>     text | markdown | json (default: text)
  -o, --out <file>       Write to a file
      --strict           Exit 1 when there is high-severity advice

Options (dokumenty):
  -o, --out <dir>        Output folder (default: <path>/rodo)
      --date <date>      Date printed on the documents, YYYY-MM-DD (default: today)
      --force            Overwrite existing files
      --dry-run          Show what would be written

Options (ropa):
      --init             Write a starter stonekeep.ropa.yaml listing every PII entity
      --ropa <file>      Activity file (default: <path>/stonekeep.ropa.yaml)
      --lang <l>         en | pl (default: the file's "language")
      --format <fmt>     markdown | json (default: markdown)
      --date <date>      "As of" date, YYYY-MM-DD (default: today)
  -o, --out <file>       Write to a file instead of stdout
      --strict           Exit 1 when the record has open points (e.g. PII tables no activity covers)

Options (breach):
      --tables <list>    Affected tables, comma-separated (repeatable)
      --discovered <ts>  When the breach was discovered, ISO 8601 (default: now); sets the 72-hour deadline
      --lang <l>         en | pl (default: en)
      --ropa <file>      DPO contact source (default: stonekeep.ropa.yaml next to the connector, if present)
  -o, --out <file>       Write the report to a file
      --json             Machine-readable impact instead of Markdown

Options (discover, export, delete, mask):
      --connector <file> Connector config (default: stonekeep.connector.yaml)
      --subject <key>    Subject key (export/delete); prefer --subject-env to keep it out of shell history
      --subject-env <V>  Read the subject key from environment variable V
      --mode <m>         delete | anonymize (delete; default: delete)
      --saas-identity <c.f=v>  External id for a SaaS connector, e.g. stripe.customerId=cus_123 (repeatable)
  -o, --out <file>       ZIP path (export)
      --apply            Actually change data (delete, mask); without it they are dry runs
      --truncate         Replace existing rows in the target (mask)
      --dry-run          Count only, write no file (export)
      --json             Machine-readable output

  -h, --help             Show help
  -v, --version          Show version

Database URLs and the mask secret are read from environment variables named in the connector config.
Output never contains data values or the subject key.

Exit codes: 0 ok, 1 unmapped personal data found, 2 usage, configuration, safety or database error,
            3 partial failure (some connectors failed; see the report).
Stonekeep runs locally and sends no telemetry.
`;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function fieldRows(fields: readonly DataMapField[]): string {
  const catW = Math.max(8, ...fields.map((f) => f.category.length));
  const idW = Math.max(5, ...fields.map((f) => f.id.length));
  return fields
    .map(
      (f) =>
        `  ${pad(f.category, catW)}  ${pad(f.id, idW)}  ${f.location.file}:${f.location.line}  (${f.rule}, ${f.confidence.toFixed(2)})\n`,
    )
    .join('');
}

/** GitHub Actions workflow command; escape per the runner's rules. */
function ghEscapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function ghEscapeProp(s: string): string {
  return ghEscapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}
function ghAnnotation(level: 'error' | 'warning', f: DataMapField, message: string): string {
  return `::${level} file=${ghEscapeProp(f.location.file)},line=${f.location.line},title=${ghEscapeProp('Stonekeep')}::${ghEscapeData(message)}\n`;
}

interface CommonFlags {
  config?: string | undefined;
}

function runScan(
  path: string,
  flags: CommonFlags & { out?: string | undefined; dryRun: boolean; json: boolean },
  io: Io,
): number {
  const root = resolve(io.cwd, path);
  const config = loadConfig(root, {
    configPath: flags.config !== undefined ? resolve(io.cwd, flags.config) : undefined,
    datamapPath: flags.out !== undefined ? resolve(io.cwd, flags.out) : undefined,
  });
  const result = scan(config);
  const map = createDataMap(result.fields);
  if (!flags.dryRun) writeDataMap(config.datamapPath, map);

  if (flags.json) {
    io.stdout(
      `${JSON.stringify(
        {
          filesScanned: result.filesScanned,
          schemaFields: result.schemaFieldCount,
          datamap: flags.dryRun ? null : config.datamapPath,
          warnings: result.warnings,
          fields: map.fields,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT_OK;
  }

  for (const w of result.warnings) io.stderr(`warning: ${w}\n`);
  io.stdout(
    `Stonekeep scan: ${result.filesScanned} files, ${result.schemaFieldCount} schema fields, ${map.fields.length} personal data fields\n`,
  );
  if (map.fields.length > 0) io.stdout(fieldRows(map.fields));
  const shown = relative(io.cwd, config.datamapPath) || config.datamapPath;
  io.stdout(flags.dryRun ? 'Dry run: datamap not written.\n' : `Wrote ${shown}\n`);
  io.stdout(`${DISCLAIMER}\n`);
  return EXIT_OK;
}

type Format = 'text' | 'json' | 'github' | 'sarif';

function printCheck(result: CheckResult, format: Format, strict: boolean, io: Io): void {
  if (format === 'sarif') {
    io.stdout(`${JSON.stringify(toSarif(result, strict), null, 2)}
`);
    return;
  }
  if (format === 'json') {
    io.stdout(
      `${JSON.stringify(
        {
          ok: result.ok,
          detected: result.detected,
          filesScanned: result.filesScanned,
          unmapped: result.unmapped,
          stale: result.stale,
          changed: result.changed.map(({ id, mapped, detected }) => ({ id, mapped, detected })),
          warnings: result.warnings,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (format === 'github') {
    for (const f of result.unmapped) {
      io.stdout(
        ghAnnotation(
          'error',
          f,
          `Unmapped personal data field "${f.id}" (category: ${f.category}, confidence ${f.confidence.toFixed(2)}). Run \`stonekeep scan\` and commit stonekeep-datamap.json, or add an override in stonekeep.config.json.`,
        ),
      );
    }
    for (const c of result.changed) {
      io.stdout(
        ghAnnotation(
          strict ? 'error' : 'warning',
          c.field,
          `"${c.id}" is mapped as ${c.mapped} but now detected as ${c.detected}.`,
        ),
      );
    }
  }

  for (const w of result.warnings) io.stderr(`warning: ${w}\n`);
  if (result.unmapped.length > 0) {
    io.stdout(
      `FAIL  Stonekeep check: ${result.unmapped.length} unmapped personal data field${result.unmapped.length === 1 ? '' : 's'}\n`,
    );
    io.stdout(fieldRows(result.unmapped));
    io.stdout(
      '\nTo resolve, either:\n' +
        '  - run `stonekeep scan` and commit the updated stonekeep-datamap.json (reviewers then see the new PII in the diff), or\n' +
        '  - add an entry under "overrides" in stonekeep.config.json (set "category", or "ignore": true if it is not personal data).\n',
    );
  }
  if (result.stale.length > 0) {
    io.stdout(
      `${strict ? 'FAIL' : 'WARN'}  ${result.stale.length} datamap entr${result.stale.length === 1 ? 'y no longer exists' : 'ies no longer exist'} in code (run \`stonekeep scan\` to refresh):\n`,
    );
    io.stdout(fieldRows(result.stale));
  }
  if (result.changed.length > 0) {
    io.stdout(
      `${strict ? 'FAIL' : 'WARN'}  ${result.changed.length} field${result.changed.length === 1 ? '' : 's'} changed category:\n`,
    );
    for (const c of result.changed) io.stdout(`  ${c.id}: ${c.mapped} -> ${c.detected}\n`);
  }
  if (result.ok) {
    io.stdout(
      `OK    Stonekeep check: ${result.detected} personal data fields detected, all mapped (${result.filesScanned} files scanned)\n`,
    );
  }
}

function runCheck(
  path: string,
  flags: CommonFlags & {
    datamap?: string | undefined;
    format?: string | undefined;
    strict: boolean;
  },
  io: Io,
): number {
  const format: Format =
    flags.format === undefined
      ? io.env.GITHUB_ACTIONS === 'true'
        ? 'github'
        : 'text'
      : (flags.format as Format);
  if (!['text', 'json', 'github', 'sarif'].includes(format)) {
    io.stderr(
      `error: unknown --format "${String(flags.format)}" (expected text, json, github or sarif)\n`,
    );
    return EXIT_ERROR;
  }
  const root = resolve(io.cwd, path);
  const config = loadConfig(root, {
    configPath: flags.config !== undefined ? resolve(io.cwd, flags.config) : undefined,
    datamapPath: flags.datamap !== undefined ? resolve(io.cwd, flags.datamap) : undefined,
  });
  const datamap = readDataMap(config.datamapPath);
  const result = check(config, datamap, { strict: flags.strict });
  printCheck(result, format, flags.strict, io);
  return result.ok ? EXIT_OK : EXIT_UNMAPPED;
}

/** CLI entry point. Returns the process exit code; never calls `process.exit`. */
export async function main(argv: readonly string[], io: Io = defaultIo()): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', short: 'c' },
        out: { type: 'string', short: 'o' },
        datamap: { type: 'string', short: 'd' },
        format: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        connector: { type: 'string' },
        subject: { type: 'string' },
        'subject-env': { type: 'string' },
        'saas-identity': { type: 'string', multiple: true },
        mode: { type: 'string' },
        apply: { type: 'boolean', default: false },
        truncate: { type: 'boolean', default: false },
        model: { type: 'string' },
        offline: { type: 'boolean', default: false },
        ropa: { type: 'string' },
        lang: { type: 'string' },
        date: { type: 'string' },
        init: { type: 'boolean', default: false },
        ci: { type: 'string' },
        force: { type: 'boolean', default: false },
        tables: { type: 'string', multiple: true },
        discovered: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    io.stderr(`error: ${errorMessage(error)}\n\n${HELP}`);
    return EXIT_ERROR;
  }

  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return EXIT_OK;
  }
  const [command, ...rest] = positionals;
  const isEngine = command !== undefined && ENGINE_COMMANDS.has(command);
  const isEvidence = command === 'evidence';
  const isAi = command === 'setup' || command === 'skill';
  const [path = '.', ...extra] = isEngine || isEvidence || isAi ? ['.'] : rest;
  if (values.help || command === undefined || command === 'help') {
    io.stdout(HELP);
    return command === undefined && !values.help ? EXIT_ERROR : EXIT_OK;
  }
  if (extra.length > 0) {
    io.stderr(`error: unexpected arguments: ${extra.join(' ')}\n`);
    return EXIT_ERROR;
  }

  try {
    if (command === 'setup' || command === 'skill') {
      if (rest.length > 0) {
        io.stderr(`error: unexpected arguments: ${rest.join(' ')}\n`);
        return EXIT_ERROR;
      }
      return await runAiCommand(
        command,
        {
          connector: values.connector,
          datamap: values.datamap,
          model: values.model,
          out: values.out,
          offline: values.offline,
        },
        io,
      );
    }
    if (isEvidence) {
      return await runEvidenceCommand(
        rest,
        {
          connector: values.connector,
          subject: values.subject,
          subjectEnv: values['subject-env'],
          out: values.out,
          json: values.json,
        },
        io,
      );
    }
    if (isEngine) {
      if (rest.length > 0) {
        io.stderr(`error: unexpected arguments: ${rest.join(' ')}\n`);
        return EXIT_ERROR;
      }
      return await runEngineCommand(
        command,
        {
          connector: values.connector,
          subject: values.subject,
          subjectEnv: values['subject-env'],
          saasIdentity: values['saas-identity'],
          mode: values.mode,
          out: values.out,
          apply: values.apply,
          dryRun: values['dry-run'],
          truncate: values.truncate,
          json: values.json,
          tables: values.tables,
          discovered: values.discovered,
          lang: values.lang,
          ropa: values.ropa,
        },
        io,
      );
    }
    switch (command) {
      case 'scan':
        return runScan(
          path,
          { config: values.config, out: values.out, dryRun: values['dry-run'], json: values.json },
          io,
        );
      case 'check':
        return runCheck(
          path,
          {
            config: values.config,
            datamap: values.datamap,
            format: values.format,
            strict: values.strict,
          },
          io,
        );
      case 'porady':
      case 'advise':
        return runAdviceCommand(
          path,
          {
            config: values.config,
            lang: values.lang,
            format: values.format,
            out: values.out,
            strict: values.strict,
          },
          io,
        );
      case 'dokumenty':
      case 'documents':
        return runDocumentsCommand(
          path,
          {
            config: values.config,
            out: values.out,
            date: values.date,
            force: values.force,
            dryRun: values['dry-run'],
          },
          io,
        );
      case 'init':
        return runInitCommand(
          path,
          { lang: values.lang, ci: values.ci, dryRun: values['dry-run'], force: values.force },
          io,
        );
      case 'ropa':
        return runRopaCommand(
          path,
          {
            config: values.config,
            datamap: values.datamap,
            ropa: values.ropa,
            lang: values.lang,
            format: values.format,
            out: values.out,
            date: values.date,
            init: values.init,
            strict: values.strict,
          },
          io,
        );
      default:
        io.stderr(`error: unknown command "${command}"\n\n${HELP}`);
        return EXIT_ERROR;
    }
  } catch (error) {
    if (error instanceof StonekeepError) {
      io.stderr(`error: ${error.message}\n`);
      return EXIT_ERROR;
    }
    throw error;
  }
}
