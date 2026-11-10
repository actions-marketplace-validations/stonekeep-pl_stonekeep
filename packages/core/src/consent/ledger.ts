import Database from 'better-sqlite3';
import { StonekeepError } from '../errors.js';
import { canonicalJson, hmacHex } from './canonical.js';
import {
  GENESIS_HASH,
  bodyHashOf,
  chainHashOf,
  contentHashOf,
  verifyChain,
  type ConsentAction,
  type EntryContent,
  type LedgerEntry,
} from './chain.js';

export const MIN_LEDGER_SECRET_LENGTH = 32;
const FORMAT_VERSION = '1';
const TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/;
const PURPOSE = /^[a-z][a-z0-9_.:-]{0,63}$/;

export interface RecordInput {
  /** Raw subject id. It is HMAC'd immediately and never stored. */
  subject: string;
  purpose: string;
  action: 'granted' | 'withdrawn';
  policyVersion?: string;
  /** Where consent was captured, e.g. `banner`, `settings`, `api`. */
  source?: string;
}

export interface PurposeState {
  granted: boolean;
  since: string;
  policyVersion?: string;
}

export interface SubjectStatus {
  subject: string;
  erased: boolean;
  erasedAt?: string;
  purposes: Record<string, PurposeState>;
}

export interface LedgerVerification {
  valid: boolean;
  entries: number;
  headSeq: number;
  errors: string[];
}

export interface EvidenceEntry {
  seq: number;
  prevHash: string;
  /** H({ seq, subject, contentHash }) — lets hidden entries be chained without revealing them. */
  bodyHash: string;
  hash: string;
  /** Present for the subject's own, non-redacted entries only. */
  content?: EntryContent;
  /** Another subject's entry or a redacted one: hashes only. */
  redacted?: true;
}

/** A self-contained, verifiable chain segment proving a subject's consent history. */
export interface EvidenceSegment {
  format: 'stonekeep-consent-evidence';
  formatVersion: 1;
  generatedAt: string;
  subject: string;
  /** The link before the first entry of the segment. */
  anchor: { seq: number; hash: string };
  entries: EvidenceEntry[];
  /** Ledger head at export time; the segment runs up to it, so nothing later is hidden. */
  head: { seq: number; hash: string; mac: string };
  status: SubjectStatus;
}

interface Row {
  seq: number;
  subject: string;
  purpose: string | null;
  action: string | null;
  recorded_at: string | null;
  policy_version: string | null;
  source: string | null;
  redacted: number;
  content_hash: string;
  prev_hash: string;
  hash: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS consent_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS consent_entries (
  seq            INTEGER PRIMARY KEY CHECK (seq >= 1),
  subject        TEXT NOT NULL,
  purpose        TEXT,
  action         TEXT CHECK (action IN ('granted', 'withdrawn', 'erased')),
  recorded_at    TEXT,
  policy_version TEXT,
  source         TEXT,
  redacted       INTEGER NOT NULL DEFAULT 0 CHECK (redacted IN (0, 1)),
  content_hash   TEXT NOT NULL,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS consent_entries_subject ON consent_entries (subject);
CREATE TABLE IF NOT EXISTS consent_head (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  seq  INTEGER NOT NULL,
  hash TEXT NOT NULL,
  mac  TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS consent_entries_append_only_delete
BEFORE DELETE ON consent_entries
BEGIN SELECT RAISE(ABORT, 'consent ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS consent_entries_append_only_update
BEFORE UPDATE ON consent_entries
WHEN NOT (
  OLD.redacted = 0 AND NEW.redacted = 1
  AND NEW.seq = OLD.seq AND NEW.subject = OLD.subject
  AND NEW.content_hash = OLD.content_hash AND NEW.prev_hash = OLD.prev_hash AND NEW.hash = OLD.hash
  AND NEW.purpose IS NULL AND NEW.action IS NULL AND NEW.recorded_at IS NULL
  AND NEW.policy_version IS NULL AND NEW.source IS NULL
)
BEGIN SELECT RAISE(ABORT, 'consent ledger is append-only (only erasure redaction is allowed)'); END;
`;

function rowToEntry(r: Row): LedgerEntry {
  const content: EntryContent | null =
    r.redacted === 1 || r.purpose === null || r.action === null || r.recorded_at === null
      ? null
      : {
          v: 1,
          seq: r.seq,
          subject: r.subject,
          purpose: r.purpose,
          action: r.action as ConsentAction,
          recordedAt: r.recorded_at,
          ...(r.policy_version !== null ? { policyVersion: r.policy_version } : {}),
          ...(r.source !== null ? { source: r.source } : {}),
        };
  return {
    seq: r.seq,
    subject: r.subject,
    prevHash: r.prev_hash,
    contentHash: r.content_hash,
    hash: r.hash,
    content,
  };
}

function foldStatus(
  subject: string,
  entries: readonly { content: EntryContent | null }[],
): SubjectStatus {
  const status: SubjectStatus = { subject, erased: false, purposes: {} };
  for (const e of entries) {
    const c = e.content;
    if (!c || c.subject !== subject) continue;
    if (c.action === 'erased') {
      status.erased = true;
      status.erasedAt = c.recordedAt;
      status.purposes = {};
      continue;
    }
    status.erased = false;
    status.purposes[c.purpose] = {
      granted: c.action === 'granted',
      since: c.recordedAt,
      ...(c.policyVersion !== undefined ? { policyVersion: c.policyVersion } : {}),
    };
  }
  if (!status.erased) delete status.erasedAt;
  return status;
}

export interface LedgerOptions {
  /** HMAC secret (>= 32 chars). Keyed subject ids and the head signature derive from it. */
  secret: string;
  now?: () => Date;
  /** SQLite synchronous mode. Default FULL (durable on power loss); NORMAL is faster (tests). */
  synchronous?: 'FULL' | 'NORMAL';
}

/**
 * Append-only, tamper-evident consent ledger in SQLite.
 *
 * Each entry links to the previous one with a SHA-256 hash over canonical
 * JSON. The head (last seq + hash) is HMAC-signed with the ledger secret, so
 * an attacker who edits the file and recomputes the whole chain, or deletes
 * the newest entries, is still detected. Subjects are stored as HMACs only.
 */
export class ConsentLedger {
  private readonly db: Database.Database;
  private readonly subjectKey: string;
  private readonly headKey: string;
  private readonly now: () => Date;

  private constructor(db: Database.Database, options: LedgerOptions) {
    if (options.secret.length < MIN_LEDGER_SECRET_LENGTH) {
      throw new StonekeepError(
        'SAFETY',
        `The consent ledger secret must be at least ${MIN_LEDGER_SECRET_LENGTH} characters`,
      );
    }
    this.db = db;
    this.subjectKey = hmacHex(options.secret, 'stonekeep/consent/subject/v1');
    this.headKey = hmacHex(options.secret, 'stonekeep/consent/head/v1');
    this.now = options.now ?? (() => new Date());
    this.init(hmacHex(options.secret, 'stonekeep/consent/key-check/v1').slice(0, 16));
  }

  /** Open (and create if needed) a ledger file. Use `:memory:` for tests. */
  static open(path: string, options: LedgerOptions): ConsentLedger {
    const db = new Database(path);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma(`synchronous = ${options.synchronous === 'NORMAL' ? 'NORMAL' : 'FULL'}`);
      return new ConsentLedger(db, options);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /**
   * Wrap an already-open better-sqlite3 database (e.g. `new Database(':memory:')`).
   * The caller owns the handle's lifecycle; `close()` closes it.
   */
  static fromDatabase(db: Database.Database, options: LedgerOptions): ConsentLedger {
    return new ConsentLedger(db, options);
  }

  private init(keyCheck: string): void {
    this.db.exec(SCHEMA);
    const meta = this.db.prepare<[string], { value: string }>(
      'SELECT value FROM consent_meta WHERE key = ?',
    );
    const existing = meta.get('key_check')?.value;
    if (existing === undefined) {
      this.db.transaction(() => {
        this.db
          .prepare('INSERT INTO consent_meta (key, value) VALUES (?, ?), (?, ?)')
          .run('format', FORMAT_VERSION, 'key_check', keyCheck);
        this.db
          .prepare('INSERT OR IGNORE INTO consent_head (id, seq, hash, mac) VALUES (1, 0, ?, ?)')
          .run(GENESIS_HASH, this.headMac(0, GENESIS_HASH));
      })();
    } else if (existing !== keyCheck) {
      throw new StonekeepError('SAFETY', 'The consent ledger secret does not match this ledger');
    }
  }

  private headMac(seq: number, hash: string): string {
    return hmacHex(this.headKey, canonicalJson({ ledger: 'stonekeep-consent', seq, hash }));
  }

  /** Keyed pseudonym of a subject id (HMAC-SHA256, hex). */
  subjectRef(subjectId: string): string {
    if (subjectId.length === 0 || subjectId.length > 512)
      throw new StonekeepError('CONFIG', 'subject id must be 1-512 characters');
    return hmacHex(this.subjectKey, subjectId);
  }

  private head(): { seq: number; hash: string; mac: string } {
    const h = this.db
      .prepare<[], { seq: number; hash: string; mac: string }>(
        'SELECT seq, hash, mac FROM consent_head WHERE id = 1',
      )
      .get();
    if (!h) throw new StonekeepError('SAFETY', 'consent ledger head is missing');
    return h;
  }

  private append(content: Omit<EntryContent, 'seq' | 'v'>): LedgerEntry {
    return this.db
      .transaction((): LedgerEntry => {
        const head = this.head();
        if (head.mac !== this.headMac(head.seq, head.hash)) {
          throw new StonekeepError(
            'SAFETY',
            'consent ledger head signature is invalid; refusing to append (run verify)',
          );
        }
        const seq = head.seq + 1;
        const full: EntryContent = { v: 1, seq, ...content };
        const contentHash = contentHashOf(full);
        const hash = chainHashOf(seq, head.hash, bodyHashOf(seq, full.subject, contentHash));
        this.db
          .prepare(
            `INSERT INTO consent_entries (seq, subject, purpose, action, recorded_at, policy_version, source, content_hash, prev_hash, hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            seq,
            full.subject,
            full.purpose,
            full.action,
            full.recordedAt,
            full.policyVersion ?? null,
            full.source ?? null,
            contentHash,
            head.hash,
            hash,
          );
        this.db
          .prepare('UPDATE consent_head SET seq = ?, hash = ?, mac = ? WHERE id = 1')
          .run(seq, hash, this.headMac(seq, hash));
        return {
          seq,
          subject: full.subject,
          prevHash: head.hash,
          contentHash,
          hash,
          content: full,
        };
      })
      .immediate();
  }

  /** Record a consent decision. */
  record(input: RecordInput): LedgerEntry {
    if (!PURPOSE.test(input.purpose))
      throw new StonekeepError(
        'CONFIG',
        'purpose must be a short lowercase identifier, e.g. "analytics"',
      );
    // Runtime check for JS callers and untyped API input.
    const action: string = input.action;
    if (action !== 'granted' && action !== 'withdrawn')
      throw new StonekeepError('CONFIG', 'action must be "granted" or "withdrawn"');
    for (const [k, v] of [
      ['policyVersion', input.policyVersion],
      ['source', input.source],
    ] as const) {
      if (v !== undefined && !TOKEN.test(v))
        throw new StonekeepError('CONFIG', `${k} must match ${TOKEN.source}`);
    }
    return this.append({
      subject: this.subjectRef(input.subject),
      purpose: input.purpose,
      action: input.action,
      recordedAt: this.now().toISOString(),
      ...(input.policyVersion !== undefined ? { policyVersion: input.policyVersion } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
    });
  }

  /**
   * Erasure hook (Stage 2 deletes): append an `erased` event and redact the
   * content of the subject's earlier entries. Only the subject HMAC, the
   * hashes (so the chain still verifies) and the erasure event remain.
   * Idempotent: a second call with nothing new to redact records nothing.
   */
  recordErasure(
    subjectId: string,
    options: { source?: string } = {},
  ): { entry: LedgerEntry; redacted: number; alreadyErased: boolean } {
    const subject = this.subjectRef(subjectId);
    return this.db
      .transaction(() => {
        const live = this.db
          .prepare<[string], Row>(
            'SELECT * FROM consent_entries WHERE subject = ? AND redacted = 0 ORDER BY seq',
          )
          .all(subject);
        const last = live.at(-1);
        if (last?.action === 'erased' && live.every((r) => r.action === 'erased')) {
          return { entry: rowToEntry(last), redacted: 0, alreadyErased: true };
        }
        const entry = this.append({
          subject,
          purpose: '*',
          action: 'erased',
          recordedAt: this.now().toISOString(),
          source: options.source ?? 'stonekeep-delete',
        });
        const redacted = this.db
          .prepare(
            `UPDATE consent_entries
                SET redacted = 1, purpose = NULL, action = NULL, recorded_at = NULL, policy_version = NULL, source = NULL
              WHERE subject = ? AND redacted = 0 AND seq < ?`,
          )
          .run(subject, entry.seq).changes;
        return { entry, redacted, alreadyErased: false };
      })
      .immediate();
  }

  /** Number of non-redacted entries for a subject (what an erasure would redact). */
  liveEntryCount(subjectId: string): number {
    const row = this.db
      .prepare<[string], { n: number }>(
        `SELECT count(*) AS n FROM consent_entries WHERE subject = ? AND redacted = 0 AND action <> 'erased'`,
      )
      .get(this.subjectRef(subjectId));
    return row?.n ?? 0;
  }

  entries(): LedgerEntry[] {
    return this.db
      .prepare<[], Row>('SELECT * FROM consent_entries ORDER BY seq')
      .all()
      .map(rowToEntry);
  }

  /** Current consent state of a subject. */
  status(subjectId: string): SubjectStatus {
    const subject = this.subjectRef(subjectId);
    const rows = this.db
      .prepare<[string], Row>('SELECT * FROM consent_entries WHERE subject = ? ORDER BY seq')
      .all(subject);
    return foldStatus(subject, rows.map(rowToEntry));
  }

  /** Full verification: chain integrity from genesis plus the signed head. */
  verify(): LedgerVerification {
    const entries = this.entries();
    const check = verifyChain(entries, undefined, { checkRedactions: true });
    const errors = [...check.errors];
    // Redacted rows must stay empty (content written back into one would not be
    // covered by any hash), and live rows must have complete content.
    const inconsistent = this.db
      .prepare<[], { seq: number }>(
        `SELECT seq FROM consent_entries
          WHERE (redacted = 1 AND (purpose IS NOT NULL OR action IS NOT NULL OR recorded_at IS NOT NULL
                                   OR policy_version IS NOT NULL OR source IS NOT NULL))
             OR (redacted = 0 AND (purpose IS NULL OR action IS NULL OR recorded_at IS NULL))
          ORDER BY seq`,
      )
      .all();
    for (const r of inconsistent)
      errors.push(`seq ${r.seq}: redaction state does not match its columns`);
    let head: { seq: number; hash: string; mac: string } | undefined;
    try {
      head = this.head();
    } catch {
      errors.push('head: missing');
    }
    if (head) {
      if (head.mac !== this.headMac(head.seq, head.hash)) errors.push('head: signature is invalid');
      const last = entries.at(-1);
      if ((last?.seq ?? 0) !== head.seq || (last?.hash ?? GENESIS_HASH) !== head.hash) {
        errors.push(
          `head: ledger ends at seq ${last?.seq ?? 0} but the signed head is seq ${head.seq} (entries removed or added)`,
        );
      }
    }
    return {
      valid: errors.length === 0,
      entries: entries.length,
      headSeq: head?.seq ?? -1,
      errors,
    };
  }

  /**
   * Export a verifiable chain segment for one subject: from the subject's
   * first entry to the current head. Other subjects' entries appear as
   * hashes only. Refuses to export from a ledger that fails verification.
   */
  exportEvidence(subjectId: string): EvidenceSegment {
    const verification = this.verify();
    if (!verification.valid) {
      throw new StonekeepError(
        'SAFETY',
        `Consent ledger failed verification; not exporting evidence:\n  - ${verification.errors.join('\n  - ')}`,
      );
    }
    const subject = this.subjectRef(subjectId);
    const head = this.head();
    const first =
      this.db
        .prepare<[string], { seq: number }>(
          'SELECT min(seq) AS seq FROM consent_entries WHERE subject = ?',
        )
        .get(subject)?.seq ?? null;
    const rows =
      first === null
        ? []
        : this.db
            .prepare<[number], Row>('SELECT * FROM consent_entries WHERE seq >= ? ORDER BY seq')
            .all(first);
    const entries = rows.map(rowToEntry);
    const anchor = entries[0]
      ? { seq: entries[0].seq - 1, hash: entries[0].prevHash }
      : { seq: head.seq, hash: head.hash };
    return {
      format: 'stonekeep-consent-evidence',
      formatVersion: 1,
      generatedAt: this.now().toISOString(),
      subject,
      anchor,
      entries: entries.map((e): EvidenceEntry => {
        const base = {
          seq: e.seq,
          prevHash: e.prevHash,
          bodyHash: bodyHashOf(e.seq, e.subject, e.contentHash),
          hash: e.hash,
        };
        return e.content && e.subject === subject
          ? { ...base, content: e.content }
          : { ...base, redacted: true };
      }),
      head,
      status: foldStatus(subject, entries),
    };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Verify an evidence segment without access to the ledger: chain links,
 * contents of the disclosed entries, and that the segment ends at its head.
 * (The head MAC can only be checked by the ledger owner.)
 */
export function verifyEvidence(segment: EvidenceSegment): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  // Segments are usually parsed from untrusted JSON: check the header at runtime.
  const header: { format: unknown; formatVersion: unknown } = segment;
  if (header.format !== 'stonekeep-consent-evidence' || header.formatVersion !== 1)
    errors.push('unknown evidence format');
  const entries = segment.entries.map((e) => ({
    seq: e.seq,
    prevHash: e.prevHash,
    hash: e.hash,
    // Disclosed entries are verified from their content; hidden ones via bodyHash.
    bodyHash: e.bodyHash,
    content: e.content ?? null,
  }));
  errors.push(...verifyChain(entries, segment.anchor).errors);
  for (const e of segment.entries) {
    if (e.content && e.content.subject !== segment.subject)
      errors.push(`seq ${e.seq}: disclosed entry belongs to another subject`);
    if (!e.content && e.redacted !== true)
      errors.push(`seq ${e.seq}: entry has neither content nor the hidden marker`);
  }
  const last = segment.entries.at(-1);
  const end = last ? { seq: last.seq, hash: last.hash } : segment.anchor;
  if (end.seq !== segment.head.seq || end.hash !== segment.head.hash)
    errors.push('segment does not end at the ledger head');
  const recomputed = foldStatus(segment.subject, entries);
  if (canonicalJson(recomputed) !== canonicalJson(segment.status))
    errors.push('status summary does not match the entries');
  return { valid: errors.length === 0, errors };
}
