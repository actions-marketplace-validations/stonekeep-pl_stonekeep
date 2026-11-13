import type { ResolvedConfig } from './config.js';
import { scan } from './scanner.js';
import type { DataMap, DataMapField } from './types.js';

export interface CategoryChange {
  id: string;
  mapped: string;
  detected: string;
  field: DataMapField;
}

export interface CheckResult {
  /**
   * True when no unmapped PII was found, every schema source could be read (unless
   * `allowIncomplete`), and, in strict mode, there is no drift.
   */
  ok: boolean;
  /** PII fields in the code that are neither in the datamap nor in config overrides. Blocking. */
  unmapped: DataMapField[];
  /** Datamap entries that no longer exist in the code. Warning (blocking with `strict`). */
  stale: DataMapField[];
  /** Fields whose detected category differs from the datamap. Warning (blocking with `strict`). */
  changed: CategoryChange[];
  /** Total PII fields detected in the current code. */
  detected: number;
  filesScanned: number;
  warnings: string[];
  /**
   * Schema sources that could not be read or parsed. Blocking unless `allowIncomplete`: a check
   * that skipped part of the schema cannot say that all personal data is mapped.
   */
  incomplete: string[];
}

export interface CheckOptions {
  /** Treat stale entries and category changes as failures too. */
  strict?: boolean;
  /** Pass even when some schema sources could not be read. They are still listed. */
  allowIncomplete?: boolean;
}

/** Compare the current code against a committed datamap. */
export function check(
  config: ResolvedConfig,
  datamap: DataMap,
  options: CheckOptions = {},
): CheckResult {
  const current = scan(config);
  const mappedById = new Map(datamap.fields.map((f) => [f.id, f]));
  const currentIds = new Set(current.fields.map((f) => f.id));

  const unmapped = current.fields.filter(
    (f) => !mappedById.has(f.id) && config.overrides[f.id] === undefined,
  );
  // An entry whose source could not be read is not known to be gone: do not call it stale.
  const stale =
    current.incomplete.length > 0 ? [] : datamap.fields.filter((f) => !currentIds.has(f.id));
  const changed: CategoryChange[] = [];
  for (const f of current.fields) {
    const mapped = mappedById.get(f.id);
    if (mapped && mapped.category !== f.category) {
      changed.push({ id: f.id, mapped: mapped.category, detected: f.category, field: f });
    }
  }

  const drift = stale.length > 0 || changed.length > 0;
  const partial = current.incomplete.length > 0 && options.allowIncomplete !== true;
  return {
    ok: unmapped.length === 0 && !partial && !(options.strict === true && drift),
    unmapped,
    stale,
    changed,
    detected: current.fields.length,
    filesScanned: current.filesScanned,
    warnings: current.warnings,
    incomplete: current.incomplete,
  };
}
