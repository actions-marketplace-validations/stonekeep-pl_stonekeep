import { existsSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  StonekeepError,
  ROPA_FILENAME,
  ROPA_LANGUAGES,
  buildRopa,
  loadConfig,
  readDataMap,
  readRopaFile,
  renderRopaMarkdown,
  ropaTemplate,
  type RopaLanguage,
} from '@stonekeep/core';
import type { Io } from './index.js';

export interface RopaFlags {
  config?: string | undefined;
  datamap?: string | undefined;
  ropa?: string | undefined;
  lang?: string | undefined;
  format?: string | undefined;
  out?: string | undefined;
  date?: string | undefined;
  init: boolean;
  strict: boolean;
}

function parseLanguage(value: string | undefined): RopaLanguage | undefined {
  if (value === undefined) return undefined;
  if ((ROPA_LANGUAGES as readonly string[]).includes(value)) return value as RopaLanguage;
  throw new StonekeepError(
    'CONFIG',
    `unknown --lang "${value}" (expected ${ROPA_LANGUAGES.join(' or ')})`,
  );
}

/**
 * `stonekeep ropa [path]`: write the GDPR Art. 30 record from stonekeep.ropa.yaml and the
 * datamap. `--init` writes a starter stonekeep.ropa.yaml instead. Exit 1 with `--strict`
 * when the record has open points (for example PII tables no activity covers).
 */
export function runRopaCommand(path: string, flags: RopaFlags, io: Io): number {
  const root = resolve(io.cwd, path);
  const config = loadConfig(root, {
    configPath: flags.config !== undefined ? resolve(io.cwd, flags.config) : undefined,
    datamapPath: flags.datamap !== undefined ? resolve(io.cwd, flags.datamap) : undefined,
  });
  const ropaPath =
    flags.ropa !== undefined ? resolve(io.cwd, flags.ropa) : resolve(root, ROPA_FILENAME);
  const shown = (p: string) => relative(io.cwd, p) || p;
  const language = parseLanguage(flags.lang);
  const datamap = readDataMap(config.datamapPath);

  if (flags.init) {
    if (existsSync(ropaPath)) {
      throw new StonekeepError('CONFIG', `${shown(ropaPath)} already exists; edit it instead`);
    }
    writeFileSync(ropaPath, ropaTemplate(datamap, language ?? 'en'));
    io.stdout(
      `Wrote ${shown(ropaPath)}. Split the TODO activity into real processing activities, then run \`stonekeep ropa\`.\n`,
    );
    return 0;
  }

  const format = flags.format ?? 'markdown';
  if (format !== 'markdown' && format !== 'json') {
    throw new StonekeepError('CONFIG', `unknown --format "${format}" (expected markdown or json)`);
  }
  if (flags.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(flags.date)) {
    throw new StonekeepError('CONFIG', `--date must be YYYY-MM-DD, got "${flags.date}"`);
  }

  const ropa = buildRopa(readRopaFile(ropaPath), datamap, {
    ...(flags.date !== undefined ? { asOf: flags.date } : {}),
    ...(language !== undefined ? { language } : {}),
  });
  const output =
    format === 'json' ? `${JSON.stringify(ropa, null, 2)}\n` : renderRopaMarkdown(ropa);

  if (flags.out !== undefined) {
    const outPath = resolve(io.cwd, flags.out);
    writeFileSync(outPath, output);
    io.stdout(
      `Wrote ${shown(outPath)}: ${ropa.activities.length} processing activit${ropa.activities.length === 1 ? 'y' : 'ies'}, ${ropa.issues.length} open point${ropa.issues.length === 1 ? '' : 's'}\n`,
    );
  } else {
    io.stdout(output);
  }
  for (const issue of ropa.issues) io.stderr(`warning: ${issue.message}\n`);
  return flags.strict && ropa.issues.length > 0 ? 1 : 0;
}
