import { canonicalJson, sha256Hex } from './canonical.js';

/** Hash that precedes the first entry. */
export const GENESIS_HASH = '0'.repeat(64);

export type ConsentAction = 'granted' | 'withdrawn' | 'erased';

/** The hashed content of one ledger entry. `subject` is an HMAC, never the raw id. */
export interface EntryContent {
  v: 1;
  seq: number;
  subject: string;
  purpose: string;
  action: ConsentAction;
  /** ISO 8601 UTC. */
  recordedAt: string;
  policyVersion?: string;
  source?: string;
}

export interface LedgerEntry {
  seq: number;
  /** Subject HMAC. Kept even after redaction (it is not reversible without the ledger secret). */
  subject: string;
  prevHash: string;
  contentHash: string;
  hash: string;
  /** `null` once redacted by an erasure: only the hashes remain. */
  content: EntryContent | null;
}

/*
 * Hash structure (all SHA-256 over canonical JSON):
 *
 *   contentHash = H(content)                         content can be redacted later
 *   bodyHash    = H({ seq, subject, contentHash })   binds the subject even after redaction
 *   hash        = H({ seq, prevHash, bodyHash })     the chain link
 *
 * An evidence segment can show another subject's entry as just
 * { seq, prevHash, bodyHash, hash }: the chain still verifies, while that
 * entry's subject and content stay hidden.
 */
export function contentHashOf(content: EntryContent): string {
  return sha256Hex(canonicalJson(content));
}

export function bodyHashOf(seq: number, subject: string, contentHash: string): string {
  return sha256Hex(canonicalJson({ seq, subject, contentHash }));
}

export function chainHashOf(seq: number, prevHash: string, bodyHash: string): string {
  return sha256Hex(canonicalJson({ seq, prevHash, bodyHash }));
}

/** One link to verify. Either `subject` + `contentHash` (ledger) or a disclosed `bodyHash` (evidence). */
export interface ChainItem {
  seq: number;
  prevHash: string;
  hash: string;
  subject?: string;
  contentHash?: string;
  bodyHash?: string;
  content: EntryContent | null;
}

export interface ChainCheck {
  valid: boolean;
  /** Problems, identified by sequence number only. */
  errors: string[];
}

export interface ChainOptions {
  /** Require redacted entries to be followed by an erasure of the same subject (ledger mode). */
  checkRedactions?: boolean;
}

/**
 * Verify a contiguous run of entries starting after `anchor`:
 *  - sequence numbers are contiguous,
 *  - every `prevHash` equals the previous entry's `hash`,
 *  - every `hash` recomputes from (seq, prevHash, bodyHash),
 *  - disclosed content recomputes to its contentHash and matches seq/subject,
 *  - (ledger mode) a redacted entry is followed by an erasure of its subject.
 */
export function verifyChain(
  entries: readonly ChainItem[],
  anchor: { seq: number; hash: string } = { seq: 0, hash: GENESIS_HASH },
  options: ChainOptions = {},
): ChainCheck {
  const errors: string[] = [];
  let prev = anchor.hash;
  let expectedSeq = anchor.seq + 1;
  const lastErasure = new Map<string, number>();
  for (const e of entries) {
    if (e.content?.action === 'erased' && e.subject !== undefined)
      lastErasure.set(e.subject, Math.max(lastErasure.get(e.subject) ?? 0, e.seq));
  }
  for (const e of entries) {
    if (e.seq !== expectedSeq)
      errors.push(`seq ${e.seq}: expected seq ${expectedSeq} (gap, duplicate or reorder)`);
    if (e.prevHash !== prev)
      errors.push(`seq ${e.seq}: prevHash does not match the previous entry`);

    let contentHash = e.contentHash;
    if (e.content) {
      const recomputed = contentHashOf(e.content);
      if (contentHash !== undefined && recomputed !== contentHash)
        errors.push(`seq ${e.seq}: content was modified`);
      contentHash = recomputed;
      if (e.content.seq !== e.seq || (e.subject !== undefined && e.content.subject !== e.subject)) {
        errors.push(`seq ${e.seq}: content seq/subject mismatch`);
      }
    }
    const subject = e.subject ?? e.content?.subject;
    const body =
      subject !== undefined && contentHash !== undefined
        ? bodyHashOf(e.seq, subject, contentHash)
        : e.bodyHash;
    if (body === undefined) errors.push(`seq ${e.seq}: not enough data to verify`);
    else if (e.bodyHash !== undefined && body !== e.bodyHash)
      errors.push(`seq ${e.seq}: body hash mismatch`);
    if (body !== undefined && chainHashOf(e.seq, e.prevHash, body) !== e.hash)
      errors.push(`seq ${e.seq}: hash does not match its contents`);

    if (
      options.checkRedactions &&
      !e.content &&
      subject !== undefined &&
      (lastErasure.get(subject) ?? 0) <= e.seq
    ) {
      errors.push(`seq ${e.seq}: redacted without a later erasure event`);
    }
    prev = e.hash;
    expectedSeq = e.seq + 1;
    if (errors.length >= 20) break;
  }
  return { valid: errors.length === 0, errors };
}
