import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConsentLedger,
  canonicalJson,
  verifyEvidence,
  type EvidenceSegment,
} from '../src/consent/index.js';

const SECRET = 'consent-ledger-test-secret-0123456789abcdef';
let dir: string;
let path: string;
let clock: number;
const now = () => new Date(clock);

function open(secret = SECRET): ConsentLedger {
  return ConsentLedger.open(path, { secret, now });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stonekeep-consent-'));
  path = join(dir, 'ledger.db');
  clock = Date.parse('2026-03-01T10:00:00Z');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(ledger: ConsentLedger): void {
  const tick = () => (clock += 60_000);
  ledger.record({
    subject: 'alice@example.com',
    purpose: 'analytics',
    action: 'granted',
    policyVersion: '2026-01',
    source: 'banner',
  });
  tick();
  ledger.record({
    subject: 'bob@example.com',
    purpose: 'marketing',
    action: 'granted',
    source: 'banner',
  });
  tick();
  ledger.record({
    subject: 'alice@example.com',
    purpose: 'marketing',
    action: 'granted',
    source: 'settings',
  });
  tick();
  ledger.record({
    subject: 'alice@example.com',
    purpose: 'marketing',
    action: 'withdrawn',
    source: 'settings',
  });
  tick();
  ledger.record({ subject: 'carol@example.com', purpose: 'analytics', action: 'withdrawn' });
}

describe('canonicalJson', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });
});

describe('ConsentLedger', () => {
  it('records consent and folds it into a current status', () => {
    const ledger = open();
    seed(ledger);
    expect(ledger.status('alice@example.com')).toMatchObject({
      erased: false,
      purposes: {
        analytics: { granted: true, since: '2026-03-01T10:00:00.000Z', policyVersion: '2026-01' },
        marketing: { granted: false, since: '2026-03-01T10:03:00.000Z' },
      },
    });
    expect(ledger.verify()).toMatchObject({ valid: true, entries: 5, headSeq: 5 });
    ledger.close();
  });

  it('never stores raw subject ids (only HMACs)', () => {
    const ledger = open();
    seed(ledger);
    const ref = ledger.subjectRef('alice@example.com');
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    ledger.close();
    const bytes = [path, `${path}-wal`].map((p) => {
      try {
        return readFileSync(p).toString('latin1');
      } catch {
        return '';
      }
    });
    for (const raw of ['alice@example.com', 'bob@example.com', 'carol@example.com']) {
      expect(bytes.some((b) => b.includes(raw))).toBe(false);
    }
  });

  it('is append-only at the database level', () => {
    const ledger = open();
    seed(ledger);
    ledger.close();
    const raw = new Database(path);
    expect(() =>
      raw.prepare(`UPDATE consent_entries SET action = 'granted' WHERE seq = 4`).run(),
    ).toThrow(/append-only/);
    expect(() => raw.prepare('DELETE FROM consent_entries WHERE seq = 5').run()).toThrow(
      /append-only/,
    );
    raw.close();
  });

  it('refuses a wrong or weak secret', () => {
    open().close();
    expect(() => open('another-secret-that-is-long-enough-000000')).toThrow(
      /does not match this ledger/,
    );
    expect(() => ConsentLedger.open(':memory:', { secret: 'short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('only accepts identifier-like purposes, sources and policy versions (no free text)', () => {
    const ledger = open();
    expect(() =>
      ledger.record({ subject: 'a', purpose: 'Analytics for jane@example.com', action: 'granted' }),
    ).toThrow(/purpose/);
    expect(() =>
      ledger.record({
        subject: 'a',
        purpose: 'analytics',
        action: 'granted',
        source: 'call with Jane',
      }),
    ).toThrow(/source/);
    ledger.close();
  });
});

describe('erasure hook', () => {
  it('keeps only the hashed id and the erasure event, and the chain still verifies', () => {
    const ledger = open();
    seed(ledger);
    clock += 3_600_000;
    const r = ledger.recordErasure('alice@example.com');
    expect(r).toMatchObject({
      redacted: 3,
      alreadyErased: false,
      entry: { seq: 6, content: { action: 'erased', purpose: '*' } },
    });

    const alice = ledger.subjectRef('alice@example.com');
    const mine = ledger.entries().filter((e) => e.subject === alice);
    expect(mine.map((e) => e.content?.action ?? 'redacted')).toEqual([
      'redacted',
      'redacted',
      'redacted',
      'erased',
    ]);
    expect(ledger.status('alice@example.com')).toEqual({
      subject: alice,
      erased: true,
      erasedAt: '2026-03-01T11:04:00.000Z',
      purposes: {},
    });
    // Other subjects are untouched, the whole ledger still verifies.
    expect(ledger.status('bob@example.com').purposes.marketing?.granted).toBe(true);
    expect(ledger.verify().valid).toBe(true);

    // Idempotent.
    expect(ledger.recordErasure('alice@example.com')).toMatchObject({
      alreadyErased: true,
      redacted: 0,
    });
    expect(ledger.verify().entries).toBe(6);

    // Evidence after erasure shows only the erasure event.
    const ev = ledger.exportEvidence('alice@example.com');
    expect(ev.entries.filter((e) => e.content).map((e) => e.content?.action)).toEqual(['erased']);
    expect(verifyEvidence(ev).valid).toBe(true);
    ledger.close();
  });
});

describe('evidence export', () => {
  it('produces a verifiable segment that hides other subjects', () => {
    const ledger = open();
    seed(ledger);
    const ev = ledger.exportEvidence('alice@example.com');
    expect(ev.subject).toBe(ledger.subjectRef('alice@example.com'));
    expect(ev.anchor.seq).toBe(0);
    expect(ev.entries.map((e) => (e.content ? e.content.action : 'hidden'))).toEqual([
      'granted',
      'hidden',
      'granted',
      'withdrawn',
      'hidden',
    ]);
    expect(ev.head.seq).toBe(5);
    expect(ev.status.purposes.marketing?.granted).toBe(false);
    expect(JSON.stringify(ev)).not.toContain(ledger.subjectRef('bob@example.com'));
    expect(JSON.stringify(ev)).not.toContain('alice@example.com');
    expect(verifyEvidence(ev)).toEqual({ valid: true, errors: [] });
    ledger.close();
  });

  it('detects a segment that omits a later withdrawal', () => {
    const ledger = open();
    seed(ledger);
    const ev = ledger.exportEvidence('alice@example.com');
    const truncated: EvidenceSegment = {
      ...ev,
      entries: ev.entries.slice(0, 3),
      status: {
        ...ev.status,
        purposes: {
          ...ev.status.purposes,
          marketing: { granted: true, since: '2026-03-01T10:02:00.000Z' },
        },
      },
    };
    expect(verifyEvidence(truncated).valid).toBe(false);
    ledger.close();
  });

  it('refuses to export from a tampered ledger', () => {
    const ledger = open();
    seed(ledger);
    ledger.close();
    const raw = new Database(path);
    raw.exec('DROP TRIGGER consent_entries_append_only_update');
    raw.prepare(`UPDATE consent_entries SET action = 'granted' WHERE seq = 4`).run();
    raw.close();
    const reopened = open();
    expect(() => reopened.exportEvidence('alice@example.com')).toThrow(/failed verification/);
    reopened.close();
  });
});
