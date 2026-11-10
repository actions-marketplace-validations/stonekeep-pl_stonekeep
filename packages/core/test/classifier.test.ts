import { describe, expect, it } from 'vitest';
import {
  classify,
  coarseType,
  compileRuleSet,
  loadDefaultRules,
  normalizeName,
} from '../src/index.js';

const rules = compileRuleSet(loadDefaultRules());
const cls = (
  name: string,
  extra: { rawType?: string; format?: string; columnName?: string } = {},
) =>
  classify(
    {
      names: extra.columnName ? [name, extra.columnName] : [name],
      rawType: extra.rawType,
      format: extra.format,
    },
    rules,
  );

describe('normalizeName', () => {
  it.each([
    ['phoneNumber', 'phone_number'],
    ['PhoneNumber', 'phone_number'],
    ['PHONE-NUMBER', 'phone_number'],
    ['IPAddress', 'ip_address'],
    ['user.email', 'user_email'],
    ['__dob__', 'dob'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
});

describe('coarseType', () => {
  it.each([
    ['VARCHAR(255)', 'string'],
    ['Boolean', 'boolean'],
    ['tinyint(1)', 'boolean'],
    ['TIMESTAMPTZ', 'date'],
    ['BIGINT', 'number'],
    ['jsonb', 'json'],
    ['string | null', 'string'],
    [undefined, 'unknown'],
  ])('%s -> %s', (input, expected) => {
    expect(coarseType(input)).toBe(expected);
  });
});

describe('classify (default rules)', () => {
  it.each([
    ['email', 'contact', 'email'],
    ['emailAddress', 'contact', 'email'],
    ['work_email', 'contact', 'email'],
    ['phone', 'contact', 'phone'],
    ['phoneNumber', 'contact', 'phone'],
    ['mobile_no', 'contact', 'phone'],
    ['first_name', 'identity', 'person-name'],
    ['passport_number', 'government_id', 'government-id'],
    ['ssn', 'government_id', 'government-id'],
    ['iban', 'financial', 'financial'],
    ['date_of_birth', 'demographic', 'date-of-birth'],
    ['ip_address', 'online_identifier', 'online-identifier'],
    ['shipping_address', 'location', 'postal-address'],
    ['password_hash', 'credential', 'credential'],
  ])('%s is %s', (name, category, rule) => {
    expect(cls(name)).toMatchObject({ category, rule });
  });

  it.each([
    'id',
    'title',
    'created_at',
    'email_verified',
    'is_email_public',
    'total_cents',
    'zipper',
    'page',
  ])('%s is not PII', (name) => {
    expect(cls(name)).toBeUndefined();
  });

  it('does not treat email_address / ip_address as a postal address', () => {
    expect(cls('email_address')?.category).toBe('contact');
    expect(cls('ip_address')?.category).toBe('online_identifier');
  });

  it('uses the mapped column name as a second candidate', () => {
    expect(cls('travelDocument', { columnName: 'passport_no' })?.category).toBe('government_id');
  });

  it('uses JSON Schema formats', () => {
    expect(cls('primary', { format: 'email' })).toMatchObject({
      category: 'contact',
      confidence: 0.98,
    });
  });

  it('lowers confidence for boolean columns', () => {
    const plain = cls('phone');
    const bool = cls('phone', { rawType: 'boolean' });
    expect(plain && bool && bool.confidence < plain.confidence).toBe(true);
  });

  it('prefers the most specific (highest confidence) match', () => {
    expect(cls('email')?.confidence).toBeGreaterThan(cls('email_backup_list')?.confidence ?? 1);
  });
});
