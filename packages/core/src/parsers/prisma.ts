import { LineIndex, findMatching, maskCodeComments } from '../text.js';
import type { SchemaField } from '../types.js';
import type { SourceFile } from './sql.js';

const BLOCK = /\b(model|type|view|enum)\s+(\w+)\s*\{/g;
const FIELD = /^(\w+)\s+(\w+)(?:\(([^)]*)\))?(\[\])?(\?)?(.*)$/;
const MAP_ATTR = /@map\(\s*(?:name\s*:\s*)?"([^"]+)"\s*\)/;

/** Parse Prisma schema files. Relation fields (whose type is another model) are skipped. */
export function parsePrisma(files: readonly SourceFile[]): SchemaField[] {
  const parsed = files.map((file) => {
    const masked = maskCodeComments(file.content);
    const blocks: { kind: string; name: string; bodyStart: number; body: string }[] = [];
    for (const m of masked.matchAll(BLOCK)) {
      const open = m.index + m[0].length - 1;
      const close = findMatching(masked, open);
      if (close === -1 || m[1] === undefined || m[2] === undefined) continue;
      blocks.push({
        kind: m[1],
        name: m[2],
        bodyStart: open + 1,
        body: masked.slice(open + 1, close),
      });
    }
    return { file, blocks };
  });

  // Names across all files (Prisma supports multi-file schemas).
  const relationTypes = new Set<string>();
  const enums = new Set<string>();
  for (const { blocks } of parsed) {
    for (const b of blocks) {
      if (b.kind === 'enum') enums.add(b.name);
      else relationTypes.add(b.name);
    }
  }

  const fields: SchemaField[] = [];
  for (const { file, blocks } of parsed) {
    const lines = new LineIndex(file.content);
    for (const block of blocks) {
      if (block.kind === 'enum') continue;
      let offset = block.bodyStart;
      for (const rawLine of block.body.split('\n')) {
        const lineOffset = offset;
        offset += rawLine.length + 1;
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith('@')) continue;
        const m = FIELD.exec(line);
        if (!m?.[1] || !m[2]) continue;
        const type = m[2];
        if (relationTypes.has(type)) continue;
        const field: SchemaField = {
          entity: block.name,
          field: m[1],
          rawType: enums.has(type) ? 'enum' : type,
          source: 'prisma',
          location: { file: file.path, line: lines.lineAt(lineOffset) },
        };
        const mapped = MAP_ATTR.exec(m[6] ?? '');
        if (mapped?.[1] !== undefined) field.columnName = mapped[1];
        fields.push(field);
      }
    }
  }
  return fields;
}
