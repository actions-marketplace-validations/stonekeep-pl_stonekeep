/**
 * RODO document pack for small Polish teams: templates ("wzory") prefilled from the
 * record of processing and the data map. Every file is a starting point to adapt,
 * marked with [UZUPEŁNIJ: …] where Stonekeep cannot know the answer.
 *
 * The texts quote GDPR articles so readers can check the source. They are not legal
 * advice and do not replace a lawyer or a data protection officer.
 */
import { LEGAL_SOURCES, RODO_FACTS } from './legal.js';
import type { LegalBasis, RopaActivityConfig, RopaConfig } from './ropa.js';
import { SPECIAL_CATEGORIES } from './ropa.js';
import { dataCategoryLabel, legalBasisLabel, specialConditionLabel } from './ropa-render.js';
import { compareStrings } from './text.js';
import type { DataMap } from './types.js';

export interface DocumentFile {
  /** Path relative to the output folder, POSIX separators. */
  path: string;
  title: string;
  /** Plain-language "when do I use this". */
  when: string;
  content: string;
}

export interface DocumentPackInput {
  ropa?: RopaConfig | undefined;
  datamap: DataMap;
  /** ISO date printed on every document. */
  asOf: string;
  /** Who handles incidents (name, phone), from the company profile. */
  incidentContact?: string | undefined;
  /** The company stated it has not appointed a DPO. */
  noDpo?: boolean | undefined;
}

type DraftFile = Omit<DocumentFile, 'when'>;

const FILL = (what: string) => `[UZUPEŁNIJ: ${what}]`;

const HEADER = (title: string, asOf: string) =>
  `# ${title}\n\n> Wzór przygotowany przez Stonekeep (${asOf}) na podstawie rejestru czynności przetwarzania i mapy danych. Dostosuj go do swojej sytuacji. Nie stanowi porady prawnej.\n`;

const isTodo = (s: string | undefined) => s === undefined || s.trim().startsWith('TODO');
const val = (s: string | undefined, what: string) => (isTodo(s) ? FILL(what) : (s as string));

function controllerBlock(ropa: RopaConfig | undefined, noDpo = false): string {
  const c = ropa?.controller;
  const lines = [
    `**Administrator danych:** ${val(c?.name, 'pełna nazwa firmy lub imię i nazwisko przedsiębiorcy')}`,
    `**Adres:** ${val(c?.address, 'adres siedziby')}`,
    `**Kontakt w sprawach danych osobowych:** ${val(c?.contact, 'e-mail lub telefon')}`,
  ];
  if (ropa?.dpo && !isTodo(ropa.dpo.name)) {
    lines.push(
      `**Inspektor ochrony danych:** ${ropa.dpo.name}, ${val(ropa.dpo.contact, 'kontakt do IOD')}`,
    );
  } else if (noDpo) {
    lines.push(
      '**Inspektor ochrony danych:** administrator nie wyznaczył inspektora ochrony danych; w sprawach danych osobowych pisz na adres podany wyżej.',
    );
  } else {
    lines.push(
      `**Inspektor ochrony danych:** ${FILL('dane IOD albo zdanie: „Administrator nie wyznaczył inspektora ochrony danych.”')}`,
    );
  }
  return lines.map((l) => `- ${l}`).join('\n');
}

function activities(ropa: RopaConfig | undefined): RopaActivityConfig[] {
  return ropa?.activities ?? [];
}

function rightsFor(bases: readonly LegalBasis[]): string[] {
  const rights = [
    'dostępu do swoich danych i otrzymania ich kopii (art. 15 RODO),',
    'sprostowania danych (art. 16 RODO),',
    'usunięcia danych (art. 17 RODO),',
    'ograniczenia przetwarzania (art. 18 RODO),',
  ];
  if (bases.includes('consent') || bases.includes('contract')) {
    rights.push('przenoszenia danych (art. 20 RODO),');
  }
  if (bases.includes('legitimate_interests') || bases.includes('public_task')) {
    rights.push(
      'wniesienia sprzeciwu wobec przetwarzania z przyczyn związanych z Twoją szczególną sytuacją (art. 21 RODO),',
    );
  }
  if (bases.includes('consent')) {
    rights.push(
      'cofnięcia zgody w dowolnym momencie, bez wpływu na zgodność z prawem przetwarzania przed jej cofnięciem (art. 7 ust. 3 RODO),',
    );
  }
  rights.push(`wniesienia skargi do organu nadzorczego: ${RODO_FACTS.uodoAddress} (art. 77 RODO).`);
  return rights;
}

function requirementText(bases: readonly LegalBasis[]): string {
  if (bases.includes('contract')) {
    return 'Podanie danych jest dobrowolne, ale niezbędne do zawarcia i wykonania umowy. Bez nich nie możemy świadczyć usługi.';
  }
  if (bases.includes('legal_obligation')) {
    return `Podanie danych jest wymogiem ustawowym: ${FILL('przepis, z którego wynika obowiązek')}.`;
  }
  if (bases.includes('consent')) {
    return 'Podanie danych jest dobrowolne.';
  }
  return FILL(
    'czy podanie danych jest wymogiem ustawowym lub umownym albo warunkiem zawarcia umowy oraz jakie są skutki ich niepodania',
  );
}

function informationClause(input: DocumentPackInput): DraftFile {
  const { ropa, asOf } = input;
  const out: string[] = [
    HEADER('Klauzula informacyjna (art. 13 RODO)', asOf),
    'Klauzulę przekazujesz osobie w chwili zbierania od niej danych: w formularzu rejestracji, w polityce prywatności, w stopce e-maila albo w umowie. Jeśli dane pochodzą z innego źródła niż od osoby, stosuje się art. 14 RODO (podaj też kategorie danych i źródło).',
    '',
    '## Kto przetwarza Twoje dane',
    '',
    controllerBlock(ropa, input.noDpo),
    '',
  ];
  const acts = activities(ropa);
  if (acts.length === 0) {
    out.push(
      '## Cel i podstawa prawna',
      '',
      FILL(
        'cel przetwarzania i podstawa prawna z art. 6 ust. 1 RODO; uzupełnij stonekeep.ropa.yaml i wygeneruj ponownie',
      ),
      '',
    );
  }
  for (const a of acts) {
    out.push(`## ${isTodo(a.name) ? FILL('nazwa czynności przetwarzania') : a.name}`, '');
    const purposes = a.purposes.filter((p) => !isTodo(p));
    out.push(
      `**Cel:** ${purposes.length > 0 ? purposes.join('; ') : FILL('cel przetwarzania')}`,
      '',
      `**Podstawa prawna:** ${a.legalBasis.map((b) => legalBasisLabel('pl', b)).join('; ')}`,
    );
    if (a.legalBasis.includes('legitimate_interests')) {
      out.push(
        '',
        `**Nasz prawnie uzasadniony interes:** ${FILL('na czym polega, np. dochodzenie roszczeń, bezpieczeństwo usługi')}`,
      );
    }
    if (a.specialCategoryConditions.length > 0) {
      out.push(
        '',
        `**Przesłanka dla danych szczególnych kategorii:** ${a.specialCategoryConditions
          .map((c) => specialConditionLabel('pl', c))
          .join('; ')}`,
      );
    }
    const recipients = a.recipients.filter((r) => !isTodo(r));
    out.push(
      '',
      `**Odbiorcy danych:** ${
        recipients.length > 0
          ? recipients.join('; ')
          : `podmioty przetwarzające dane na nasze zlecenie, np. ${FILL('dostawca hostingu, poczty e-mail, systemu księgowego')}`
      }`,
      '',
      `**Przekazywanie poza Europejski Obszar Gospodarczy:** ${
        a.transfers.length === 0
          ? 'nie przekazujemy danych do państw trzecich.'
          : a.transfers
              .map(
                (t) =>
                  `${t.country} (zabezpieczenie: ${t.safeguard ?? FILL('mechanizm z rozdziału V RODO')}; kopię zabezpieczeń możesz uzyskać, pisząc na adres kontaktowy administratora)`,
              )
              .join('; ')
      }`,
      '',
      `**Okres przechowywania:** ${val(a.retention, 'jak długo przechowujesz dane albo kryteria ustalania tego okresu')}`,
      '',
      `**Czy musisz podać dane:** ${requirementText(a.legalBasis)}`,
      '',
      '**Twoje prawa.** Masz prawo do:',
      '',
      ...rightsFor(a.legalBasis).map((r) => `- ${r}`),
      '',
    );
  }
  out.push(
    '## Zautomatyzowane decyzje',
    '',
    `Nie podejmujemy decyzji opartych wyłącznie na zautomatyzowanym przetwarzaniu, w tym profilowaniu, które wywoływałyby wobec Ciebie skutki prawne. ${FILL('zmień, jeśli to nieprawda (art. 22 RODO)')}`,
    '',
  );
  return {
    path: 'klauzula-informacyjna.md',
    title: 'Klauzula informacyjna',
    content: `${out.join('\n').trimEnd()}\n`,
  };
}

function requestProcedure(input: DocumentPackInput): DraftFile {
  const m = RODO_FACTS.dsarDeadlineMonths;
  const ext = RODO_FACTS.dsarExtensionMonths;
  const content = `${HEADER('Procedura obsługi wniosków osób, których dane dotyczą', input.asOf)}
Dotyczy wniosków o dostęp, sprostowanie, usunięcie, ograniczenie, przeniesienie danych i sprzeciw (art. 15–22 RODO).

## Terminy

| Krok | Termin | Podstawa |
| --- | --- | --- |
| Odpowiedź na wniosek | bez zbędnej zwłoki, najpóźniej w ciągu ${m} miesiąca od otrzymania | art. 12 ust. 3 RODO |
| Przedłużenie (złożony wniosek lub wiele wniosków) | o kolejne ${ext} miesiące; poinformuj osobę o przedłużeniu i jego przyczynach w ciągu pierwszego miesiąca | art. 12 ust. 3 RODO |
| Informacja o odmowie | w ciągu ${m} miesiąca, z pouczeniem o skardze do Prezesa UODO i o sądzie | art. 12 ust. 4 RODO |

Obsługa wniosku jest bezpłatna. Przy wnioskach ewidentnie nieuzasadnionych lub nadmiernych możesz pobrać rozsądną opłatę albo odmówić; to Ty musisz to wykazać (art. 12 ust. 5 RODO).

## Kroki

1. **Przyjęcie.** Zapisz datę wpływu, kanał (e-mail, formularz, pismo) i sygnaturę, np. \`DSR-${input.asOf.slice(0, 4)}-001\`. Termin liczysz od dnia otrzymania.
2. **Weryfikacja tożsamości.** Jeśli masz uzasadnione wątpliwości, poproś o dodatkowe informacje (art. 12 ust. 6 RODO). Pytaj tylko o dane, które już przetwarzasz (np. potwierdzenie z adresu e-mail konta); nie żądaj skanu dowodu ani numeru PESEL, jeśli ich nie przechowujesz.
3. **Ustalenie zakresu.** Sprawdź, gdzie są dane osoby: \`stonekeep discover\` pokazuje tabele i powiązania, mapa danych pokazuje kolumny.
4. **Realizacja.**
   - Dostęp i kopia danych (art. 15): \`stonekeep export --subject-env SUBJECT_ID -o eksport.zip\`. Do kopii dołącz informacje z art. 15 ust. 1 (cele, kategorie, odbiorcy, okres przechowywania, prawa).
   - Sprostowanie (art. 16): popraw dane i potwierdź osobie.
   - Usunięcie (art. 17): \`stonekeep delete --subject-env SUBJECT_ID\` pokazuje plan (próba), \`--apply\` wykonuje. Dane, które musisz zachować (np. faktury z przepisów podatkowych), Stonekeep odłącza od osoby zgodnie z regułami retencji. Wyjątki od prawa do usunięcia: art. 17 ust. 3 RODO (m.in. obowiązek prawny, ustalenie, dochodzenie lub obrona roszczeń).
   - Ograniczenie (art. 18), przeniesienie (art. 20), sprzeciw (art. 21): ${FILL('opisz, jak realizujesz te prawa w swoim systemie')}.
5. **Odbiorcy.** O sprostowaniu, usunięciu lub ograniczeniu poinformuj odbiorców, którym ujawniono dane (art. 19 RODO). Konektory Stonekeep usuwają dane m.in. w Stripe i Auth0.
6. **Odpowiedź.** Odpowiedz w formie, w jakiej przyszedł wniosek, chyba że osoba prosi inaczej (art. 12 ust. 3). Wzory pism: folder \`odpowiedzi/\`.
7. **Dokumentacja.** Zachowaj wniosek, odpowiedź i dowód wykonania (rozliczalność, art. 5 ust. 2 RODO). Konsola Stonekeep zapisuje historię wniosku i dziennik audytu.

## Osoba odpowiedzialna

${FILL('kto przyjmuje wnioski i kto zatwierdza usunięcia; w małym zespole może to być jedna osoba')}
`;
  return { path: 'procedura-wnioskow.md', title: 'Procedura obsługi wniosków', content };
}

function letters(input: DocumentPackInput): DraftFile[] {
  const sign = `\n${FILL('miejscowość, data')}\n\n${FILL('podpis, imię i nazwisko, stanowisko')}\n`;
  const to = `${FILL('imię i nazwisko osoby')}\n${FILL('adres e-mail lub pocztowy')}\n\nSygnatura: ${FILL('np. DSR-2026-001')}\n`;
  const ctrl = val(input.ropa?.controller.name, 'nazwa administratora');
  return [
    {
      path: 'odpowiedzi/dostep-do-danych.md',
      title: 'Odpowiedź na wniosek o dostęp',
      content: `${HEADER('Odpowiedź na wniosek o dostęp do danych (art. 15 RODO)', input.asOf)}
${to}
Dzień dobry,

w odpowiedzi na Pani/Pana wniosek z dnia ${FILL('data wniosku')} potwierdzamy, że ${ctrl} przetwarza Pani/Pana dane osobowe. W załączeniu przekazujemy kopię danych (plik ${FILL('nazwa pliku, np. eksport.zip')}).

Informacje o przetwarzaniu:

- cele przetwarzania: ${FILL('cele')};
- kategorie danych: ${FILL('kategorie danych')};
- odbiorcy lub kategorie odbiorców: ${FILL('odbiorcy')};
- okres przechowywania: ${FILL('okres lub kryteria')};
- źródło danych, jeśli nie zebraliśmy ich od Pani/Pana: ${FILL('źródło albo „dane zebraliśmy bezpośrednio od Pani/Pana”')};
- zautomatyzowane podejmowanie decyzji, w tym profilowanie: ${FILL('nie stosujemy / opis')}.

Przysługuje Pani/Panu prawo do sprostowania, usunięcia lub ograniczenia przetwarzania danych, prawo sprzeciwu oraz prawo wniesienia skargi do Prezesa Urzędu Ochrony Danych Osobowych (${RODO_FACTS.uodoAddress}).
${sign}`,
    },
    {
      path: 'odpowiedzi/usuniecie-danych.md',
      title: 'Potwierdzenie usunięcia danych',
      content: `${HEADER('Potwierdzenie usunięcia danych (art. 17 RODO)', input.asOf)}
${to}
Dzień dobry,

informujemy, że zgodnie z Pani/Pana wnioskiem z dnia ${FILL('data wniosku')} usunęliśmy Pani/Pana dane osobowe z naszych systemów w dniu ${FILL('data wykonania')}.

${FILL('jeśli część danych zachowano: „Zachowaliśmy wyłącznie dane, których przechowywanie nakazują przepisy prawa (' + 'np. dokumenty księgowe), na podstawie art. 17 ust. 3 lit. b RODO. Dane te nie są wykorzystywane w innym celu i zostaną usunięte po upływie wymaganego okresu.”')}

O usunięciu poinformowaliśmy podmioty, którym ujawniliśmy dane (art. 19 RODO).
${sign}`,
    },
    {
      path: 'odpowiedzi/przedluzenie-terminu.md',
      title: 'Przedłużenie terminu odpowiedzi',
      content: `${HEADER('Informacja o przedłużeniu terminu (art. 12 ust. 3 RODO)', input.asOf)}
${to}
Dzień dobry,

otrzymaliśmy Pani/Pana wniosek z dnia ${FILL('data wniosku')}. Ze względu na ${FILL('przyczyna: złożony charakter wniosku lub liczba wniosków')} termin odpowiedzi zostaje przedłużony o ${RODO_FACTS.dsarExtensionMonths} miesiące, zgodnie z art. 12 ust. 3 RODO. Odpowiedź otrzyma Pani/Pan najpóźniej do dnia ${FILL('nowa data')}.
${sign}`,
    },
    {
      path: 'odpowiedzi/odmowa.md',
      title: 'Odmowa realizacji wniosku',
      content: `${HEADER('Informacja o odmowie realizacji wniosku (art. 12 ust. 4 RODO)', input.asOf)}
${to}
Dzień dobry,

po rozpatrzeniu Pani/Pana wniosku z dnia ${FILL('data wniosku')} informujemy, że nie możemy go zrealizować ${FILL('w całości / w części')}, ponieważ ${FILL('uzasadnienie i podstawa, np. art. 17 ust. 3 lit. b RODO: obowiązek przechowywania dokumentacji wynikający z przepisów podatkowych')}.

Przysługuje Pani/Panu prawo wniesienia skargi do Prezesa Urzędu Ochrony Danych Osobowych (${RODO_FACTS.uodoAddress}) oraz prawo do skorzystania ze środków ochrony prawnej przed sądem.
${sign}`,
    },
  ];
}

function breachProcedure(input: DocumentPackInput): DraftFile {
  const h = RODO_FACTS.breachNotifyHours;
  const content = `${HEADER('Procedura postępowania w przypadku naruszenia ochrony danych', input.asOf)}
Naruszenie to każde zdarzenie prowadzące do przypadkowego lub niezgodnego z prawem zniszczenia, utracenia, zmodyfikowania, nieuprawnionego ujawnienia lub dostępu do danych osobowych (art. 4 pkt 12 RODO). Przykłady: wyciek bazy, zgubiony laptop bez szyfrowania, e-mail z danymi wysłany do złej osoby, atak ransomware.

## Pierwsze ${h} godziny

| Kiedy | Co zrobić |
| --- | --- |
| Od razu | Zgłoś zdarzenie osobie odpowiedzialnej: ${input.incidentContact ? input.incidentContact : FILL('kto, telefon, e-mail')}. Zapisz godzinę stwierdzenia naruszenia: od niej liczy się termin. |
| Pierwsze godziny | Ogranicz skutki: odbierz dostęp, zmień hasła i klucze, odetnij podatność, zabezpiecz dowody (logi). |
| Do 24 h | Oceń zakres: \`stonekeep breach --tables <tabele> --discovered <data i godzina> --lang pl\` albo strona „Incydenty” w konsoli. Ustal kategorie danych, liczbę osób i rekordów. |
| Do 24 h | Oceń ryzyko dla osób (nie dla firmy): czy możliwa kradzież tożsamości, strata finansowa, dyskryminacja, utrata poufności. |
| Do ${h} h | Jeśli naruszenie może powodować ryzyko: zgłoś je Prezesowi UODO (formularz na stronie UODO). Jeśli nie znasz jeszcze wszystkich faktów, zgłoś to, co wiesz, i uzupełniaj (art. 33 ust. 4). |
| Bez zbędnej zwłoki | Jeśli ryzyko jest wysokie: zawiadom osoby, których dane dotyczą, prostym językiem (art. 34). |
| Zawsze | Wpisz zdarzenie do rejestru naruszeń, także jeśli nie zgłaszasz go do UODO (art. 33 ust. 5). |

Jeśli działasz jako podmiot przetwarzający (np. utrzymujesz system klienta), zawiadom administratora bez zbędnej zwłoki (art. 33 ust. 2) i nie zgłaszaj naruszenia do UODO w jego imieniu, chyba że tak stanowi umowa.

## Co musi zawierać zgłoszenie (art. 33 ust. 3 RODO)

1. Charakter naruszenia, w miarę możliwości kategorie i przybliżoną liczbę osób oraz wpisów danych.
2. Imię i nazwisko oraz dane kontaktowe inspektora ochrony danych lub innego punktu kontaktowego.
3. Możliwe konsekwencje naruszenia.
4. Środki zastosowane lub proponowane w celu zaradzenia naruszeniu i zminimalizowania skutków.

Projekt zgłoszenia z punktami 1–4 tworzy \`stonekeep breach\`.

## Kiedy nie trzeba zawiadamiać osób (art. 34 ust. 3 RODO)

- dane były skutecznie zabezpieczone, np. zaszyfrowane, a klucz nie wyciekł;
- zastosowano środki, które eliminują prawdopodobieństwo wysokiego ryzyka;
- zawiadomienie wymagałoby niewspółmiernie dużego wysiłku (wtedy komunikat publiczny).

Jak oceniać ryzyko i zgłaszać naruszenia: wytyczne EROD 9/2022 (zgłaszanie naruszeń) i 01/2021 (przykłady naruszeń), dostępne na ${LEGAL_SOURCES.edpb.url}. Formularz zgłoszenia i aktualny kanał (strona UODO, biznes.gov.pl) sprawdź na ${LEGAL_SOURCES.uodo.url}; zgłoszenie po terminie wymaga wyjaśnienia przyczyn opóźnienia (art. 33 ust. 1 RODO).
`;
  return { path: 'procedura-naruszen.md', title: 'Procedura naruszeń', content };
}

function breachRegister(input: DocumentPackInput): DraftFile {
  const content = `${HEADER('Rejestr naruszeń ochrony danych osobowych (art. 33 ust. 5 RODO)', input.asOf)}
Wpisuj każde naruszenie, także to, którego nie zgłaszasz do UODO; wtedy wpisz uzasadnienie braku zgłoszenia.

| Nr | Data i godzina stwierdzenia | Opis zdarzenia | Kategorie danych | Liczba osób | Liczba rekordów | Ocena ryzyka | Zgłoszenie do UODO (data albo powód braku) | Zawiadomienie osób (data albo powód braku) | Podjęte środki |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | | | | | | | | | |
| 2 | | | | | | | | | |
| 3 | | | | | | | | | |
`;
  return { path: 'rejestr-naruszen.md', title: 'Rejestr naruszeń', content };
}

function authorisation(input: DocumentPackInput): DraftFile {
  const scope = activities(input.ropa)
    .filter((a) => !isTodo(a.name))
    .map((a) => `- ${a.name}`);
  const categories = [...new Set(input.datamap.fields.map((f) => f.category))]
    .sort(compareStrings)
    .map((c) => `- ${dataCategoryLabel('pl', c)}`);
  const content = `${HEADER('Upoważnienie do przetwarzania danych osobowych', input.asOf)}
Na podstawie art. 29 i art. 32 ust. 4 RODO osoba, która ma dostęp do danych osobowych, przetwarza je wyłącznie na polecenie administratora. Upoważnienie dokumentuje to polecenie. Wystaw je każdej osobie z dostępem do danych produkcyjnych: pracownikom, współpracownikom B2B, stażystom.

${FILL('miejscowość, data')}

**Administrator:** ${val(input.ropa?.controller.name, 'nazwa administratora')}

Upoważniam Panią/Pana **${FILL('imię i nazwisko')}** do przetwarzania danych osobowych w zakresie czynności:

${scope.length > 0 ? scope.join('\n') : `- ${FILL('czynności przetwarzania z rejestru')}`}

obejmującym kategorie danych:

${categories.length > 0 ? categories.join('\n') : `- ${FILL('kategorie danych')}`}

Zakres dostępu w systemach: ${FILL('np. odczyt w panelu administracyjnym, dostęp do bazy produkcyjnej tylko w trybie odczytu')}.

Upoważnienie obowiązuje od ${FILL('data')} do ${FILL('data albo „odwołania”')}.

${FILL('podpis administratora')}

---

**Oświadczenie osoby upoważnionej**

Oświadczam, że zapoznałam/zapoznałem się z zasadami ochrony danych osobowych obowiązującymi u administratora, zobowiązuję się przetwarzać dane wyłącznie w zakresie upoważnienia i zachować je w tajemnicy, także po ustaniu współpracy.

${FILL('data, podpis')}
`;
  return { path: 'upowaznienie-do-przetwarzania.md', title: 'Upoważnienie', content };
}

function processorChecklist(input: DocumentPackInput): DraftFile {
  const recipients = [
    ...new Set(activities(input.ropa).flatMap((a) => a.recipients.filter((r) => !isTodo(r)))),
  ];
  const content = `${HEADER('Umowa powierzenia przetwarzania danych: lista kontrolna (art. 28 RODO)', input.asOf)}
Umowę powierzenia zawierasz z każdym podmiotem, który przetwarza dane osobowe na Twoje zlecenie: hosting, poczta e-mail, newsletter, biuro rachunkowe, CRM, helpdesk, programista z dostępem do bazy produkcyjnej. Duzi dostawcy publikują gotowe umowy (DPA); sprawdź je według tej listy.

${recipients.length > 0 ? `**Odbiorcy z Twojego rejestru do sprawdzenia:**\n\n${recipients.map((r) => `- [ ] ${r}`).join('\n')}\n` : ''}
## Umowa musi określać (art. 28 ust. 3 RODO)

- [ ] przedmiot i czas trwania przetwarzania
- [ ] charakter i cel przetwarzania
- [ ] rodzaj danych osobowych i kategorie osób, których dane dotyczą
- [ ] obowiązki i prawa administratora

## Podmiot przetwarzający zobowiązuje się do (art. 28 ust. 3 lit. a–h)

- [ ] a) przetwarzania danych wyłącznie na udokumentowane polecenie administratora, także w zakresie przekazywania danych do państwa trzeciego
- [ ] b) zapewnienia, że osoby upoważnione zobowiązały się do zachowania tajemnicy
- [ ] c) stosowania środków bezpieczeństwa z art. 32 RODO
- [ ] d) korzystania z dalszych podmiotów przetwarzających tylko za zgodą administratora (art. 28 ust. 2 i 4)
- [ ] e) pomocy w realizacji praw osób, których dane dotyczą (wnioski z rozdziału III)
- [ ] f) pomocy w wywiązaniu się z obowiązków z art. 32–36 (bezpieczeństwo, naruszenia, DPIA)
- [ ] g) usunięcia lub zwrotu danych po zakończeniu usług, zgodnie z decyzją administratora
- [ ] h) udostępnienia informacji potrzebnych do wykazania zgodności i umożliwienia audytów

## Jeśli to Ty jesteś podmiotem przetwarzającym

Freelancer lub software house, który utrzymuje system klienta i ma dostęp do jego danych, jest podmiotem przetwarzającym. Wtedy:

- podpisz z klientem umowę powierzenia (powyższa lista działa w obie strony);
- prowadź rejestr kategorii czynności przetwarzania dokonywanych w imieniu administratora (art. 30 ust. 2 RODO);
- o naruszeniu informuj klienta bez zbędnej zwłoki (art. 33 ust. 2 RODO);
- pracuj na danych zamaskowanych, gdy to możliwe: \`stonekeep mask\` tworzy kopię bazy bez prawdziwych danych.
`;
  return { path: 'umowa-powierzenia-checklista.md', title: 'Umowa powierzenia', content };
}

function retention(input: DocumentPackInput): DraftFile {
  const rows = activities(input.ropa).map(
    (a) =>
      `| ${val(a.name, 'czynność')} | ${a.entities.length > 0 ? a.entities.map((e) => `\`${e}\``).join(', ') : FILL('tabele')} | ${val(a.retention, 'okres')} | ${FILL('jak usuwasz: ręcznie, zadanie cykliczne, stonekeep delete')} |`,
  );
  const sensitive = [
    ...new Set(
      input.datamap.fields.filter((f) => SPECIAL_CATEGORIES.has(f.category)).map((f) => f.entity),
    ),
  ];
  const content = `${HEADER('Okresy przechowywania danych', input.asOf)}
Dane przechowujesz nie dłużej, niż jest to niezbędne do celów przetwarzania (zasada ograniczenia przechowywania, art. 5 ust. 1 lit. e RODO). Okresy pochodzą z rejestru czynności przetwarzania.

| Czynność | Tabele | Okres przechowywania | Sposób usuwania |
| --- | --- | --- | --- |
${rows.length > 0 ? rows.join('\n') : `| ${FILL('czynność')} | ${FILL('tabele')} | ${FILL('okres')} | ${FILL('sposób')} |`}

## Nie zapomnij o

- **kopiach zapasowych:** ${FILL('jak długo trzymasz backupy i jak usuwasz z nich dane po wniosku o usunięcie')};
- **logach aplikacji i serwera** (adresy IP, e-maile w logach): ${FILL('np. 30–90 dni')};
- **środowiskach testowych:** nie kopiuj danych produkcyjnych; użyj \`stonekeep mask\`.
${sensitive.length > 0 ? `\nTabele z danymi szczególnych kategorii wymagają szczególnie krótkich okresów i ograniczonego dostępu: ${sensitive.map((e) => `\`${e}\``).join(', ')}.\n` : ''}`;
  return { path: 'okresy-przechowywania.md', title: 'Okresy przechowywania', content };
}

function index(files: readonly DraftFile[], input: DocumentPackInput): DraftFile {
  const content = `${HEADER('Pakiet dokumentów RODO', input.asOf)}
Wzory dla małego zespołu lub jednoosobowej firmy. Pola do uzupełnienia są oznaczone jako \`[UZUPEŁNIJ: …]\`. Po zmianie rejestru (\`stonekeep.ropa.yaml\`) wygeneruj pakiet ponownie: \`stonekeep dokumenty --force\`.

## Dokumenty

${files.map((f) => `- [${f.title}](${f.path})`).join('\n')}

## Najważniejsze terminy

| Obowiązek | Termin | Podstawa |
| --- | --- | --- |
| Odpowiedź na wniosek osoby | ${RODO_FACTS.dsarDeadlineMonths} miesiąc (+${RODO_FACTS.dsarExtensionMonths} miesiące w uzasadnionych przypadkach) | art. 12 ust. 3 RODO |
| Zgłoszenie naruszenia do Prezesa UODO | ${RODO_FACTS.breachNotifyHours} godziny od stwierdzenia | art. 33 ust. 1 RODO |
| Zawiadomienie osób przy wysokim ryzyku | bez zbędnej zwłoki | art. 34 ust. 1 RODO |
| Informacja przy zbieraniu danych | w momencie zbierania | art. 13 ust. 1 RODO |

Kary: za naruszenie praw osób, zasad przetwarzania i przekazywania danych do państw trzecich do ${(RODO_FACTS.maxFineEur / 1_000_000).toFixed(0)} mln euro lub ${RODO_FACTS.maxFinePercent}% rocznego światowego obrotu (art. 83 ust. 5 RODO); za naruszenie obowiązków administratora i podmiotu przetwarzającego (m.in. art. 25–39, w tym zgłoszenie naruszenia) do ${(RODO_FACTS.maxFineLowerEur / 1_000_000).toFixed(0)} mln euro lub ${RODO_FACTS.maxFineLowerPercent}% (art. 83 ust. 4 RODO). W praktyce organ bierze pod uwagę m.in. charakter naruszenia, współpracę i podjęte środki (art. 83 ust. 2).

## Źródła prawa

${Object.values(LEGAL_SOURCES)
  .map((s) => `- [${s.title.pl}](${s.url})`)
  .join('\n')}

## Porady dla Twojego projektu

\`stonekeep porady\` sprawdza mapę danych i rejestr i podpowiada, co poprawić, z odwołaniem do przepisów.

Stonekeep pomaga wypełniać obowiązki RODO, ale nie gwarantuje zgodności z prawem i nie zastępuje porady prawnej.
`;
  return { path: 'README.md', title: 'Spis dokumentów', content };
}

const WHEN: Record<string, string> = {
  'README.md': 'Spis wszystkich dokumentów i najważniejsze terminy w jednym miejscu.',
  'klauzula-informacyjna.md':
    'Wklej do polityki prywatności i pokaż przy formularzach, gdzie zbierasz dane (rejestracja, zamówienie, newsletter).',
  'procedura-wnioskow.md':
    'Gdy ktoś pyta, jakie masz jego dane, albo prosi o ich usunięcie. Masz na odpowiedź miesiąc.',
  'odpowiedzi/dostep-do-danych.md': 'Gotowa odpowiedź, gdy ktoś prosi o kopię swoich danych.',
  'odpowiedzi/usuniecie-danych.md': 'Potwierdzenie dla osoby, której dane usunąłeś.',
  'odpowiedzi/przedluzenie-terminu.md':
    'Gdy nie zdążysz w miesiąc: informujesz, że odpowiesz później (maks. 2 miesiące dłużej).',
  'odpowiedzi/odmowa.md':
    'Gdy nie możesz spełnić prośby, np. musisz trzymać faktury z powodu przepisów podatkowych.',
  'procedura-naruszen.md':
    'Na wypadek wycieku danych: co robić w pierwszych 72 godzinach. Wydrukuj i miej pod ręką.',
  'rejestr-naruszen.md': 'Zapisuj tu każdy incydent, nawet drobny. Organ może o to zapytać.',
  'upowaznienie-do-przetwarzania.md':
    'Dla każdej osoby (pracownik, współpracownik), która ma dostęp do danych klientów.',
  'umowa-powierzenia-checklista.md':
    'Sprawdź, czy umowy z hostingiem, mailingiem, księgową itp. zawierają wymagane punkty.',
  'okresy-przechowywania.md': 'Jak długo trzymasz dane i kiedy je usuwasz.',
};

/** Generate the Polish RODO document pack. Pure: returns files, writes nothing. */
export function generateDocumentPack(input: DocumentPackInput): DocumentFile[] {
  const files = [
    informationClause(input),
    requestProcedure(input),
    ...letters(input),
    breachProcedure(input),
    breachRegister(input),
    authorisation(input),
    processorChecklist(input),
    retention(input),
  ];
  return [index(files, input), ...files].map((f) => ({ ...f, when: WHEN[f.path] ?? '' }));
}
