/**
 * Pre-send privacy guardrail. Every payload bound for an LLM provider passes
 * through `assertSafeToSend` immediately before the network call. The payload
 * must consist of schema metadata only (entity/column names, types,
 * classifications); anything that looks like a real personal-data value or a
 * credential blocks the request.
 *
 * Findings report a kind and a JSON path, never the matched value.
 */

export type FindingKind =
  | 'email'
  | 'phone'
  | 'ipv4'
  | 'ipv6'
  | 'credit_card'
  | 'iban'
  | 'national_id'
  | 'date'
  | 'number_sequence'
  | 'secret'
  | 'url_credentials'
  | 'identifier';

export interface GuardFinding {
  kind: FindingKind;
  /** JSON path of the offending string, e.g. `$.entities[3].columns[0].name`. */
  path: string;
}

export class PrivacyGuardError extends Error {
  readonly findings: GuardFinding[];

  constructor(findings: GuardFinding[]) {
    const kinds = [...new Set(findings.map((f) => f.kind))].join(', ');
    const where = findings
      .slice(0, 5)
      .map((f) => `${f.kind} at ${f.path}`)
      .join('; ');
    super(
      `Privacy guard blocked the request: payload contains possible personal data or secrets (${kinds}). ${where}`,
    );
    this.name = 'PrivacyGuardError';
    this.findings = findings;
  }
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const DETECTORS: { kind: FindingKind; test: (s: string) => boolean }[] = [
  { kind: 'email', test: (s) => /[A-Z0-9._%+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,}/i.test(s) },
  { kind: 'url_credentials', test: (s) => /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(s) },
  {
    kind: 'secret',
    test: (s) =>
      /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/.test(s) ||
      /\bks_[a-z2-7]{12}_/.test(s) ||
      /\bsk-ant-[A-Za-z0-9-]{10,}/.test(s) ||
      /\bAKIA[0-9A-Z]{16}\b/.test(s) ||
      /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/.test(s) ||
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s) ||
      /\bgh[pousr]_[A-Za-z0-9]{20,}/.test(s),
  },
  { kind: 'national_id', test: (s) => /\b\d{3}-\d{2}-\d{4}\b/.test(s) },
  {
    kind: 'iban',
    test: (s) => /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/.test(s),
  },
  {
    kind: 'credit_card',
    test: (s) => {
      for (const m of s.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true;
      }
      return false;
    },
  },
  {
    kind: 'phone',
    test: (s) =>
      /(?:\+|\b00)\d{1,3}[\s().-]*\d(?:[\s().-]*\d){6,}/.test(s) ||
      /\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/.test(s),
  },
  {
    kind: 'ipv4',
    test: (s) => /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/.test(s),
  },
  {
    kind: 'ipv6',
    test: (s) =>
      /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/i.test(s) ||
      /\b[0-9a-f]{1,4}::[0-9a-f]{1,4}\b/i.test(s),
  },
  {
    kind: 'date',
    test: (s) =>
      /\b(?:1[89]|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b/.test(s) ||
      /\b(?:0?[1-9]|[12]\d|3[01])[/.](?:0?[1-9]|1[0-2])[/.](?:1[89]|20)\d{2}\b/.test(s),
  },
  { kind: 'number_sequence', test: (s) => /\d{9,}/.test(s) },
];

/** Scan every string (keys and values) in a JSON-like value. */
export function inspectPayload(value: unknown, path = '$'): GuardFinding[] {
  const out: GuardFinding[] = [];
  const visit = (v: unknown, p: string): void => {
    if (typeof v === 'string') {
      for (const d of DETECTORS) if (d.test(v)) out.push({ kind: d.kind, path: p });
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        visit(item, `${p}[${i}]`);
      });
    } else if (typeof v === 'object' && v !== null) {
      for (const [k, item] of Object.entries(v)) {
        for (const d of DETECTORS) if (d.test(k)) out.push({ kind: d.kind, path: `${p}{key}` });
        visit(item, `${p}.${k}`);
      }
    }
  };
  visit(value, path);
  return out;
}

/** Throws PrivacyGuardError if anything in `value` looks like personal data or a secret. */
export function assertSafeToSend(value: unknown): void {
  const findings = inspectPayload(value);
  if (findings.length > 0) throw new PrivacyGuardError(findings);
}

/** Schema identifiers: letters, digits, `_ $ . - [ ]`, at most 128 characters. */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$.[\]-]{0,127}$/;
/** Type names such as `varchar(255)`, `timestamp with time zone`, `String`, `string | null`. */
export const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_ (),.|[\]]{0,63}$/;
