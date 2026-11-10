import { readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { classify } from './classifier.js';
import { CONFIG_FILENAME, type ResolvedConfig } from './config.js';
import { errorMessage } from './errors.js';
import { listFiles } from './files.js';
import { ROPA_FILENAME } from './ropa.js';
import { compareStrings } from './text.js';
import { parsePrisma } from './parsers/prisma.js';
import { parseSchemaDocument } from './parsers/schema.js';
import { parseSql, type SourceFile } from './parsers/sql.js';
import { looksLikeTypeOrm, parseTypeOrm } from './parsers/typeorm.js';
import type { DataMapField, SchemaField } from './types.js';

/** Skip very large files (generated dumps, bundles). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const NON_SCHEMA_JSON = new Set([
  'package.json',
  'package-lock.json',
  'composer.json',
  'composer.lock',
  'pnpm-lock.yaml',
  'yarn.lock',
  CONFIG_FILENAME,
  // Stonekeep's own files are configuration, not schemas.
  ROPA_FILENAME,
  'stonekeep.connector.yaml',
]);

export interface ScanResult {
  /** PII fields at or above `minConfidence`, sorted by id. */
  fields: DataMapField[];
  /** Every schema field the parsers found (PII or not). */
  schemaFieldCount: number;
  filesScanned: number;
  /** Non-fatal problems. Contain file paths only, never file contents. */
  warnings: string[];
}

export function fieldId(entity: string, field: string): string {
  return `${entity}.${field}`;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Extract schema fields from every supported file under the config root. */
export function collectSchemaFields(config: ResolvedConfig): {
  fields: SchemaField[];
  filesScanned: number;
  warnings: string[];
} {
  const warnings: string[] = [];
  const datamapRel = toPosix(relative(config.root, config.datamapPath));
  const sql: SourceFile[] = [];
  const prisma: SourceFile[] = [];
  const typeorm: SourceFile[] = [];
  const schemaDocs: SourceFile[] = [];

  const read = (rel: string): string | undefined => {
    const abs = join(config.root, rel);
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) {
        warnings.push(`Skipped ${rel}: larger than ${MAX_FILE_BYTES} bytes`);
        return undefined;
      }
      return readFileSync(abs, 'utf8');
    } catch (error) {
      warnings.push(`Could not read ${rel}: ${errorMessage(error)}`);
      return undefined;
    }
  };

  let filesScanned = 0;
  for (const rel of listFiles(config.root, config.exclude)) {
    if (rel === datamapRel) continue;
    const lower = rel.toLowerCase();
    const bucket = lower.endsWith('.sql')
      ? sql
      : lower.endsWith('.prisma')
        ? prisma
        : lower.endsWith('.ts') && !lower.endsWith('.d.ts')
          ? typeorm
          : /\.(json|ya?ml)$/.test(lower) &&
              !NON_SCHEMA_JSON.has(basename(lower)) &&
              !/^tsconfig.*\.json$/.test(basename(lower))
            ? schemaDocs
            : undefined;
    if (!bucket) continue;
    const content = read(rel);
    if (content === undefined) continue;
    if (bucket === typeorm && !looksLikeTypeOrm(content)) continue;
    bucket.push({ path: rel, content });
    filesScanned++;
  }

  const fields: SchemaField[] = [];
  const safely = (label: string, fn: () => SchemaField[]): void => {
    try {
      fields.push(...fn());
    } catch (error) {
      warnings.push(`Failed to parse ${label}: ${errorMessage(error)}`);
    }
  };
  safely('SQL migrations', () => parseSql(sql));
  safely('Prisma schema', () => parsePrisma(prisma));
  for (const f of typeorm) safely(f.path, () => parseTypeOrm([f]));
  for (const f of schemaDocs) safely(f.path, () => parseSchemaDocument(f));
  return { fields, filesScanned, warnings };
}

/** Classify schema fields with the configured rules and apply per-field overrides. */
export function classifyFields(
  fields: readonly SchemaField[],
  config: ResolvedConfig,
): DataMapField[] {
  const byId = new Map<string, DataMapField>();
  const ordered = [...fields].sort(
    (a, b) => compareStrings(a.location.file, b.location.file) || a.location.line - b.location.line,
  );
  for (const f of ordered) {
    const id = fieldId(f.entity, f.field);
    if (byId.has(id)) continue;
    const override = config.overrides[id];
    if (override?.ignore === true) continue;

    const leaf = f.field.split('.').pop()?.replace(/\[\]$/, '') ?? f.field;
    const names = f.columnName !== undefined ? [leaf, f.columnName] : [leaf];
    const auto = classify({ names, rawType: f.rawType, format: f.format }, config.ruleSet);
    const classification =
      override?.category !== undefined
        ? { category: override.category, rule: 'override', confidence: 1 }
        : auto !== undefined && auto.confidence >= config.minConfidence
          ? auto
          : undefined;
    if (!classification) continue;

    byId.set(id, {
      id,
      entity: f.entity,
      field: f.field,
      category: classification.category,
      rule: classification.rule,
      confidence: classification.confidence,
      source: f.source,
      location: f.location,
    });
  }
  return [...byId.values()].sort((a, b) => compareStrings(a.id, b.id));
}

/** Scan the configured root for personal data fields. Read-only; writes nothing. */
export function scan(config: ResolvedConfig): ScanResult {
  const collected = collectSchemaFields(config);
  return {
    fields: applyInlineIgnores(classifyFields(collected.fields, config), config),
    schemaFieldCount: collected.fields.length,
    filesScanned: collected.filesScanned,
    warnings: collected.warnings,
  };
}

const INLINE_IGNORE = /stonekeep-ignore/;
/** A line that holds only a comment containing the marker (`--`, `//`, `#`, `/*`, `*`). */
const IGNORE_COMMENT_LINE = /^\s*(--|\/\/|#|\/\*|\*).*stonekeep-ignore/;

/**
 * Drop fields whose definition line contains a `stonekeep-ignore` marker, or whose
 * previous line is a comment-only line with the marker. A trailing marker on one
 * field never suppresses the next field. Only reads the files that contain detected
 * fields, and only looks for the marker.
 */
function applyInlineIgnores(fields: DataMapField[], config: ResolvedConfig): DataMapField[] {
  const cache = new Map<string, string[] | undefined>();
  const lines = (file: string): string[] | undefined => {
    if (!cache.has(file)) {
      try {
        cache.set(file, readFileSync(join(config.root, file), 'utf8').split(/\r?\n/));
      } catch {
        cache.set(file, undefined);
      }
    }
    return cache.get(file);
  };
  return fields.filter((f) => {
    const l = lines(f.location.file);
    if (!l) return true;
    const at = f.location.line - 1;
    return !(INLINE_IGNORE.test(l[at] ?? '') || IGNORE_COMMENT_LINE.test(l[at - 1] ?? ''));
  });
}
