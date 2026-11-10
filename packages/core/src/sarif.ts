import type { CheckResult } from './check.js';
import type { DataMapField } from './types.js';
import { VERSION } from './version.js';

/** Minimal SARIF 2.1.0 log for GitHub Code Scanning. Contains identifiers and locations only. */
export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: unknown[];
}

const RULES = [
  {
    id: 'stonekeep/unmapped-pii',
    name: 'UnmappedPersonalData',
    shortDescription: { text: 'Personal data field is not in the committed datamap' },
    help: {
      text: 'Run `stonekeep scan` and commit stonekeep-datamap.json, or add an override in stonekeep.config.json. Classification is heuristic and needs human review.',
    },
    defaultConfiguration: { level: 'error' },
  },
  {
    id: 'stonekeep/category-changed',
    name: 'PersonalDataCategoryChanged',
    shortDescription: { text: 'Detected category differs from the datamap' },
    defaultConfiguration: { level: 'warning' },
  },
];

function result(ruleId: string, level: 'error' | 'warning', text: string, f: DataMapField) {
  return {
    ruleId,
    level,
    message: { text },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.location.file },
          region: { startLine: Math.max(1, f.location.line) },
        },
      },
    ],
    partialFingerprints: { 'stonekeepFieldId/v1': f.id },
  };
}

/** Convert a check result into a SARIF log. `strict` upgrades category changes to errors. */
export function toSarif(check: CheckResult, strict = false): SarifLog {
  const results = [
    ...check.unmapped.map((f) =>
      result(
        'stonekeep/unmapped-pii',
        'error',
        `Unmapped personal data field "${f.id}" (category: ${f.category}, confidence ${f.confidence.toFixed(2)}).`,
        f,
      ),
    ),
    ...check.changed.map((c) =>
      result(
        'stonekeep/category-changed',
        strict ? 'error' : 'warning',
        `"${c.id}" is mapped as ${c.mapped} but now detected as ${c.detected}.`,
        c.field,
      ),
    ),
  ];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Stonekeep',
            version: VERSION,
            informationUri: 'https://github.com/stonekeep-pl/stonekeep',
            rules: RULES,
          },
        },
        results,
      },
    ],
  };
}
