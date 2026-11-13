// Cases where the scanner used to miss fields without saying so. A compliance gate must
// either read a schema or report that it could not: it must never pass by skipping.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import {
  check,
  createDataMap,
  loadConfig,
  parsePrisma,
  parseSchemaDocument,
  parseSql,
  parseTypeOrm,
  scan,
} from '../src/index.js';

const names = (fields: { entity: string; field: string }[]) =>
  fields.map((f) => `${f.entity}.${f.field}`).sort();
const sql = (content: string, report?: (p: string) => void) =>
  names(parseSql([{ path: 'm/1.sql', content }], report));

const dirs: string[] = [];
function repo(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stonekeep-rel-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseSql: no silent misses', () => {
  it('reads identifiers with Polish and other non-ASCII letters', () => {
    expect(
      sql('CREATE TABLE klienci (imię text, nazwisko_użytkownika text, "adres e-mail" text);'),
    ).toEqual(['klienci.adres e-mail', 'klienci.imię', 'klienci.nazwisko_użytkownika']);
    expect(
      sql('CREATE TABLE zamówienia (id int);\nALTER TABLE zamówienia ADD COLUMN płeć text;'),
    ).toEqual(['zamówienia.id', 'zamówienia.płeć']);
  });

  it('reads every statement of a script that has no semicolons', () => {
    expect(
      sql(
        'CREATE TABLE a (\n  email text\n)\nCREATE TABLE b (\n  phone text\n)\nALTER TABLE a ADD pesel char(11)\n',
      ),
    ).toEqual(['a.email', 'a.pesel', 'b.phone']);
  });

  it('treats a T-SQL GO line as a statement separator', () => {
    expect(
      sql(
        'CREATE TABLE [dbo].[Users] (\r\n  [Email] nvarchar(255)\r\n)\r\nGO\r\nCREATE TABLE [dbo].[Orders] (\r\n  [Ip] varchar(45)\r\n)\r\nGO\r\nDROP TABLE [dbo].[Orders]\r\nGO\r\n',
      ),
    ).toEqual(['Users.Email']);
  });

  it('ignores DDL inside a function body quoted with a numbered dollar tag', () => {
    expect(
      sql(
        'CREATE FUNCTION f() RETURNS void AS $fn1$ BEGIN CREATE TABLE fake (email text); END; $fn1$ LANGUAGE plpgsql;\nCREATE TABLE real_t (email text);',
      ),
    ).toEqual(['real_t.email']);
  });

  it('reads ALTER TABLE ... ADD (several columns)', () => {
    expect(
      sql('CREATE TABLE t (id int);\nALTER TABLE t ADD (email varchar(255), phone text);'),
    ).toEqual(['t.email', 't.id', 't.phone']);
  });

  it('copies columns for CREATE TABLE ... LIKE', () => {
    expect(
      sql(
        'CREATE TABLE users (id int, email text);\nCREATE TABLE users_archive (LIKE users INCLUDING ALL, archived_at timestamptz);\nCREATE TABLE users_copy LIKE users;',
      ),
    ).toEqual([
      'users.email',
      'users.id',
      'users_archive.archived_at',
      'users_archive.email',
      'users_archive.id',
      'users_copy.email',
      'users_copy.id',
    ]);
  });

  it('is not thrown off by quotes and comment marks inside quoted identifiers', () => {
    expect(sql('CREATE TABLE t ("it\'s" text, "a--b" text, `c#d` text, email text);')).toEqual([
      't.a--b',
      't.c#d',
      't.email',
      "t.it's",
    ]);
  });

  it('keeps reading after a string literal that ends with a backslash', () => {
    expect(
      sql("CREATE TABLE t (dir text DEFAULT 'C:\\', email text);\nCREATE TABLE u (phone text);"),
    ).toEqual(['t.dir', 't.email', 'u.phone']);
    // MySQL-style escaped quote inside a literal still works
    expect(sql("CREATE TABLE t (note text DEFAULT 'it\\'s', email text);")).toEqual([
      't.email',
      't.note',
    ]);
  });

  it('reports a CREATE TABLE whose brackets never close instead of dropping it quietly', () => {
    const problems: string[] = [];
    expect(
      sql('CREATE TABLE broken (\n  email text,\n  phone text', (p) => problems.push(p)),
    ).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('m/1.sql');
  });

  it('never puts seed values into the result', () => {
    const fields = parseSql([
      {
        path: 'seed.sql',
        content:
          "CREATE TABLE users (email text);\nINSERT INTO users VALUES ('jane@example.com'), ('CREATE TABLE leak (pesel text)');",
      },
    ]);
    expect(names(fields)).toEqual(['users.email']);
    expect(JSON.stringify(fields)).not.toContain('jane');
  });
});

describe('parseTypeOrm: no silent misses', () => {
  it('reads columns of base and embedded classes that have no @Entity', () => {
    const fields = parseTypeOrm([
      {
        path: 'src/person.ts',
        content: `import { Column } from 'typeorm';
export abstract class Person {
  @Column() email: string;
}
export class Address {
  @Column({ name: 'street_line' }) street: string;
}
`,
      },
      {
        path: 'src/customer.entity.ts',
        content: `@Entity('customers')
export class Customer extends Person {
  @Column() phone: string;
  @Column(() => Address) address: Address;
}
`,
      },
    ]);
    expect(names(fields)).toEqual([
      'Address.street',
      'Customer.address',
      'Customer.phone',
      'Person.email',
    ]);
  });
});

describe('parseSchemaDocument: no silent misses', () => {
  const doc = (content: string, path = 'api.yaml', report?: (p: string) => void) =>
    names(parseSchemaDocument({ path, content }, report));

  it('reads every document of a multi-document YAML file', () => {
    expect(
      doc(`---
title: Lead
type: object
properties:
  email: { type: string, format: email }
---
openapi: 3.0.0
components:
  schemas:
    Customer:
      type: object
      properties:
        phone: { type: string }
`),
    ).toEqual(['Customer.phone', 'Lead.email']);
  });

  it('follows YAML anchors and aliases', () => {
    expect(
      doc(`openapi: 3.0.0
components:
  schemas:
    Base: &base
      type: object
      properties: &props
        email: &mail { type: string, format: email }
    Copy: *base
    Other:
      type: object
      properties:
        backup_email: *mail
    Third:
      type: object
      properties: *props
`),
    ).toEqual(['Base.email', 'Copy.email', 'Other.backup_email', 'Third.email']);
  });

  it('reads inline request, response and parameter schemas of OpenAPI paths', () => {
    expect(
      doc(`openapi: 3.0.0
paths:
  /users/{id}:
    parameters:
      - { name: id, in: path, schema: { type: string } }
    post:
      parameters:
        - { name: email, in: query, schema: { type: string, format: email } }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                phone: { type: string }
                address:
                  type: object
                  properties:
                    street: { type: string }
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  properties:
                    pesel: { type: string }
        default:
          $ref: '#/components/responses/Error'
`),
    ).toEqual([
      'POST /users/{id}.path.id',
      'POST /users/{id}.query.email',
      'POST /users/{id}.request.address.street',
      'POST /users/{id}.request.phone',
      'POST /users/{id}.response.200[].pesel',
    ]);
  });

  it('reads Swagger 2 body parameters and response schemas', () => {
    expect(
      doc(
        JSON.stringify({
          swagger: '2.0',
          paths: {
            '/leads': {
              put: {
                parameters: [
                  {
                    in: 'body',
                    name: 'body',
                    schema: { type: 'object', properties: { email: { type: 'string' } } },
                  },
                ],
                responses: {
                  200: { schema: { type: 'object', properties: { ip: { type: 'string' } } } },
                },
              },
            },
          },
        }),
        'swagger.json',
      ),
    ).toEqual(['PUT /leads.request.email', 'PUT /leads.response.200.ip']);
  });

  it('reports a schema document that does not parse', () => {
    const problems: string[] = [];
    expect(
      doc('{ "openapi": "3.0.0", "components": { "schemas": { ', 'broken.json', (p) =>
        problems.push(p),
      ),
    ).toEqual([]);
    expect(problems).toEqual([expect.stringContaining('broken.json')]);
  });

  it('stays quiet about broken files that are not schemas', () => {
    const problems: string[] = [];
    doc('name: {{ .Values.name }}\n  bad: [', 'chart/values.yaml', (p) => problems.push(p));
    expect(problems).toEqual([]);
  });
});

describe('scan: encodings and unreadable input', () => {
  it('reads UTF-16 files with a byte order mark', () => {
    const ddl = 'CREATE TABLE Users (Email nvarchar(255), Phone nvarchar(30));\r\n';
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ddl, 'utf16le')]);
    const be = Buffer.from(le);
    be.swap16();
    const result = scan(
      loadConfig(
        repo({ 'le/1.sql': le, 'be/schema.sql': Buffer.from(be), 'x.sql': '\uFEFF' + ddl }),
      ),
    );
    expect(result.incomplete).toEqual([]);
    expect(result.fields.map((f) => f.id)).toEqual(['Users.Email', 'Users.Phone']);
  });

  it('reports a binary file with a schema extension as incomplete', () => {
    const result = scan(
      loadConfig(
        repo({
          'dump.sql': Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 0, 0, 1, 2, 3, 0, 0]),
          'ok.sql': 'CREATE TABLE users (email text);',
        }),
      ),
    );
    expect(result.fields.map((f) => f.id)).toEqual(['users.email']);
    expect(result.incomplete).toEqual([expect.stringContaining('dump.sql')]);
  });

  it('makes check fail when part of the schema could not be read', () => {
    const dir = repo({
      'a.sql': 'CREATE TABLE users (email text);',
      'b.sql': 'CREATE TABLE orders (\n  ip_address inet,',
    });
    const config = loadConfig(dir);
    const result = check(config, createDataMap(scan(config).fields));
    expect(result.unmapped).toEqual([]);
    expect(result.incomplete).toEqual([expect.stringContaining('b.sql')]);
    expect(result.ok).toBe(false);
    expect(check(config, createDataMap(scan(config).fields), { allowIncomplete: true }).ok).toBe(
      true,
    );
  });
});

describe('parsers never throw and never loop on arbitrary input', () => {
  const fragments = fc.constantFrom(
    'CREATE TABLE ',
    'ALTER TABLE ',
    'DROP TABLE ',
    ' ADD COLUMN ',
    ' LIKE ',
    'users',
    'email text',
    '(',
    ')',
    ',',
    ';',
    "'",
    '"',
    '`',
    '\\',
    '$$',
    '$a1$',
    '--',
    '/*',
    '*/',
    '#',
    '\n',
    'GO\n',
    '[',
    ']',
    '{',
    '}',
    ':',
    '@Entity(',
    '@Column(',
    'class A ',
    'model U ',
    'properties',
    'openapi',
    '&a',
    '*a',
    '---\n',
    'ż',
    ' ',
  );
  const soup = fc.array(fc.oneof(fragments, fc.string({ maxLength: 4 })), { maxLength: 60 });

  it('holds for every parser', () => {
    fc.assert(
      fc.property(soup, (parts) => {
        const content = parts.join('');
        const file = { path: 'f', content };
        const all = [
          ...parseSql([file], () => {}),
          ...parsePrisma([file]),
          ...parseTypeOrm([file]),
          ...parseSchemaDocument(file, () => {}),
        ];
        for (const f of all) {
          expect(f.entity.length).toBeGreaterThan(0);
          expect(f.field.length).toBeGreaterThan(0);
          expect(f.location.line).toBeGreaterThan(0);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('gives the same result every time', () => {
    fc.assert(
      fc.property(soup, (parts) => {
        const file = { path: 'f', content: parts.join('') };
        expect(parseSql([file])).toEqual(parseSql([file]));
      }),
      { numRuns: 100 },
    );
  });
});
