import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { StonekeepError, errorMessage } from './errors.js';
import {
  categorySchema,
  compileRuleSet,
  formatZodError,
  loadDefaultRules,
  readRulesFile,
  type RuleSet,
} from './rules.js';

export const CONFIG_FILENAME = 'stonekeep.config.json';
export const DEFAULT_DATAMAP_FILENAME = 'stonekeep-datamap.json';

const overrideSchema = z
  .object({
    /** Force a category for this field (it is then treated as mapped). */
    category: categorySchema.optional(),
    /** Reviewed and confirmed NOT personal data: drop it from the datamap. */
    ignore: z.boolean().optional(),
    /** Free-text justification for reviewers. Must not contain personal data. */
    note: z.string().optional(),
  })
  .strict()
  .refine((o) => o.category !== undefined || o.ignore === true, {
    message: 'an override needs either "category" or "ignore": true',
  });

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    /** Path of the datamap, relative to the scan root. */
    datamap: z.string().min(1).default(DEFAULT_DATAMAP_FILENAME),
    /** Replace the built-in rules with this rules file (relative to the scan root). */
    rulesFile: z.string().min(1).optional(),
    /** Extra rules appended to (or replacing, by id) the active rules. */
    extraRules: z.array(z.unknown()).default([]),
    /** Fields scoring below this confidence are not reported. */
    minConfidence: z.number().min(0).max(1).default(0.5),
    /** Glob patterns (relative to the scan root) to skip. */
    exclude: z.array(z.string().min(1)).default([]),
    /** Per-field decisions keyed by datamap id (`Entity.field`). */
    overrides: z.record(z.string().min(1), overrideSchema).default({}),
  })
  .strict();

export type StonekeepConfigInput = z.input<typeof configSchema>;
export type FieldOverride = z.output<typeof overrideSchema>;

export interface ResolvedConfig {
  /** Absolute scan root. */
  root: string;
  /** Absolute path of the config file, if one was loaded. */
  configFile: string | undefined;
  /** Absolute datamap path. */
  datamapPath: string;
  minConfidence: number;
  exclude: string[];
  overrides: Record<string, FieldOverride>;
  ruleSet: RuleSet;
}

export interface LoadConfigOptions {
  /** Explicit config path (absolute or relative to cwd). Must exist if given. */
  configPath?: string | undefined;
  /** Explicit datamap path (absolute or relative to cwd); overrides the config value. */
  datamapPath?: string | undefined;
}

export function resolveConfig(root: string, raw: unknown, configFile?: string): ResolvedConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StonekeepError(
      'CONFIG',
      `Invalid config ${configFile ?? '(inline)'}:\n${formatZodError(parsed.error)}`,
    );
  }
  const cfg = parsed.data;
  const absRoot = resolve(root);
  const rulesFile =
    cfg.rulesFile === undefined
      ? loadDefaultRules()
      : readRulesFile(resolve(absRoot, cfg.rulesFile));
  return {
    root: absRoot,
    configFile,
    datamapPath: isAbsolute(cfg.datamap) ? cfg.datamap : resolve(absRoot, cfg.datamap),
    minConfidence: cfg.minConfidence,
    exclude: cfg.exclude,
    overrides: cfg.overrides,
    ruleSet: compileRuleSet(rulesFile, cfg.extraRules),
  };
}

/** Load `stonekeep.config.json` from `root` (optional) or an explicit path (required). */
export function loadConfig(root: string, options: LoadConfigOptions = {}): ResolvedConfig {
  const absRoot = resolve(root);
  const configFile =
    options.configPath !== undefined
      ? resolve(options.configPath)
      : resolve(absRoot, CONFIG_FILENAME);

  let raw: unknown = {};
  let loadedFrom: string | undefined;
  if (existsSync(configFile)) {
    try {
      raw = JSON.parse(readFileSync(configFile, 'utf8'));
    } catch (error) {
      throw new StonekeepError('CONFIG', `Cannot parse ${configFile}: ${errorMessage(error)}`);
    }
    loadedFrom = configFile;
  } else if (options.configPath !== undefined) {
    throw new StonekeepError('CONFIG', `Config file not found: ${configFile}`);
  }

  const resolved = resolveConfig(absRoot, raw, loadedFrom);
  if (options.datamapPath !== undefined) {
    return { ...resolved, datamapPath: resolve(options.datamapPath) };
  }
  return resolved;
}
