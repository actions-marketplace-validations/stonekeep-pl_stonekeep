/**
 * Legal sources and article references used by advice and document templates.
 * Links point to official publications (EUR-Lex, ISAP, UODO, EDPB). Article numbers
 * refer to Regulation (EU) 2016/679 (RODO / GDPR) unless stated otherwise.
 *
 * Stonekeep quotes articles to help readers find the rule; it does not interpret
 * them for a specific case. Always check the current consolidated text.
 */

export type LegalLanguage = 'pl' | 'en';

export interface LegalSource {
  id: string;
  title: Record<LegalLanguage, string>;
  url: string;
}

export const LEGAL_SOURCES = {
  rodo: {
    id: 'rodo',
    title: {
      pl: 'Rozporządzenie (UE) 2016/679 (RODO), tekst w EUR-Lex',
      en: 'Regulation (EU) 2016/679 (GDPR), text on EUR-Lex',
    },
    url: 'https://eur-lex.europa.eu/legal-content/PL/TXT/?uri=CELEX:32016R0679',
  },
  uodoAct: {
    id: 'uodoAct',
    title: {
      pl: 'Ustawa z dnia 10 maja 2018 r. o ochronie danych osobowych (Dz.U. 2018 poz. 1000, sprawdź tekst jednolity w ISAP)',
      en: 'Polish Personal Data Protection Act of 10 May 2018 (Journal of Laws 2018 item 1000; check the consolidated text in ISAP)',
    },
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20180001000',
  },
  uodo: {
    id: 'uodo',
    title: {
      pl: 'Urząd Ochrony Danych Osobowych (UODO): poradniki, formularz zgłoszenia naruszenia, wykaz operacji wymagających DPIA',
      en: 'Polish supervisory authority (UODO): guidance, breach notification form, list of operations requiring a DPIA',
    },
    url: 'https://uodo.gov.pl',
  },
  pke: {
    id: 'pke',
    title: {
      pl: 'Ustawa z dnia 12 lipca 2024 r. Prawo komunikacji elektronicznej (Dz.U. 2024 poz. 1221), art. 399: cookies i podobne technologie',
      en: 'Polish Electronic Communications Law of 12 July 2024 (Journal of Laws 2024 item 1221), Art. 399: cookies and similar technologies',
    },
    url: 'https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20240001221',
  },
  edpb: {
    id: 'edpb',
    title: {
      pl: 'Europejska Rada Ochrony Danych (EROD): wytyczne, m.in. 9/2022 o zgłaszaniu naruszeń, 01/2021 z przykładami naruszeń i 01/2022 o prawie dostępu',
      en: 'European Data Protection Board (EDPB): guidelines, e.g. 9/2022 on breach notification, 01/2021 with breach examples and 01/2022 on the right of access',
    },
    url: 'https://www.edpb.europa.eu',
  },
} as const satisfies Record<string, LegalSource>;

/** An article of the GDPR, optionally with paragraph and point: art(30), art(33, 5), art(6, 1, 'f'). */
export interface ArticleRef {
  article: number;
  paragraph?: number;
  point?: string;
}

export const art = (article: number, paragraph?: number, point?: string): ArticleRef => ({
  article,
  ...(paragraph !== undefined ? { paragraph } : {}),
  ...(point !== undefined ? { point } : {}),
});

/** "art. 33 ust. 5 RODO" / "GDPR Art. 33(5)". */
export function formatArticle(ref: ArticleRef, lang: LegalLanguage): string {
  if (lang === 'pl') {
    return `art. ${ref.article}${ref.paragraph !== undefined ? ` ust. ${ref.paragraph}` : ''}${
      ref.point !== undefined ? ` lit. ${ref.point}` : ''
    } RODO`;
  }
  return `GDPR Art. ${ref.article}${ref.paragraph !== undefined ? `(${ref.paragraph})` : ''}${
    ref.point !== undefined ? `(${ref.point})` : ''
  }`;
}

/** Recital, e.g. motyw 30 (online identifiers). */
export function formatRecital(n: number, lang: LegalLanguage): string {
  return lang === 'pl' ? `motyw ${n} RODO` : `GDPR Recital ${n}`;
}

/** Facts that templates and advice rely on, kept in one place for review. */
export const RODO_FACTS = {
  /** Art. 12(3): answer within one month, extendable by two further months. */
  dsarDeadlineMonths: 1,
  dsarExtensionMonths: 2,
  /** Art. 33(1). */
  breachNotifyHours: 72,
  /** Art. 8(1) as applied in Poland (no lower age set by Polish law). */
  childConsentAgePL: 16,
  /** Art. 83(4): up to EUR 10 million or 2% (controller duties, e.g. Art. 25-39). */
  maxFineLowerEur: 10_000_000,
  maxFineLowerPercent: 2,
  /** Art. 83(5): up to EUR 20 million or 4% of worldwide annual turnover. */
  maxFineEur: 20_000_000,
  maxFinePercent: 4,
  /** Art. 30(5): exemption threshold (rarely applicable in practice). */
  ropaExemptionEmployees: 250,
  /** Art. 10 of the Polish Act of 10 May 2018: notify UODO of a DPO within 14 days. */
  dpoNotifyDays: 14,
  uodoAddress: 'Prezes Urzędu Ochrony Danych Osobowych, ul. Stawki 2, 00-193 Warszawa',
} as const;
