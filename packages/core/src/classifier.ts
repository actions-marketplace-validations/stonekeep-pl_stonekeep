import { coarseType, normalizeName } from './normalize.js';
import type { RuleSet } from './rules.js';
import type { Classification } from './types.js';

export interface ClassifyInput {
  /** Candidate names (e.g. property name and mapped column name). */
  names: readonly string[];
  rawType?: string | undefined;
  format?: string | undefined;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * Rule-based classification. Returns the best-scoring rule or `undefined`.
 * Ties are resolved by rule order. This is a heuristic, not a legal opinion.
 */
export function classify(input: ClassifyInput, ruleSet: RuleSet): Classification | undefined {
  const names = [...new Set(input.names.map(normalizeName).filter((n) => n.length > 0))];
  const matchable = names.filter((n) => !ruleSet.ignore.some((re) => re.test(n)));
  const format = input.format?.toLowerCase();
  const type = coarseType(input.rawType);

  let best: Classification | undefined;
  for (const rule of ruleSet.rules) {
    let score = 0;
    for (const name of matchable) {
      if (rule.exclude.some((re) => re.test(name))) continue;
      for (const m of rule.matchers) {
        if (m.confidence > score && m.re.test(name)) score = m.confidence;
      }
    }
    if (format !== undefined && rule.formats.has(format)) {
      score = Math.max(score, rule.formatConfidence);
    }
    if (score === 0) continue;
    const adjustment = rule.typeAdjustments[type] ?? ruleSet.typeAdjustments[type] ?? 0;
    const confidence = round2(clamp01(score + adjustment));
    if (confidence > 0 && (best === undefined || confidence > best.confidence)) {
      best = { category: rule.category, rule: rule.id, confidence };
    }
  }
  return best;
}
