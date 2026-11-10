/**
 * Tamper-evident consent ledger (Stage 4). Import from `@stonekeep/core/consent`
 * (separate entry point: it loads the native better-sqlite3 module).
 */
export { canonicalJson, sha256Hex, hmacHex, type Json } from './canonical.js';
export {
  GENESIS_HASH,
  bodyHashOf,
  chainHashOf,
  contentHashOf,
  verifyChain,
  type ChainCheck,
  type ChainItem,
  type ChainOptions,
  type ConsentAction,
  type EntryContent,
  type LedgerEntry,
} from './chain.js';
export {
  ConsentLedger,
  MIN_LEDGER_SECRET_LENGTH,
  verifyEvidence,
  type EvidenceEntry,
  type EvidenceSegment,
  type LedgerOptions,
  type LedgerVerification,
  type PurposeState,
  type RecordInput,
  type SubjectStatus,
} from './ledger.js';
