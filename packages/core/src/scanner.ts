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
  /**
   * Schema sources that could not be read or parsed (file paths only). When this is not empty
   * the result does not cover the whole repository, so `check` treats it as a failure.
   */
  incomplete: string[];
}

/**
 * Decode a source file. Handles UTF-8 with or without a byte order mark and UTF-16 with one
 * (SQL Server tools save scripts as UTF-16). Returns `undefined` for binary content.
 */
export function decodeSource(bytes: Buffer): string | undefined {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  // a NUL byte never occurs in UTF-8 text: this is a binary file or UTF-16 without a mark
  if (bytes.subarray(0, 8192).includes(0)) return undefined;
  const text = bytes.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
  incomplete: string[];
} {
  const warnings: string[] = [];
  const incomplete: string[] = [];
  const datamapRel = toPosix(relative(config.root, config.datamapPath));
  const sql: SourceFile[] = [];
  const prisma: SourceFile[] = [];
  const typeorm: SourceFile[] = [];
  const schemaDocs: SourceFile[] = [];

  // `certain` marks files that are schema sources by their extension alone (SQL, Prisma).
  // Skipping one of those leaves a hole in the scan; a skipped JSON or YAML file is usually data.
  const read = (rel: string, certain: boolean): string | undefined => {
    const abs = join(config.root, rel);
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) {
        (certain ? incomplete : warnings).push(
          `Skipped ${rel}: larger than ${MAX_FILE_BYTES} bytes` +
            (certain ? '. Split it, or list it under "exclude" if it holds no schema' : ''),
        );
        return undefined;
      }
      const text = decodeSource(readFileSync(abs));
      if (text === undefined) {
        (certain ? incomplete : warnings).push(
          `Skipped ${rel}: not a text file` +
            (certain ? '. List it under "exclude" if it holds no schema' : ''),
        );
      }
      return text;
    } catch (error) {
      incomplete.push(`Could not read ${rel}: ${errorMessage(error)}`);
      return undefined;
    }
  };

  let filesScanned = 0;
  const files = listFiles(config.root, config.exclude, (dir, error) =>
    incomplete.push(`Could not read directory ${dir}: ${errorMessage(error)}`),
  );
  for (const rel of files) {
    if (rel === datamapRel) continue;
    const lower = rel.toLowerCase();
    const bucket = lower.endsWith('.sql')
      ? sql
      : lower.endsWith('.prisma')
        ? prisma
        : /\.[cm]?ts$/.test(lower) && !/\.d\.[cm]?ts$/.test(lower)
          ? typeorm
          : /\.(json|ya?ml)$/.test(lower) &&
              !NON_SCHEMA_JSON.has(basename(lower)) &&
              !/^tsconfig.*\.json$/.test(basename(lower))
            ? schemaDocs
            : undefined;
    if (!bucket) continue;
    const content = read(rel, bucket === sql || bucket === prisma);
    if (content === undefined) continue;
    if (bucket === typeorm && !looksLikeTypeOrm(content)) continue;
    bucket.push({ path: rel, content });
    filesScanned++;
  }

  const fields: SchemaField[] = [];
  const report = (problem: string): void => {
    incomplete.push(problem);
  };
  // A parser that throws must not take the rest of the scan with it, and must not go unnoticed.
  const safely = (label: string, fn: () => SchemaField[]): void => {
    try {
      // a loop, not a spread: a spread of a very large array overflows the call stack
      for (const field of fn()) fields.push(field);
    } catch (error) {
      incomplete.push(`Failed to parse ${label}: ${errorMessage(error)}`);
    }
  };
  safely('SQL migrations', () => parseSql(sql, report));
  safely('Prisma schema', () => parsePrisma(prisma));
  for (const f of typeorm) safely(f.path, () => parseTypeOrm([f]));
  for (const f of schemaDocs) safely(f.path, () => parseSchemaDocument(f, report));
  return { fields, filesScanned, warnings, incomplete };
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
    incomplete: collected.incomplete,
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
        cache.set(file, decodeSource(readFileSync(join(config.root, file)))?.split(/\r?\n/));
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
