/**
 * Public engine types. Every result and event type here is designed to carry
 * identifiers and counts only — never data values or the subject key.
 */

export type DeleteMode = 'delete' | 'anonymize';

export interface OperationOptions {
  /**
   * Plan and count without changing anything. Defaults to `true` for
   * destructive operations (delete, mask) and `false` for export/discover.
   */
  dryRun?: boolean;
}

export interface ExportOptions extends OperationOptions {
  /** Where to write the ZIP (required unless dryRun). */
  outFile?: string;
  /** Clock override (tests). */
  now?: Date;
}

export type StepAction = 'retain' | 'detach' | 'delete' | 'anonymize';

export interface StepReport {
  table: string;
  action: StepAction;
  /** Rows affected (or that would be affected in a dry run). */
  rows: number;
  /** Columns written by this step (empty for deletes). */
  columns: string[];
  /** Retention reason, for `retain` steps. */
  reason?: string;
}

export interface SkippedColumn {
  table: string;
  column: string;
  reason: string;
}

export interface DeleteResult {
  operation: 'delete';
  mode: DeleteMode;
  dryRun: boolean;
  steps: StepReport[];
  totalRows: number;
  /** PII columns that could not be anonymized in place (e.g. primary keys). */
  skipped: SkippedColumn[];
}

export interface ExportTableReport {
  table: string;
  rows: number;
}

export interface ExportResult {
  operation: 'export';
  dryRun: boolean;
  tables: ExportTableReport[];
  totalRows: number;
  /** Absolute path of the written ZIP (not set in dry runs). */
  file?: string;
  /** SHA-256 of the ZIP file. */
  sha256?: string;
  bytes?: number;
}

export interface DiscoveredColumn {
  name: string;
  type: string;
  nullable: boolean;
  pii?: { category: string; rule: string; source: 'datamap' | 'rules' | 'config' };
}

export interface DiscoveredTable {
  name: string;
  primaryKey: string[];
  columns: DiscoveredColumn[];
  /** How the table relates to the subject. */
  role: 'subject' | 'subject-data' | 'retained' | 'excluded' | 'unrelated';
}

export interface DiscoveredForeignKey {
  name: string;
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  source: 'database' | 'config';
}

export interface DiscoveryResult {
  operation: 'discover';
  dryRun: boolean;
  schema: string;
  subject: { table: string; key: string };
  tables: DiscoveredTable[];
  foreignKeys: DiscoveredForeignKey[];
  /** Datamap entries that matched no database column. */
  unmatchedDatamap: string[];
}

export interface Connector {
  discover(options?: OperationOptions): Promise<DiscoveryResult>;
  export(subject: string, options?: ExportOptions): Promise<ExportResult>;
  delete(subject: string, mode: DeleteMode, options?: OperationOptions): Promise<DeleteResult>;
}

/** Progress events. By construction they contain identifiers and counts only. */
export type EngineEvent =
  | {
      type: 'step';
      operation: string;
      table: string;
      action: string;
      rows: number;
      dryRun: boolean;
    }
  | { type: 'phase'; operation: string; phase: string };

export type EngineLogger = (event: EngineEvent) => void;
