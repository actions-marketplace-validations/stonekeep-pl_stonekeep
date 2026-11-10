import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { createDataMap, loadConfig, scan, serializeDataMap } from '../src/index.js';
import { cleanupFixtures, copyFixture, fixturePath } from './helpers.js';

afterAll(cleanupFixtures);

const byId = (fields: { id: string; category: string }[]) =>
  Object.fromEntries(fields.map((f) => [f.id, f.category]));

describe('scanner: Prisma fixture', () => {
  const result = scan(loadConfig(fixturePath('prisma-app')));
  const found = byId(result.fields);

  it('finds emails and phone numbers', () => {
    expect(found['User.email']).toBe('contact');
    expect(found['User.phoneNumber']).toBe('contact');
    expect(found['Profile.mobile']).toBe('contact');
  });

  it('finds other personal data', () => {
    expect(found).toMatchObject({
      'User.firstName': 'identity',
      'User.lastName': 'identity',
      'User.dateOfBirth': 'demographic',
      'User.passwordHash': 'credential',
      'User.lastLoginIp': 'online_identifier',
      'Profile.street': 'location',
      'Profile.postcode': 'location',
    });
  });

  it('ignores non-PII, flags and relations', () => {
    for (const id of [
      'User.id',
      'User.emailVerified',
      'User.role',
      'User.posts',
      'Post.title',
      'Post.author',
    ]) {
      expect(found[id]).toBeUndefined();
    }
  });

  it('records location and confidence', () => {
    const email = result.fields.find((f) => f.id === 'User.email');
    expect(email).toMatchObject({
      source: 'prisma',
      rule: 'email',
      location: { file: 'prisma/schema.prisma', line: 19 },
    });
    expect(email?.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe('scanner: SQL migrations fixture', () => {
  const result = scan(loadConfig(fixturePath('sql-migrations')));
  const found = byId(result.fields);

  it('finds emails and phone numbers', () => {
    expect(found['users.email']).toBe('contact');
    expect(found['users.phone']).toBe('contact');
  });

  it('reflects the final schema after all migrations', () => {
    expect(found['users.display_name']).toBe('identity'); // renamed from full_name
    expect(found['users.full_name']).toBeUndefined();
    expect(found['users.mobile_phone']).toBeUndefined(); // dropped in 010
    expect(found['audit_log.ip_address']).toBeUndefined(); // table dropped
    expect(found['users.date_of_birth']).toBe('demographic');
    expect(found['orders.shipping_address']).toBe('location');
    expect(found['users.is_email_public']).toBeUndefined();
  });

  it('never copies seed values into the datamap', () => {
    const json = serializeDataMap(createDataMap(result.fields));
    expect(json).not.toContain('jane.fixture@example.com');
    expect(json).not.toContain('555-0100');
    expect(json).not.toContain('Jane Fixture');
  });

  it('matches the committed datamap exactly', () => {
    const committed = readFileSync(
      `${fixturePath('sql-migrations')}/stonekeep-datamap.json`,
      'utf8',
    );
    expect(serializeDataMap(createDataMap(result.fields))).toBe(committed.replace(/\r\n/g, '\n'));
  });
});

describe('scanner: TypeORM + OpenAPI + JSON Schema fixture', () => {
  const result = scan(loadConfig(fixturePath('typeorm-openapi')));
  const found = byId(result.fields);

  it('finds TypeORM columns, using the column name option', () => {
    expect(found).toMatchObject({
      'Customer.contactEmail': 'contact',
      'Customer.telephone': 'contact',
      'Customer.travelDocument': 'government_id',
      'Customer.iban': 'financial',
    });
    expect(found['Customer.marketingOptIn']).toBeUndefined();
    expect(found['Customer.commentedOut']).toBeUndefined();
  });

  it('finds OpenAPI and JSON Schema properties', () => {
    expect(found).toMatchObject({
      'Contact.primary': 'contact',
      'Contact.address.street': 'location',
      'Contact.address.postalCode': 'location',
      'Contact.devices[].lastSeenIp': 'online_identifier',
      'Lead.workEmail': 'contact',
      'Lead.phone': 'contact',
      'Lead.gender': 'demographic',
      'Consent.ipAddress': 'online_identifier',
    });
    expect(found['Health.status']).toBeUndefined();
  });

  it('applies config overrides and excludes', () => {
    expect(result.fields.find((f) => f.id === 'Contact.name')).toMatchObject({
      category: 'identity',
      rule: 'override',
      confidence: 1,
    });
    expect(found['Customer.plan']).toBeUndefined();
    expect(found['legacy_people.ssn']).toBeUndefined();
  });
});

describe('scanner: configurable rules', () => {
  it('honours extraRules and minConfidence from stonekeep.config.json', async () => {
    const dir = copyFixture('prisma-app');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      `${dir}/stonekeep.config.json`,
      JSON.stringify({
        minConfidence: 0.9,
        extraRules: [
          { id: 'bio', category: 'free_text', match: [{ pattern: '^bio$', confidence: 0.95 }] },
        ],
      }),
    );
    const found = byId(scan(loadConfig(dir)).fields);
    expect(found['Profile.bio']).toBe('free_text');
    expect(found['Profile.postcode']).toBeUndefined(); // 0.8 < 0.9
    expect(found['User.email']).toBe('contact');
  });

  it('can replace the default rules entirely with rulesFile', async () => {
    const dir = copyFixture('prisma-app');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      `${dir}/rules.json`,
      JSON.stringify({
        version: 1,
        rules: [
          { id: 'only-email', category: 'contact', match: [{ pattern: 'email', confidence: 0.9 }] },
        ],
      }),
    );
    writeFileSync(`${dir}/stonekeep.config.json`, JSON.stringify({ rulesFile: 'rules.json' }));
    const ids = scan(loadConfig(dir)).fields.map((f) => f.id);
    expect(ids).toEqual(['User.email', 'User.emailVerified']);
  });
});
