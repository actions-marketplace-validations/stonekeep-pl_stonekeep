import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { VERSION } from '../version.js';

export interface ExportTable {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ExportManifest {
  format: 'stonekeep-export';
  formatVersion: 1;
  generator: string;
  generatedAt: string;
  hashAlgorithm: 'sha256';
  tables: { table: string; rows: number; files: string[] }[];
  files: ManifestFile[];
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

/**
 * RFC 4180 CSV cell. Values that a spreadsheet would execute as a formula
 * (leading = + - @ tab CR) are prefixed with `'` (OWASP CSV injection guidance).
 */
export function csvCell(value: unknown): string {
  let text = cellText(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(table: ExportTable): string {
  const lines = [table.columns.map(csvCell).join(',')];
  for (const row of table.rows) lines.push(table.columns.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function safeFileName(table: string): string {
  return table.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/**
 * Build the export ZIP: `data/<table>.json`, `data/<table>.csv`,
 * `manifest.json` (SHA-256 of every data file) and `SHA256SUMS`
 * (compatible with `sha256sum -c`).
 */
export function buildExportZip(
  tables: readonly ExportTable[],
  generatedAt: Date,
): { zip: Uint8Array; manifest: ExportManifest } {
  const mtime = generatedAt;
  const entries: Zippable = {};
  const files: ManifestFile[] = [];
  const add = (path: string, content: string): void => {
    const data = strToU8(content);
    entries[path] = [data, { mtime }];
    files.push({ path, bytes: data.byteLength, sha256: sha256Hex(data) });
  };

  const manifestTables: ExportManifest['tables'] = [];
  for (const t of tables) {
    const base = `data/${safeFileName(t.table)}`;
    add(
      `${base}.json`,
      `${JSON.stringify({ table: t.table, columns: t.columns, rows: t.rows }, null, 2)}\n`,
    );
    add(`${base}.csv`, toCsv(t));
    manifestTables.push({
      table: t.table,
      rows: t.rows.length,
      files: [`${base}.json`, `${base}.csv`],
    });
  }

  const manifest: ExportManifest = {
    format: 'stonekeep-export',
    formatVersion: 1,
    generator: `stonekeep ${VERSION}`,
    generatedAt: generatedAt.toISOString(),
    hashAlgorithm: 'sha256',
    tables: manifestTables,
    files: [...files],
  };
  add('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = files.map((f) => `${f.sha256}  ${f.path}`).join('\n');
  entries['SHA256SUMS'] = [strToU8(`${sums}\n`), { mtime }];

  return { zip: zipSync(entries, { level: 6 }), manifest };
}

/** Write atomically: temp file + rename, so a partial ZIP is never left behind. */
export function writeFileAtomic(path: string, data: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}
