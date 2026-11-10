import { connectorConfigSchema } from '@stonekeep/core/engine';
import { stringify } from 'yaml';
import type { SchemaMetadata } from './metadata.js';
import type { Proposal } from './proposal.js';

export interface RenderedProposal {
  /** Connector config object (validated). */
  config: Record<string, unknown>;
  yaml: string;
  /** Entries dropped because they reference names absent from the metadata, etc. */
  warnings: string[];
}

const HEADER = `# stonekeep.connector.yaml — proposed by \`stonekeep setup\` from schema metadata only.
# Review every entry: the proposal is a starting point, not legal advice.
`;

/**
 * Turn a proposal into a connector config. Unknown entities/columns are
 * dropped (models can hallucinate names). `connection`, `saas`, `consent`
 * and other settings in an existing config are kept as they are — the
 * assistant never touches credentials or connections.
 */
export function renderProposal(
  proposal: Proposal,
  metadata: SchemaMetadata,
  existing?: Record<string, unknown>,
): RenderedProposal {
  const warnings: string[] = [];
  const cols = new Map(
    metadata.entities.map((e) => [e.name, new Set(e.columns.map((c) => c.name))]),
  );
  const hasTable = (t: string, where: string): boolean => {
    if (cols.has(t)) return true;
    warnings.push(`${where}: unknown table "${t}" dropped`);
    return false;
  };
  const hasColumn = (t: string, c: string, where: string): boolean => {
    if (cols.get(t)?.has(c) === true) return true;
    warnings.push(`${where}: unknown column "${t}.${c}" dropped`);
    return false;
  };

  const tables: Record<string, Record<string, unknown>> = {};
  const table = (t: string): Record<string, unknown> => (tables[t] ??= {});

  for (const r of proposal.retain) {
    if (!hasTable(r.table, 'retain') || r.table === proposal.subject.table) continue;
    table(r.table).retain = {
      reason: r.reason,
      reference: null,
      anonymize: r.anonymize.filter((c) => hasColumn(r.table, c, 'retain.anonymize')),
    };
  }
  for (const fk of proposal.foreignKeys) {
    const [refTable = '', refCol = ''] = fk.references.split('.');
    if (
      !hasTable(fk.table, 'foreignKeys') ||
      !hasColumn(fk.table, fk.column, 'foreignKeys') ||
      !hasTable(refTable, 'foreignKeys.references') ||
      !hasColumn(refTable, refCol, 'foreignKeys.references')
    )
      continue;
    const t = table(fk.table);
    t.foreignKeys = [
      ...((t.foreignKeys as unknown[] | undefined) ?? []),
      { column: fk.column, references: `${refTable}.${refCol}` },
    ];
  }
  for (const ex of proposal.exclude) {
    if (hasTable(ex, 'exclude') && ex !== proposal.subject.table) table(ex).exclude = true;
  }
  const maskColumns: Record<string, string> = {};
  for (const m of proposal.mask) {
    if (m.strategy !== 'keep' && hasTable(m.table, 'mask') && hasColumn(m.table, m.column, 'mask'))
      maskColumns[`${m.table}.${m.column}`] = m.strategy;
  }

  let subject = proposal.subject;
  if (
    !hasTable(subject.table, 'subject') ||
    !hasColumn(subject.table, subject.key, 'subject.key')
  ) {
    subject = { table: subject.table, key: subject.key };
    warnings.push(
      'subject: the proposed subject does not exist in the metadata; fix it before use',
    );
  }

  const base = existing ?? {};
  const existingMask = (base.mask as Record<string, unknown> | undefined) ?? {};
  const config: Record<string, unknown> = {
    version: 1,
    connector: 'postgres',
    ...base,
    subject,
    tables,
    mask: { ...existingMask, columns: maskColumns },
  };
  const valid = connectorConfigSchema.safeParse(config);
  if (!valid.success) {
    for (const i of valid.error.issues) warnings.push(`invalid: ${i.path.join('.')}: ${i.message}`);
  }
  const notes =
    proposal.notes.length > 0
      ? `# Review notes:\n${proposal.notes.map((n) => `#  - ${n.replace(/\n/g, ' ')}`).join('\n')}\n`
      : '';
  return { config, yaml: `${HEADER}${notes}${stringify(config, { lineWidth: 0 })}`, warnings };
}
