/**
 * "Moja firma": a plain-language company profile for people who do not know RODO.
 * They tick what their app does, which services they use and which safeguards they
 * have; Stonekeep turns that into a record of processing (legal bases and retention
 * chosen from common practice), advice, a progress checklist and documents.
 *
 * The presets are typical starting points for small Polish businesses, not legal
 * advice: every generated document says so and asks the user to review it.
 */
import { z } from 'zod';
import { adviseProject, type Advice } from './advice.js';
import type { LegalLanguage } from './legal.js';
import { SPECIAL_CATEGORIES, parseRopa, type LegalBasis, type RopaConfig } from './ropa.js';
import { dataCategoryLabel } from './ropa-render.js';
import { compareStrings } from './text.js';
import type { DataMap } from './types.js';

type Text = Record<LegalLanguage, string>;

export interface ActivityPreset {
  id: string;
  label: Text;
  help: Text;
  name: string;
  purposes: string[];
  legalBasis: LegalBasis[];
  dataSubjects: string[];
  retention: string;
  /** Datamap entities whose name matches belong to this activity. */
  entityHint: RegExp;
}

export interface ServicePreset {
  id: string;
  label: Text;
  help: Text;
  recipient: string;
  /** Activities this recipient belongs to; '*' for all. */
  activities: string[] | '*';
  transfer?: { country: string; safeguard: string };
}

export interface SecurityPreset {
  id: string;
  label: Text;
  help: Text;
}

export const ACTIVITY_PRESETS: ActivityPreset[] = [
  {
    id: 'shop',
    label: { pl: 'Sprzedaję online (sklep, zamówienia)', en: 'I sell online (shop, orders)' },
    help: {
      pl: 'Zbierasz dane kupujących, żeby zrealizować zamówienie i dostawę.',
      en: 'You collect buyer data to fulfil orders and deliveries.',
    },
    name: 'Sprzedaż online i realizacja zamówień',
    purposes: [
      'Zawarcie i wykonanie umowy sprzedaży, dostawa zamówień',
      'Obsługa reklamacji i zwrotów',
    ],
    legalBasis: ['contract'],
    dataSubjects: ['Klienci'],
    retention: 'Przez czas realizacji umowy, a następnie do upływu terminu przedawnienia roszczeń',
    entityHint: /order|zamow|cart|koszyk|address|adres|shipping|dostaw|product|produkt/,
  },
  {
    id: 'accounts',
    label: { pl: 'Użytkownicy zakładają konto', en: 'Users create an account' },
    help: {
      pl: 'Rejestracja, logowanie, profil użytkownika w Twojej aplikacji.',
      en: 'Sign-up, login and a user profile in your app.',
    },
    name: 'Prowadzenie kont użytkowników',
    purposes: ['Prowadzenie konta użytkownika i świadczenie usługi'],
    legalBasis: ['contract'],
    dataSubjects: ['Użytkownicy'],
    retention: 'Do usunięcia konta, a następnie do upływu terminu przedawnienia roszczeń',
    entityHint: /user|uzytkown|account|konto|konta|profile|profil|login|session|klient|customer/,
  },
  {
    id: 'invoices',
    label: { pl: 'Wystawiam faktury', en: 'I issue invoices' },
    help: {
      pl: 'Faktury i księgowość: tu obowiązek wynika z przepisów podatkowych.',
      en: 'Invoices and accounting: tax law requires this processing.',
    },
    name: 'Faktury i księgowość',
    purposes: ['Wystawianie faktur i prowadzenie księgowości'],
    legalBasis: ['legal_obligation'],
    dataSubjects: ['Klienci', 'Kontrahenci'],
    retention:
      'Przez okres wymagany przepisami podatkowymi (zwykle 5 lat od końca roku, w którym upłynął termin płatności podatku)',
    entityHint: /invoice|faktur|payment|platnos|billing|rachun/,
  },
  {
    id: 'newsletter',
    label: {
      pl: 'Wysyłam newsletter lub e-maile marketingowe',
      en: 'I send a newsletter or marketing e-mails',
    },
    help: {
      pl: 'Potrzebujesz zgody odbiorcy; musi móc ją łatwo wycofać.',
      en: 'You need the recipient’s consent, which must be easy to withdraw.',
    },
    name: 'Newsletter i e-mail marketing',
    purposes: ['Wysyłanie newslettera i informacji handlowych'],
    legalBasis: ['consent'],
    dataSubjects: ['Subskrybenci'],
    retention: 'Do wycofania zgody',
    entityHint: /newsletter|subscri|subskryb|marketing|mailing/,
  },
  {
    id: 'contact',
    label: {
      pl: 'Mam formularz kontaktowy lub obsługę klienta',
      en: 'I have a contact form or customer support',
    },
    help: {
      pl: 'Odpowiadasz na pytania, zgłoszenia, reklamacje.',
      en: 'You answer questions, tickets and complaints.',
    },
    name: 'Obsługa zapytań i zgłoszeń',
    purposes: ['Odpowiedź na zapytania i obsługa zgłoszeń'],
    legalBasis: ['legitimate_interests'],
    dataSubjects: ['Osoby kontaktujące się z firmą'],
    retention: 'Do załatwienia sprawy; sugerujemy usunięcie najpóźniej po 12 miesiącach',
    entityHint: /contact|kontakt|message|wiadom|ticket|zgloszen|support|inquir|zapytan/,
  },
  {
    id: 'analytics',
    label: { pl: 'Zbieram statystyki odwiedzin strony', en: 'I collect website statistics' },
    help: {
      pl: 'Np. Google Analytics. Wymaga zgody w banerze cookies.',
      en: 'E.g. Google Analytics. Needs consent in the cookie banner.',
    },
    name: 'Statystyki i analityka strony',
    purposes: ['Analiza ruchu i ulepszanie serwisu'],
    legalBasis: ['consent'],
    dataSubjects: ['Odwiedzający stronę'],
    retention: 'Do 14 miesięcy (typowe ustawienie narzędzi analitycznych)',
    entityHint: /analytic|event|visit|tracking|pageview|log/,
  },
  {
    id: 'recruitment',
    label: { pl: 'Rekrutuję pracowników', en: 'I recruit employees' },
    help: {
      pl: 'CV i dane kandydatów. Dane ponad wymagane przepisami tylko za zgodą.',
      en: 'CVs and candidate data. Anything beyond what labour law requires needs consent.',
    },
    name: 'Rekrutacja',
    purposes: ['Przeprowadzenie rekrutacji'],
    legalBasis: ['legal_obligation', 'consent'],
    dataSubjects: ['Kandydaci do pracy'],
    retention: 'Do zakończenia rekrutacji; dłużej tylko za zgodą kandydata na przyszłe rekrutacje',
    entityHint: /candidat|kandydat|recruit|rekrut|cv|job|aplikac/,
  },
];

export const SERVICE_PRESETS: ServicePreset[] = [
  {
    id: 'hosting-eu',
    label: {
      pl: 'Hosting lub serwer w UE (np. OVH, home.pl, Hetzner)',
      en: 'Hosting or server in the EU (e.g. OVH, Hetzner)',
    },
    help: {
      pl: 'Firma, na której serwerach są Twoje dane.',
      en: 'The company whose servers hold your data.',
    },
    recipient: 'Dostawca hostingu (podmiot przetwarzający)',
    activities: '*',
  },
  {
    id: 'cloud-us',
    label: {
      pl: 'Chmura spoza UE (np. AWS, Google Cloud, Vercel w USA)',
      en: 'Cloud outside the EU (e.g. AWS, Google Cloud, Vercel in the US)',
    },
    help: {
      pl: 'Dane trafiają poza Europę: dostawca musi mieć odpowiednie zabezpieczenia.',
      en: 'Data leaves Europe: the provider needs proper safeguards.',
    },
    recipient: 'Dostawca usług chmurowych (podmiot przetwarzający)',
    activities: '*',
    transfer: {
      country: 'USA',
      safeguard:
        'EU-US Data Privacy Framework lub standardowe klauzule umowne (sprawdź umowę dostawcy)',
    },
  },
  {
    id: 'payments',
    label: {
      pl: 'Płatności online (np. Przelewy24, PayU, Stripe)',
      en: 'Online payments (e.g. Przelewy24, PayU, Stripe)',
    },
    help: {
      pl: 'Operator obsługuje płatności Twoich klientów.',
      en: 'The operator handles your customers’ payments.',
    },
    recipient: 'Operator płatności',
    activities: ['shop', 'accounts', 'invoices'],
  },
  {
    id: 'courier',
    label: {
      pl: 'Firma kurierska (np. InPost, DPD, Poczta Polska)',
      en: 'Courier (e.g. InPost, DPD)',
    },
    help: {
      pl: 'Przekazujesz adres i telefon do doręczenia.',
      en: 'You pass on address and phone for delivery.',
    },
    recipient: 'Firma kurierska',
    activities: ['shop'],
  },
  {
    id: 'mailing',
    label: {
      pl: 'Wysyłka e-maili (np. Mailchimp, SendGrid, Brevo)',
      en: 'E-mail sending (e.g. Mailchimp, SendGrid, Brevo)',
    },
    help: {
      pl: 'Narzędzie do newslettera lub e-maili transakcyjnych.',
      en: 'A newsletter or transactional e-mail tool.',
    },
    recipient: 'Dostawca usług wysyłki e-mail (podmiot przetwarzający)',
    activities: ['newsletter', 'accounts', 'shop'],
    transfer: {
      country: 'USA',
      safeguard:
        'EU-US Data Privacy Framework lub standardowe klauzule umowne (sprawdź umowę dostawcy)',
    },
  },
  {
    id: 'analytics',
    label: {
      pl: 'Google Analytics lub podobne narzędzie',
      en: 'Google Analytics or a similar tool',
    },
    help: {
      pl: 'Statystyki odwiedzin; dane trafiają do USA.',
      en: 'Visit statistics; data goes to the US.',
    },
    recipient: 'Dostawca narzędzia analitycznego',
    activities: ['analytics'],
    transfer: {
      country: 'USA',
      safeguard: 'EU-US Data Privacy Framework (sprawdź certyfikację dostawcy)',
    },
  },
  {
    id: 'accounting',
    label: { pl: 'Biuro rachunkowe', en: 'Accounting office' },
    help: {
      pl: 'Księgowa lub biuro, które dostaje Twoje faktury.',
      en: 'The accountant who receives your invoices.',
    },
    recipient: 'Biuro rachunkowe (podmiot przetwarzający)',
    activities: ['invoices'],
  },
  {
    id: 'crm',
    label: {
      pl: 'CRM lub helpdesk (np. HubSpot, Freshdesk, LiveChat)',
      en: 'CRM or helpdesk (e.g. HubSpot, Freshdesk, LiveChat)',
    },
    help: { pl: 'Narzędzie do kontaktu z klientami.', en: 'A tool for talking to customers.' },
    recipient: 'Dostawca systemu CRM / helpdesk (podmiot przetwarzający)',
    activities: ['contact', 'accounts'],
  },
];

export const SECURITY_PRESETS: SecurityPreset[] = [
  {
    id: 'https',
    label: {
      pl: 'Strona działa przez HTTPS (kłódka w przeglądarce)',
      en: 'The site uses HTTPS (padlock in the browser)',
    },
    help: {
      pl: 'Szyfruje dane w drodze między użytkownikiem a serwerem.',
      en: 'Encrypts data between the user and the server.',
    },
  },
  {
    id: 'backup',
    label: { pl: 'Robię regularne kopie zapasowe', en: 'I make regular backups' },
    help: {
      pl: 'Chroni przed utratą danych, np. po ataku ransomware.',
      en: 'Protects against data loss, e.g. after ransomware.',
    },
  },
  {
    id: 'encryption',
    label: { pl: 'Baza danych lub dyski są szyfrowane', en: 'The database or disks are encrypted' },
    help: {
      pl: 'Skradziony dysk lub kopia nie ujawnia danych.',
      en: 'A stolen disk or backup does not reveal data.',
    },
  },
  {
    id: '2fa',
    label: {
      pl: 'Logowanie dwuskładnikowe (2FA) do paneli i serwerów',
      en: 'Two-factor login (2FA) to admin panels and servers',
    },
    help: {
      pl: 'Samo hasło nie wystarczy włamywaczowi.',
      en: 'A password alone is not enough for an attacker.',
    },
  },
  {
    id: 'access',
    label: {
      pl: 'Dostęp do danych mają tylko osoby, które go potrzebują',
      en: 'Only people who need it can access the data',
    },
    help: {
      pl: 'Mniej osób z dostępem to mniejsze ryzyko wycieku.',
      en: 'Fewer people with access means less risk.',
    },
  },
  {
    id: 'updates',
    label: {
      pl: 'Aktualizuję oprogramowanie i biblioteki',
      en: 'I keep software and libraries updated',
    },
    help: {
      pl: 'Większość włamań wykorzystuje znane, niezałatane luki.',
      en: 'Most breaches exploit known, unpatched holes.',
    },
  },
  {
    id: 'password-hash',
    label: {
      pl: 'Hasła użytkowników są zapisane jako skrót (np. bcrypt, argon2)',
      en: 'User passwords are stored as hashes (e.g. bcrypt, argon2)',
    },
    help: {
      pl: 'Nawet po wycieku nikt nie odczyta haseł.',
      en: 'Even after a leak nobody can read the passwords.',
    },
  },
];

const SECURITY_PL: Record<string, string> = {
  https: 'Szyfrowanie transmisji (HTTPS)',
  backup: 'Regularne kopie zapasowe',
  encryption: 'Szyfrowanie bazy danych lub dysków',
  '2fa': 'Uwierzytelnianie dwuskładnikowe do paneli administracyjnych i serwerów',
  access: 'Dostęp do danych ograniczony do osób upoważnionych',
  updates: 'Regularne aktualizacje oprogramowania i bibliotek',
  'password-hash': 'Hasła przechowywane wyłącznie jako skrót kryptograficzny',
};

const text = z.string().trim().max(300);

export const companyProfileSchema = z
  .object({
    company: z
      .object({ name: text.default(''), address: text.default(''), email: text.default('') })
      .strict()
      .default({}),
    dpo: z
      .object({
        mode: z.enum(['none', 'appointed']).default('none'),
        name: text.optional(),
        email: text.optional(),
      })
      .strict()
      .default({}),
    incidentContact: text.default(''),
    activities: z.array(z.string().max(40)).max(20).default([]),
    services: z.array(z.string().max(40)).max(20).default([]),
    processorAgreements: z.boolean().default(false),
    security: z.array(z.string().max(40)).max(20).default([]),
  })
  .strict();

export type CompanyProfileInput = z.input<typeof companyProfileSchema>;
export type CompanyProfile = z.output<typeof companyProfileSchema>;

export function parseCompanyProfile(raw: unknown): CompanyProfile {
  return companyProfileSchema.parse(raw);
}

/** Build a record of processing from the profile, assigning data-map tables to activities. */
export function profileToRopa(profile: CompanyProfile, datamap: DataMap): RopaConfig | undefined {
  const presets = ACTIVITY_PRESETS.filter((p) => profile.activities.includes(p.id));
  if (presets.length === 0) return undefined;
  const services = SERVICE_PRESETS.filter((s) => profile.services.includes(s.id));
  const entities = [...new Set(datamap.fields.map((f) => f.entity))].sort(compareStrings);

  // Each PII table goes to the first activity whose hint matches; the rest to the first activity.
  const assigned = new Map<string, string[]>(presets.map((p) => [p.id, []]));
  for (const entity of entities) {
    const name = entity.toLowerCase();
    const hit = presets.find((p) => p.entityHint.test(name)) ?? presets[0];
    if (hit) assigned.get(hit.id)?.push(entity);
  }

  const raw = {
    version: 1,
    language: 'pl',
    controller: {
      name: profile.company.name || 'TODO: nazwa firmy',
      ...(profile.company.address ? { address: profile.company.address } : {}),
      contact: profile.company.email || 'TODO: e-mail kontaktowy',
    },
    ...(profile.dpo.mode === 'appointed' && profile.dpo.name
      ? { dpo: { name: profile.dpo.name, contact: profile.dpo.email || 'TODO: kontakt do IOD' } }
      : {}),
    securityMeasures: profile.security.map((s) => SECURITY_PL[s]).filter((s): s is string => !!s),
    activities: presets.map((p) => {
      const mine = services.filter(
        (s) =>
          s.activities === '*' ||
          s.activities.includes(p.id) ||
          // A service whose activities were not selected still has to appear somewhere.
          (p === presets[0] && !s.activities.some((a) => profile.activities.includes(a))),
      );
      const transfers = mine.flatMap((s) => (s.transfer ? [s.transfer] : []));
      return {
        id: p.id,
        name: p.name,
        purposes: p.purposes,
        legalBasis: p.legalBasis,
        dataSubjects: p.dataSubjects,
        entities: assigned.get(p.id) ?? [],
        recipients: [...new Set(mine.map((s) => s.recipient))],
        transfers: [...new Map(transfers.map((t) => [t.country + t.safeguard, t])).values()],
        retention: p.retention,
      };
    }),
  };
  return parseRopa(raw, 'company profile');
}

export interface ChecklistItem {
  id: string;
  done: boolean;
  title: string;
  hint: string;
  /** Console route that fixes it. */
  link: string;
}

export interface ComplianceOverview {
  profileStarted: boolean;
  score: { done: number; total: number };
  checklist: ChecklistItem[];
  advice: (Advice & { link?: string })[];
  categories: { category: string; label: string; count: number; sensitive: boolean }[];
  fields: number;
}

const SENSITIVE = new Set(['government_id', 'financial', 'credential', ...SPECIAL_CATEGORIES]);

const CHECK_TEXT: Record<LegalLanguage, Record<string, [string, string]>> = {
  pl: {
    company: ['Dane firmy', 'Kto odpowiada za dane: nazwa i kontakt pojawią się w dokumentach.'],
    purposes: [
      'Cele przetwarzania',
      'Do czego używasz danych. Na tej podstawie dobieramy podstawy prawne.',
    ],
    services: [
      'Usługi zewnętrzne i umowy',
      'Z kim dzielisz dane i czy masz z nimi umowy powierzenia.',
    ],
    security: ['Zabezpieczenia', 'Minimum: HTTPS, kopie zapasowe, 2FA, ograniczony dostęp.'],
    incident: ['Osoba od incydentów', 'Kto działa, gdy dojdzie do wycieku: liczy się 72 godziny.'],
    urgent: ['Brak pilnych problemów', 'Żadnej porady o wysokim priorytecie.'],
  },
  en: {
    company: ['Company details', 'Who is responsible for the data: shown in your documents.'],
    purposes: ['Purposes', 'What you use data for. Legal bases are chosen from this.'],
    services: [
      'Third-party services and agreements',
      'Who you share data with and whether you have processing agreements.',
    ],
    security: ['Security', 'Minimum: HTTPS, backups, 2FA, limited access.'],
    incident: ['Incident contact', 'Who acts if data leaks: you have 72 hours.'],
    urgent: ['No urgent problems', 'No high-priority advice.'],
  },
};

const CONSOLE_ACTION: Record<LegalLanguage, Record<string, { action: string; link?: string }>> = {
  pl: {
    noRopa: {
      action:
        'Wypełnij „Moja firma” (ok. 3 minuty): na tej podstawie Stonekeep przygotuje rejestr i dokumenty.',
      link: '/firma',
    },
    ropaTodo: { action: 'Uzupełnij brakujące pola w „Moja firma”.', link: '/firma' },
    uncovered: { action: 'Zaznacz w „Moja firma”, do czego służą te dane.', link: '/firma' },
    noSecurity: {
      action: 'Zaznacz w „Moja firma”, jakie zabezpieczenia stosujesz.',
      link: '/firma',
    },
    processors: {
      action:
        'Pobierz listę kontrolną umowy powierzenia, sprawdź umowy z dostawcami i zaznacz to w „Moja firma”.',
      link: '/dokumenty',
    },
    noDpo: {
      action:
        'Większość małych firm nie musi mieć IOD. Jeśli przetwarzasz dane o zdrowiu na dużą skalę, skonsultuj to z prawnikiem i zaznacz w „Moja firma”.',
      link: '/firma',
    },
    specialNoCondition: {
      action:
        'Skonsultuj z prawnikiem lub IOD, na jakiej podstawie przetwarzasz dane o zdrowiu lub inne szczególne dane.',
    },
    transfer: {
      action:
        'Sprawdź w umowie z dostawcą spoza UE, że ma certyfikat Data Privacy Framework albo standardowe klauzule umowne.',
    },
    nationalId: {
      action:
        'Poproś programistę, żeby sprawdził, czy PESEL jest naprawdę potrzebny, i zaszyfrował tę kolumnę.',
    },
    plainPassword: {
      action:
        'Pilnie poproś programistę, żeby przechowywał hasła jako skrót (bcrypt lub argon2) i wymusił zmianę haseł.',
    },
    financial: {
      action:
        'Poproś programistę o szyfrowanie tej kolumny. Płatności kartą zostaw operatorowi płatności.',
    },
  },
  en: {
    noRopa: {
      action:
        'Fill in “My company” (about 3 minutes): Stonekeep builds your record and documents from it.',
      link: '/firma',
    },
    ropaTodo: { action: 'Complete the missing fields in “My company”.', link: '/firma' },
    uncovered: { action: 'Tick in “My company” what this data is used for.', link: '/firma' },
    noSecurity: { action: 'Tick in “My company” which safeguards you use.', link: '/firma' },
    processors: {
      action:
        'Download the processing-agreement checklist, review your contracts and tick it in “My company”.',
      link: '/dokumenty',
    },
    noDpo: {
      action:
        'Most small companies do not need a DPO. If you process health data on a large scale, ask a lawyer and record it in “My company”.',
      link: '/firma',
    },
    specialNoCondition: {
      action:
        'Ask a lawyer or DPO which legal condition covers the health or other special-category data.',
    },
    transfer: {
      action:
        'Check the non-EU provider’s contract for Data Privacy Framework certification or standard contractual clauses.',
    },
    nationalId: {
      action: 'Ask your developer whether PESEL is really needed and to encrypt that column.',
    },
    plainPassword: {
      action:
        'Urgently ask your developer to store passwords as hashes (bcrypt or argon2) and force a password reset.',
    },
    financial: {
      action:
        'Ask your developer to encrypt this column. Leave card payments to the payment operator.',
    },
  },
};

const MISSING_SECURITY: Record<
  LegalLanguage,
  { title: string; why: (list: string) => string; action: string }
> = {
  pl: {
    title: 'Brakuje podstawowych zabezpieczeń',
    why: (list) =>
      `Nie zaznaczono: ${list}. RODO wymaga zabezpieczeń odpowiednich do ryzyka, a te są tanie i chronią przed najczęstszymi wyciekami.`,
    action:
      'Wprowadź brakujące zabezpieczenia (albo poproś o to programistę) i zaznacz je w „Moja firma”.',
  },
  en: {
    title: 'Basic safeguards are missing',
    why: (list) =>
      `Not ticked: ${list}. GDPR requires safeguards appropriate to the risk; these are cheap and stop the most common leaks.`,
    action:
      'Put the missing safeguards in place (or ask your developer) and tick them in “My company”.',
  },
};

/** Everything the console's "Pulpit RODO" shows, computed from the profile and the data map. */
export function assessCompliance(
  profile: CompanyProfile | undefined,
  datamap: DataMap,
  lang: LegalLanguage = 'pl',
): ComplianceOverview {
  const p = profile ?? parseCompanyProfile({});
  const ropa = profileToRopa(p, datamap);
  const raw = adviseProject({ datamap, ropa, hasCi: true, hasDocuments: true, language: lang });
  const advice: ComplianceOverview['advice'] = raw
    .filter((a) => !(a.id === 'processors' && p.processorAgreements))
    .map((a) => {
      const c = CONSOLE_ACTION[lang][a.id];
      return c ? { ...a, action: c.action, ...(c.link ? { link: c.link } : {}) } : a;
    });

  const essentials = ['https', 'backup', '2fa', 'access'];
  const missing = SECURITY_PRESETS.filter(
    (s) => essentials.includes(s.id) && !p.security.includes(s.id),
  );
  if (ropa && missing.length > 0 && p.security.length > 0) {
    const t = MISSING_SECURITY[lang];
    advice.push({
      id: 'missingSecurity',
      severity: 'medium',
      title: t.title,
      why: t.why(missing.map((s) => s.label[lang]).join('; ')),
      action: t.action,
      refs: [lang === 'pl' ? 'art. 32 RODO' : 'GDPR Art. 32'],
      link: '/firma',
    });
  }
  const order = { high: 0, medium: 1, low: 2 } as const;
  advice.sort((a, b) => order[a.severity] - order[b.severity]);

  const t = CHECK_TEXT[lang];
  const item = (id: string, done: boolean, link = '/firma'): ChecklistItem => ({
    id,
    done,
    title: t[id]?.[0] ?? id,
    hint: t[id]?.[1] ?? '',
    link,
  });
  const checklist = [
    item('company', !!(p.company.name && p.company.email)),
    item('purposes', p.activities.length > 0),
    item('services', p.services.length > 0 && p.processorAgreements),
    item(
      'security',
      essentials.every((s) => p.security.includes(s)),
    ),
    item('incident', p.incidentContact.length > 0),
    item('urgent', !advice.some((a) => a.severity === 'high'), '/porady'),
  ];

  const counts = new Map<string, number>();
  for (const f of datamap.fields) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  const categories = [...counts.entries()]
    .map(([category, count]) => ({
      category,
      label: dataCategoryLabel(lang, category),
      count,
      sensitive: SENSITIVE.has(category),
    }))
    .sort((a, b) => Number(b.sensitive) - Number(a.sensitive) || b.count - a.count);

  return {
    profileStarted: profile !== undefined,
    score: { done: checklist.filter((c) => c.done).length, total: checklist.length },
    checklist,
    advice,
    categories,
    fields: datamap.fields.length,
  };
}

/** Wizard options for the console, in the viewer's language. */
export function complianceCatalog(lang: LegalLanguage = 'pl') {
  const pick = (x: { id: string; label: Text; help: Text }) => ({
    id: x.id,
    label: x.label[lang],
    help: x.help[lang],
  });
  return {
    activities: ACTIVITY_PRESETS.map(pick),
    services: SERVICE_PRESETS.map((s) => ({ ...pick(s), outsideEu: s.transfer !== undefined })),
    security: SECURITY_PRESETS.map(pick),
  };
}
