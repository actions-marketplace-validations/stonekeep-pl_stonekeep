# Porady, dokumenty i źródła prawa

Dwie komendy dla zespołów bez działu prawnego. Obie działają lokalnie i korzystają z mapy danych
(`stonekeep-datamap.json`) oraz rejestru (`stonekeep.ropa.yaml`).

## `stonekeep porady`: co poprawić w projekcie

```bash
npx @stonekeep/cli porady                 # w terminalu, po polsku
npx @stonekeep/cli porady --format markdown -o porady.md
npx @stonekeep/cli porady --strict        # w CI: kod 1, gdy jest uwaga o wysokim priorytecie
npx @stonekeep/cli advise --lang en       # po angielsku
```

Każda porada ma priorytet, wyjaśnienie, konkretne działanie (często gotową komendę) i podstawę prawną.
Stonekeep sprawdza m.in.:

| Porada                                         | Priorytet | Podstawa                       |
| ---------------------------------------------- | --------- | ------------------------------ |
| Brak rejestru czynności przetwarzania          | wysoki    | art. 30 ust. 1 i 5 RODO        |
| Hasło przechowywane jawnie (kolumna `haslo`)   | wysoki    | art. 32, art. 34 RODO          |
| Dane o zdrowiu bez przesłanki z art. 9         | wysoki    | art. 9 ust. 2, art. 35 RODO    |
| Przekazanie danych poza EOG bez zabezpieczenia | wysoki    | art. 44–46 RODO                |
| PESEL, NIP, numer dowodu w bazie               | średni    | art. 5 ust. 1 lit. c, 32, 87   |
| Dane finansowe                                 | średni    | art. 32 RODO                   |
| Odbiorcy bez umów powierzenia                  | średni    | art. 28 ust. 3 RODO            |
| Tabele z danymi poza rejestrem                 | średni    | art. 5, 6, 30 RODO             |
| Brak IOD przy danych szczególnych kategorii    | średni    | art. 37 RODO                   |
| Data urodzenia (usługi dla dzieci)             | niski     | art. 8 ust. 1 RODO             |
| Adresy IP i identyfikatory urządzeń            | niski     | motyw 30, art. 5 ust. 1 lit. e |
| Brak kontroli w CI, brak pakietu dokumentów    | niski     | art. 25, art. 5 ust. 2 RODO    |

## `stonekeep dokumenty`: pakiet wzorów RODO

```bash
npx @stonekeep/cli dokumenty              # zapisuje folder ./rodo
npx @stonekeep/cli dokumenty --force      # nadpisuje po zmianie rejestru
```

| Plik                               | Do czego służy                                                         |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `klauzula-informacyjna.md`         | Obowiązek informacyjny z art. 13, osobno dla każdej czynności          |
| `procedura-wnioskow.md`            | Terminy z art. 12 ust. 3, kroki i komendy Stonekeep dla art. 15–21     |
| `odpowiedzi/*.md`                  | Pisma: dostęp do danych, potwierdzenie usunięcia, przedłużenie, odmowa |
| `procedura-naruszen.md`            | Pierwsze 72 godziny, treść zgłoszenia z art. 33 ust. 3, art. 34        |
| `rejestr-naruszen.md`              | Wewnętrzny rejestr naruszeń (art. 33 ust. 5)                           |
| `upowaznienie-do-przetwarzania.md` | Upoważnienie dla osób z dostępem do danych (art. 29, art. 32 ust. 4)   |
| `umowa-powierzenia-checklista.md`  | Elementy umowy powierzenia z art. 28 ust. 3 lit. a–h                   |
| `okresy-przechowywania.md`         | Okresy z rejestru, kopie zapasowe, logi (art. 5 ust. 1 lit. e)         |

Dane, które Stonekeep zna z rejestru (administrator, cele, podstawy prawne, odbiorcy, okresy), są
wpisane automatycznie. Resztę oznacza `[UZUPEŁNIJ: …]`.

## Źródła prawa

- [RODO, rozporządzenie (UE) 2016/679 w EUR-Lex](https://eur-lex.europa.eu/legal-content/PL/TXT/?uri=CELEX:32016R0679)
- [Ustawa z dnia 10 maja 2018 r. o ochronie danych osobowych w ISAP](https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU20180001000) (sprawdź aktualny tekst jednolity)
- [Urząd Ochrony Danych Osobowych](https://uodo.gov.pl): poradniki, formularz zgłoszenia naruszenia, wykaz operacji wymagających oceny skutków
- [Europejska Rada Ochrony Danych](https://www.edpb.europa.eu): wytyczne, m.in. 9/2022 o zgłaszaniu naruszeń i 01/2022 o prawie dostępu

Adres do skarg i korespondencji: Prezes Urzędu Ochrony Danych Osobowych, ul. Stawki 2, 00-193 Warszawa.

## Zastrzeżenie

Porady i wzory to lista kontrolna, a nie opinia prawna. Odwołania do przepisów pomagają znaleźć
źródło; o zastosowaniu przepisu w konkretnej sprawie decyduje administrator, w razie wątpliwości
z prawnikiem lub inspektorem ochrony danych.
