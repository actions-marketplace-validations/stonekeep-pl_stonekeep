import type { DataMap, SchemaField } from '@stonekeep/core';
import {
  IDENTIFIER,
  PrivacyGuardError,
  TYPE_NAME,
  assertSafeToSend,
  type GuardFinding,
} from './guard.js';

/**
 * The ONLY data the setup assistant sends to an LLM: names, types and
 * classifications. No values, file contents, or comments.
 */
export interface SchemaMetadata {
  entities: {
    name: string;
    columns: {
      name: string;
      type: string | null;
      pii: { category: string; rule: string; confidence: number } | null;
    }[];
  }[];
}

export interface MetadataInput {
  datamap: DataMap;
  /** All schema fields from `collectSchemaFields` (PII or not), for context. */
  fields?: readonly SchemaField[];
}

/**
 * Build the metadata payload from the datamap (+ optional full field list).
 * Strict allowlist: every identifier and type name must match a narrow
 * pattern, nested JSON paths are skipped, and the result is re-checked by the
 * privacy guard. Throws PrivacyGuardError rather than silently dropping data.
 */
export function buildSchemaMetadata(input: MetadataInput): SchemaMetadata {
  const findings: GuardFinding[] = [];
  const entities = new Map<
    string,
    Map<string, SchemaMetadata['entities'][number]['columns'][number]>
  >();
  const column = (
    entity: string,
    field: string,
    path: string,
  ): SchemaMetadata['entities'][number]['columns'][number] | undefined => {
    // Validate first: an unsafe name fails loudly even if it would be skipped below.
    if (!IDENTIFIER.test(entity)) findings.push({ kind: 'identifier', path: `${path}.entity` });
    if (!IDENTIFIER.test(field)) findings.push({ kind: 'identifier', path: `${path}.field` });
    if (field.includes('.')) return undefined; // nested JSON/OpenAPI paths are not database columns
    let cols = entities.get(entity);
    if (!cols) {
      cols = new Map();
      entities.set(entity, cols);
    }
    let col = cols.get(field);
    if (!col) {
      col = { name: field, type: null, pii: null };
      cols.set(field, col);
    }
    return col;
  };

  (input.fields ?? []).forEach((f, i) => {
    const col = column(f.entity, f.field, `$.fields[${i}]`);
    if (col && f.rawType !== undefined) {
      if (TYPE_NAME.test(f.rawType)) col.type = f.rawType;
      else findings.push({ kind: 'identifier', path: `$.fields[${i}].rawType` });
    }
  });
  input.datamap.fields.forEach((f, i) => {
    const col = column(f.entity, f.field, `$.datamap.fields[${i}]`);
    if (col) col.pii = { category: f.category, rule: f.rule, confidence: f.confidence };
  });
  if (findings.length > 0) throw new PrivacyGuardError(findings);

  const metadata: SchemaMetadata = {
    entities: [...entities.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, cols]) => ({ name, columns: [...cols.values()] })),
  };
  assertSafeToSend(metadata);
  return metadata;
}
