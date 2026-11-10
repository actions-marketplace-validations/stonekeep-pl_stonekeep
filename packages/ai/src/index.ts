export {
  PrivacyGuardError,
  assertSafeToSend,
  inspectPayload,
  type FindingKind,
  type GuardFinding,
} from './guard.js';
export { buildSchemaMetadata, type MetadataInput, type SchemaMetadata } from './metadata.js';
export { ProposalSchema, type Proposal } from './proposal.js';
export { SYSTEM_PROMPT, buildPrompt } from './prompt.js';
export {
  DEFAULT_MODEL,
  GuardedProvider,
  createAnthropicProvider,
  type AnthropicProviderOptions,
  type PromptPayload,
  type ProposalProvider,
} from './providers.js';
export { heuristicProposal, heuristicProvider, heuristicStrategy } from './heuristic.js';
export { renderProposal, type RenderedProposal } from './render.js';
export { diffLines, renderDiff, type DiffLine } from './diff.js';
export { runSetup, type SetupIo, type SetupOptions, type SetupResult } from './setup.js';
export {
  formatReport,
  goldenMetadata,
  loadGolden,
  runEval,
  scoreProposal,
  type EvalReport,
  type GoldenSet,
} from './eval.js';
export { renderSkillMd } from './skill.js';
