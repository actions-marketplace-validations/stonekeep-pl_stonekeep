/**
 * Record of processing activities (GDPR Art. 30(1)) built from a DPO-maintained
 * description of processing activities (`stonekeep.ropa.yaml`) and the committed
 * datamap. The datamap supplies the categories of personal data per activity, and
 * the builder reports gaps such as PII tables that no activity covers.
 *
 * Output contains identifiers and the text the DPO wrote, never data values.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { StonekeepError, errorMessage } from './errors.js';
import { formatZodError } from './rules.js';
import { compareStrings } from './text.js';
import type { DataMap, DataMapField } from './types.js';

export const ROPA_FILENAME = 'stonekeep.ropa.yaml';

/** GDPR Art. 6(1) points (a)-(f). */
export const LEGAL_BASES = [
  'consent',
  'contract',
  'legal_obligation',
  'vital_interests',
  'public_task',
  'legitimate_interests',
] as const;
export type LegalBasis = (typeof LEGAL_BASES)[number];

/** GDPR Art. 9(2) points (a)-(j). */
export const SPECIAL_CATEGORY_CONDITIONS = [
  'explicit_consent',
  'employment_social_security',
  'vital_interests',
  'non_profit_body',
  'made_public',
  'legal_claims',
  'substantial_public_interest',
  'health_care',
  'public_health',
  'archiving_research',
] as const;
export type SpecialCategoryCondition = (typeof SPECIAL_CATEGORY_CONDITIONS)[number];

/** Datamap categories that GDPR Art. 9 treats as special categories of data. */
export const SPECIAL_CATEGORIES: ReadonlySet<string> = new Set(['special_category', 'health']);

export const ROPA_LANGUAGES = ['en', 'pl'] as const;
export type RopaLanguage = (typeof ROPA_LANGUAGES)[number];

const text = z.string().trim().min(1);
const contactSchema = z.object({ name: text, contact: text }).strict();

const transferSchema = z
  .object({
    /** Third country or international organisation. */
    country: text,
    /** Safeguard, e.g. "adequacy decision", "SCC 2021/914". */
    safeguard: text.optional(),
  })
  .strict();

const activitySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'activity id must be lowercase kebab/snake case'),
    name: text,
    purposes: z.array(text).min(1),
    legalBasis: z.array(z.enum(LEGAL_BASES)).min(1),
    /** Required when the activity covers special-category or health data. */
    specialCategoryConditions: z.array(z.enum(SPECIAL_CATEGORY_CONDITIONS)).default([]),
    dataSubjects: z.array(text).min(1),
    /** Datamap entities (tables, models, schemas) used by this activity. */
    entities: z.array(text).default([]),
    /** Individual datamap field ids (`Entity.field`) in addition to `entities`. */
    fields: z.array(text).default([]),
    /** Categories of personal data not visible in schemas (e.g. paper records). */
    extraDataCategories: z.array(text).default([]),
    recipients: z.array(text).default([]),
    transfers: z.array(transferSchema).default([]),
    retention: text,
    /** Overrides the record-wide `securityMeasures` for this activity. */
    securityMeasures: z.array(text).optional(),
  })
  .strict();

export const ropaSchema = z
  .object({
    version: z.literal(1),
    language: z.enum(ROPA_LANGUAGES).default('en'),
    controller: z
      .object({
        name: text,
        address: text.optional(),
        contact: text,
        representative: contactSchema.optional(),
        jointControllers: z.array(contactSchema).default([]),
      })
      .strict(),
    dpo: contactSchema.optional(),
    /** Art. 32 technical and organisational measures that apply to every activity. */
    securityMeasures: z.array(text).default([]),
    activities: z.array(activitySchema).min(1),
  })
  .strict()
  .superRefine((ropa, ctx) => {
    const seen = new Set<string>();
    ropa.activities.forEach((a, i) => {
      if (seen.has(a.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['activities', i, 'id'],
          message: `duplicate activity id "${a.id}"`,
        });
      }
      seen.add(a.id);
    });
  });

export type RopaInput = z.input<typeof ropaSchema>;
export type RopaConfig = z.output<typeof ropaSchema>;
export type RopaActivityConfig = RopaConfig['activities'][number];

export function parseRopa(raw: unknown, source = '(inline)'): RopaConfig {
  const parsed = ropaSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StonekeepError(
      'CONFIG',
      `Invalid ROPA file ${source}:\n${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function readRopaFile(path: string): RopaConfig {
  if (!existsSync(path)) {
    throw new StonekeepError(
      'CONFIG',
      `ROPA file not found: ${path}\nRun \`stonekeep ropa --init\` to create a starter file.`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new StonekeepError('CONFIG', `Cannot parse ${path}: ${errorMessage(error)}`);
  }
  return parseRopa(raw, path);
}

// ---------------------------------------------------------------------------
// Builder

export interface RopaDataCategory {
  category: string;
  /** Datamap field ids in this category, sorted. */
  fields: string[];
}

export interface RopaActivity extends Omit<RopaActivityConfig, 'securityMeasures' | 'fields'> {
  dataCategories: RopaDataCategory[];
  securityMeasures: string[];
  /** True when any data category is a GDPR Art. 9 special category. */
  specialCategories: boolean;
}

export type RopaIssueCode =
  | 'unknown-entity'
  | 'unknown-field'
  | 'no-personal-data'
  | 'missing-special-category-condition'
  | 'transfer-without-safeguard'
  | 'no-security-measures'
  | 'uncovered-entity';

export interface RopaIssue {
  code: RopaIssueCode;
  /** Activity id, or undefined for record-wide issues. */
  activity?: string;
  /** Entity or field id the issue is about. */
  subject?: string;
  message: string;
}

export interface Ropa {
  language: RopaLanguage;
  /** ISO date (YYYY-MM-DD) the record is stated as of. */
  asOf: string;
  controller: RopaConfig['controller'];
  dpo: RopaConfig['dpo'];
  activities: RopaActivity[];
  /** Datamap entities with personal data that no activity references. */
  uncoveredEntities: string[];
  issues: RopaIssue[];
}

export interface BuildRopaOptions {
  /** ISO date for the "as of" line. Defaults to today (UTC). */
  asOf?: string;
  /** Override the language set in the ROPA file. */
  language?: RopaLanguage;
}

function groupByCategory(fields: readonly DataMapField[]): RopaDataCategory[] {
  const by = new Map<string, Set<string>>();
  for (const f of fields) {
    const set = by.get(f.category) ?? new Set<string>();
    set.add(f.id);
    by.set(f.category, set);
  }
  return [...by.entries()]
    .map(([category, ids]) => ({ category, fields: [...ids].sort(compareStrings) }))
    .sort((a, b) => compareStrings(a.category, b.category));
}

/** Combine the DPO's activity descriptions with the datamap into an Art. 30 record. */
export function buildRopa(
  config: RopaConfig,
  datamap: DataMap,
  options: BuildRopaOptions = {},
): Ropa {
  const issues: RopaIssue[] = [];
  const byEntity = new Map<string, DataMapField[]>();
  const byId = new Map<string, DataMapField>();
  for (const f of datamap.fields) {
    byId.set(f.id, f);
    const list = byEntity.get(f.entity) ?? [];
    list.push(f);
    byEntity.set(f.entity, list);
  }

  const covered = new Set<string>();
  const activities = config.activities.map((a): RopaActivity => {
    const selected = new Map<string, DataMapField>();
    for (const entity of a.entities) {
      const fields = byEntity.get(entity);
      if (!fields) {
        issues.push({
          code: 'unknown-entity',
          activity: a.id,
          subject: entity,
          message: `Entity "${entity}" has no personal data fields in the datamap (check the name, or run \`stonekeep scan\`).`,
        });
        continue;
      }
      covered.add(entity);
      for (const f of fields) selected.set(f.id, f);
    }
    for (const id of a.fields) {
      const f = byId.get(id);
      if (!f) {
        issues.push({
          code: 'unknown-field',
          activity: a.id,
          subject: id,
          message: `Field "${id}" is not in the datamap.`,
        });
        continue;
      }
      covered.add(f.entity);
      selected.set(f.id, f);
    }

    const dataCategories = groupByCategory([...selected.values()]);
    const specialCategories = dataCategories.some((c) => SPECIAL_CATEGORIES.has(c.category));
    if (dataCategories.length === 0 && a.extraDataCategories.length === 0) {
      issues.push({
        code: 'no-personal-data',
        activity: a.id,
        message: `Activity "${a.id}" lists no personal data: add "entities", "fields" or "extraDataCategories".`,
      });
    }
    if (specialCategories && a.specialCategoryConditions.length === 0) {
      issues.push({
        code: 'missing-special-category-condition',
        activity: a.id,
        message: `Activity "${a.id}" processes special-category or health data but names no GDPR Art. 9(2) condition in "specialCategoryConditions".`,
      });
    }
    for (const t of a.transfers) {
      if (t.safeguard === undefined) {
        issues.push({
          code: 'transfer-without-safeguard',
          activity: a.id,
          subject: t.country,
          message: `Transfer to "${t.country}" in activity "${a.id}" has no safeguard (GDPR Chapter V).`,
        });
      }
    }
    const securityMeasures = a.securityMeasures ?? config.securityMeasures;
    if (securityMeasures.length === 0) {
      issues.push({
        code: 'no-security-measures',
        activity: a.id,
        message: `Activity "${a.id}" has no security measures: set "securityMeasures" at the top level or on the activity.`,
      });
    }

    return {
      id: a.id,
      name: a.name,
      purposes: a.purposes,
      legalBasis: a.legalBasis,
      specialCategoryConditions: a.specialCategoryConditions,
      dataSubjects: a.dataSubjects,
      entities: a.entities,
      extraDataCategories: a.extraDataCategories,
      recipients: a.recipients,
      transfers: a.transfers,
      retention: a.retention,
      dataCategories,
      securityMeasures,
      specialCategories,
    };
  });

  const uncoveredEntities = [...byEntity.keys()]
    .filter((e) => !covered.has(e))
    .sort(compareStrings);
  for (const entity of uncoveredEntities) {
    issues.push({
      code: 'uncovered-entity',
      subject: entity,
      message: `Entity "${entity}" holds personal data but no processing activity references it.`,
    });
  }

  return {
    language: options.language ?? config.language,
    asOf: options.asOf ?? new Date().toISOString().slice(0, 10),
    controller: config.controller,
    dpo: config.dpo,
    activities,
    uncoveredEntities,
    issues,
  };
}

/** A starter ROPA file listing every PII entity in one TODO activity, for the DPO to split up. */
export function ropaTemplate(datamap: DataMap, language: RopaLanguage = 'en'): string {
  const entities = [...new Set(datamap.fields.map((f) => f.entity))].sort(compareStrings);
  const pl = language === 'pl';
  // JSON strings are valid YAML scalars, so values containing ": " stay strings.
  const q = (en: string, polish: string) => JSON.stringify(pl ? polish : en);
  const list = (items: string[], indent: string) =>
    items.length === 0
      ? ` []\n`
      : `\n${items.map((i) => `${indent}- ${JSON.stringify(i)}`).join('\n')}\n`;
  return `# Record of processing activities (GDPR Art. 30(1)), maintained by the DPO.
# \`stonekeep ropa\` combines it with stonekeep-datamap.json into a document.
# Split the TODO activity below into real ones (one per purpose) and review every value.
# Legal bases: ${LEGAL_BASES.join(', ')}
# Art. 9(2) conditions: ${SPECIAL_CATEGORY_CONDITIONS.join(', ')}
version: 1
language: ${language}
controller:
  name: ${q('TODO: controller name', 'TODO: nazwa administratora')}
  address: ${q('TODO: address', 'TODO: adres')}
  contact: ${q('TODO: email or phone', 'TODO: e-mail lub telefon')}
dpo:
  name: ${q('TODO: data protection officer', 'TODO: inspektor ochrony danych')}
  contact: "TODO"
securityMeasures:
  - ${q('TODO: e.g. encryption at rest and in transit', 'TODO: np. szyfrowanie w spoczynku i w tranzycie')}
activities:
  - id: todo
    name: ${q('TODO: processing activity name', 'TODO: nazwa czynności przetwarzania')}
    purposes:
      - ${q('TODO: purpose', 'TODO: cel przetwarzania')}
    legalBasis:
      - contract
    dataSubjects:
      - ${q('TODO: e.g. customers', 'TODO: np. klienci')}
    entities:${list(entities, '      ')}    recipients: []
    transfers: []
    retention: ${q('TODO: e.g. 6 years after the contract ends', 'TODO: np. 6 lat od zakończenia umowy')}
`;
}
