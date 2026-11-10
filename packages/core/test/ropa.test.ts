import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  buildRopa,
  parseRopa,
  renderRopaMarkdown,
  ropaTemplate,
  type DataMap,
  type DataMapField,
  type RopaInput,
} from '../src/index.js';

const field = (entity: string, name: string, category: string): DataMapField => ({
  id: `${entity}.${name}`,
  entity,
  field: name,
  category,
  rule: 'test',
  confidence: 0.9,
  source: 'sql',
  location: { file: 'schema.sql', line: 1 },
});

const datamap: DataMap = {
  version: 1,
  fields: [
    field('klienci', 'email', 'contact'),
    field('klienci', 'pesel', 'government_id'),
    field('klienci', 'imie', 'identity'),
    field('wizyty', 'diagnoza', 'health'),
    field('logi', 'adres_ip', 'online_identifier'),
  ],
};

const base: RopaInput = {
  version: 1,
  language: 'pl',
  controller: {
    name: 'Przykład sp. z o.o.',
    address: 'ul. Testowa 1, Warszawa',
    contact: 'iod@example.pl',
  },
  dpo: { name: 'Inspektor', contact: 'iod@example.pl' },
  securityMeasures: ['Szyfrowanie danych w spoczynku'],
  activities: [
    {
      id: 'obsluga-klientow',
      name: 'Obsługa klientów',
      purposes: ['Realizacja umów'],
      legalBasis: ['contract', 'legal_obligation'],
      dataSubjects: ['Klienci'],
      entities: ['klienci'],
      recipients: ['Biuro rachunkowe'],
      transfers: [{ country: 'USA', safeguard: 'EU-US Data Privacy Framework' }],
      retention: '6 lat od zakończenia umowy',
    },
  ],
};

describe('buildRopa', () => {
  it('derives data categories from the datamap and reports uncovered entities', () => {
    const ropa = buildRopa(parseRopa(base), datamap, { asOf: '2026-11-08' });
    expect(ropa.activities[0]?.dataCategories).toEqual([
      { category: 'contact', fields: ['klienci.email'] },
      { category: 'government_id', fields: ['klienci.pesel'] },
      { category: 'identity', fields: ['klienci.imie'] },
    ]);
    expect(ropa.uncoveredEntities).toEqual(['logi', 'wizyty']);
    expect(ropa.issues.map((i) => i.code)).toEqual(['uncovered-entity', 'uncovered-entity']);
  });

  it('flags special categories without an Art. 9(2) condition, unknown names and unsafe transfers', () => {
    const ropa = buildRopa(
      parseRopa({
        ...base,
        securityMeasures: [],
        activities: [
          {
            id: 'leczenie',
            name: 'Leczenie',
            purposes: ['Opieka zdrowotna'],
            legalBasis: ['contract'],
            dataSubjects: ['Pacjenci'],
            entities: ['wizyty', 'pacjenci'],
            fields: ['klienci.pesel', 'klienci.brak'],
            transfers: [{ country: 'Indie' }],
            retention: '20 lat',
          },
        ],
      }),
      datamap,
    );
    const codes = ropa.issues.map((i) => i.code).sort();
    expect(codes).toEqual(
      [
        'missing-special-category-condition',
        'no-security-measures',
        'transfer-without-safeguard',
        'uncovered-entity',
        'unknown-entity',
        'unknown-field',
      ].sort(),
    );
    expect(ropa.activities[0]?.specialCategories).toBe(true);
    // A field reference covers its entity.
    expect(ropa.uncoveredEntities).toEqual(['logi']);
  });

  it('accepts an Art. 9(2) condition for health data', () => {
    const ropa = buildRopa(
      parseRopa({
        ...base,
        activities: [
          {
            id: 'leczenie',
            name: 'Leczenie',
            purposes: ['Opieka zdrowotna'],
            legalBasis: ['legal_obligation'],
            specialCategoryConditions: ['health_care'],
            dataSubjects: ['Pacjenci'],
            entities: ['wizyty'],
            retention: '20 lat',
          },
        ],
      }),
      datamap,
    );
    expect(ropa.issues.some((i) => i.code === 'missing-special-category-condition')).toBe(false);
  });

  it('rejects invalid files with a readable error', () => {
    expect(() =>
      parseRopa({ ...base, activities: [{ ...base.activities[0], legalBasis: ['because'] }] }),
    ).toThrow(/Invalid ROPA file/);
    expect(() =>
      parseRopa({ ...base, activities: [base.activities[0], base.activities[0]] }),
    ).toThrow(/duplicate activity id/);
  });
});

describe('renderRopaMarkdown', () => {
  it('renders a Polish Art. 30 record with RODO references', () => {
    const md = renderRopaMarkdown(buildRopa(parseRopa(base), datamap, { asOf: '2026-11-08' }));
    expect(md).toContain('# Rejestr czynności przetwarzania');
    expect(md).toContain('Stan na dzień: 2026-11-08');
    expect(md).toContain('art. 6 ust. 1 lit. b RODO (wykonanie umowy)');
    expect(md).toContain('Numery identyfikacyjne i dokumentów (PESEL, NIP, dowód osobisty)');
    expect(md).toContain('USA: EU-US Data Privacy Framework');
    expect(md).toContain('## Kwestie do wyjaśnienia przez IOD');
    expect(md).toContain(
      '- encja `logi` zawiera dane osobowe, ale żadna czynność przetwarzania jej nie obejmuje',
    );
    expect(md).toContain('`klienci.pesel`');
  });

  it('renders English and escapes table cells', () => {
    const md = renderRopaMarkdown(
      buildRopa(
        parseRopa({
          ...base,
          language: 'en',
          activities: [{ ...base.activities[0], purposes: ['Billing | invoicing'] }],
        }),
        datamap,
        { asOf: '2026-11-08' },
      ),
    );
    expect(md).toContain('# Record of processing activities');
    expect(md).toContain('Art. 6(1)(b) performance of a contract');
    expect(md).toContain('Billing \\| invoicing');
  });
});

describe('ropaTemplate', () => {
  it('is a valid ROPA file listing every PII entity', () => {
    const parsed = parseRopa(parseYaml(ropaTemplate(datamap, 'pl')));
    expect(parsed.language).toBe('pl');
    expect(parsed.activities[0]?.entities).toEqual(['klienci', 'logi', 'wizyty']);
    expect(buildRopa(parsed, datamap).uncoveredEntities).toEqual([]);
  });
});
