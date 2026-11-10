import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Node, type YAMLMap } from 'yaml';
import type { SchemaField, SourceKind } from '../types.js';
import type { SourceFile } from './sql.js';

const MAX_DEPTH = 10;

function get(map: YAMLMap, key: string): unknown {
  return map.get(key, true);
}

function getMap(map: YAMLMap, key: string): YAMLMap | undefined {
  const v = get(map, key);
  return isMap(v) ? v : undefined;
}

function getString(map: YAMLMap, key: string): string | undefined {
  const v = get(map, key);
  if (isScalar(v) && typeof v.value === 'string') return v.value;
  if (isSeq(v)) {
    // JSON Schema allows `type: ["string", "null"]`.
    for (const item of v.items) {
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

type Kind = Extract<SourceKind, 'json-schema' | 'openapi'>;

interface Walker {
  file: string;
  source: Kind;
  lines: LineCounter;
  out: SchemaField[];
}

function walkSchema(w: Walker, node: YAMLMap, entity: string, prefix: string, depth: number): void {
  if (depth > MAX_DEPTH) return;

  for (const combinator of ['allOf', 'oneOf', 'anyOf']) {
    const list = get(node, combinator);
    if (isSeq(list)) {
      for (const item of list.items)
        if (isMap(item)) walkSchema(w, item, entity, prefix, depth + 1);
    }
  }

  const properties = getMap(node, 'properties');
  if (!properties) return;
  for (const pair of properties.items) {
    const name = keyName(pair.key);
    if (name === undefined || !isMap(pair.value)) continue;
    const prop = pair.value;
    const path = prefix ? `${prefix}.${name}` : name;
    const type = getString(prop, 'type');
    const nested =
      getMap(prop, 'properties') !== undefined ||
      ['allOf', 'oneOf', 'anyOf'].some((k) => isSeq(get(prop, k)));
    const items = type === 'array' ? getMap(prop, 'items') : undefined;

    if (nested) {
      walkSchema(w, prop, entity, path, depth + 1);
      continue;
    }
    if (items && getMap(items, 'properties') !== undefined) {
      walkSchema(w, items, entity, `${path}[]`, depth + 1);
      continue;
    }

    const field: SchemaField = {
      entity,
      field: path,
      source: w.source,
      location: { file: w.file, line: w.lines.linePos(offsetOf(pair.key)).line },
    };
    const rawType = items ? (getString(items, 'type') ?? type) : type;
    if (rawType !== undefined) field.rawType = rawType;
    const format = getString(prop, 'format') ?? (items ? getString(items, 'format') : undefined);
    if (format !== undefined) field.format = format;
    w.out.push(field);
  }
}

function walkNamedSchemas(w: Walker, container: YAMLMap | undefined): void {
  if (!container) return;
  for (const pair of container.items) {
    const name = keyName(pair.key);
    if (name !== undefined && isMap(pair.value)) walkSchema(w, pair.value, name, '', 0);
  }
}

function stem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.(json|ya?ml)$/i, '').replace(/\.schema$/i, '');
}

/**
 * Detect and parse JSON Schema and OpenAPI/Swagger documents (JSON or YAML).
 * Files that are neither (e.g. package.json, CI configs) yield no fields.
 */
export function parseSchemaDocument(file: SourceFile): SchemaField[] {
  const lines = new LineCounter();
  const doc = parseDocument(file.content, { lineCounter: lines, uniqueKeys: false });
  if (doc.errors.length > 0) return [];
  const root = doc.contents;
  if (!isMap(root)) return [];

  if (get(root, 'openapi') !== undefined || get(root, 'swagger') !== undefined) {
    const w: Walker = { file: file.path, source: 'openapi', lines, out: [] };
    const components = getMap(root, 'components');
    walkNamedSchemas(w, components ? getMap(components, 'schemas') : undefined);
    walkNamedSchemas(w, getMap(root, 'definitions'));
    return w.out;
  }

  const schemaUri = getString(root, '$schema');
  const isJsonSchema =
    (schemaUri !== undefined && /json-schema/i.test(schemaUri)) ||
    (getMap(root, 'properties') !== undefined &&
      (getString(root, 'type') === 'object' || getString(root, '$id') !== undefined));
  if (!isJsonSchema) return [];

  const w: Walker = { file: file.path, source: 'json-schema', lines, out: [] };
  const title = getString(root, 'title');
  const id = getString(root, '$id');
  const entity = title ?? (id !== undefined ? stem(id.replace(/[#?].*$/, '')) : stem(file.path));
  walkSchema(w, root, entity, '', 0);
  walkNamedSchemas(w, getMap(root, 'definitions'));
  walkNamedSchemas(w, getMap(root, '$defs'));
  return w.out;
}
