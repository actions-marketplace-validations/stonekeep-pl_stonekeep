/** Maps character offsets to 1-based line numbers. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

/** Replace every character except newlines with a space (offsets and lines stay intact). */
function blank(segment: string): string {
  return segment.replace(/[^\n]/g, ' ');
}

/**
 * Mask SQL comments and string literals. Literal *contents* are blanked so
 * that seed data in migrations (e.g. `INSERT ... VALUES ('jane@example.com')`)
 * is never parsed, stored or logged. Quoted identifiers are preserved.
 */
export function maskSql(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charAt(i);
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (c === '#' && (i === 0 || text[i - 1] === '\n')) {
      // MySQL line comment at start of line.
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\' && !(text[j + 1] === "'" && endsLiteral(text, j + 2))) j += 2;
        else if (text[j] === '\\') j++;
        else if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j++;
      }
      const stop = Math.min(j, n);
      out += "'" + blank(text.slice(i + 1, stop)) + (stop < n ? "'" : '');
      i = stop + 1;
    } else if (c === '"' || c === '`') {
      // Quoted identifier: copy as is, so a quote or `--` inside a name starts nothing.
      let j = i + 1;
      while (j < n) {
        if (text[j] === c && text[j + 1] === c) j += 2;
        else if (text[j] === c || text[j] === '\n') break;
        else j++;
      }
      const stop = Math.min(j + 1, n);
      out += text.slice(i, stop);
      i = stop;
    } else if (c === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? n : end + tag[0].length;
        out += blank(text.slice(i, stop));
        i = stop;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * True when the text at `at` can only follow a finished string literal: the end of the input,
 * or optional spaces and then `,`, `)`, `;` or a line break. Tells `'C:\\'` (standard SQL, the
 * backslash is an ordinary character) from `'it\\'s'` (MySQL escape, the literal goes on).
 */
function endsLiteral(text: string, at: number): boolean {
  for (let i = at; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') continue;
    return ch === ',' || ch === ')' || ch === ';' || ch === '\n' || ch === '\r';
  }
  return true;
}

/**
 * Mask `//` and `/* *\/` comments in TypeScript/Prisma source while leaving
 * string literals intact (decorator options such as `name: 'email'` are needed).
 */
export function maskCodeComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charAt(i);
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      const stop = skipString(text, i);
      out += text.slice(i, stop);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Given the index of an opening quote, return the index just past the closing quote. */
function skipString(text: string, start: number): number {
  const quote = text[start];
  let j = start + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') j += 2;
    else if (ch === quote) return j + 1;
    else if (ch === '\n' && quote !== '`') return j;
    else j++;
  }
  return text.length;
}

const PAIRS: Record<string, string> = { '(': ')', '{': '}', '[': ']' };

/**
 * Given the index of an opening bracket, return the index of its matching
 * closing bracket, or -1. Quoted strings/identifiers are skipped.
 */
export function findMatching(text: string, openIndex: number): number {
  const open = text[openIndex];
  if (open === undefined) return -1;
  const close = PAIRS[open];
  if (close === undefined) return -1;
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

export interface Segment {
  text: string;
  /** Offset of `text[0]` within the original string. */
  offset: number;
}

/** Split on `separator` at bracket depth 0, outside quotes. Segments are left-trimmed. */
export function splitTopLevel(text: string, separator: string, baseOffset = 0): Segment[] {
  const segments: Segment[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const push = (end: number): void => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length > 0) segments.push({ text: trimmed, offset: baseOffset + start + lead });
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      push(i);
      start = i + 1;
    }
    i++;
  }
  push(text.length);
  return segments;
}

/** Natural sort so `2_x.sql` < `10_x.sql`. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

/** Locale-independent ordering so the datamap is byte-identical on every machine. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
