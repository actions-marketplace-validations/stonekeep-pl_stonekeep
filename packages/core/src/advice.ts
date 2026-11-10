/**
 * Project-specific RODO advice for small teams: what the data map and the record of
 * processing say about the project, what to do next, and which articles apply.
 * Advice is a checklist for a human, not a legal opinion.
 */
import {
  LEGAL_SOURCES,
  art,
  formatArticle,
  formatRecital,
  RODO_FACTS,
  type ArticleRef,
  type LegalLanguage,
} from './legal.js';
import { buildRopa, SPECIAL_CATEGORIES, type RopaConfig } from './ropa.js';
import type { DataMap } from './types.js';

export type AdviceSeverity = 'high' | 'medium' | 'low';

export interface Advice {
  id: string;
  severity: AdviceSeverity;
  title: string;
  why: string;
  action: string;
  /** Article references, already formatted ("art. 30 RODO"). */
  refs: string[];
  /** Data map field ids the advice is about, if any. */
  fields?: string[];
}

export interface AdviceInput {
  datamap: DataMap;
  /** Parsed record of processing, if the project has one. */
  ropa?: RopaConfig | undefined;
  /** True when a Stonekeep CI check is configured (GitHub workflow or GitLab job). */
  hasCi: boolean;
  /** True when the document pack (`stonekeep dokumenty`) exists. */
  hasDocuments: boolean;
  language?: LegalLanguage;
}

const PLAINTEXT_PASSWORD = /(^|_)(password|passwd|pwd|haslo|parola|jelszo)$/;
const HASHED = /(hash|digest|bcrypt|argon|scrypt|encrypted|enc)/;

interface Texts {
  title: string;
  why: string;
  action: string;
}

type Catalog = Record<string, (arg: string) => Texts>;

const PL: Catalog = {
  noRopa: () => ({
    title: 'Brak rejestru czynności przetwarzania',
    why: `Administrator prowadzi rejestr czynności przetwarzania. Zwolnienie dla firm poniżej ${RODO_FACTS.ropaExemptionEmployees} pracowników nie obejmuje przetwarzania, które nie ma charakteru sporadycznego, więc w praktyce dotyczy prawie każdej aplikacji.`,
    action:
      'Utwórz szablon: stonekeep ropa --init --lang pl, uzupełnij go i wygeneruj rejestr: stonekeep ropa -o rejestr.md',
  }),
  ropaTodo: (n) => ({
    title: 'Rejestr zawiera nieuzupełnione pola (TODO)',
    why: `Pozycji do uzupełnienia: ${n}. Rejestr musi wskazywać m.in. cele, kategorie osób i planowane terminy usunięcia danych.`,
    action: 'Uzupełnij wszystkie wartości TODO w stonekeep.ropa.yaml.',
  }),
  uncovered: (list) => ({
    title: 'Dane osobowe poza rejestrem',
    why: `Tabele z danymi osobowymi, których nie obejmuje żadna czynność przetwarzania: ${list}. Każde przetwarzanie musi mieć cel i podstawę prawną.`,
    action:
      'Dopisz te tabele do odpowiednich czynności (entities) w stonekeep.ropa.yaml albo usuń zbędne dane.',
  }),
  specialNoCondition: (list) => ({
    title: 'Dane szczególnych kategorii bez przesłanki z art. 9',
    why: `Czynności: ${list}. Przetwarzanie danych o zdrowiu i innych szczególnych kategorii jest co do zasady zakazane, chyba że zachodzi jedna z przesłanek z art. 9 ust. 2.`,
    action:
      'Wskaż specialCategoryConditions w stonekeep.ropa.yaml i sprawdź, czy potrzebna jest ocena skutków (DPIA).',
  }),
  transfer: (list) => ({
    title: 'Przekazanie danych poza EOG bez zabezpieczenia',
    why: `Przekazania bez wskazanego mechanizmu: ${list}. Przekazanie do państwa trzeciego wymaga np. decyzji stwierdzającej odpowiedni stopień ochrony albo standardowych klauzul umownych.`,
    action:
      'Uzupełnij pole safeguard (np. "EU-US Data Privacy Framework" lub "SCC 2021/914") i sprawdź umowę z dostawcą.',
  }),
  noSecurity: () => ({
    title: 'Brak opisu środków bezpieczeństwa',
    why: 'Rejestr powinien zawierać ogólny opis technicznych i organizacyjnych środków bezpieczeństwa, a administrator musi je faktycznie stosować.',
    action:
      'Dodaj securityMeasures do stonekeep.ropa.yaml (np. szyfrowanie, kopie zapasowe, kontrola dostępu, logowanie dostępu).',
  }),
  nationalId: (list) => ({
    title: 'Przechowujesz numery identyfikacyjne (PESEL, NIP, dowód)',
    why: `Pola: ${list}. Numer PESEL jednoznacznie identyfikuje osobę i ułatwia kradzież tożsamości. Zbieraj go tylko wtedy, gdy wymaga tego przepis lub umowa (zasada minimalizacji).`,
    action:
      'Sprawdź, czy PESEL jest niezbędny; jeśli tak, szyfruj kolumnę, nie wypisuj jej w logach i maskuj w środowisku testowym (stonekeep mask).',
  }),
  plainPassword: (list) => ({
    title: 'Kolumna wygląda na hasło w postaci jawnej',
    why: `Pola: ${list}. Hasła muszą być przechowywane wyłącznie jako skrót (np. argon2id lub bcrypt). Wyciek jawnych haseł to naruszenie wysokiego ryzyka.`,
    action:
      'Zmień kolumnę na skrót hasła (np. password_hash z argon2id) i wymuś zmianę haseł, jeśli jawne hasła były kiedykolwiek zapisane.',
  }),
  special: (list) => ({
    title: 'Przetwarzasz dane o zdrowiu lub inne szczególne kategorie',
    why: `Pola: ${list}. Wymagają przesłanki z art. 9 ust. 2, zwykle oceny skutków (DPIA) i mogą wymagać wyznaczenia inspektora ochrony danych, jeśli przetwarzanie odbywa się na dużą skalę.`,
    action:
      'Sprawdź wykaz operacji wymagających DPIA opublikowany przez Prezesa UODO, ogranicz dostęp do tych kolumn i rozważ wyznaczenie IOD.',
  }),
  financial: (list) => ({
    title: 'Przechowujesz dane finansowe',
    why: `Pola: ${list}. Ich wyciek grozi oszustwami finansowymi, więc wymaga silniejszych zabezpieczeń. Danych kart płatniczych dotyczy też standard branżowy PCI DSS.`,
    action:
      'Nie przechowuj pełnych numerów kart (użyj dostawcy płatności i tokenów), szyfruj numery rachunków i ogranicz dostęp.',
  }),
  minors: (list) => ({
    title: 'Data urodzenia: sprawdź, czy usługa jest dla dzieci',
    why: `Pola: ${list}. Jeśli oferujesz usługi online dzieciom i opierasz się na zgodzie, w Polsce zgodę za dziecko poniżej ${RODO_FACTS.childConsentAgePL} lat wyraża rodzic lub opiekun.`,
    action:
      'Jeśli potrzebujesz tylko pełnoletności, przechowuj informację "18+" zamiast pełnej daty urodzenia.',
  }),
  online: (list) => ({
    title: 'Adresy IP i identyfikatory urządzeń to dane osobowe',
    why: `Pola: ${list}. Identyfikatory internetowe mogą pozwolić zidentyfikować osobę. Pliki cookies i podobne technologie (poza niezbędnymi do działania usługi) wymagają też zgody na podstawie art. 399 Prawa komunikacji elektronicznej.`,
    action:
      'Określ okres przechowywania logów z adresami IP (np. 30–90 dni) i sprawdź baner cookies.',
  }),
  processors: (list) => ({
    title: 'Odbiorcy danych: potrzebne umowy powierzenia',
    why: `Odbiorcy w rejestrze: ${list}. Z każdym podmiotem przetwarzającym (hosting, mailing, księgowość, CRM) musisz mieć umowę powierzenia z elementami z art. 28 ust. 3.`,
    action:
      'Sprawdź umowy według listy kontrolnej: stonekeep dokumenty (plik umowa-powierzenia-checklista.md).',
  }),
  noDpo: () => ({
    title: 'Rozważ wyznaczenie inspektora ochrony danych (IOD)',
    why: 'Projekt przetwarza dane szczególnych kategorii, a rejestr nie wskazuje IOD. Wyznaczenie IOD jest obowiązkowe m.in. przy przetwarzaniu takich danych na dużą skalę jako głównej działalności.',
    action: `Oceń skalę przetwarzania; jeśli IOD jest wymagany, wyznacz go, zawiadom Prezesa UODO w ciągu ${RODO_FACTS.dpoNotifyDays} dni (art. 10 ustawy o ochronie danych osobowych, formularz elektroniczny) i dodaj sekcję dpo w stonekeep.ropa.yaml.`,
  }),
  noCi: () => ({
    title: 'Brak automatycznej kontroli w CI',
    why: 'Bez kontroli w CI nowe kolumny z danymi osobowymi trafiają do produkcji bez przeglądu, a mapa danych i rejestr przestają być aktualne.',
    action:
      'Dodaj workflow: stonekeep init --ci github (albo zadanie GitLab z stonekeep init --ci gitlab).',
  }),
  noDocuments: () => ({
    title: 'Przygotuj pakiet dokumentów RODO',
    why: 'Mała firma też potrzebuje klauzuli informacyjnej, procedury obsługi wniosków i procedury naruszeń. Organ sprawdza, czy umiesz je pokazać.',
    action: 'Wygeneruj wzory uzupełnione danymi z rejestru: stonekeep dokumenty',
  }),
};

const EN: Catalog = {
  noRopa: () => ({
    title: 'No record of processing activities',
    why: `Controllers keep a record of processing. The exemption for companies under ${RODO_FACTS.ropaExemptionEmployees} employees does not cover processing that is not occasional, so in practice it rarely applies to an application.`,
    action:
      'Create the template with stonekeep ropa --init, fill it in, then run stonekeep ropa -o ropa.md',
  }),
  ropaTodo: (n) => ({
    title: 'The record still contains TODO values',
    why: `Items to complete: ${n}. The record must state purposes, categories of data subjects and erasure time limits, among others.`,
    action: 'Replace every TODO in stonekeep.ropa.yaml.',
  }),
  uncovered: (list) => ({
    title: 'Personal data outside the record',
    why: `Tables with personal data that no processing activity covers: ${list}. Every processing operation needs a purpose and a legal basis.`,
    action:
      'Add these tables to the right activities (entities) in stonekeep.ropa.yaml, or delete data you do not need.',
  }),
  specialNoCondition: (list) => ({
    title: 'Special-category data without an Art. 9 condition',
    why: `Activities: ${list}. Processing health and other special-category data is prohibited unless an Art. 9(2) condition applies.`,
    action:
      'Set specialCategoryConditions in stonekeep.ropa.yaml and check whether a DPIA is required.',
  }),
  transfer: (list) => ({
    title: 'Transfer outside the EEA without a safeguard',
    why: `Transfers without a mechanism: ${list}. A third-country transfer needs e.g. an adequacy decision or standard contractual clauses.`,
    action:
      'Fill in safeguard (e.g. "EU-US Data Privacy Framework" or "SCC 2021/914") and check the provider contract.',
  }),
  noSecurity: () => ({
    title: 'No security measures described',
    why: 'The record should describe technical and organisational security measures, and the controller must actually apply them.',
    action:
      'Add securityMeasures to stonekeep.ropa.yaml (e.g. encryption, backups, access control, access logging).',
  }),
  nationalId: (list) => ({
    title: 'You store national ID numbers (PESEL, NIP, ID card)',
    why: `Fields: ${list}. A PESEL number uniquely identifies a person and enables identity theft. Collect it only when a law or contract requires it (data minimisation).`,
    action:
      'Check whether PESEL is necessary; if so, encrypt the column, keep it out of logs and mask it in staging (stonekeep mask).',
  }),
  plainPassword: (list) => ({
    title: 'A column looks like a plaintext password',
    why: `Fields: ${list}. Passwords must be stored only as a hash (e.g. argon2id or bcrypt). Leaking plaintext passwords is a high-risk breach.`,
    action:
      'Store a password hash instead (e.g. password_hash with argon2id) and force a reset if plaintext passwords were ever stored.',
  }),
  special: (list) => ({
    title: 'You process health or other special-category data',
    why: `Fields: ${list}. This needs an Art. 9(2) condition, usually a DPIA, and may require a DPO if processed on a large scale.`,
    action:
      'Check the UODO list of operations requiring a DPIA, restrict access to these columns and consider appointing a DPO.',
  }),
  financial: (list) => ({
    title: 'You store financial data',
    why: `Fields: ${list}. A leak enables financial fraud, so stronger safeguards are expected. Card data is also covered by the PCI DSS industry standard.`,
    action:
      'Do not store full card numbers (use a payment provider and tokens); encrypt account numbers and restrict access.',
  }),
  minors: (list) => ({
    title: 'Date of birth: check whether the service targets children',
    why: `Fields: ${list}. For online services offered to children and based on consent, in Poland a parent or guardian consents for a child under ${RODO_FACTS.childConsentAgePL}.`,
    action:
      'If you only need to know a user is an adult, store an "18+" flag instead of the full date of birth.',
  }),
  online: (list) => ({
    title: 'IP addresses and device identifiers are personal data',
    why: `Fields: ${list}. Online identifiers can identify a person. Cookies and similar technologies (other than strictly necessary ones) also need consent under Art. 399 of the Polish Electronic Communications Law.`,
    action:
      'Set a retention period for logs with IP addresses (e.g. 30–90 days) and review the cookie banner.',
  }),
  processors: (list) => ({
    title: 'Recipients: data processing agreements needed',
    why: `Recipients in the record: ${list}. Every processor (hosting, mailing, accounting, CRM) needs an agreement with the Art. 28(3) elements.`,
    action:
      'Review agreements with the checklist from stonekeep dokumenty (umowa-powierzenia-checklista.md).',
  }),
  noDpo: () => ({
    title: 'Consider appointing a data protection officer (DPO)',
    why: 'The project processes special-category data and the record names no DPO. A DPO is mandatory, among others, when such data is processed on a large scale as a core activity.',
    action: `Assess the scale; if a DPO is required, appoint one, notify UODO within ${RODO_FACTS.dpoNotifyDays} days (Art. 10 of the Polish Data Protection Act, electronic form) and add the dpo section to stonekeep.ropa.yaml.`,
  }),
  noCi: () => ({
    title: 'No automated check in CI',
    why: 'Without a CI check new personal-data columns reach production unreviewed, and the data map and record go stale.',
    action:
      'Add the workflow: stonekeep init --ci github (or a GitLab job with stonekeep init --ci gitlab).',
  }),
  noDocuments: () => ({
    title: 'Prepare a RODO document pack',
    why: 'Small companies also need an information notice, a data subject request procedure and a breach procedure. The supervisor checks that you can produce them.',
    action: 'Generate templates prefilled from the record: stonekeep dokumenty',
  }),
};

const REFS: Record<string, (lang: LegalLanguage) => string[]> = {
  noRopa: (l) => [formatArticle(art(30, 1), l), formatArticle(art(30, 5), l)],
  ropaTodo: (l) => [formatArticle(art(30, 1), l)],
  uncovered: (l) => [
    formatArticle(art(5, 1, 'a'), l),
    formatArticle(art(6, 1), l),
    formatArticle(art(30, 1), l),
  ],
  specialNoCondition: (l) => [formatArticle(art(9, 2), l), formatArticle(art(35), l)],
  transfer: (l) => [
    formatArticle(art(44), l),
    formatArticle(art(45), l),
    formatArticle(art(46), l),
  ],
  noSecurity: (l) => [formatArticle(art(30, 1, 'g'), l), formatArticle(art(32), l)],
  nationalId: (l) => [
    formatArticle(art(5, 1, 'c'), l),
    formatArticle(art(32), l),
    formatArticle(art(87), l),
  ],
  plainPassword: (l) => [formatArticle(art(32, 1), l), formatArticle(art(34), l)],
  special: (l) => [
    formatArticle(art(9), l),
    formatArticle(art(35), l),
    formatArticle(art(37, 1), l),
  ],
  financial: (l) => [formatArticle(art(32), l)],
  minors: (l) => [formatArticle(art(8, 1), l), formatArticle(art(5, 1, 'c'), l)],
  online: (l) => [formatRecital(30, l), formatArticle(art(5, 1, 'e'), l)],
  processors: (l) => [formatArticle(art(28, 3), l)],
  noDpo: (l) => [formatArticle(art(37, 1), l), formatArticle(art(37, 7), l)],
  noCi: (l) => [formatArticle(art(25, 1), l)],
  noDocuments: (l) => [
    formatArticle(art(5, 2), l),
    formatArticle(art(13), l),
    formatArticle(art(12, 3), l),
    formatArticle(art(33, 5), l),
  ],
};

const SEVERITY_ORDER: Record<AdviceSeverity, number> = { high: 0, medium: 1, low: 2 };

function countTodos(value: unknown): number {
  if (typeof value === 'string') return value.trim().startsWith('TODO') ? 1 : 0;
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countTodos(v), 0);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce<number>((n, v) => n + countTodos(v), 0);
  }
  return 0;
}

const short = (ids: string[], max = 5) =>
  ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')} (+${ids.length - max})`;

/** Advice for one project, most severe first. */
export function adviseProject(input: AdviceInput): Advice[] {
  const lang = input.language ?? 'pl';
  const texts = lang === 'pl' ? PL : EN;
  const out: Advice[] = [];
  const add = (id: string, severity: AdviceSeverity, arg = '', fields?: string[]) => {
    const t = texts[id]?.(arg);
    if (!t) return;
    out.push({
      id,
      severity,
      ...t,
      refs: REFS[id]?.(lang) ?? [],
      ...(fields && fields.length > 0 ? { fields } : {}),
    });
  };

  const fields = input.datamap.fields;
  const byCategory = (c: string) => fields.filter((f) => f.category === c).map((f) => f.id);

  // Record of processing
  if (!input.ropa) {
    if (fields.length > 0) add('noRopa', 'high');
  } else {
    const todos = countTodos(input.ropa);
    if (todos > 0) add('ropaTodo', 'medium', String(todos));
    const record = buildRopa(input.ropa, input.datamap);
    if (record.uncoveredEntities.length > 0) {
      add('uncovered', 'medium', short(record.uncoveredEntities));
    }
    const noCondition = record.issues
      .filter((i) => i.code === 'missing-special-category-condition')
      .map((i) => i.activity ?? '');
    if (noCondition.length > 0) add('specialNoCondition', 'high', short(noCondition));
    const transfers = record.issues
      .filter((i) => i.code === 'transfer-without-safeguard')
      .map((i) => `${i.subject ?? ''} (${i.activity ?? ''})`);
    if (transfers.length > 0) add('transfer', 'high', short(transfers));
    if (record.issues.some((i) => i.code === 'no-security-measures')) add('noSecurity', 'medium');
    const recipients = [...new Set(input.ropa.activities.flatMap((a) => a.recipients))].filter(
      (r) => !r.startsWith('TODO'),
    );
    if (recipients.length > 0) add('processors', 'medium', short(recipients, 4));
    const special = fields.some((f) => SPECIAL_CATEGORIES.has(f.category));
    if (special && !input.ropa.dpo) add('noDpo', 'medium');
  }

  // What the data itself says
  const passwords = fields
    .filter((f) => f.category === 'credential')
    .filter((f) => {
      const name = f.field.split('.').pop()?.toLowerCase() ?? '';
      return PLAINTEXT_PASSWORD.test(name) && !HASHED.test(name);
    })
    .map((f) => f.id);
  if (passwords.length > 0) add('plainPassword', 'high', short(passwords), passwords);

  const special = fields.filter((f) => SPECIAL_CATEGORIES.has(f.category)).map((f) => f.id);
  if (special.length > 0) add('special', 'high', short(special), special);

  const ids = byCategory('government_id');
  if (ids.length > 0) add('nationalId', 'medium', short(ids), ids);

  const fin = byCategory('financial');
  if (fin.length > 0) add('financial', 'medium', short(fin), fin);

  const dob = fields
    .filter(
      (f) =>
        f.rule.includes('date-of-birth') ||
        /urodzen|birth|dob|nasterii|szuletesi/.test(f.field.toLowerCase()),
    )
    .map((f) => f.id);
  if (dob.length > 0) add('minors', 'low', short(dob), dob);

  const online = byCategory('online_identifier');
  if (online.length > 0) add('online', 'low', short(online), online);

  // Process
  if (!input.hasCi && fields.length > 0) add('noCi', 'low');
  if (!input.hasDocuments && fields.length > 0) add('noDocuments', 'low');

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

const SEVERITY_LABEL: Record<LegalLanguage, Record<AdviceSeverity, string>> = {
  pl: { high: 'WYSOKI', medium: 'ŚREDNI', low: 'NISKI' },
  en: { high: 'HIGH', medium: 'MEDIUM', low: 'LOW' },
};

/** Markdown report with links to the official legal sources. */
export function renderAdviceMarkdown(
  advice: readonly Advice[],
  lang: LegalLanguage = 'pl',
): string {
  const pl = lang === 'pl';
  const out: string[] = [
    pl ? '# Porady RODO dla projektu' : '# GDPR advice for the project',
    '',
    pl
      ? '> Lista kontrolna wygenerowana przez Stonekeep na podstawie mapy danych i rejestru. Nie stanowi porady prawnej.'
      : '> Checklist generated by Stonekeep from the data map and the record of processing. Not legal advice.',
    '',
  ];
  if (advice.length === 0) {
    out.push(
      pl
        ? 'Brak uwag. Przejrzyj wynik ręcznie co jakiś czas.'
        : 'Nothing to report. Review by hand from time to time.',
      '',
    );
  }
  advice.forEach((a, i) => {
    out.push(
      `## ${i + 1}. [${SEVERITY_LABEL[lang][a.severity]}] ${a.title}`,
      '',
      a.why,
      '',
      `**${pl ? 'Co zrobić' : 'What to do'}:** ${a.action}`,
      '',
      `${pl ? 'Podstawa' : 'Reference'}: ${a.refs.join(', ')}`,
      '',
    );
  });
  out.push(`## ${pl ? 'Źródła prawa' : 'Legal sources'}`, '');
  for (const s of Object.values(LEGAL_SOURCES)) out.push(`- [${s.title[lang]}](${s.url})`);
  return `${out.join('\n').trimEnd()}\n`;
}

/** Plain-text report for the terminal. */
export function renderAdviceText(advice: readonly Advice[], lang: LegalLanguage = 'pl'): string {
  const pl = lang === 'pl';
  if (advice.length === 0) {
    return `${pl ? 'Brak uwag.' : 'Nothing to report.'}\n`;
  }
  const lines: string[] = [
    pl ? `Porady RODO (${advice.length}):` : `GDPR advice (${advice.length}):`,
    '',
  ];
  advice.forEach((a, i) => {
    lines.push(
      `${i + 1}. [${SEVERITY_LABEL[lang][a.severity]}] ${a.title}`,
      `   ${a.why}`,
      `   -> ${a.action}`,
      `   ${pl ? 'Podstawa' : 'Reference'}: ${a.refs.join(', ')}`,
      '',
    );
  });
  lines.push(
    pl
      ? `Teksty: ${LEGAL_SOURCES.rodo.url}\n       ${LEGAL_SOURCES.uodoAct.url}`
      : `Texts: ${LEGAL_SOURCES.rodo.url}`,
  );
  return `${lines.join('\n')}\n`;
}

export type { ArticleRef };
