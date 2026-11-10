import { describe, expect, it } from 'vitest';
import { parsePrisma, parseSchemaDocument, parseSql, parseTypeOrm } from '../src/index.js';

const names = (fields: { entity: string; field: string }[]) =>
  fields.map((f) => `${f.entity}.${f.field}`);

describe('parseSql', () => {
  it('parses CREATE TABLE columns and skips constraints', () => {
    const fields = parseSql([
      {
        path: 'm/1.sql',
        content: `CREATE TABLE "Users" (
  "id" SERIAL NOT NULL,
  email varchar(255) NOT NULL,
  \`phone\` text,
  [full name] nvarchar(100),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  UNIQUE (email)
);`,
      },
    ]);
    expect(names(fields)).toEqual(['Users.id', 'Users.email', 'Users.phone', 'Users.full name']);
    expect(fields.find((f) => f.field === 'email')).toMatchObject({
      rawType: 'varchar(255)',
      location: { file: 'm/1.sql', line: 3 },
    });
  });

  it('replays ALTER/RENAME/DROP across files in natural order', () => {
    const fields = parseSql([
      { path: 'm/10_drop.sql', content: 'ALTER TABLE users DROP COLUMN fax;' },
      { path: 'm/1_init.sql', content: 'CREATE TABLE users (id int, fax text, name text);' },
      {
        path: 'm/2_alter.sql',
        content:
          'ALTER TABLE users ADD COLUMN email text, ADD CONSTRAINT c UNIQUE (email);\nALTER TABLE users RENAME COLUMN name TO full_name;\nCREATE TABLE tmp (x int);\nDROP TABLE tmp;',
      },
    ]);
    expect(names(fields).sort()).toEqual(['users.email', 'users.full_name', 'users.id']);
  });

  it('follows SQLite-style table rebuilds (Prisma migrations)', () => {
    const fields = parseSql([
      {
        path: 'a.sql',
        content: `CREATE TABLE "User" ("id" INTEGER, "email" TEXT);
CREATE TABLE "new_User" ("id" INTEGER, "email" TEXT, "phone" TEXT);
INSERT INTO "new_User" ("id", "email") SELECT "id", "email" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";`,
      },
    ]);
    expect(names(fields)).toEqual(['User.id', 'User.email', 'User.phone']);
  });

  it('ignores comments and never reads string literal contents', () => {
    const fields = parseSql([
      {
        path: 'a.sql',
        content: `-- CREATE TABLE commented (ssn text);
/* CREATE TABLE also_commented (ssn text); */
CREATE TABLE t (note text DEFAULT 'a, b; CREATE TABLE x (ssn text)');
INSERT INTO t (note) VALUES ('secret@example.com');`,
      },
    ]);
    expect(names(fields)).toEqual(['t.note']);
  });
});

describe('parsePrisma', () => {
  it('extracts scalar fields, @map names and skips relations', () => {
    const fields = parsePrisma([
      {
        path: 'schema.prisma',
        content: `model User {
  id     Int     @id
  // phone String  (commented out)
  email  String  @unique @map("email_address")
  posts  Post[]
  role   Role
  @@map("users")
}
model Post {
  id     Int  @id
  author User @relation(fields: [authorId], references: [id])
  authorId Int
}
enum Role { A B }`,
      },
    ]);
    expect(names(fields)).toEqual([
      'User.id',
      'User.email',
      'User.role',
      'Post.id',
      'Post.authorId',
    ]);
    expect(fields[1]).toMatchObject({
      columnName: 'email_address',
      rawType: 'String',
      location: { line: 4 },
    });
    expect(fields[2]?.rawType).toBe('enum');
  });
});

describe('parseTypeOrm', () => {
  it('extracts decorated columns with options', () => {
    const fields = parseTypeOrm([
      {
        path: 'u.ts',
        content: `@Entity()
export class Account {
  @PrimaryGeneratedColumn() id: number;
  @Column({ name: 'mail', type: 'varchar', comment: 'has (parens)' })
  @IsEmail()
  email!: string;
  helper(): void {}
  @Column('date') readonly birthday?: Date;
}`,
      },
    ]);
    expect(names(fields)).toEqual(['Account.id', 'Account.email', 'Account.birthday']);
    expect(fields[1]).toMatchObject({
      columnName: 'mail',
      rawType: 'varchar',
      location: { line: 6 },
    });
    expect(fields[2]?.rawType).toBe('date');
  });
});

describe('parseSchemaDocument', () => {
  it('reads OpenAPI component schemas, nested objects and arrays (YAML)', () => {
    const fields = parseSchemaDocument({
      path: 'api.yaml',
      content: `openapi: 3.0.0
components:
  schemas:
    User:
      type: object
      properties:
        email: { type: string, format: email }
        address:
          type: object
          properties:
            zip: { type: string }
        tags:
          type: array
          items:
            type: object
            properties:
              label: { type: string }
`,
    });
    expect(names(fields)).toEqual(['User.email', 'User.address.zip', 'User.tags[].label']);
    expect(fields[0]).toMatchObject({ source: 'openapi', format: 'email', location: { line: 7 } });
  });

  it('reads JSON Schema with $defs', () => {
    const fields = parseSchemaDocument({
      path: 'x/person.schema.json',
      content: JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { phone: { type: ['string', 'null'] } },
        $defs: { Card: { type: 'object', properties: { number: { type: 'string' } } } },
      }),
    });
    expect(names(fields)).toEqual(['person.phone', 'Card.number']);
    expect(fields[0]?.rawType).toBe('string');
  });

  it('ignores JSON that is not a schema', () => {
    expect(
      parseSchemaDocument({ path: 'p.json', content: '{"name":"x","properties":{"email":{}}}' }),
    ).toEqual([]);
    expect(parseSchemaDocument({ path: 'bad.json', content: '{ not json' })).toEqual([]);
  });
});
