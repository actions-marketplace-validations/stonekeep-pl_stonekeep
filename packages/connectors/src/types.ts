import type { DeleteMode } from '@stonekeep/core/engine';
import { z } from 'zod';
import type { HttpLogger, RetryPolicy } from './http.js';
import type { SecretResolver } from './secrets.js';

/**
 * Identifiers of the subject in an external system, e.g.
 * `{ customerId: 'cus_123', email: 'jane@example.com' }`.
 * These ARE personal data: keep them in memory, never log or report them.
 */
export type SubjectIdentity = Partial<Record<string, string>>;

export interface SaasStep {
  /** e.g. `anonymize`, `delete`, `detach`. */
  action: string;
  /** e.g. `customer`, `user`, `payment_method`. */
  resource: string;
  count: number;
}

export interface RetainedRecords {
  resource: string;
  count: number;
  reason: string;
}

export interface SaasOutcome {
  status: 'succeeded' | 'skipped';
  steps: SaasStep[];
  retained: RetainedRecords[];
  /** Why the connector did nothing (for `skipped`) or a note. Never contains personal data. */
  note?: string;
}

export interface SaasConnector {
  /** Instance name (unique per config), e.g. `stripe` or `stripe-eu`. */
  readonly name: string;
  /** Plugin type, e.g. `stripe`. */
  readonly type: string;
  /** Identity field -> subject-table column used to address the subject. */
  readonly identityColumns: Readonly<Record<string, string>>;
  /** Online credential check (cheap, read-only). Throws on failure. */
  verifyCredentials(): Promise<void>;
  /** Erase the subject. Must be idempotent. `dryRun` performs reads only. */
  erase(
    identity: SubjectIdentity,
    mode: DeleteMode,
    options: { dryRun: boolean },
  ): Promise<SaasOutcome>;
}

export interface PluginContext {
  secrets: SecretResolver;
  logger?: HttpLogger;
  /** Overrides for tests (fast retries, deterministic jitter). */
  http?: {
    retry?: Partial<RetryPolicy>;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    timeoutMs?: number;
  };
}

export interface SaasPlugin<Config = unknown> {
  type: string;
  description: string;
  configSchema: z.ZodType<Config, z.ZodTypeDef, unknown>;
  /** Validate formats and resolve secrets; no network calls. Throws StonekeepError('CONFIG'). */
  create(config: Config, ctx: PluginContext): Promise<SaasConnector>;
}

const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]*$/, 'must be a column name');

/** `{ column: users.<column> }`: where an identity value lives on the subject row. */
export const identityColumnSchema = z.object({ column: ident }).strict();

export const baseEntrySchema = {
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_-]*$/)
    .optional(),
};
