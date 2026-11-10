# Szybki start

Stonekeep pomaga małym zespołom i programistom, którzy sami odpowiadają za RODO: znajduje dane
osobowe w kodzie, pilnuje ich w pull requestach i przygotowuje dokumenty po polsku. Działa lokalnie,
bez konta i bez telemetrii.

## 1. Konfiguracja w jednej komendzie

W katalogu projektu (tam, gdzie są migracje SQL, schemat Prisma, encje TypeORM albo OpenAPI):

```bash
npx @stonekeep/cli init
```

Stonekeep:

- skanuje schematy i zapisuje mapę danych `stonekeep-datamap.json`, czyli listę pól z danymi
  osobowymi (rozpoznaje m.in. `pesel`, `nip`, `imie`, `nazwisko`, `nr_dowodu`, `nr_rachunku`);
- tworzy `stonekeep.config.json`, w którym poprawisz błędne wyniki;
- tworzy szablon rejestru czynności przetwarzania `stonekeep.ropa.yaml`;
- dodaje workflow GitHub Actions (albo pokazuje zadanie dla GitLab CI);
- wypisuje, co zrobić dalej.

Istniejące pliki nie są nadpisywane. `--dry-run` pokazuje, co zostałoby zapisane, `--force`
nadpisuje pliki.

## 2. Przegląd mapy danych

Otwórz `stonekeep-datamap.json` i sprawdź wyniki. Jeśli pole nie zawiera danych osobowych, dodaj
w `stonekeep.config.json`:

```json
{ "overrides": { "users.handle": { "ignore": true, "note": "nazwa wyświetlana, bez danych" } } }
```

albo komentarz `-- stonekeep-ignore` w linii z kolumną. Zatwierdź pliki w repozytorium. Od teraz CI
zablokuje pull request, który doda nowe dane osobowe bez wpisu w mapie.

## 3. Rejestr czynności przetwarzania (art. 30 RODO)

Uzupełnij `stonekeep.ropa.yaml`: cele, podstawy prawne, kategorie osób i okresy przechowywania.
Kategorie danych Stonekeep bierze z mapy danych. Potem:

```bash
npx @stonekeep/cli ropa -o rejestr.md
```

Dostajesz rejestr po polsku z listą rozbieżności, np. tabel z danymi osobowymi, których nie obejmuje
żadna czynność.

## 4. Gdy dojdzie do naruszenia (art. 33 RODO)

Masz 72 godziny na zgłoszenie do Prezesa UODO. Wskaż tabele, których dotyczy incydent:

```bash
npx @stonekeep/cli breach --tables klienci,adresy --lang pl -o naruszenie.md
```

Stonekeep policzy rekordy i osoby (bez duplikatów między tabelami) i przygotuje projekt zgłoszenia.
To samo jest dostępne w konsoli na stronie „Incydenty”.

## 5. Porady i dokumenty

```bash
npx @stonekeep/cli porady       # co poprawić, z odwołaniami do RODO
npx @stonekeep/cli dokumenty    # wzory: klauzula informacyjna, procedury, pisma, upoważnienie
```

Szczegóły: [Porady, dokumenty i źródła prawa](prawo.md).

## Ważne

Klasyfikacja jest heurystyczna i wymaga przeglądu. Stonekeep pomaga wypełniać obowiązki RODO, ale nie
gwarantuje zgodności z prawem i nie zastępuje porady prawnej ani inspektora ochrony danych.
