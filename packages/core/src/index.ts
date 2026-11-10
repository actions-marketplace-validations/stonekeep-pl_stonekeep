export * from './types.js';
export * from './errors.js';
export { normalizeName, coarseType } from './normalize.js';
export { classify, type ClassifyInput } from './classifier.js';
export {
  DEFAULT_RULES_URL,
  compileRuleSet,
  loadDefaultRules,
  parseRulesFile,
  readRulesFile,
  ruleSchema,
  rulesFileSchema,
  type CompiledRule,
  type RuleDefinition,
  type RuleSet,
  type RulesFile,
} from './rules.js';
export {
  CONFIG_FILENAME,
  DEFAULT_DATAMAP_FILENAME,
  configSchema,
  loadConfig,
  resolveConfig,
  type FieldOverride,
  type StonekeepConfigInput,
  type LoadConfigOptions,
  type ResolvedConfig,
} from './config.js';
export { listFiles, globToRegExp, DEFAULT_EXCLUDED_DIRS } from './files.js';
export { parseSql, type SourceFile } from './parsers/sql.js';
export { parsePrisma } from './parsers/prisma.js';
export { parseTypeOrm, looksLikeTypeOrm } from './parsers/typeorm.js';
export { parseSchemaDocument } from './parsers/schema.js';
export {
  scan,
  classifyFields,
  collectSchemaFields,
  fieldId,
  MAX_FILE_BYTES,
  type ScanResult,
} from './scanner.js';
export {
  createDataMap,
  parseDataMap,
  readDataMap,
  serializeDataMap,
  writeDataMap,
} from './datamap.js';
export { check, type CheckOptions, type CheckResult, type CategoryChange } from './check.js';
export { toSarif, type SarifLog } from './sarif.js';
export {
  LEGAL_BASES,
  ROPA_FILENAME,
  ROPA_LANGUAGES,
  SPECIAL_CATEGORIES,
  SPECIAL_CATEGORY_CONDITIONS,
  buildRopa,
  parseRopa,
  readRopaFile,
  ropaSchema,
  ropaTemplate,
  type BuildRopaOptions,
  type LegalBasis,
  type Ropa,
  type RopaActivity,
  type RopaConfig,
  type RopaDataCategory,
  type RopaInput,
  type RopaIssue,
  type RopaIssueCode,
  type RopaLanguage,
  type SpecialCategoryCondition,
} from './ropa.js';
export {
  dataCategoryLabel,
  legalBasisLabel,
  renderRopaMarkdown,
  specialConditionLabel,
} from './ropa-render.js';
export {
  LEGAL_SOURCES,
  RODO_FACTS,
  art,
  formatArticle,
  formatRecital,
  type ArticleRef,
  type LegalLanguage,
  type LegalSource,
} from './legal.js';
export {
  adviseProject,
  renderAdviceMarkdown,
  renderAdviceText,
  type Advice,
  type AdviceInput,
  type AdviceSeverity,
} from './advice.js';
export { generateDocumentPack, type DocumentFile, type DocumentPackInput } from './documents.js';
export {
  ACTIVITY_PRESETS,
  SECURITY_PRESETS,
  SERVICE_PRESETS,
  assessCompliance,
  companyProfileSchema,
  complianceCatalog,
  parseCompanyProfile,
  profileToRopa,
  type ChecklistItem,
  type CompanyProfile,
  type CompanyProfileInput,
  type ComplianceOverview,
} from './compliance.js';
export {
  BREACH_NOTIFY_HOURS,
  HIGH_RISK_CATEGORIES,
  renderBreachMarkdown,
  summarizeBreach,
  type BreachColumn,
  type BreachImpact,
  type BreachLanguage,
  type BreachRenderOptions,
  type BreachRisk,
  type BreachTableImpact,
} from './breach.js';
export { VERSION } from './version.js';
