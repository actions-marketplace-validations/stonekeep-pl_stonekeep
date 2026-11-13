import { LineIndex, findMatching, maskCodeComments } from '../text.js';
import type { SchemaField } from '../types.js';
import type { SourceFile } from './sql.js';

const COLUMN_DECORATORS =
  'Column|PrimaryColumn|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn|ObjectIdColumn|ViewColumn';
const CLASS = /\bclass\s+([\p{L}_$][\p{L}\p{N}_$]*)[^{;]*\{/gu;
const COLUMN_DECORATOR = new RegExp(String.raw`@(${COLUMN_DECORATORS})\s*\(`, 'g');
const LOOKS_LIKE = new RegExp(
  String.raw`@(?:Entity|ViewEntity|ChildEntity|${COLUMN_DECORATORS})\s*\(`,
);
const OTHER_DECORATOR = /\s*@[\w.]+\s*/y;
const PROPERTY =
  /\s*(?:(?:public|private|protected|readonly|declare|override|static|accessor)\s+)*([\p{L}_$][\p{L}\p{N}_$]*)\s*[!?]?\s*(?::\s*([^;=\n]+))?/uy;
const NAME_OPTION = /\bname\s*:\s*['"`]([^'"`]+)['"`]/;
const TYPE_OPTION = /\btype\s*:\s*['"`]([^'"`]+)['"`]/;
const POSITIONAL_TYPE = /^\s*['"`]([^'"`]+)['"`]/;

/**
 * Quick pre-filter so we only parse files that declare TypeORM entities or columns. A base or
 * embedded class has `@Column` fields but no `@Entity`, and its columns end up in real tables.
 */
export function looksLikeTypeOrm(content: string): boolean {
  return LOOKS_LIKE.test(content);
}

/**
 * Parse classes that carry `@Column`-family decorators: entities, and also base and embedded
 * classes without `@Entity`, whose columns are inherited by or embedded into entities.
 */
export function parseTypeOrm(files: readonly SourceFile[]): SchemaField[] {
  const fields: SchemaField[] = [];
  for (const file of files) {
    const text = maskCodeComments(file.content);
    const lines = new LineIndex(file.content);
    let nextClassFrom = 0;
    for (const cls of text.matchAll(CLASS)) {
      // a class nested inside the previous one was already read as part of its body
      if (!cls[1] || cls.index < nextClassFrom) continue;
      const bodyOpen = cls.index + cls[0].length - 1;
      const bodyClose = findMatching(text, bodyOpen);
      if (bodyClose === -1) continue;
      nextClassFrom = bodyClose;
      const body = text.slice(bodyOpen, bodyClose);

      for (const dec of body.matchAll(COLUMN_DECORATOR)) {
        const decOpen = bodyOpen + dec.index + dec[0].length - 1;
        const decClose = findMatching(text, decOpen);
        if (decClose === -1) continue;
        const args = text.slice(decOpen + 1, decClose);

        let cursor = decClose + 1;
        // Skip stacked decorators like `@Index()` `@IsEmail()`.
        for (;;) {
          OTHER_DECORATOR.lastIndex = cursor;
          const other = OTHER_DECORATOR.exec(text);
          if (!other) break;
          const after = other.index + other[0].length;
          cursor = text[after] === '(' ? findMatching(text, after) + 1 : after;
          if (cursor === 0) break;
        }
        if (cursor === 0) continue;
        PROPERTY.lastIndex = cursor;
        const prop = PROPERTY.exec(text);
        if (!prop?.[1]) continue;
        const nameOffset =
          prop.index + prop[0].indexOf(prop[1], prop[0].length - prop[0].trimStart().length);

        const field: SchemaField = {
          entity: cls[1],
          field: prop[1],
          source: 'typeorm',
          location: { file: file.path, line: lines.lineAt(nameOffset) },
        };
        const columnName = NAME_OPTION.exec(args)?.[1];
        if (columnName !== undefined) field.columnName = columnName;
        const rawType =
          TYPE_OPTION.exec(args)?.[1] ?? POSITIONAL_TYPE.exec(args)?.[1] ?? prop[2]?.trim();
        if (rawType !== undefined && rawType.length > 0) field.rawType = rawType;
        fields.push(field);
      }
    }
  }
  return fields;
}
