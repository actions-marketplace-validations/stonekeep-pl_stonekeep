import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { StonekeepError, ROPA_FILENAME, readRopaFile, renderBreachMarkdown } from '@stonekeep/core';
import type {
  DeleteMode,
  DeleteResult,
  DiscoveryResult,
  EngineLogger,
  ExportResult,
  MaskResult,
  PostgresConnector,
} from '@stonekeep/core/engine';
import type { DeletionReport, SubjectIdentity } from '@stonekeep/connectors';
import { openConfiguredLedger } from './evidence-commands.js';
import type { Io } from './index.js';

/** Some connectors failed while others succeeded (see the report). */
export const EXIT_PARTIAL = 3;

export interface EngineFlags {
  connector?: string | undefined;
  subject?: string | undefined;
  subjectEnv?: string | undefined;
  /** `<connector>.<field>=<value>`, repeatable. */
  saasIdentity?: string[] | undefined;
  mode?: string | undefined;
  out?: string | undefined;
  apply: boolean;
  dryRun: boolean;
  truncate: boolean;
  json: boolean;
  /** breach: comma-separated affected tables (repeatable). */
  tables?: string[] | undefined;
  /** breach: when the breach was discovered (ISO 8601). */
  discovered?: string | undefined;
  /** breach: report language. */
  lang?: string | undefined;
  /** breach: ROPA file for the DPO contact (default: stonekeep.ropa.yaml next to the connector). */
  ropa?: string | undefined;
}

const DRY_RUN_NOTE = 'DRY RUN: nothing was changed. Re-run with --apply to execute.';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The subject key is personal data: accept it from a flag or an env var, never print it. */
function subjectFrom(flags: EngineFlags, io: Io): string {
  if (flags.subject !== undefined && flags.subjectEnv !== undefined) {
    throw new StonekeepError('CONFIG', 'Use either --subject or --subject-env, not both');
  }
  const value = flags.subjectEnv !== undefined ? io.env[flags.subjectEnv] : flags.subject;
  if (value === undefined || value.length === 0) {
    throw new StonekeepError(
      'CONFIG',
      flags.subjectEnv !== undefined
        ? `Environment variable ${flags.subjectEnv} (subject key) is not set`
        : 'Missing --subject <key> (or --subject-env <VAR>)',
    );
  }
  return value;
}

function printDiscovery(r: DiscoveryResult, io: Io): void {
  io.stdout(`Schema "${r.schema}", subject ${r.subject.table}.${r.subject.key}\n`);
  const w = Math.max(5, ...r.tables.map((t) => t.name.length));
  for (const t of r.tables) {
    const pii = t.columns.filter((c) => c.pii).map((c) => `${c.name}:${c.pii?.category ?? ''}`);
    io.stdout(
      `  ${pad(t.name, w)}  ${pad(t.role, 12)}  ${pii.length > 0 ? `PII ${pii.join(', ')}` : ''}\n`.replace(
        /\s+\n$/,
        '\n',
      ),
    );
  }
  const soft = r.foreignKeys.filter((fk) => fk.source === 'config');
  if (soft.length > 0) {
    io.stdout(
      `Config relations: ${soft.map((fk) => `${fk.table}(${fk.columns.join(',')}) -> ${fk.refTable}`).join('; ')}\n`,
    );
  }
  if (r.unmatchedDatamap.length > 0) {
    io.stdout(`Datamap entries with no matching column: ${r.unmatchedDatamap.join(', ')}\n`);
  }
}

function printDelete(r: DeleteResult, io: Io): void {
  io.stdout(`${r.mode === 'delete' ? 'Delete' : 'Anonymize'} plan for subject (key not shown):\n`);
  const w = Math.max(5, ...r.steps.map((s) => s.table.length));
  for (const s of r.steps) {
    const cols = s.columns.length > 0 ? `  [${s.columns.join(', ')}]` : '';
    const reason = s.reason !== undefined ? `  (${s.reason})` : '';
    const line = `  ${pad(s.action, 9)}  ${pad(s.table, w)}  ${pad(plural(s.rows, 'row'), 9)}${cols}${reason}`;
    io.stdout(`${line.trimEnd()}\n`);
  }
  for (const s of r.skipped) io.stdout(`  skipped    ${s.table}.${s.column}: ${s.reason}\n`);
  io.stdout(
    `${r.dryRun ? DRY_RUN_NOTE : `Done: ${plural(r.totalRows, 'row')} affected in one transaction.`}\n`,
  );
}

/** `stripe.customerId=cus_123` -> `{ stripe: { customerId: 'cus_123' } }`. Values are never printed. */
function parseSaasIdentities(
  values: readonly string[] | undefined,
): Record<string, SubjectIdentity> {
  const out: Record<string, SubjectIdentity> = {};
  for (const v of values ?? []) {
    const m = /^([a-z][a-z0-9_-]*)\.([A-Za-z][A-Za-z0-9]*)=(.+)$/.exec(v);
    if (!m?.[1] || !m[2] || m[3] === undefined) {
      throw new StonekeepError(
        'CONFIG',
        '--saas-identity must look like <connector>.<field>=<value>, e.g. stripe.customerId=cus_123',
      );
    }
    out[m[1]] = { ...out[m[1]], [m[2]]: m[3] };
  }
  return out;
}

function printDeletionReport(r: DeletionReport, io: Io): void {
  const label = { completed: 'COMPLETED', partial: 'PARTIAL FAILURE', failed: 'FAILED' }[r.status];
  io.stdout(
    `${label}  ${r.mode} across ${plural(r.connectors.length, 'connector')} (${r.durationMs} ms)${r.dryRun ? ', dry run' : ''}\n\n`,
  );
  for (const c of r.connectors) {
    io.stdout(`[${c.connector}] ${c.status} (${c.durationMs} ms)\n`);
    if (c.database) printDelete(c.database, io);
    for (const s of c.steps ?? [])
      io.stdout(`  ${pad(s.action, 9)}  ${pad(s.resource, 15)}  ${s.count}\n`);
    for (const k of c.retained ?? [])
      io.stdout(`  retain     ${pad(k.resource, 15)}  ${k.count}  (${k.reason})\n`);
    if (c.note !== undefined) io.stdout(`  note: ${c.note}\n`);
    if (c.error) io.stdout(`  error: ${c.error.message}\n`);
    io.stdout('\n');
  }
  for (const h of r.hints) io.stdout(`hint: ${h}\n`);
  if (r.dryRun) io.stdout(`${DRY_RUN_NOTE}\n`);
}

function printExport(r: ExportResult, io: Io): void {
  const w = Math.max(5, ...r.tables.map((t) => t.table.length));
  for (const t of r.tables) io.stdout(`  ${pad(t.table, w)}  ${plural(t.rows, 'row')}\n`);
  if (r.dryRun || r.file === undefined) {
    io.stdout(`Dry run: ${plural(r.totalRows, 'row')} would be exported; no file written.\n`);
  } else {
    const shown = relative(io.cwd, r.file) || r.file;
    io.stdout(`Wrote ${shown} (${plural(r.bytes ?? 0, 'byte')}, sha256 ${r.sha256 ?? ''})\n`);
    io.stdout(
      "The archive contains the subject's personal data: deliver it securely and delete local copies.\n",
    );
  }
}

function printMask(r: MaskResult, io: Io): void {
  const w = Math.max(5, ...r.tables.map((t) => t.table.length));
  for (const t of r.tables) {
    const masked = t.masked.map((m) => `${m.column}=${m.strategy}`).join(', ');
    io.stdout(
      `  ${pad(t.table, w)}  ${pad(plural(t.rows, 'row'), 10)}  ${masked ? `mask ${masked}` : 'copy as-is'}\n`,
    );
  }
  if (r.skippedTables.length > 0) io.stdout(`Not copied: ${r.skippedTables.join(', ')}\n`);
  io.stdout(
    `${r.dryRun ? DRY_RUN_NOTE : `Done: ${plural(r.totalRows, 'row')} copied to the target with personal data masked.`}\n`,
  );
}

/** `stonekeep breach --tables a,b`: impact of a breach plus a draft Art. 33 notification. */
async function runBreach(
  connector: PostgresConnector,
  connectorPath: string,
  flags: EngineFlags,
  io: Io,
): Promise<number> {
  const tables = (flags.tables ?? [])
    .flatMap((t) => t.split(','))
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tables.length === 0) {
    throw new StonekeepError('CONFIG', 'Missing --tables <table,table,...> (the affected tables)');
  }
  const lang = flags.lang ?? 'en';
  if (lang !== 'en' && lang !== 'pl') {
    throw new StonekeepError('CONFIG', `unknown --lang "${lang}" (expected en or pl)`);
  }
  let discoveredAt = new Date();
  if (flags.discovered !== undefined) {
    discoveredAt = new Date(flags.discovered);
    if (Number.isNaN(discoveredAt.getTime())) {
      throw new StonekeepError(
        'CONFIG',
        `--discovered must be an ISO date-time, e.g. 2026-11-08T09:30:00Z, got "${flags.discovered}"`,
      );
    }
  }

  const impact = await connector.assessBreach(tables, { discoveredAt });

  // DPO and controller contact for the draft, from the ROPA file when there is one.
  const ropaPath =
    flags.ropa !== undefined
      ? resolve(io.cwd, flags.ropa)
      : join(dirname(connectorPath), ROPA_FILENAME);
  const ropa =
    flags.ropa !== undefined || existsSync(ropaPath) ? readRopaFile(ropaPath) : undefined;

  const output = flags.json
    ? `${JSON.stringify(impact, null, 2)}\n`
    : renderBreachMarkdown(impact, {
        language: lang,
        ...(ropa?.dpo ? { dpo: ropa.dpo } : {}),
        ...(ropa ? { controller: ropa.controller } : {}),
      });
  if (flags.out !== undefined) {
    const file = resolve(io.cwd, flags.out);
    writeFileSync(file, output);
    io.stdout(
      `Wrote ${relative(io.cwd, file) || file}: ${plural(impact.records, 'record')}, ${
        impact.subjects.min === impact.subjects.max
          ? impact.subjects.min
          : `${impact.subjects.min}-${impact.subjects.max}`
      } data subjects, risk ${impact.risk}. Notify the supervisory authority by ${impact.notifyBy}.\n`,
    );
  } else {
    io.stdout(output);
  }
  return 0;
}

export async function runEngineCommand(
  command: string,
  flags: EngineFlags,
  io: Io,
): Promise<number> {
  const engine = await import('@stonekeep/core/engine');
  const connectorPath = resolve(io.cwd, flags.connector ?? engine.CONNECTOR_CONFIG_FILENAME);
  const ctx = engine.loadEngineContext(connectorPath);
  if (!ctx.datamapFound && !flags.json) {
    io.stderr(
      `warning: datamap not found (${relative(io.cwd, ctx.connector.datamapPath)}); classifying columns with rules only. Run \`stonekeep scan\` first.\n`,
    );
  }
  const logger: EngineLogger = () => undefined;
  const out = (value: unknown): void => {
    io.stdout(`${JSON.stringify(value, null, 2)}\n`);
  };

  switch (command) {
    case 'discover': {
      const r = await engine.createPostgresConnector(ctx, io.env, logger).discover();
      if (flags.json) out(r);
      else printDiscovery(r, io);
      return 0;
    }
    case 'export': {
      const subject = subjectFrom(flags, io);
      const r = await engine.createPostgresConnector(ctx, io.env, logger).export(subject, {
        dryRun: flags.dryRun,
        ...(flags.out !== undefined ? { outFile: resolve(io.cwd, flags.out) } : {}),
      });
      if (flags.json) out(r);
      else printExport(r, io);
      return 0;
    }
    case 'delete': {
      const requested = flags.mode ?? 'delete';
      if (requested !== 'delete' && requested !== 'anonymize') {
        throw new StonekeepError('CONFIG', `--mode must be "delete" or "anonymize"`);
      }
      const mode: DeleteMode = requested;
      const subject = subjectFrom(flags, io);
      const { consentLedgerStep, createSaasConnectors, runDeletion } =
        await import('@stonekeep/connectors');
      const saas = await createSaasConnectors(ctx.connector.config.saas, io.env);
      // Erasure hook: record proof in the consent ledger when one is configured.
      const ledger = ctx.connector.config.consent
        ? await openConfiguredLedger(connectorPath, io.env)
        : undefined;
      const report = await runDeletion({
        postErasure: ledger ? [consentLedgerStep(ledger)] : [],
        database: engine.createPostgresConnector(ctx, io.env, logger),
        saas,
        subject,
        mode,
        dryRun: !flags.apply,
        identityOverrides: parseSaasIdentities(flags.saasIdentity),
      }).finally(() => ledger?.close());
      if (flags.json) out(report);
      else printDeletionReport(report, io);
      return report.status === 'completed' ? 0 : report.status === 'partial' ? EXIT_PARTIAL : 2;
    }
    case 'mask': {
      const { mask } = ctx.connector.config;
      const r = await engine.runMask({
        config: ctx.connector.config,
        sourceUrl: engine.requireEnv(io.env, mask.sourceUrlEnv, 'source database URL'),
        targetUrl: engine.requireEnv(io.env, mask.targetUrlEnv, 'target database URL'),
        secret: engine.requireEnv(io.env, mask.secretEnv, 'mask secret'),
        pii: ctx.pii,
        dryRun: !flags.apply,
        truncate: flags.truncate,
        logger,
      });
      if (flags.json) out(r);
      else printMask(r, io);
      return 0;
    }
    case 'breach':
      return runBreach(
        engine.createPostgresConnector(ctx, io.env, logger),
        connectorPath,
        flags,
        io,
      );
    default:
      throw new StonekeepError('CONFIG', `unknown engine command "${command}"`);
  }
}
