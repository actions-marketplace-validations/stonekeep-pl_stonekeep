import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { StonekeepError, errorMessage } from './errors.js';
import { COARSE_TYPES, type CoarseType } from './types.js';

const coarseTypeSchema = z.enum(COARSE_TYPES);
const typeAdjustmentsSchema = z.record(coarseTypeSchema, z.number().min(-1).max(1));

export const categorySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'category must be lowercase snake_case');

export const ruleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/, 'rule id must be lowercase kebab/snake case'),
    category: categorySchema,
    description: z.string().optional(),
    match: z
      .array(
        z.object({ pattern: z.string().min(1), confidence: z.number().min(0).max(1) }).strict(),
      )
      .min(1),
    exclude: z.array(z.string().min(1)).default([]),
    formats: z.array(z.string().min(1)).default([]),
    formatConfidence: z.number().min(0).max(1).default(0.98),
    typeAdjustments: typeAdjustmentsSchema.optional(),
  })
  .strict();

export const rulesFileSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    description: z.string().optional(),
    ignore: z.array(z.string().min(1)).default([]),
    typeAdjustments: typeAdjustmentsSchema.default({}),
    rules: z.array(ruleSchema),
  })
  .strict();

export type RuleDefinition = z.input<typeof ruleSchema>;
export type RulesFile = z.output<typeof rulesFileSchema>;

export interface CompiledRule {
  id: string;
  category: string;
  matchers: { re: RegExp; confidence: number }[];
  exclude: RegExp[];
  formats: Set<string>;
  formatConfidence: number;
  typeAdjustments: Partial<Record<CoarseType, number>>;
}

export interface RuleSet {
  ignore: RegExp[];
  typeAdjustments: Partial<Record<CoarseType, number>>;
  rules: CompiledRule[];
}

export const DEFAULT_RULES_URL = new URL('../rules/default-rules.json', import.meta.url);

function compileRegex(pattern: string, where: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new StonekeepError(
      'RULES',
      `Invalid regular expression in ${where}: ${errorMessage(error)}`,
    );
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

export function parseRulesFile(json: unknown, source: string): RulesFile {
  const parsed = rulesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new StonekeepError(
      'RULES',
      `Invalid rules file ${source}:\n${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function readRulesFile(path: string | URL): RulesFile {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StonekeepError(
      'RULES',
      `Cannot read rules file ${String(path)}: ${errorMessage(error)}`,
    );
  }
  return parseRulesFile(json, String(path));
}

export function loadDefaultRules(): RulesFile {
  return readRulesFile(DEFAULT_RULES_URL);
}

export function compileRule(rule: z.output<typeof ruleSchema>): CompiledRule {
  return {
    id: rule.id,
    category: rule.category,
    matchers: rule.match.map((m, i) => ({
      re: compileRegex(m.pattern, `rule "${rule.id}" match[${i}]`),
      confidence: m.confidence,
    })),
    exclude: rule.exclude.map((p, i) => compileRegex(p, `rule "${rule.id}" exclude[${i}]`)),
    formats: new Set(rule.formats.map((f) => f.toLowerCase())),
    formatConfidence: rule.formatConfidence,
    typeAdjustments: rule.typeAdjustments ?? {},
  };
}

/**
 * Compile a rules file plus optional extra rules. An extra rule whose `id`
 * matches an existing rule replaces it; otherwise it is appended.
 */
export function compileRuleSet(file: RulesFile, extraRules: readonly unknown[] = []): RuleSet {
  const extras = extraRules.map((r, i) => {
    const parsed = ruleSchema.safeParse(r);
    if (!parsed.success) {
      throw new StonekeepError(
        'CONFIG',
        `Invalid extraRules[${i}]:\n${formatZodError(parsed.error)}`,
      );
    }
    return parsed.data;
  });
  const byId = new Map(file.rules.map((r) => [r.id, r]));
  for (const extra of extras) byId.set(extra.id, extra);
  return {
    ignore: file.ignore.map((p, i) => compileRegex(p, `ignore[${i}]`)),
    typeAdjustments: file.typeAdjustments,
    rules: [...byId.values()].map(compileRule),
  };
}

export { formatZodError };
