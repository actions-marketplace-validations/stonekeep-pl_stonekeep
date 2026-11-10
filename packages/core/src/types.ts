/** Where a schema definition was found. `file` is a POSIX path relative to the scan root. */
export interface Location {
  file: string;
  line: number;
}

export type SourceKind = 'sql' | 'prisma' | 'typeorm' | 'json-schema' | 'openapi';

/** Coarse storage type used by classification heuristics. */
export const COARSE_TYPES = [
  'string',
  'number',
  'boolean',
  'date',
  'json',
  'binary',
  'unknown',
] as const;
export type CoarseType = (typeof COARSE_TYPES)[number];

/**
 * A field/column definition extracted from a schema source. Parsers only ever
 * extract identifiers and type names — never data values.
 */
export interface SchemaField {
  /** Table, model, entity class or schema name. */
  entity: string;
  /** Field/column name (dotted path for nested JSON/OpenAPI properties). */
  field: string;
  /** Physical column name when it differs from `field` (Prisma `@map`, TypeORM `name`). */
  columnName?: string;
  /** Declared type as written in the source, e.g. `varchar(255)`, `String`, `string`. */
  rawType?: string;
  /** JSON Schema / OpenAPI `format`, e.g. `email`. */
  format?: string;
  source: SourceKind;
  location: Location;
}

export interface Classification {
  category: string;
  /** Id of the rule that matched, or `override` when set in stonekeep.config.json. */
  rule: string;
  /** Heuristic confidence in [0, 1]. */
  confidence: number;
}

/** One entry in stonekeep-datamap.json. */
export interface DataMapField extends Classification {
  /** Stable identifier: `<entity>.<field>`. */
  id: string;
  entity: string;
  field: string;
  source: SourceKind;
  location: Location;
}

export interface DataMap {
  version: 1;
  fields: DataMapField[];
}
