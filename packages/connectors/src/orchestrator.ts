import { StonekeepError } from '@stonekeep/core';
import type { DeleteMode, DeleteResult } from '@stonekeep/core/engine';
import { HttpError } from './http.js';
import type { PostErasureStep } from './ledger-step.js';
import type { RetainedRecords, SaasConnector, SaasStep, SubjectIdentity } from './types.js';

/** What the orchestrator needs from the database side (PostgresConnector satisfies it). */
export interface DatabaseConnector {
  lookupSubject(
    subject: string,
    columns: readonly string[],
  ): Promise<Record<string, string | null> | null>;
  delete(subject: string, mode: DeleteMode, options: { dryRun: boolean }): Promise<DeleteResult>;
}

export type ConnectorStatus = 'succeeded' | 'skipped' | 'failed';

export interface ConnectorError {
  message: string;
  status?: number;
  code?: string;
  attempts?: number;
}

export interface ConnectorReport {
  connector: string;
  type: string;
  status: ConnectorStatus;
  durationMs: number;
  /** Postgres plan/result (identifiers and counts only). */
  database?: DeleteResult;
  steps?: SaasStep[];
  retained?: RetainedRecords[];
  note?: string;
  error?: ConnectorError;
}

export interface DeletionReport {
  operation: 'delete';
  mode: DeleteMode;
  dryRun: boolean;
  /** completed: nothing failed · partial: some connectors failed · failed: everything failed or aborted. */
  status: 'completed' | 'partial' | 'failed';
  /** Set when the run stopped before executing anything. */
  abortedAt?: 'credentials';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  connectors: ConnectorReport[];
  /** Operator guidance. Never contains personal data. */
  hints: string[];
}

export type OrchestratorEvent =
  | { type: 'phase'; phase: 'credentials' | 'identity' | 'execute' | 'done' }
  | { type: 'connector'; connector: string; status: ConnectorStatus; durationMs: number };

export interface DeletionOptions {
  database: DatabaseConnector;
  saas: readonly SaasConnector[];
  subject: string;
  mode: DeleteMode;
  /** Default true. */
  dryRun?: boolean;
  /**
   * Identities supplied explicitly per connector (e.g. when re-running after
   * the database row is gone). Merged over values read from the database.
   */
  identityOverrides?: Readonly<Record<string, SubjectIdentity>>;
  /** Run after a successful database erasure, in order (e.g. the consent ledger hook). */
  postErasure?: readonly PostErasureStep[];
  /** Skip the online credential check (not recommended). */
  skipCredentialCheck?: boolean;
  logger?: (event: OrchestratorEvent) => void;
  now?: () => Date;
}

/** Convert any failure into a report-safe shape (no response bodies, no values). */
export function describeError(error: unknown): ConnectorError {
  if (error instanceof HttpError) {
    return {
      message: error.message,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.code !== undefined ? { code: error.code } : {}),
      attempts: error.attempts,
    };
  }
  if (error instanceof StonekeepError) return { message: error.message, code: error.code };
  const name = error instanceof Error ? error.name : typeof error;
  return { message: `Unexpected ${name}` };
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T; ms: number } | { ok: false; error: unknown; ms: number }> {
  const start = performance.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: Math.round(performance.now() - start) };
  } catch (error) {
    return { ok: false, error, ms: Math.round(performance.now() - start) };
  }
}

/** completed: nothing failed · failed: something failed and nothing succeeded · partial: a mix. */
function overallStatus(reports: readonly ConnectorReport[]): DeletionReport['status'] {
  const failed = reports.some((r) => r.status === 'failed');
  if (!failed) return 'completed';
  return reports.some((r) => r.status === 'succeeded') ? 'partial' : 'failed';
}

/**
 * Erase a subject everywhere: the Postgres database (Stage 2 engine) and all
 * configured SaaS connectors, **in parallel**, aggregated into one report.
 *
 * 1. Credentials of every SaaS connector are verified first; any failure
 *    aborts the run before anything is changed.
 * 2. External identities (e.g. Stripe customer id) are read from the subject
 *    row *before* it is deleted. They stay in memory and are never reported.
 * 3. All connectors run concurrently; one failing does not stop the others.
 */
export async function runDeletion(options: DeletionOptions): Promise<DeletionReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const dryRun = options.dryRun ?? true;
  const log = options.logger ?? (() => undefined);
  const finish = (
    connectors: ConnectorReport[],
    extra: Partial<DeletionReport> = {},
  ): DeletionReport => {
    const finishedAt = now();
    log({ type: 'phase', phase: 'done' });
    return {
      operation: 'delete',
      mode: options.mode,
      dryRun,
      status: overallStatus(connectors),
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      connectors,
      hints: [],
      ...extra,
    };
  };

  // 1. Credentials.
  if (!options.skipCredentialCheck && options.saas.length > 0) {
    log({ type: 'phase', phase: 'credentials' });
    const checks = await Promise.all(options.saas.map((c) => timed(() => c.verifyCredentials())));
    const failures = checks.flatMap((r, i) => (r.ok ? [] : [{ connector: options.saas[i], r }]));
    if (failures.length > 0) {
      const reports: ConnectorReport[] = [
        {
          connector: 'postgres',
          type: 'postgres',
          status: 'skipped',
          durationMs: 0,
          note: 'not started: SaaS credential check failed',
        },
        ...options.saas.map((c, i): ConnectorReport => {
          const r = checks[i];
          return r && !r.ok
            ? {
                connector: c.name,
                type: c.type,
                status: 'failed',
                durationMs: r.ms,
                error: describeError(r.error),
              }
            : {
                connector: c.name,
                type: c.type,
                status: 'skipped',
                durationMs: r?.ms ?? 0,
                note: 'not started: another connector failed its credential check',
              };
        }),
      ];
      return {
        ...finish(reports),
        status: 'failed',
        abortedAt: 'credentials',
        hints: [
          'Nothing was changed. Fix the credentials of the failed connector(s) and run again.',
        ],
      };
    }
  }

  // 2. Identities (read-only, before the row can disappear).
  log({ type: 'phase', phase: 'identity' });
  const columns = [...new Set(options.saas.flatMap((c) => Object.values(c.identityColumns)))];
  const lookup =
    columns.length > 0
      ? await timed(() => options.database.lookupSubject(options.subject, columns))
      : undefined;
  if (lookup && !lookup.ok) {
    const reports: ConnectorReport[] = [
      {
        connector: 'postgres',
        type: 'postgres',
        status: 'failed',
        durationMs: lookup.ms,
        error: describeError(lookup.error),
      },
      ...options.saas.map((c): ConnectorReport => ({
        connector: c.name,
        type: c.type,
        status: 'skipped',
        durationMs: 0,
        note: 'not started: subject lookup failed',
      })),
    ];
    return { ...finish(reports), hints: ['Nothing was changed.'] };
  }
  const row = lookup?.ok ? lookup.value : null;
  const identities = options.saas.map((c) => {
    const identity: SubjectIdentity = {};
    for (const [field, column] of Object.entries(c.identityColumns)) {
      const value = row?.[column];
      if (value !== null && value !== undefined && value !== '') identity[field] = value;
    }
    return { ...identity, ...options.identityOverrides?.[c.name] };
  });

  // 3. Execute everything in parallel.
  log({ type: 'phase', phase: 'execute' });
  const [db, ...saas] = await Promise.all([
    timed(() => options.database.delete(options.subject, options.mode, { dryRun })),
    ...options.saas.map((c, i) =>
      timed(() => c.erase(identities[i] ?? {}, options.mode, { dryRun })),
    ),
  ]);

  const reports: ConnectorReport[] = [
    db.ok
      ? {
          connector: 'postgres',
          type: 'postgres',
          status: 'succeeded',
          durationMs: db.ms,
          database: db.value,
        }
      : {
          connector: 'postgres',
          type: 'postgres',
          status: 'failed',
          durationMs: db.ms,
          error: describeError(db.error),
        },
  ];
  options.saas.forEach((c, i) => {
    const r = saas[i];
    if (!r) return;
    reports.push(
      r.ok
        ? {
            connector: c.name,
            type: c.type,
            status: r.value.status,
            durationMs: r.ms,
            steps: r.value.steps,
            retained: r.value.retained,
            ...(r.value.note !== undefined ? { note: r.value.note } : {}),
          }
        : {
            connector: c.name,
            type: c.type,
            status: 'failed',
            durationMs: r.ms,
            error: describeError(r.error),
          },
    );
  });
  // 4. Post-erasure steps (e.g. consent ledger proof) only once the database erasure succeeded.
  const dbSucceeded = reports[0]?.status === 'succeeded';
  for (const step of options.postErasure ?? []) {
    if (!dbSucceeded) {
      reports.push({
        connector: step.name,
        type: step.type,
        status: 'skipped',
        durationMs: 0,
        note: 'not run: the database erasure did not succeed',
      });
      continue;
    }
    const r = await timed(() => step.run(options.subject, { dryRun }));
    reports.push(
      r.ok
        ? {
            connector: step.name,
            type: step.type,
            status: r.value.status,
            durationMs: r.ms,
            steps: r.value.steps,
            retained: r.value.retained,
            ...(r.value.note !== undefined ? { note: r.value.note } : {}),
          }
        : {
            connector: step.name,
            type: step.type,
            status: 'failed',
            durationMs: r.ms,
            error: describeError(r.error),
          },
    );
  }

  for (const r of reports)
    log({ type: 'connector', connector: r.connector, status: r.status, durationMs: r.durationMs });

  const hints: string[] = [];
  const failedSaas = reports
    .filter((r) => r.type !== 'postgres' && r.status === 'failed')
    .map((r) => r.connector);
  const dbDone = reports.find((r) => r.type === 'postgres')?.status === 'succeeded';
  if (failedSaas.length > 0) {
    hints.push(
      dbDone && !dryRun
        ? `Re-run to retry ${failedSaas.join(', ')}. The database row is already gone, so pass the external ids explicitly ` +
            '(CLI: --saas-identity <connector>.<field>=<value>, e.g. stripe.customerId=cus_…).'
        : `Re-run to retry ${failedSaas.join(', ')}; every connector is idempotent.`,
    );
  }
  if (reports.find((r) => r.type === 'postgres')?.status === 'failed') {
    hints.push('The database transaction was rolled back; no database rows were changed.');
  }
  return finish(reports, { hints });
}
