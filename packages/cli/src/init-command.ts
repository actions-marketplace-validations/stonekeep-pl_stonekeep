import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  CONFIG_FILENAME,
  DEFAULT_DATAMAP_FILENAME,
  StonekeepError,
  ROPA_FILENAME,
  createDataMap,
  loadConfig,
  readDataMap,
  ropaTemplate,
  scan,
  writeDataMap,
  type DataMap,
} from '@stonekeep/core';
import type { Io } from './index.js';

export interface InitFlags {
  lang?: string | undefined;
  /** auto (default) | github | gitlab | none */
  ci?: string | undefined;
  dryRun: boolean;
  force: boolean;
}

type Lang = 'pl' | 'en';
type Ci = 'github' | 'gitlab' | 'none';

const SENSITIVE = new Set([
  'government_id',
  'financial',
  'health',
  'special_category',
  'credential',
]);

const CATEGORY: Record<Lang, Record<string, string>> = {
  pl: {
    contact: 'dane kontaktowe',
    identity: 'dane identyfikacyjne',
    government_id: 'numery identyfikacyjne (PESEL, NIP, dowód)',
    financial: 'dane finansowe',
    location: 'adresy i lokalizacja',
    online_identifier: 'identyfikatory internetowe',
    demographic: 'dane demograficzne',
    special_category: 'szczególne kategorie danych (art. 9)',
    health: 'dane o zdrowiu (art. 9)',
    credential: 'dane uwierzytelniające',
  },
  en: {
    contact: 'contact details',
    identity: 'identification data',
    government_id: 'national IDs (PESEL, NIP, ID card)',
    financial: 'financial data',
    location: 'addresses and location',
    online_identifier: 'online identifiers',
    demographic: 'demographic data',
    special_category: 'special categories (Art. 9)',
    health: 'health data (Art. 9)',
    credential: 'authentication data',
  },
};

const T = {
  pl: {
    title: 'Stonekeep: konfiguracja projektu',
    dryRun: 'Tryb próbny: nic nie zostanie zapisane.',
    noSchemas:
      'Nie znaleziono plików schematów (migracje SQL, Prisma, TypeORM, JSON Schema, OpenAPI).\nUruchom `stonekeep init` w katalogu projektu albo podaj ścieżkę: `stonekeep init ./backend`.',
    scanned: (files: number, fields: number, pii: number) =>
      `Przeskanowane pliki: ${files}. Pola w schematach: ${fields}, z danymi osobowymi: ${pii}.`,
    found: 'Znalezione kategorie danych osobowych:',
    sensitive:
      'Uwaga: projekt przechowuje dane wrażliwe. Zadbaj o szyfrowanie i ogranicz dostęp do tych kolumn.',
    noPii:
      'Nie wykryto pól z danymi osobowymi. Sprawdź wynik ręcznie: nazwy pól mogą być nietypowe.',
    files: 'Pliki:',
    created: 'utworzono',
    wouldCreate: 'zostanie utworzony',
    overwritten: 'nadpisano',
    kept: 'pominięto, plik już istnieje',
    datamapKept: 'pominięto, plik już istnieje; odśwież: stonekeep scan',
    gitlab:
      'GitLab: dodaj do .gitlab-ci.yml zadanie poniżej (Stonekeep nie zmienia istniejącego pliku):',
    noCi: 'CI: nie wykryto GitHub ani GitLab. Dodaj workflow później: stonekeep init --ci github',
    next: 'Co dalej:',
    step1: (datamap: string) =>
      `Przejrzyj ${datamap}: to lista pól z danymi osobowymi. Błędne wyniki popraw w ${CONFIG_FILENAME} ("overrides") albo komentarzem stonekeep-ignore.`,
    step2: (ropa: string) =>
      `Uzupełnij ${ropa} (cele, podstawy prawne, okresy przechowywania), potem: stonekeep ropa -o rejestr.md`,
    step3:
      'Zatwierdź pliki w repozytorium. Od teraz CI zablokuje PR z nowymi danymi osobowymi bez wpisu w mapie.',
    step4: 'Sprawdź porady dla projektu (z odwołaniami do RODO): stonekeep porady',
    step5:
      'Wygeneruj wzory dokumentów (klauzula informacyjna, procedury, pisma): stonekeep dokumenty',
    disclaimer:
      'Klasyfikacja jest heurystyczna i wymaga przeglądu. Stonekeep pomaga w obowiązkach RODO, ale nie gwarantuje zgodności z prawem.',
  },
  en: {
    title: 'Stonekeep: project setup',
    dryRun: 'Dry run: nothing will be written.',
    noSchemas:
      'No schema files found (SQL migrations, Prisma, TypeORM, JSON Schema, OpenAPI).\nRun `stonekeep init` in your project folder or pass a path: `stonekeep init ./backend`.',
    scanned: (files: number, fields: number, pii: number) =>
      `Scanned ${files} file(s): ${fields} fields, ${pii} with personal data.`,
    found: 'Categories of personal data found:',
    sensitive:
      'Note: this project stores sensitive data. Encrypt it and restrict access to these columns.',
    noPii: 'No personal data fields detected. Check by hand: field names may be unusual.',
    files: 'Files:',
    created: 'created',
    wouldCreate: 'would be created',
    overwritten: 'overwritten',
    kept: 'skipped, file already exists',
    datamapKept: 'skipped, file already exists; refresh: stonekeep scan',
    gitlab:
      'GitLab: add the job below to .gitlab-ci.yml (Stonekeep does not change an existing file):',
    noCi: 'CI: no GitHub or GitLab detected. Add the workflow later: stonekeep init --ci github',
    next: 'Next steps:',
    step1: (datamap: string) =>
      `Review ${datamap}: the fields that hold personal data. Fix wrong results in ${CONFIG_FILENAME} ("overrides") or with a stonekeep-ignore comment.`,
    step2: (ropa: string) =>
      `Fill in ${ropa} (purposes, legal bases, retention), then: stonekeep ropa -o ropa.md`,
    step3:
      'Commit the files. From now on CI blocks a PR that adds personal data without a datamap entry.',
    step4: 'Get advice for this project, with GDPR references: stonekeep porady --lang en',
    step5: 'Generate document templates (Polish): stonekeep dokumenty',
    disclaimer:
      'Classification is heuristic and needs review. Stonekeep helps with GDPR duties; it does not guarantee legal compliance.',
  },
} as const;

const CONFIG_TEMPLATE = `${JSON.stringify(
  {
    minConfidence: 0.5,
    exclude: [],
    overrides: {},
  },
  null,
  2,
)}\n`;

/** Walk up from `start` to the folder that contains `.git`. */
function gitRoot(start: string): string | undefined {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function detectCi(root: string, repo: string | undefined): Ci {
  const base = repo ?? root;
  if (existsSync(join(base, '.gitlab-ci.yml'))) return 'gitlab';
  if (existsSync(join(base, '.github'))) return 'github';
  if (repo !== undefined) {
    try {
      const cfg = readFileSync(join(repo, '.git', 'config'), 'utf8');
      if (/github\.com[:/]/.test(cfg)) return 'github';
      if (/gitlab\./.test(cfg)) return 'gitlab';
    } catch {
      // .git may be a file (worktree or submodule); fall through
    }
  }
  return 'none';
}

const posix = (p: string) => p.split(sep).join('/');

function githubWorkflow(projectPath: string, lang: Lang): string {
  const target = projectPath === '' ? '' : ` ${projectPath}`;
  const comment =
    lang === 'pl'
      ? '# Stonekeep: blokuje PR, który dodaje dane osobowe bez wpisu w mapie danych (RODO).'
      : '# Stonekeep: blocks a PR that adds personal data without a datamap entry (GDPR).';
  return `${comment}
name: Stonekeep
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  pii-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx --yes @stonekeep/cli check${target}
`;
}

function gitlabJob(projectPath: string): string {
  const target = projectPath === '' ? '' : ` ${projectPath}`;
  return `stonekeep:
  image: node:20
  script:
    - npx --yes @stonekeep/cli check${target}
`;
}

/**
 * `stonekeep init [path]`: one command for a small team or a solo developer. Scans the
 * project, writes the datamap, a config, a Polish ROPA template and a CI workflow, then
 * prints what to do next. Never overwrites existing files unless `--force`.
 */
export function runInitCommand(path: string, flags: InitFlags, io: Io): number {
  const rawLang = flags.lang ?? 'pl';
  if (rawLang !== 'pl' && rawLang !== 'en') {
    throw new StonekeepError('CONFIG', `unknown --lang "${rawLang}" (expected pl or en)`);
  }
  const lang: Lang = rawLang;
  const ciFlag = flags.ci ?? 'auto';
  if (!['auto', 'github', 'gitlab', 'none'].includes(ciFlag)) {
    throw new StonekeepError(
      'CONFIG',
      `unknown --ci "${ciFlag}" (expected auto, github, gitlab or none)`,
    );
  }
  const t = T[lang];
  const root = resolve(io.cwd, path);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new StonekeepError('CONFIG', `not a folder: ${root}`);
  }
  const shown = (p: string) => posix(relative(io.cwd, p)) || '.';

  io.stdout(`${t.title}\n`);
  if (flags.dryRun) io.stdout(`${t.dryRun}\n`);
  io.stdout('\n');

  // 1. Scan
  const config = loadConfig(root);
  const result = scan(config);
  for (const w of result.warnings) io.stderr(`warning: ${w}\n`);
  if (result.filesScanned === 0) {
    io.stderr(`${t.noSchemas}\n`);
    return 2;
  }
  const fresh: DataMap = createDataMap(result.fields);
  io.stdout(`${t.scanned(result.filesScanned, result.schemaFieldCount, fresh.fields.length)}\n`);

  const byCategory = new Map<string, number>();
  for (const f of fresh.fields) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
  if (byCategory.size > 0) {
    io.stdout(`${t.found}\n`);
    for (const [cat, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
      const mark = SENSITIVE.has(cat) ? '!' : '-';
      io.stdout(`  ${mark} ${CATEGORY[lang][cat] ?? cat}: ${n}\n`);
    }
    if ([...byCategory.keys()].some((c) => SENSITIVE.has(c))) io.stdout(`\n${t.sensitive}\n`);
  } else {
    io.stdout(`${t.noPii}\n`);
  }

  // 2. Files
  const lines: string[] = [];
  const write = (file: string, content: string | (() => void), keptMsg: string = t.kept) => {
    const exists = existsSync(file);
    if (exists && !flags.force) {
      lines.push(`  = ${shown(file)}  (${keptMsg})`);
      return;
    }
    if (!flags.dryRun) {
      mkdirSync(dirname(file), { recursive: true });
      if (typeof content === 'string') writeFileSync(file, content, 'utf8');
      else content();
    }
    lines.push(
      `  + ${shown(file)}  (${flags.dryRun ? t.wouldCreate : exists ? t.overwritten : t.created})`,
    );
  };

  write(config.datamapPath, () => writeDataMap(config.datamapPath, fresh), t.datamapKept);
  write(join(root, CONFIG_FILENAME), CONFIG_TEMPLATE);
  // The ROPA lists the entities of the datamap that will be committed.
  const committed =
    existsSync(config.datamapPath) && !flags.force && !flags.dryRun
      ? readDataMap(config.datamapPath)
      : fresh;
  write(join(root, ROPA_FILENAME), ropaTemplate(committed, lang));

  const repo = gitRoot(root);
  const ci: Ci = ciFlag === 'auto' ? detectCi(root, repo) : (ciFlag as Ci);
  const projectPath = repo !== undefined ? posix(relative(repo, root)) : '';
  let gitlabSnippet: string | undefined;
  if (ci === 'github') {
    write(
      join(repo ?? root, '.github', 'workflows', 'stonekeep.yml'),
      githubWorkflow(projectPath, lang),
    );
  } else if (ci === 'gitlab') {
    gitlabSnippet = gitlabJob(projectPath);
  }

  io.stdout(`\n${t.files}\n${lines.join('\n')}\n`);
  if (gitlabSnippet !== undefined) io.stdout(`\n${t.gitlab}\n\n${gitlabSnippet}`);
  if (ci === 'none') io.stdout(`\n${t.noCi}\n`);

  // 3. Next steps
  const datamapName = shown(config.datamapPath) || DEFAULT_DATAMAP_FILENAME;
  io.stdout(
    `\n${t.next}\n` +
      `  1. ${t.step1(datamapName)}\n` +
      `  2. ${t.step2(shown(join(root, ROPA_FILENAME)))}\n` +
      `  3. ${t.step3}\n` +
      `  4. ${t.step4}\n` +
      `  5. ${t.step5}\n\n` +
      `${t.disclaimer}\n`,
  );
  return 0;
}
