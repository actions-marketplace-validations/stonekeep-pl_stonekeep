export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

/** Line diff (LCS). Good enough for config files of a few hundred lines. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length === 0 ? [] : before.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const b = after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i];
      if (!row) continue;
      row[j] =
        a[i] === b[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] ?? '' });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      out.push({ op: '-', text: a[i++] ?? '' });
    } else {
      out.push({ op: '+', text: b[j++] ?? '' });
    }
  }
  while (i < a.length) out.push({ op: '-', text: a[i++] ?? '' });
  while (j < b.length) out.push({ op: '+', text: b[j++] ?? '' });
  return out;
}

export function renderDiff(lines: readonly DiffLine[], color: boolean): string {
  const paint = (l: DiffLine): string => {
    const s = `${l.op} ${l.text}`;
    if (!color || l.op === ' ') return s;
    return l.op === '+' ? `\x1b[32m${s}\x1b[0m` : `\x1b[31m${s}\x1b[0m`;
  };
  return `${lines.map(paint).join('\n')}\n`;
}
