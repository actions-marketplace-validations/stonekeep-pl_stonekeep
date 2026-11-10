import { describe, expect, it } from 'vitest';
import {
  assessCompliance,
  buildRopa,
  complianceCatalog,
  generateDocumentPack,
  parseCompanyProfile,
  profileToRopa,
  type DataMap,
  type DataMapField,
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
    field('users', 'email', 'contact'),
    field('users', 'full_name', 'identity'),
    field('orders', 'shipping_address', 'location'),
    field('invoices', 'billing_name', 'identity'),
    field('subscribers', 'email', 'contact'),
    field('audit_misc', 'ip', 'online_identifier'),
  ],
};

const profile = parseCompanyProfile({
  company: { name: 'Sklep Ceramika', address: 'ul. Lipowa 3, Kraków', email: 'rodo@ceramika.test' },
  activities: ['shop', 'accounts', 'invoices', 'newsletter'],
  services: ['hosting-eu', 'payments', 'mailing', 'accounting'],
  security: ['https', 'backup', '2fa'],
  incidentContact: 'Anna Nowak, +48 600 100 200',
});

describe('profileToRopa', () => {
  const ropa = profileToRopa(profile, datamap);

  it('chooses legal bases and retention from the presets', () => {
    expect(ropa?.activities.map((a) => [a.id, a.legalBasis])).toEqual([
      ['shop', ['contract']],
      ['accounts', ['contract']],
      ['invoices', ['legal_obligation']],
      ['newsletter', ['consent']],
    ]);
    expect(ropa?.controller.name).toBe('Sklep Ceramika');
    expect(ropa?.securityMeasures).toContain('Szyfrowanie transmisji (HTTPS)');
  });

  it('assigns every table with personal data to an activity', () => {
    const byId = Object.fromEntries((ropa?.activities ?? []).map((a) => [a.id, a.entities]));
    expect(byId.shop).toEqual(expect.arrayContaining(['orders']));
    expect(byId.accounts).toEqual(expect.arrayContaining(['users']));
    expect(byId.invoices).toEqual(['invoices']);
    expect(byId.newsletter).toEqual(['subscribers']);
    // Unmatched tables fall back to the first activity, so nothing is left uncovered.
    if (!ropa) throw new Error('expected a record');
    expect(buildRopa(ropa, datamap).uncoveredEntities).toEqual([]);
  });

  it('records non-EU transfers with a safeguard and routes services to activities', () => {
    const newsletter = ropa?.activities.find((a) => a.id === 'newsletter');
    expect(newsletter?.transfers[0]?.country).toBe('USA');
    expect(newsletter?.transfers[0]?.safeguard).toMatch(/Data Privacy Framework/);
    const invoices = ropa?.activities.find((a) => a.id === 'invoices');
    expect(invoices?.recipients).toEqual(
      expect.arrayContaining(['Biuro rachunkowe (podmiot przetwarzający)']),
    );
  });

  it('returns no record until at least one purpose is chosen', () => {
    expect(profileToRopa(parseCompanyProfile({}), datamap)).toBeUndefined();
  });
});

describe('assessCompliance', () => {
  it('starts at zero with an urgent "fill in the profile" item', () => {
    const o = assessCompliance(undefined, datamap, 'pl');
    expect(o.profileStarted).toBe(false);
    expect(o.score.done).toBe(0);
    const first = o.advice[0];
    expect(first?.id).toBe('noRopa');
    expect(first?.link).toBe('/firma');
    expect(first?.action).toContain('Moja firma');
  });

  it('rises as the profile is filled in and explains what is left', () => {
    const o = assessCompliance(profile, datamap, 'pl');
    expect(o.profileStarted).toBe(true);
    expect(o.score).toEqual({ done: 4, total: 6 });
    const ids = o.advice.map((a) => a.id);
    expect(ids).toContain('processors');
    expect(ids).toContain('missingSecurity');
    expect(ids).not.toContain('noRopa');

    const complete = parseCompanyProfile({
      ...profile,
      processorAgreements: true,
      security: ['https', 'backup', '2fa', 'access'],
    });
    const done = assessCompliance(complete, datamap, 'en');
    expect(done.score).toEqual({ done: 6, total: 6 });
    expect(done.advice.map((a) => a.id)).not.toContain('processors');
  });

  it('labels data categories and flags sensitive ones', () => {
    const o = assessCompliance(profile, {
      version: 1,
      fields: [field('u', 'pesel', 'government_id')],
    });
    expect(o.categories[0]).toMatchObject({ category: 'government_id', sensitive: true });
  });
});

describe('catalog and documents', () => {
  it('serves wizard options in both languages', () => {
    expect(complianceCatalog('pl').activities[0]?.label).toContain('Sprzedaję');
    expect(complianceCatalog('en').services.find((s) => s.id === 'analytics')?.outsideEu).toBe(
      true,
    );
  });

  it('fills documents from the profile, including the incident contact and no-DPO line', () => {
    const files = generateDocumentPack({
      ropa: profileToRopa(profile, datamap),
      datamap,
      asOf: '2026-11-09',
      incidentContact: profile.incidentContact,
      noDpo: true,
    });
    const doc = (p: string) => files.find((f) => f.path === p);
    expect(doc('klauzula-informacyjna.md')?.content).toContain('Sklep Ceramika');
    expect(doc('klauzula-informacyjna.md')?.content).toContain(
      'administrator nie wyznaczył inspektora ochrony danych',
    );
    expect(doc('procedura-naruszen.md')?.content).toContain('Anna Nowak, +48 600 100 200');
    expect(doc('procedura-naruszen.md')?.when).toContain('72 godzinach');
  });
});
