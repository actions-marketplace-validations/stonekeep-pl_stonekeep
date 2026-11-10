import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  check,
  classify,
  compileRuleSet,
  loadConfig,
  loadDefaultRules,
  normalizeName,
  scan,
  toSarif,
} from '../src/index.js';

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function project(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'stonekeep-rm-'));
  temps.push(dir);
  writeFileSync(join(dir, '001.sql'), sql);
  return dir;
}

const rules = compileRuleSet(loadDefaultRules());
const category = (name: string) => classify({ names: [name] }, rules)?.category;

describe('normalizeName folds Central European diacritics', () => {
  it.each([
    ['imię', 'imie'],
    ['dataUrodzenia', 'data_urodzenia'],
    ['születési_dátum', 'szuletesi_datum'],
    ['Łódź', 'lodz'],
    ['reședință', 'resedinta'],
    ['adóazonosító_jel', 'adoazonosito_jel'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
});

describe('CEE field names', () => {
  it.each([
    // Poland
    ['pesel', 'government_id'],
    ['nrDowodu', 'government_id'],
    ['nip', 'government_id'],
    ['imię', 'identity'],
    ['nazwisko', 'identity'],
    ['numer_telefonu', 'contact'],
    ['adres_zamieszkania', 'location'],
    ['kod_pocztowy', 'location'],
    ['data_urodzenia', 'demographic'],
    ['nr_rachunku', 'financial'],
    ['haslo', 'credential'],
    ['hasło', 'credential'],
    // Romania
    ['cnp', 'government_id'],
    ['serie_buletin', 'government_id'],
    ['prenume', 'identity'],
    ['nume', 'identity'],
    ['domiciliu', 'location'],
    ['data_nașterii', 'demographic'],
    ['cont_bancar', 'financial'],
    // Hungary
    ['adóazonosító_jel', 'government_id'],
    ['taj_szam', 'government_id'],
    ['vezetéknév', 'identity'],
    ['keresztnév', 'identity'],
    ['telefonszám', 'contact'],
    ['lakcím', 'location'],
    ['születési_dátum', 'demographic'],
    ['bankszámlaszám', 'financial'],
    // Wider CEE
    ['rodne_cislo', 'government_id'],
    ['egn', 'government_id'],
    ['oib', 'government_id'],
  ])('%s -> %s', (name, expected) => {
    expect(category(name)).toBe(expected);
  });

  it.each(['adres_ip', 'adresa_ip'])('%s is an online identifier, not a postal address', (name) => {
    expect(category(name)).toBe('online_identifier');
  });

  it.each(['status', 'opis', 'kwota', 'descriere', 'leiras'])('%s is not personal data', (name) => {
    expect(category(name)).toBeUndefined();
  });

  it('detects Polish columns in a SQL migration', () => {
    const dir = project(
      'CREATE TABLE klienci (\n id int,\n imie text,\n nazwisko text,\n pesel char(11),\n telefon text,\n status text\n);',
    );
    const found = Object.fromEntries(scan(loadConfig(dir)).fields.map((f) => [f.id, f.category]));
    expect(found).toEqual({
      'klienci.imie': 'identity',
      'klienci.nazwisko': 'identity',
      'klienci.pesel': 'government_id',
      'klienci.telefon': 'contact',
    });
  });
});

describe('stonekeep-ignore', () => {
  it('suppresses a field via a comment on the same or previous line', () => {
    const dir = project(
      'CREATE TABLE t (\n  email text, -- stonekeep-ignore\n  -- stonekeep-ignore\n  phone text,\n  dob date\n);',
    );
    const ids = scan(loadConfig(dir)).fields.map((f) => f.id);
    expect(ids).toEqual(['t.dob']);
  });

  it('does not let a trailing marker suppress the next field', () => {
    const dir = project(
      'CREATE TABLE t (\n  pesel text, -- stonekeep-ignore\n  nr_rachunku text\n);',
    );
    const ids = scan(loadConfig(dir)).fields.map((f) => f.id);
    expect(ids).toEqual(['t.nr_rachunku']);
  });
});

describe('SARIF output', () => {
  it('reports unmapped fields with locations', () => {
    const dir = project('CREATE TABLE t (\n  email text\n);');
    const sarif = toSarif(check(loadConfig(dir), { version: 1, fields: [] }));
    const run = sarif.runs[0] as {
      results: {
        ruleId: string;
        locations: { physicalLocation: { region: { startLine: number } } }[];
      }[];
    };
    expect(sarif.version).toBe('2.1.0');
    expect(run.results).toHaveLength(1);
    expect(run.results[0]?.ruleId).toBe('stonekeep/unmapped-pii');
    expect(run.results[0]?.locations[0]?.physicalLocation.region.startLine).toBe(2);
  });
});

describe('scanner ignores Stonekeep and CI files', () => {
  it('does not treat stonekeep.ropa.yaml or GitHub workflows as schemas', () => {
    const dir = project('CREATE TABLE t (\n  email text\n);');
    writeFileSync(join(dir, 'stonekeep.ropa.yaml'), 'version: 1\nactivities: []\n');
    writeFileSync(join(dir, 'stonekeep.connector.yaml'), 'version: 1\n');
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n');
    const result = scan(loadConfig(dir));
    expect(result.filesScanned).toBe(1);
    expect(result.warnings).toEqual([]);
  });
});
