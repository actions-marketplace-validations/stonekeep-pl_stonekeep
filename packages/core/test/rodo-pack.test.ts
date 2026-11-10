import { describe, expect, it } from 'vitest';
import {
  LEGAL_SOURCES,
  adviseProject,
  formatArticle,
  art,
  generateDocumentPack,
  parseRopa,
  renderAdviceMarkdown,
  renderAdviceText,
  type DataMap,
  type DataMapField,
  type RopaInput,
} from '../src/index.js';

const field = (entity: string, name: string, category: string, rule = 'test'): DataMapField => ({
  id: `${entity}.${name}`,
  entity,
  field: name,
  category,
  rule,
  confidence: 0.9,
  source: 'sql',
  location: { file: 'schema.sql', line: 1 },
});

const datamap: DataMap = {
  version: 1,
  fields: [
    field('klienci', 'email', 'contact'),
    field('klienci', 'pesel', 'government_id'),
    field('klienci', 'haslo', 'credential'),
    field('klienci', 'password_hash', 'credential'),
    field('klienci', 'data_urodzenia', 'demographic', 'cee-demographic'),
    field('wizyty', 'diagnoza', 'health'),
    field('logi', 'adres_ip', 'online_identifier'),
  ],
};

const ropa: RopaInput = {
  version: 1,
  language: 'pl',
  controller: {
    name: 'Gabinet Przykład',
    address: 'ul. Zdrowa 2, Kraków',
    contact: 'rodo@gabinet.pl',
  },
  securityMeasures: ['Szyfrowanie'],
  activities: [
    {
      id: 'pacjenci',
      name: 'Obsługa pacjentów',
      purposes: ['Udzielanie świadczeń zdrowotnych'],
      legalBasis: ['legal_obligation'],
      dataSubjects: ['Pacjenci'],
      entities: ['klienci', 'wizyty'],
      recipients: ['Dostawca systemu gabinetowego'],
      transfers: [{ country: 'USA' }],
      retention: '20 lat',
    },
    {
      id: 'newsletter',
      name: 'Newsletter',
      purposes: ['Informacje o promocjach'],
      legalBasis: ['consent'],
      dataSubjects: ['Subskrybenci'],
      fields: ['klienci.email'],
      retention: 'TODO: okres',
    },
  ],
};

describe('legal references', () => {
  it('formats GDPR articles in Polish and English', () => {
    expect(formatArticle(art(33, 5), 'pl')).toBe('art. 33 ust. 5 RODO');
    expect(formatArticle(art(6, 1, 'f'), 'pl')).toBe('art. 6 ust. 1 lit. f RODO');
    expect(formatArticle(art(6, 1, 'f'), 'en')).toBe('GDPR Art. 6(1)(f)');
    expect(LEGAL_SOURCES.rodo.url).toContain('CELEX:32016R0679');
    expect(LEGAL_SOURCES.uodoAct.url).toContain('WDU20180001000');
  });
});

describe('adviseProject', () => {
  it('asks for a record of processing when there is none', () => {
    const advice = adviseProject({ datamap, hasCi: false, hasDocuments: false });
    const ids = advice.map((a) => a.id);
    expect(ids[0]).not.toBe(undefined);
    expect(ids).toContain('noRopa');
    expect(ids).toContain('noCi');
    expect(ids).toContain('noDocuments');
    expect(advice.find((a) => a.id === 'noRopa')?.refs).toContain('art. 30 ust. 1 RODO');
  });

  it('finds plaintext passwords, health data, national IDs and transfers, high first', () => {
    const advice = adviseProject({
      datamap,
      ropa: parseRopa(ropa),
      hasCi: true,
      hasDocuments: true,
    });
    const ids = advice.map((a) => a.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'plainPassword',
        'special',
        'specialNoCondition',
        'transfer',
        'nationalId',
        'processors',
        'noDpo',
        'ropaTodo',
        'uncovered',
        'minors',
        'online',
      ]),
    );
    expect(ids).not.toContain('noCi');
    expect(advice.find((a) => a.id === 'plainPassword')?.fields).toEqual(['klienci.haslo']);
    // Most severe first.
    const order = advice.map((a) => a.severity);
    expect(order.indexOf('low')).toBeGreaterThan(order.lastIndexOf('high'));
  });

  it('renders text and markdown with legal sources, in both languages', () => {
    const advice = adviseProject({ datamap, hasCi: false, hasDocuments: false, language: 'en' });
    expect(renderAdviceText(advice, 'en')).toContain('[HIGH]');
    const md = renderAdviceMarkdown(advice, 'pl');
    expect(md).toContain('## Źródła prawa');
    expect(md).toContain(LEGAL_SOURCES.uodo.url);
    expect(renderAdviceText([], 'pl')).toBe('Brak uwag.\n');
  });
});

describe('generateDocumentPack', () => {
  const pack = generateDocumentPack({ ropa: parseRopa(ropa), datamap, asOf: '2026-11-09' });
  const doc = (p: string) => pack.find((f) => f.path === p)?.content ?? '';

  it('produces the full pack with an index', () => {
    expect(pack.map((f) => f.path)).toEqual([
      'README.md',
      'klauzula-informacyjna.md',
      'procedura-wnioskow.md',
      'odpowiedzi/dostep-do-danych.md',
      'odpowiedzi/usuniecie-danych.md',
      'odpowiedzi/przedluzenie-terminu.md',
      'odpowiedzi/odmowa.md',
      'procedura-naruszen.md',
      'rejestr-naruszen.md',
      'upowaznienie-do-przetwarzania.md',
      'umowa-powierzenia-checklista.md',
      'okresy-przechowywania.md',
    ]);
    for (const f of pack) expect(f.content).toContain('Nie stanowi porady prawnej');
    expect(doc('README.md')).toContain('(klauzula-informacyjna.md)');
  });

  it('prefills the information clause from the record', () => {
    const clause = doc('klauzula-informacyjna.md');
    expect(clause).toContain('**Administrator danych:** Gabinet Przykład');
    expect(clause).toContain('art. 6 ust. 1 lit. c RODO (obowiązek prawny)');
    expect(clause).toContain('ul. Stawki 2, 00-193 Warszawa');
    // Consent-based activities mention withdrawing consent, others do not.
    const newsletter = clause.slice(clause.indexOf('## Newsletter'));
    expect(newsletter).toContain('art. 7 ust. 3 RODO');
    expect(clause.slice(0, clause.indexOf('## Newsletter'))).not.toContain('art. 7 ust. 3 RODO');
    // Missing safeguard and TODO retention become fill-in markers.
    expect(clause).toContain('USA (zabezpieczenie: [UZUPEŁNIJ:');
    expect(newsletter).toContain('**Okres przechowywania:** [UZUPEŁNIJ:');
  });

  it('states the legal deadlines and processor duties', () => {
    expect(doc('procedura-wnioskow.md')).toContain('art. 12 ust. 3 RODO');
    expect(doc('procedura-naruszen.md')).toContain('72');
    expect(doc('procedura-naruszen.md')).toContain('art. 33 ust. 3 RODO');
    const dpa = doc('umowa-powierzenia-checklista.md');
    for (const point of ['a)', 'b)', 'c)', 'd)', 'e)', 'f)', 'g)', 'h)']) {
      expect(dpa).toContain(`- [ ] ${point}`);
    }
    expect(dpa).toContain('- [ ] Dostawca systemu gabinetowego');
    expect(doc('upowaznienie-do-przetwarzania.md')).toContain('- Obsługa pacjentów');
  });

  it('still works without a record, with fill-in markers', () => {
    const bare = generateDocumentPack({ datamap, asOf: '2026-11-09' });
    const clause = bare.find((f) => f.path === 'klauzula-informacyjna.md')?.content ?? '';
    expect(clause).toContain('**Administrator danych:** [UZUPEŁNIJ:');
  });
});
