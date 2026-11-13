import {
  LineIndex,
  findMatching,
  maskSql,
  naturalCompare,
  splitTopLevel,
  type Segment,
} from '../text.js';
import type { SchemaField } from '../types.js';

export interface SourceFile {
  /** POSIX path relative to the scan root. */
  path: string;
  content: string;
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\p{L}_][\p{L}\p{N}_$]*)`;
const QNAME = String.raw`${IDENT}(?:\s*\.\s*${IDENT}){0,2}`;

const CREATE_TABLE = new RegExp(
  String.raw`^create\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:temporary\s+|temp\s+)?(?:unlogged\s+)?table\s+(if\s+not\s+exists\s+)?(${QNAME})\s*\(`,
  'iu',
);
/** MySQL `CREATE TABLE copy LIKE original` (no column list). */
const CREATE_TABLE_LIKE = new RegExp(
  String.raw`^create\s+(?:temporary\s+)?table\s+(if\s+not\s+exists\s+)?(${QNAME})\s+like\s+(${QNAME})\s*$`,
  'iu',
);
/** `LIKE original [INCLUDING ...]` inside a column list (PostgreSQL). */
const LIKE_ITEM = new RegExp(String.raw`^like\s+(${QNAME})`, 'iu');
/** `ADD [COLUMN] (a int, b text)`: several columns in one action (MySQL, Oracle). */
const ADD_GROUP = /^add\s*(?:column\s*)?\(/i;
/** Where a new DDL statement starts, used to split statements that have no `;` between them. */
const STATEMENT_START =
  /(?:create\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:temporary\s+|temp\s+)?(?:unlogged\s+)?table|alter\s+table|drop\s+table)\s/iy;
/** T-SQL batch separator on a line of its own. */
const GO_LINE = /^[ \t]*go[ \t]*\r?$/i;
const ALTER_TABLE = new RegExp(
  String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${QNAME})\s+([\s\S]*)$`,
  'iu',
);
const DROP_TABLE = /^drop\s+table\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+(?:cascade|restrict))?\s*$/i;
const ADD_COLUMN = new RegExp(
  String.raw`^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(${IDENT})(?:\s+([\s\S]*))?$`,
  'iu',
);
const DROP_COLUMN = new RegExp(
  String.raw`^drop\s+(?:column\s+)?(?:if\s+exists\s+)?(${IDENT})`,
  'iu',
);
const RENAME_COLUMN = new RegExp(
  String.raw`^rename\s+(?:column\s+)?(${IDENT})\s+to\s+(${IDENT})`,
  'iu',
);
const CHANGE_COLUMN = new RegExp(
  String.raw`^change\s+(?:column\s+)?(${IDENT})\s+(${IDENT})(?:\s+([\s\S]*))?$`,
  'iu',
);
const RENAME_TABLE = new RegExp(String.raw`^rename\s+to\s+(${QNAME})`, 'iu');
const COLUMN_DEF = new RegExp(String.raw`^(${IDENT})(?:\s+([\s\S]*))?$`, 'u');
const IDENT_GLOBAL = new RegExp(IDENT, 'gu');

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

/**
 * Split masked SQL into statements. Besides `;`, a statement also ends where a new
 * CREATE/ALTER/DROP TABLE starts at the beginning of a line outside brackets, or at a T-SQL `GO`
 * line. Without this, a script that has no semicolons would yield only its first table.
 */
function splitStatements(masked: string): Segment[] {
  const out: Segment[] = [];
  for (const stmt of splitTopLevel(masked, ';')) {
    const text = stmt.text;
    const cuts: number[] = [];
    let depth = 0;
    let lineStart = true;
    let i = 0;
    while (i < text.length) {
      const ch = text.charAt(i);
      if (lineStart && depth === 0 && ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
        const eol = text.indexOf('\n', i);
        const line = text.slice(i, eol === -1 ? text.length : eol);
        if (GO_LINE.test(line)) {
          // blank the separator out of both neighbours by cutting on each side of it
          cuts.push(i, i + line.length);
          i += line.length;
          continue;
        }
        STATEMENT_START.lastIndex = i;
        if (i > 0 && STATEMENT_START.test(text)) cuts.push(i);
      }
      if (ch === '\n') lineStart = true;
      else if (ch !== ' ' && ch !== '\t' && ch !== '\r') lineStart = false;
      if (ch === '"' || ch === "'" || ch === '`') {
        const close = text.indexOf(ch, i + 1);
        i = close === -1 ? text.length : close + 1;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      i++;
    }
    let from = 0;
    for (const cut of [...cuts, text.length]) {
      const raw = text.slice(from, cut);
      const lead = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      if (trimmed.length > 0 && !GO_LINE.test(trimmed))
        out.push({ text: trimmed, offset: stmt.offset + from + lead });
      from = cut;
    }
  }
  return out;
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
 * COLUMN, ALTER TABLE RENAME TO, CREATE TABLE ... LIKE, and DROP TABLE. DML is ignored and
 * string literal contents are masked before parsing.
 *
 * `report` receives problems that mean part of a file could not be read (the message holds the
 * file path and line only). A file that fails is reported and the other files are still replayed.
 */
export function parseSql(
  files: readonly SourceFile[],
  report: (problem: string) => void = () => {},
): SchemaField[] {
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

    const copyColumns = (table: TableState, fromQname: string, offset: number): void => {
      const source = tables.get(tableName(fromQname).toLowerCase());
      if (!source || source === table) return;
      for (const col of source.columns.values()) {
        table.columns.set(col.name.toLowerCase(), {
          ...col,
          file: file.path,
          line: lines.lineAt(offset),
        });
      }
    };
    const addColumnList = (table: TableState, body: string, bodyOffset: number): void => {
      for (const item of splitTopLevel(body, ',', bodyOffset)) {
        const like = LIKE_ITEM.exec(item.text);
        if (like?.[1] !== undefined) {
          copyColumns(table, like[1], item.offset);
          continue;
        }
        const def = COLUMN_DEF.exec(item.text);
        if (!def?.[1]) continue;
        if (!isQuoted(def[1]) && CONSTRAINT_KEYWORDS.has(def[1].toLowerCase())) continue;
        addColumn(table, def[1], def[2], item.offset);
      }
    };

    const applyStatement = (stmt: Segment): void => {
      const create = CREATE_TABLE.exec(stmt.text);
      if (create) {
        const name = tableName(create[2] ?? '');
        const ifNotExists = create[1] !== undefined;
        if (ifNotExists && tables.has(name.toLowerCase())) return;
        const open = create[0].length - 1;
        const close = findMatching(stmt.text, open);
        if (close === -1) {
          report(
            `Unbalanced brackets in CREATE TABLE in ${file.path} near line ${lines.lineAt(stmt.offset)}: its columns were not read`,
          );
          return;
        }
        // the new table replaces an old one of the same name
        const table: TableState = { name, columns: new Map() };
        addColumnList(table, stmt.text.slice(open + 1, close), stmt.offset + open + 1);
        tables.set(name.toLowerCase(), table);
        return;
      }

      const createLike = CREATE_TABLE_LIKE.exec(stmt.text);
      if (createLike?.[2] !== undefined && createLike[3] !== undefined) {
        const name = tableName(createLike[2]);
        if (createLike[1] !== undefined && tables.has(name.toLowerCase())) return;
        const table: TableState = { name, columns: new Map() };
        copyColumns(table, createLike[3], stmt.offset);
        tables.set(name.toLowerCase(), table);
        return;
      }

      const alter = ALTER_TABLE.exec(stmt.text);
      if (alter?.[1] !== undefined && alter[2] !== undefined) {
        let table = getTable(tableName(alter[1]));
        const actionsStart = stmt.offset + stmt.text.length - alter[2].length;
        for (const action of splitTopLevel(alter[2], ',', actionsStart)) {
          const group = ADD_GROUP.exec(action.text);
          if (group) {
            const open = group[0].length - 1;
            const close = findMatching(action.text, open);
            if (close !== -1)
              addColumnList(table, action.text.slice(open + 1, close), action.offset + open + 1);
            continue;
          }
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
        return;
      }

      const dropTable = DROP_TABLE.exec(stmt.text);
      if (dropTable?.[1] !== undefined) {
        for (const t of splitTopLevel(dropTable[1], ','))
          tables.delete(tableName(t.text).toLowerCase());
      }
    };

    let statements: Segment[];
    try {
      statements = splitStatements(masked);
    } catch {
      report(`Could not parse ${file.path}`);
      continue;
    }
    for (const stmt of statements) {
      try {
        applyStatement(stmt);
      } catch {
        report(
          `Could not parse a statement in ${file.path} near line ${lines.lineAt(stmt.offset)}`,
        );
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
