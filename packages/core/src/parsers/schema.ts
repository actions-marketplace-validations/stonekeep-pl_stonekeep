import {
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document,
  type Node,
  type YAMLMap,
} from 'yaml';
import type { SchemaField, SourceKind } from '../types.js';
import type { SourceFile } from './sql.js';

const MAX_DEPTH = 10;
/** Upper bound on emitted fields per file, so aliases that fan out cannot exhaust memory. */
const MAX_FIELDS = 50_000;
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
/** Text that makes a file worth a warning when it does not parse: it was meant to be a schema. */
const SCHEMA_HINT = /["']?(?:openapi|swagger|\$schema)["']?\s*:/;

type Kind = Extract<SourceKind, 'json-schema' | 'openapi'>;

interface Walker {
  doc: Document.Parsed;
  file: string;
  source: Kind;
  lines: LineCounter;
  out: SchemaField[];
}

/** Value of `key`, with a YAML alias (`*name`) replaced by the node it points to. */
function get(w: Walker, map: YAMLMap, key: string): unknown {
  return deref(w, map.get(key, true));
}

function deref(w: Walker, node: unknown): unknown {
  return isAlias(node) ? node.resolve(w.doc) : node;
}

function getMap(w: Walker, map: YAMLMap, key: string): YAMLMap | undefined {
  const v = get(w, map, key);
  return isMap(v) ? v : undefined;
}

function getString(w: Walker, map: YAMLMap, key: string): string | undefined {
  const v = get(w, map, key);
  if (isScalar(v) && typeof v.value === 'string') return v.value;
  if (isSeq(v)) {
    // JSON Schema allows `type: ["string", "null"]`.
    for (const raw of v.items) {
      const item = deref(w, raw);
      if (isScalar(item) && typeof item.value === 'string' && item.value !== 'null')
        return item.value;
    }
  }
  return undefined;
}

function keyName(key: unknown): string | undefined {
  if (isScalar(key) && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return String(key.value);
  }
  return undefined;
}

function offsetOf(node: unknown): number {
  const range = (node as Node | null)?.range;
  return range ? range[0] : 0;
}

function lineOf(w: Walker, node: unknown): number {
  return Math.max(1, w.lines.linePos(offsetOf(node)).line);
}

const COMBINATORS = ['allOf', 'oneOf', 'anyOf'] as const;

function walkSchema(w: Walker, node: YAMLMap, entity: string, prefix: string, depth: number): void {
  if (depth > MAX_DEPTH || w.out.length >= MAX_FIELDS) return;

  for (const combinator of COMBINATORS) {
    const list = get(w, node, combinator);
    if (isSeq(list)) {
      for (const raw of list.items) {
        const item = deref(w, raw);
        if (isMap(item)) walkSchema(w, item, entity, prefix, depth + 1);
      }
    }
  }

  // a schema that is itself an array of objects, e.g. a response body listing users
  if (getMap(w, node, 'properties') === undefined && getString(w, node, 'type') === 'array') {
    const items = getMap(w, node, 'items');
    if (items) walkSchema(w, items, entity, prefix ? `${prefix}[]` : '', depth + 1);
    return;
  }

  const properties = getMap(w, node, 'properties');
  if (!properties) return;
  for (const pair of properties.items) {
    const name = keyName(pair.key);
    const prop = deref(w, pair.value);
    if (name === undefined || name.length === 0 || !isMap(prop)) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    const type = getString(w, prop, 'type');
    const nested =
      getMap(w, prop, 'properties') !== undefined ||
      COMBINATORS.some((k) => isSeq(get(w, prop, k)));
    const items = type === 'array' ? getMap(w, prop, 'items') : undefined;

    if (nested) {
      walkSchema(w, prop, entity, path, depth + 1);
      continue;
    }
    if (
      items &&
      (getMap(w, items, 'properties') !== undefined ||
        COMBINATORS.some((k) => isSeq(get(w, items, k))))
    ) {
      walkSchema(w, items, entity, `${path}[]`, depth + 1);
      continue;
    }

    const field: SchemaField = {
      entity,
      field: path,
      source: w.source,
      location: { file: w.file, line: lineOf(w, pair.key) },
    };
    const rawType = items ? (getString(w, items, 'type') ?? type) : type;
    if (rawType !== undefined) field.rawType = rawType;
    const format =
      getString(w, prop, 'format') ?? (items ? getString(w, items, 'format') : undefined);
    if (format !== undefined) field.format = format;
    w.out.push(field);
  }
}

function walkNamedSchemas(w: Walker, container: YAMLMap | undefined): void {
  if (!container) return;
  for (const pair of container.items) {
    const name = keyName(pair.key);
    const value = deref(w, pair.value);
    if (name !== undefined && name.length > 0 && isMap(value)) walkSchema(w, value, name, '', 0);
  }
}

/** `parameters:` of a path or an operation: one field per parameter, `<in>.<name>`. */
function walkParameters(w: Walker, owner: YAMLMap, entity: string): void {
  const list = get(w, owner, 'parameters');
  if (!isSeq(list)) return;
  for (const raw of list.items) {
    const param = deref(w, raw);
    if (!isMap(param)) continue;
    const name = getString(w, param, 'name');
    const where = getString(w, param, 'in');
    if (name === undefined || name.length === 0 || where === undefined) continue;
    const schema = getMap(w, param, 'schema');
    if (where === 'body') {
      // Swagger 2 request body
      if (schema) walkSchema(w, schema, entity, 'request', 0);
      continue;
    }
    const field: SchemaField = {
      entity,
      field: `${where}.${name}`,
      source: w.source,
      location: { file: w.file, line: lineOf(w, param) },
    };
    const rawType =
      (schema ? getString(w, schema, 'type') : undefined) ?? getString(w, param, 'type');
    if (rawType !== undefined) field.rawType = rawType;
    const format =
      (schema ? getString(w, schema, 'format') : undefined) ?? getString(w, param, 'format');
    if (format !== undefined) field.format = format;
    w.out.push(field);
  }
}

/** Schemas under `content.<media type>.schema` (OpenAPI 3) or `schema` (Swagger 2). */
function walkBody(w: Walker, body: YAMLMap | undefined, entity: string, prefix: string): void {
  if (!body) return;
  const direct = getMap(w, body, 'schema');
  if (direct) walkSchema(w, direct, entity, prefix, 0);
  const content = getMap(w, body, 'content');
  if (!content) return;
  const seen = new Set<string>();
  for (const pair of content.items) {
    const media = deref(w, pair.value);
    const schema = isMap(media) ? getMap(w, media, 'schema') : undefined;
    if (!schema) continue;
    // the same body is often declared for several media types: report each field once
    const before = w.out.length;
    walkSchema(w, schema, entity, prefix, 0);
    const added = w.out.splice(before);
    for (const f of added) {
      if (seen.has(f.field)) continue;
      seen.add(f.field);
      w.out.push(f);
    }
  }
}

/** Inline schemas of `paths`: parameters, request bodies and responses of every operation. */
function walkPaths(w: Walker, paths: YAMLMap | undefined): void {
  if (!paths) return;
  for (const pathPair of paths.items) {
    const route = keyName(pathPair.key);
    const item = deref(w, pathPair.value);
    if (route === undefined || !isMap(item)) continue;
    for (const opPair of item.items) {
      const method = keyName(opPair.key)?.toLowerCase();
      const op = deref(w, opPair.value);
      if (method === undefined || !HTTP_METHODS.has(method) || !isMap(op)) continue;
      const entity = `${method.toUpperCase()} ${route}`;
      walkParameters(w, item, entity);
      walkParameters(w, op, entity);
      walkBody(w, getMap(w, op, 'requestBody'), entity, 'request');
      const responses = getMap(w, op, 'responses');
      if (!responses) continue;
      for (const resPair of responses.items) {
        const status = keyName(resPair.key);
        const response = deref(w, resPair.value);
        if (status !== undefined && isMap(response))
          walkBody(w, response, entity, `response.${status}`);
      }
    }
  }
}

function stem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.(json|ya?ml)$/i, '').replace(/\.schema$/i, '');
}

function parseOne(w: Walker): void {
  const root = w.doc.contents;
  if (!isMap(root)) return;

  if (get(w, root, 'openapi') !== undefined || get(w, root, 'swagger') !== undefined) {
    w.source = 'openapi';
    const components = getMap(w, root, 'components');
    walkNamedSchemas(w, components ? getMap(w, components, 'schemas') : undefined);
    walkNamedSchemas(w, getMap(w, root, 'definitions'));
    walkPaths(w, getMap(w, root, 'paths'));
    return;
  }

  const schemaUri = getString(w, root, '$schema');
  const isJsonSchema =
    (schemaUri !== undefined && /json-schema/i.test(schemaUri)) ||
    (getMap(w, root, 'properties') !== undefined &&
      (getString(w, root, 'type') === 'object' || getString(w, root, '$id') !== undefined));
  if (!isJsonSchema) return;

  w.source = 'json-schema';
  const title = getString(w, root, 'title');
  const id = getString(w, root, '$id');
  const named = title ?? (id !== undefined ? stem(id.replace(/[#?].*$/, '')) : stem(w.file));
  const entity = named.length > 0 ? named : stem(w.file) || 'schema';
  walkSchema(w, root, entity, '', 0);
  walkNamedSchemas(w, getMap(w, root, 'definitions'));
  walkNamedSchemas(w, getMap(w, root, '$defs'));
}

/**
 * Detect and parse JSON Schema and OpenAPI/Swagger documents (JSON or YAML, one or several
 * documents per file). Files that are neither (e.g. package.json, CI configs) yield no fields.
 *
 * `report` receives a message (file path only) when a file that declares itself a schema
 * cannot be parsed, so the caller knows its fields are missing from the result.
 */
export function parseSchemaDocument(
  file: SourceFile,
  report: (problem: string) => void = () => {},
): SchemaField[] {
  const lines = new LineCounter();
  let docs: Document.Parsed[];
  try {
    const parsed = parseAllDocuments(file.content, { lineCounter: lines, uniqueKeys: false });
    docs = Array.isArray(parsed) ? parsed : [];
  } catch {
    if (SCHEMA_HINT.test(file.content)) report(`Could not parse ${file.path}`);
    return [];
  }
  const out: SchemaField[] = [];
  let broken = false;
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      broken = true;
      continue;
    }
    try {
      parseOne({ doc, file: file.path, source: 'json-schema', lines, out });
    } catch {
      // e.g. an alias that points nowhere
      broken = true;
    }
  }
  if (broken && SCHEMA_HINT.test(file.content))
    report(`Could not parse ${file.path}: it has syntax errors, so its fields were not read`);
  return out;
}
