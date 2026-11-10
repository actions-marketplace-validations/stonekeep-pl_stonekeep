import { LineIndex, findMatching, maskCodeComments } from '../text.js';
import type { SchemaField } from '../types.js';
import type { SourceFile } from './sql.js';

const ENTITY = /@(?:Entity|ViewEntity|ChildEntity)\s*\(/g;
const CLASS = /\bclass\s+(\w+)[^{]*\{/y;
const COLUMN_DECORATOR =
  /@(Column|PrimaryColumn|PrimaryGeneratedColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn|ObjectIdColumn|ViewColumn)\s*\(/g;
const OTHER_DECORATOR = /\s*@[\w.]+\s*/y;
const PROPERTY =
  /\s*(?:(?:public|private|protected|readonly|declare|override|static|accessor)\s+)*(\w+)\s*[!?]?\s*(?::\s*([^;=\n]+))?/y;
const NAME_OPTION = /\bname\s*:\s*['"`]([^'"`]+)['"`]/;
const TYPE_OPTION = /\btype\s*:\s*['"`]([^'"`]+)['"`]/;
const POSITIONAL_TYPE = /^\s*['"`]([^'"`]+)['"`]/;

/** Quick pre-filter so we only parse files that declare TypeORM entities. */
export function looksLikeTypeOrm(content: string): boolean {
  return /@(?:Entity|ViewEntity|ChildEntity)\s*\(/.test(content);
}

/** Parse TypeORM entity classes decorated with `@Entity` and `@Column`-family decorators. */
export function parseTypeOrm(files: readonly SourceFile[]): SchemaField[] {
  const fields: SchemaField[] = [];
  for (const file of files) {
    const text = maskCodeComments(file.content);
    const lines = new LineIndex(file.content);
    for (const entity of text.matchAll(ENTITY)) {
      const argsOpen = entity.index + entity[0].length - 1;
      const argsClose = findMatching(text, argsOpen);
      if (argsClose === -1) continue;

      // Skip any further decorators/whitespace/`export default abstract` before `class`.
      let pos = argsClose + 1;
      const classSearch = /\bclass\s/g;
      classSearch.lastIndex = pos;
      const classAt = classSearch.exec(text);
      if (!classAt) continue;
      pos = classAt.index;
      CLASS.lastIndex = pos;
      const cls = CLASS.exec(text);
      if (!cls?.[1]) continue;
      const bodyOpen = cls.index + cls[0].length - 1;
      const bodyClose = findMatching(text, bodyOpen);
      if (bodyClose === -1) continue;
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
