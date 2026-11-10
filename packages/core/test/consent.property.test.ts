import Database from 'better-sqlite3';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ConsentLedger,
  bodyHashOf,
  chainHashOf,
  contentHashOf,
  verifyEvidence,
  type EntryContent,
  type EvidenceSegment,
} from '../src/consent/index.js';

const SECRET = 'property-test-ledger-secret-0123456789abcdef';
/** Scale all property runs, e.g. STONEKEEP_FC_SCALE=10 for a deep run. */
const SCALE = Number(process.env.STONEKEEP_FC_SCALE ?? '1');
const runs = (n: number): number => Math.max(1, Math.round(n * SCALE));
/** Test timeout grows with the scale. */
const TIMEOUT = 60_000 * Math.max(1, SCALE);
const opArb = fc.record({
  subject: fc.constantFrom('u1', 'u2', 'u3', 'u4'),
  kind: fc.constantFrom('granted', 'withdrawn', 'granted', 'erased'),
  purpose: fc.constantFrom('analytics', 'marketing', 'personalization'),
  policyVersion: fc.option(fc.constantFrom('v1', 'v2'), { nil: undefined }),
});
const opsArb = fc.array(opArb, { minLength: 2, maxLength: 25 });
type Op = typeof opArb extends fc.Arbitrary<infer T> ? T : never;

/**
 * Build a ledger from operations in an in-memory SQLite database (same engine,
 * schema and triggers as a file; no disk I/O so hundreds of runs stay fast).
 */
function build(ops: readonly Op[]): Database.Database {
  const db = new Database(':memory:');
  let t = Date.parse('2026-01-01T00:00:00Z');
  const ledger = ConsentLedger.fromDatabase(db, {
    secret: SECRET,
    now: () => new Date((t += 1000)),
  });
  for (const op of ops) {
    if (op.kind === 'erased') ledger.recordErasure(op.subject);
    else
      ledger.record({
        subject: op.subject,
        purpose: op.purpose,
        action: op.kind,
        ...(op.policyVersion ? { policyVersion: op.policyVersion } : {}),
      });
  }
  return db;
}

const ledgerOf = (db: Database.Database): ConsentLedger =>
  ConsentLedger.fromDatabase(db, { secret: SECRET });
const verify = (db: Database.Database): boolean => ledgerOf(db).verify().valid;

interface RawRow {
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

/** An attacker with write access to the SQLite database, but not the ledger secret. */
function tamper(
  db: Database.Database,
  apply: (db: Database.Database, rows: RawRow[]) => boolean,
): boolean {
  db.exec(
    'DROP TRIGGER IF EXISTS consent_entries_append_only_update; DROP TRIGGER IF EXISTS consent_entries_append_only_delete;',
  );
  const rows = db.prepare<[], RawRow>('SELECT * FROM consent_entries ORDER BY seq').all();
  return db.transaction(() => apply(db, rows))();
}

/** Recompute every hash from row `from` onwards and move the head (the sophisticated attack). */
function rehashFrom(db: Database.Database, from: number): void {
  const rows = db.prepare<[], RawRow>('SELECT * FROM consent_entries ORDER BY seq').all();
  let prev = rows.find((r) => r.seq === from - 1)?.hash ?? '0'.repeat(64);
  for (const r of rows.filter((x) => x.seq >= from)) {
    let contentHash = r.content_hash;
    if (r.redacted === 0 && r.purpose !== null && r.action !== null && r.recorded_at !== null) {
      const content: EntryContent = {
        v: 1,
        seq: r.seq,
        subject: r.subject,
        purpose: r.purpose,
        action: r.action as EntryContent['action'],
        recordedAt: r.recorded_at,
        ...(r.policy_version !== null ? { policyVersion: r.policy_version } : {}),
        ...(r.source !== null ? { source: r.source } : {}),
      };
      contentHash = contentHashOf(content);
    }
    const hash = chainHashOf(r.seq, prev, bodyHashOf(r.seq, r.subject, contentHash));
    db.prepare(
      'UPDATE consent_entries SET content_hash = ?, prev_hash = ?, hash = ? WHERE seq = ?',
    ).run(contentHash, prev, hash, r.seq);
    prev = hash;
  }
  const last = db
    .prepare<[], { seq: number; hash: string }>(
      'SELECT seq, hash FROM consent_entries ORDER BY seq DESC LIMIT 1',
    )
    .get();
  // The attacker can move the head but cannot produce a valid MAC without the secret.
  db.prepare('UPDATE consent_head SET seq = ?, hash = ? WHERE id = 1').run(
    last?.seq ?? 0,
    last?.hash ?? '0'.repeat(64),
  );
}

const COLUMNS = [
  'subject',
  'purpose',
  'action',
  'recorded_at',
  'policy_version',
  'content_hash',
  'prev_hash',
  'hash',
] as const;

type Mutation =
  | { kind: 'field'; row: number; column: (typeof COLUMNS)[number]; rehash: boolean }
  | { kind: 'swap-content'; a: number; b: number; rehash: boolean }
  | { kind: 'permute-seq'; a: number; b: number }
  | { kind: 'delete'; row: number; rehash: boolean }
  | { kind: 'truncate'; count: number }
  | { kind: 'append-forged'; rehash: boolean }
  | { kind: 'redact'; row: number }
  | { kind: 'head'; field: 'seq' | 'hash' | 'mac' };

const mutationArb: fc.Arbitrary<Mutation> = fc.oneof(
  fc.record({
    kind: fc.constant('field' as const),
    row: fc.nat(),
    column: fc.constantFrom(...COLUMNS),
    rehash: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('swap-content' as const),
    a: fc.nat(),
    b: fc.nat(),
    rehash: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('permute-seq' as const), a: fc.nat(), b: fc.nat() }),
  fc.record({ kind: fc.constant('delete' as const), row: fc.nat(), rehash: fc.boolean() }),
  fc.record({ kind: fc.constant('truncate' as const), count: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ kind: fc.constant('append-forged' as const), rehash: fc.boolean() }),
  fc.record({ kind: fc.constant('redact' as const), row: fc.nat() }),
  fc.record({
    kind: fc.constant('head' as const),
    field: fc.constantFrom('seq' as const, 'hash' as const, 'mac' as const),
  }),
);

function mutate(db: Database.Database, rows: RawRow[], m: Mutation): boolean {
  const pick = (i: number): RawRow | undefined => rows[i % rows.length];
  switch (m.kind) {
    case 'field': {
      const r = pick(m.row);
      if (!r) return false;
      const old = r[m.column];
      const next =
        m.column === 'action'
          ? old === 'granted'
            ? 'withdrawn'
            : 'granted'
          : m.column === 'recorded_at'
            ? '2030-01-01T00:00:00.000Z'
            : m.column.endsWith('hash') || m.column === 'subject'
              ? 'f'.repeat(64)
              : 'tampered';
      if (next === old) return false;
      db.prepare(`UPDATE consent_entries SET ${m.column} = ? WHERE seq = ?`).run(next, r.seq);
      if (m.rehash && !m.column.endsWith('hash')) rehashFrom(db, r.seq);
      return true;
    }
    case 'swap-content': {
      const a = pick(m.a);
      const b = pick(m.b);
      if (!a || !b || a.seq === b.seq) return false;
      const cols = [
        'subject',
        'purpose',
        'action',
        'recorded_at',
        'policy_version',
        'source',
        'redacted',
      ] as const;
      if (cols.every((c) => a[c] === b[c])) return false;
      const set = db.prepare(
        `UPDATE consent_entries SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE seq = ?`,
      );
      set.run(...cols.map((c) => b[c]), a.seq);
      set.run(...cols.map((c) => a[c]), b.seq);
      if (m.rehash) rehashFrom(db, Math.min(a.seq, b.seq));
      return true;
    }
    case 'permute-seq': {
      const a = pick(m.a);
      const b = pick(m.b);
      if (!a || !b || a.seq === b.seq) return false;
      const parked = 1_000_000_000;
      db.prepare('UPDATE consent_entries SET seq = ? WHERE seq = ?').run(parked, a.seq);
      db.prepare('UPDATE consent_entries SET seq = ? WHERE seq = ?').run(a.seq, b.seq);
      db.prepare('UPDATE consent_entries SET seq = ? WHERE seq = ?').run(b.seq, parked);
      return true;
    }
    case 'delete': {
      const r = pick(m.row);
      if (!r) return false;
      db.prepare('DELETE FROM consent_entries WHERE seq = ?').run(r.seq);
      if (m.rehash) {
        // Close the gap and rebuild the chain, as a careful attacker would.
        db.prepare('UPDATE consent_entries SET seq = seq - 1 WHERE seq > ?').run(r.seq);
        rehashFrom(db, r.seq);
      }
      return true;
    }
    case 'truncate': {
      const count = Math.min(m.count, rows.length);
      if (count === 0) return false;
      const keep = rows.length - count;
      db.prepare('DELETE FROM consent_entries WHERE seq > ?').run(keep);
      // Point the head at the new end (MAC cannot be recomputed).
      const last = db
        .prepare<[], { seq: number; hash: string }>(
          'SELECT seq, hash FROM consent_entries ORDER BY seq DESC LIMIT 1',
        )
        .get();
      db.prepare('UPDATE consent_head SET seq = ?, hash = ? WHERE id = 1').run(
        last?.seq ?? 0,
        last?.hash ?? '0'.repeat(64),
      );
      return true;
    }
    case 'append-forged': {
      const last = rows.at(-1);
      const seq = (last?.seq ?? 0) + 1;
      const content: EntryContent = {
        v: 1,
        seq,
        subject: last?.subject ?? 'f'.repeat(64),
        purpose: 'marketing',
        action: 'granted',
        recordedAt: '2030-01-01T00:00:00.000Z',
      };
      const contentHash = contentHashOf(content);
      const hash = chainHashOf(
        seq,
        last?.hash ?? '0'.repeat(64),
        bodyHashOf(seq, content.subject, contentHash),
      );
      db.prepare(
        'INSERT INTO consent_entries (seq, subject, purpose, action, recorded_at, content_hash, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        seq,
        content.subject,
        content.purpose,
        content.action,
        content.recordedAt,
        contentHash,
        last?.hash ?? '0'.repeat(64),
        hash,
      );
      if (m.rehash)
        db.prepare('UPDATE consent_head SET seq = ?, hash = ? WHERE id = 1').run(seq, hash);
      return true;
    }
    case 'redact': {
      const r = pick(m.row);
      if (!r || r.redacted === 1) return false;
      // Redaction is legal only after an erasure of that subject; skip rows where it would be legitimate.
      const erasedLater = rows.some(
        (x) => x.subject === r.subject && x.action === 'erased' && x.seq > r.seq,
      );
      if (erasedLater) return false;
      db.prepare(
        'UPDATE consent_entries SET redacted = 1, purpose = NULL, action = NULL, recorded_at = NULL, policy_version = NULL, source = NULL WHERE seq = ?',
      ).run(r.seq);
      return true;
    }
    case 'head': {
      const value = m.field === 'seq' ? 999 : 'e'.repeat(64);
      db.prepare(`UPDATE consent_head SET ${m.field} = ? WHERE id = 1`).run(value);
      return true;
    }
  }
}

describe('consent ledger tamper evidence (property-based)', () => {
  it(
    'an untouched ledger always verifies, and so does every exported evidence segment',
    () => {
      fc.assert(
        fc.property(opsArb, (ops) => {
          const db = build(ops);
          const ledger = ledgerOf(db);
          expect(ledger.verify().valid).toBe(true);
          for (const s of new Set(ops.map((o) => o.subject))) {
            expect(verifyEvidence(ledger.exportEvidence(s)).valid).toBe(true);
          }
          db.close();
        }),
        { numRuns: runs(60) },
      );
    },
    TIMEOUT,
  );

  it(
    'ANY mutation, deletion, insertion, truncation or reordering of the SQLite ledger is detected',
    () => {
      fc.assert(
        fc.property(opsArb, mutationArb, (ops, mutation) => {
          const db = build(ops);
          const changed = tamper(db, (db, rows) => mutate(db, rows, mutation));
          fc.pre(changed);
          expect(verify(db), `undetected ${mutation.kind}`).toBe(false);
        }),
        { numRuns: runs(300) },
      );
    },
    TIMEOUT,
  );

  it(
    'any reordering (non-identity permutation of rows) is detected',
    () => {
      fc.assert(
        fc.property(
          opsArb.filter((o) => o.length >= 3),
          fc.nat(),
          (ops, seed) => {
            const db = build(ops);
            const changed = tamper(db, (db, rows) => {
              const seqs = rows.map((r) => r.seq);
              // Deterministic shuffle from the seed; reject identity permutations.
              const shuffled = [...seqs].sort(
                (a, b) => ((a * 2654435761 + seed) % 97) - ((b * 2654435761 + seed) % 97),
              );
              if (shuffled.every((s, i) => s === seqs[i])) return false;
              const offset = 1_000_000_000;
              db.prepare('UPDATE consent_entries SET seq = seq + ?').run(offset);
              shuffled.forEach((target, i) =>
                db
                  .prepare('UPDATE consent_entries SET seq = ? WHERE seq = ?')
                  .run(target, (seqs[i] ?? 0) + offset),
              );
              return true;
            });
            fc.pre(changed);
            expect(verify(db)).toBe(false);
          },
        ),
        { numRuns: runs(100) },
      );
    },
    TIMEOUT,
  );

  it(
    'any change to an exported evidence segment is detected',
    () => {
      fc.assert(
        fc.property(
          opsArb,
          fc.nat(),
          fc.constantFrom('prevHash', 'hash', 'bodyHash', 'action', 'recordedAt', 'drop', 'swap'),
          (ops, idx, what) => {
            const db = build(ops);
            const ev: EvidenceSegment = ledgerOf(db).exportEvidence(ops[0]?.subject ?? 'u1');
            db.close();
            fc.pre(ev.entries.length > 0);
            const copy = JSON.parse(JSON.stringify(ev)) as EvidenceSegment;
            const i = idx % copy.entries.length;
            const e = copy.entries[i];
            if (!e) return;
            if (what === 'drop') copy.entries.splice(i, 1);
            else if (what === 'swap') {
              fc.pre(copy.entries.length > 1);
              const j = (i + 1) % copy.entries.length;
              const other = copy.entries[j];
              if (!other) return;
              copy.entries[i] = other;
              copy.entries[j] = e;
            } else if (what === 'action' || what === 'recordedAt') {
              fc.pre(e.content !== undefined && e.content.action !== 'erased');
              {
                if (what === 'action')
                  e.content.action = e.content.action === 'granted' ? 'withdrawn' : 'granted';
                else e.content.recordedAt = '2031-01-01T00:00:00.000Z';
              }
            } else {
              e[what] = e[what].replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
            }
            expect(verifyEvidence(copy).valid).toBe(false);
          },
        ),
        { numRuns: runs(200) },
      );
    },
    TIMEOUT,
  );
});
