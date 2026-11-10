import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  StonekeepError,
  ROPA_FILENAME,
  adviseProject,
  createDataMap,
  errorMessage,
  generateDocumentPack,
  loadConfig,
  readDataMap,
  readRopaFile,
  renderAdviceMarkdown,
  renderAdviceText,
  scan,
  type DataMap,
  type RopaConfig,
} from '@stonekeep/core';
import type { Io } from './index.js';

export const DOCUMENTS_DIR = 'rodo';

interface ProjectContext {
  root: string;
  datamap: DataMap;
  datamapFromScan: boolean;
  ropa: RopaConfig | undefined;
  ropaError: string | undefined;
  hasCi: boolean;
  hasDocuments: boolean;
}

function gitRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function hasStonekeepCi(root: string): boolean {
  const base = gitRoot(root) ?? root;
  const workflows = join(base, '.github', 'workflows');
  if (existsSync(workflows)) {
    for (const f of readdirSync(workflows)) {
      if (!/\.ya?ml$/.test(f)) continue;
      if (/stonekeep/.test(readFileSync(join(workflows, f), 'utf8'))) return true;
    }
  }
  const gitlab = join(base, '.gitlab-ci.yml');
  return existsSync(gitlab) && /stonekeep/.test(readFileSync(gitlab, 'utf8'));
}

/** Datamap (committed, or a live scan), ROPA (if any) and process facts for one project. */
function loadProject(path: string, io: Io, config?: string): ProjectContext {
  const root = resolve(io.cwd, path);
  const cfg = loadConfig(root, {
    configPath: config !== undefined ? resolve(io.cwd, config) : undefined,
  });
  let datamap: DataMap;
  let datamapFromScan = false;
  if (existsSync(cfg.datamapPath)) {
    datamap = readDataMap(cfg.datamapPath);
  } else {
    datamap = createDataMap(scan(cfg).fields);
    datamapFromScan = true;
  }
  let ropa: RopaConfig | undefined;
  let ropaError: string | undefined;
  const ropaPath = join(root, ROPA_FILENAME);
  if (existsSync(ropaPath)) {
    try {
      ropa = readRopaFile(ropaPath);
    } catch (error) {
      ropaError = errorMessage(error);
    }
  }
  return {
    root,
    datamap,
    datamapFromScan,
    ropa,
    ropaError,
    hasCi: hasStonekeepCi(root),
    hasDocuments: existsSync(join(root, DOCUMENTS_DIR, 'README.md')),
  };
}

function parseLang(value: string | undefined): 'pl' | 'en' {
  const v = value ?? 'pl';
  if (v !== 'pl' && v !== 'en') {
    throw new StonekeepError('CONFIG', `unknown --lang "${v}" (expected pl or en)`);
  }
  return v;
}

export interface AdviceFlags {
  config?: string | undefined;
  lang?: string | undefined;
  format?: string | undefined;
  out?: string | undefined;
  strict: boolean;
}

/** `stonekeep porady [path]` (alias `advise`): project-specific RODO checklist. */
export function runAdviceCommand(path: string, flags: AdviceFlags, io: Io): number {
  const lang = parseLang(flags.lang);
  const format = flags.format ?? 'text';
  if (!['text', 'markdown', 'json'].includes(format)) {
    throw new StonekeepError(
      'CONFIG',
      `unknown --format "${format}" (expected text, markdown or json)`,
    );
  }
  const project = loadProject(path, io, flags.config);
  if (project.ropaError !== undefined) {
    io.stderr(
      lang === 'pl'
        ? `uwaga: nie udało się odczytać ${ROPA_FILENAME}, porady pomijają rejestr:\n${project.ropaError}\n`
        : `warning: could not read ${ROPA_FILENAME}; advice ignores the record:\n${project.ropaError}\n`,
    );
  }
  if (project.datamapFromScan && format === 'text') {
    io.stderr(
      lang === 'pl'
        ? 'uwaga: brak stonekeep-datamap.json, porady na podstawie bieżącego skanu (zacznij od: stonekeep init)\n'
        : 'warning: no stonekeep-datamap.json; advice uses a live scan (start with: stonekeep init)\n',
    );
  }
  const advice = adviseProject({
    datamap: project.datamap,
    ropa: project.ropa,
    hasCi: project.hasCi,
    hasDocuments: project.hasDocuments,
    language: lang,
  });
  const output =
    format === 'json'
      ? `${JSON.stringify(advice, null, 2)}\n`
      : format === 'markdown'
        ? renderAdviceMarkdown(advice, lang)
        : renderAdviceText(advice, lang);
  if (flags.out !== undefined) {
    const file = resolve(io.cwd, flags.out);
    writeFileSync(file, output);
    io.stdout(`${lang === 'pl' ? 'Zapisano' : 'Wrote'} ${relative(io.cwd, file) || file}\n`);
  } else {
    io.stdout(output);
  }
  return flags.strict && advice.some((a) => a.severity === 'high') ? 1 : 0;
}

export interface DocumentsFlags {
  config?: string | undefined;
  out?: string | undefined;
  date?: string | undefined;
  force: boolean;
  dryRun: boolean;
}

/** `stonekeep dokumenty [path]` (alias `documents`): Polish RODO document pack. */
export function runDocumentsCommand(path: string, flags: DocumentsFlags, io: Io): number {
  if (flags.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(flags.date)) {
    throw new StonekeepError('CONFIG', `--date must be YYYY-MM-DD, got "${flags.date}"`);
  }
  const project = loadProject(path, io, flags.config);
  if (project.ropaError !== undefined) {
    io.stderr(
      `uwaga: nie udało się odczytać ${ROPA_FILENAME}; dokumenty będą zawierać więcej pól do uzupełnienia:\n${project.ropaError}\n`,
    );
  }
  const outDir =
    flags.out !== undefined ? resolve(io.cwd, flags.out) : join(project.root, DOCUMENTS_DIR);
  const files = generateDocumentPack({
    ropa: project.ropa,
    datamap: project.datamap,
    asOf: flags.date ?? new Date().toISOString().slice(0, 10),
  });
  const shown = (p: string) => relative(io.cwd, p).split(sep).join('/') || p;

  io.stdout('Pakiet dokumentów RODO\n');
  if (flags.dryRun) io.stdout('Tryb próbny: nic nie zostanie zapisane.\n');
  io.stdout('\n');
  let written = 0;
  for (const f of files) {
    const target = join(outDir, ...f.path.split('/'));
    const exists = existsSync(target);
    if (exists && !flags.force) {
      io.stdout(`  = ${shown(target)}  (pominięto, plik już istnieje; nadpisz: --force)\n`);
      continue;
    }
    if (!flags.dryRun) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, 'utf8');
    }
    written++;
    io.stdout(
      `  + ${shown(target)}  (${flags.dryRun ? 'zostanie utworzony' : exists ? 'nadpisano' : 'utworzono'})\n`,
    );
  }
  const todo = files.reduce((n, f) => n + (f.content.match(/\[UZUPEŁNIJ:/g)?.length ?? 0), 0);
  io.stdout(
    `\nPlików: ${written} z ${files.length}. Pól do uzupełnienia: ${todo} (oznaczone jako [UZUPEŁNIJ: …]).\n` +
      (project.ropa === undefined
        ? 'Wskazówka: uzupełnij rejestr (stonekeep ropa --init --lang pl), a Stonekeep wypełni dokumenty za Ciebie.\n'
        : '') +
      'Wzory nie stanowią porady prawnej. Dostosuj je do swojej sytuacji.\n',
  );
  return 0;
}
