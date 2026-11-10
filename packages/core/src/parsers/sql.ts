import { LineIndex, findMatching, maskSql, naturalCompare, splitTopLevel } from '../text.js';
import type { SchemaField } from '../types.js';

export interface SourceFile {
  /** POSIX path relative to the scan root. */
  path: string;
  content: string;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;

const CREATE_TABLE = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:temporary\s+|temp\s+)?(?:unlogged\s+)?table\s+(if\s+not\s+exists\s+)?(${QNAME})\s*\(`,
  'i',
);
const ALTER_TABLE = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QNAME})\s+([\s\S]*)$`,
  'i',
);
const DROP_TABLE = /^drop\s+table\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+(?:cascade|restrict))?\s*$/i;
const ADD_COLUMN = new RegExp(
  String.raw`^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(${IDENT})(?:\s+([\s\S]*))?$`,
  'i',
);
const DROP_COLUMN = new RegExp(
  String.raw`^drop\s+(?:column\s+)?(?:if\s+exists\s+)?(${IDENT})`,
  'i',
);
const RENAME_COLUMN = new RegExp(
  String.raw`^rename\s+(?:column\s+)?(${IDENT})\s+to\s+(${IDENT})`,
  'i',
);
const CHANGE_COLUMN = new RegExp(
  String.raw`^change\s+(?:column\s+)?(${IDENT})\s+(${IDENT})(?:\s+([\s\S]*))?$`,
  'i',
);
const RENAME_TABLE = new RegExp(String.raw`^rename\s+to\s+(${QNAME})`, 'i');
const COLUMN_DEF = new RegExp(String.raw`^(${IDENT})(?:\s+([\s\S]*))?$`);
const IDENT_GLOBAL = new RegExp(IDENT, 'g');

/** Unquoted leading keywords that start a table constraint rather than a column. */
const CONSTRAINT_KEYWORDS = new Set([
  'constraint',
  'primary',
  'foreign',
  'unique',
  'check',
  'key',
  'index',
  'fulltext',
  'spatial',
  'exclude',
  'like',
  'period',
]);

const TYPE_TERMINATOR =
  /\s+(?:not\b|null\b|default\b|primary\b|references\b|unique\b|check\b|constraint\b|collate\b|generated\b|auto_increment\b|autoincrement\b|comment\b|on\b|identity\b)/i;

function unquote(ident: string): string {
  const first = ident[0];
  if (first === '"') return ident.slice(1, -1).replace(/""/g, '"');
  if (first === '`' || first === '[') return ident.slice(1, -1);
  return ident;
}

function isQuoted(ident: string): boolean {
  return ident[0] === '"' || ident[0] === '`' || ident[0] === '[';
}

/** `public."Users"` -> `Users` */
function tableName(qname: string): string {
  const parts = qname.match(IDENT_GLOBAL) ?? [qname];
  return unquote(parts[parts.length - 1] ?? qname);
}

function columnType(rest: string | undefined): string | undefined {
  if (rest === undefined) return undefined;
  const type = rest.split(TYPE_TERMINATOR)[0]?.trim();
  return type === undefined || type.length === 0 ? undefined : type;
}

interface ColumnState {
  name: string;
  rawType: string | undefined;
  file: string;
  line: number;
}

interface TableState {
  name: string;
  columns: Map<string, ColumnState>;
}

/**
 * Replay SQL DDL across migration files (natural path order) and return the
 * resulting columns. Supports CREATE TABLE, ALTER TABLE ADD/DROP/RENAME/CHANGE
 * COLUMN, ALTER TABLE RENAME TO, and DROP TABLE. DML is ignored and string
 * literal contents are masked before parsing.
 */
export function parseSql(files: readonly SourceFile[]): SchemaField[] {
  const tables = new Map<string, TableState>();
  const getTable = (name: string): TableState => {
    const key = name.toLowerCase();
    let table = tables.get(key);
    if (!table) {
      table = { name, columns: new Map() };
      tables.set(key, table);
    }
    return table;
  };

  const ordered = [...files].sort((a, b) => naturalCompare(a.path, b.path));
  for (const file of ordered) {
    const masked = maskSql(file.content);
    const lines = new LineIndex(file.content);
    const addColumn = (
      table: TableState,
      ident: string,
      rest: string | undefined,
      offset: number,
    ): void => {
      const name = unquote(ident);
      table.columns.set(name.toLowerCase(), {
        name,
        rawType: columnType(rest),
        file: file.path,
        line: lines.lineAt(offset),
      });
    };

    for (const stmt of splitTopLevel(masked, ';')) {
      const create = CREATE_TABLE.exec(stmt.text);
      if (create) {
        const name = tableName(create[2] ?? '');
        const ifNotExists = create[1] !== undefined;
        if (ifNotExists && tables.has(name.toLowerCase())) continue;
        const open = create[0].length - 1;
        const close = findMatching(stmt.text, open);
        if (close === -1) continue;
        tables.delete(name.toLowerCase());
        const table = getTable(name);
        const body = stmt.text.slice(open + 1, close);
        for (const item of splitTopLevel(body, ',', stmt.offset + open + 1)) {
          const def = COLUMN_DEF.exec(item.text);
          if (!def?.[1]) continue;
          if (!isQuoted(def[1]) && CONSTRAINT_KEYWORDS.has(def[1].toLowerCase())) continue;
          addColumn(table, def[1], def[2], item.offset);
        }
        continue;
      }

      const alter = ALTER_TABLE.exec(stmt.text);
      if (alter?.[1] !== undefined && alter[2] !== undefined) {
        let table = getTable(tableName(alter[1]));
        const actionsStart = stmt.offset + stmt.text.length - alter[2].length;
        for (const action of splitTopLevel(alter[2], ',', actionsStart)) {
          const add = ADD_COLUMN.exec(action.text);
          if (add?.[1] !== undefined) {
            if (!isQuoted(add[1]) && CONSTRAINT_KEYWORDS.has(add[1].toLowerCase())) continue;
            addColumn(table, add[1], add[2], action.offset);
            continue;
          }
          const renameTable = RENAME_TABLE.exec(action.text);
          if (renameTable?.[1] !== undefined) {
            const newName = tableName(renameTable[1]);
            tables.delete(table.name.toLowerCase());
            tables.delete(newName.toLowerCase());
            table = { name: newName, columns: table.columns };
            tables.set(newName.toLowerCase(), table);
            continue;
          }
          const rename = RENAME_COLUMN.exec(action.text);
          if (rename?.[1] !== undefined && rename[2] !== undefined) {
            const old = table.columns.get(unquote(rename[1]).toLowerCase());
            table.columns.delete(unquote(rename[1]).toLowerCase());
            addColumn(table, rename[2], old?.rawType, action.offset);
            continue;
          }
          const change = CHANGE_COLUMN.exec(action.text);
          if (change?.[1] !== undefined && change[2] !== undefined) {
            table.columns.delete(unquote(change[1]).toLowerCase());
            addColumn(table, change[2], change[3], action.offset);
            continue;
          }
          const drop = DROP_COLUMN.exec(action.text);
          if (drop?.[1] !== undefined) {
            if (!isQuoted(drop[1]) && CONSTRAINT_KEYWORDS.has(drop[1].toLowerCase())) continue;
            table.columns.delete(unquote(drop[1]).toLowerCase());
          }
        }
        continue;
      }

      const dropTable = DROP_TABLE.exec(stmt.text);
      if (dropTable?.[1] !== undefined) {
        for (const t of splitTopLevel(dropTable[1], ','))
          tables.delete(tableName(t.text).toLowerCase());
      }
    }
  }

  const fields: SchemaField[] = [];
  for (const table of tables.values()) {
    for (const col of table.columns.values()) {
      const field: SchemaField = {
        entity: table.name,
        field: col.name,
        source: 'sql',
        location: { file: col.file, line: col.line },
      };
      if (col.rawType !== undefined) field.rawType = col.rawType;
      fields.push(field);
    }
  }
  return fields;
}
