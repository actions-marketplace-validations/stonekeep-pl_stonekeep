# Instalacja Stonekeep (PL)

Stonekeep składa się z dwóch części:

1. **Skaner kodu** (`@stonekeep/cli`): darmowy (Apache-2.0), działa na laptopie programisty, nie wymaga serwera ani bazy.
2. **Serwer z konsolą** (`@stonekeep/server`): panel w przeglądarce do wniosków klientów (dostęp, usunięcie, eksport), naruszeń, porad i dokumentów. To część płatna (plany „Zespół” i „Software house”, licencja komercyjna). Pakiet i dostęp do instalacji dostajesz razem z licencją.

Wymagany jest Node.js 20 lub nowszy.

## 1. Skaner: pięć minut, bez serwera

```bash
npx @stonekeep/cli init
```

Skan projektu, plik z mapą danych osobowych, szablon rejestru czynności (art. 30 RODO) i workflow CI. Porady i dokumenty:

```bash
npx @stonekeep/cli porady
npx @stonekeep/cli dokumenty
```

## 2. Konsola na własnym serwerze (licencja)

Konsolę instalujesz na swoim serwerze albo na serwerze klienta (plan „Software house”), więc dane osobowe i dostęp do bazy nie opuszczają tej infrastruktury. Po zakupie licencji:

```bash
npm install -g @stonekeep/server
stonekeep-server setup
stonekeep-server start
```

- `setup` pyta o adres bazy PostgreSQL, odczytuje listę tabel, zgaduje, która tabela trzyma klientów, i zapisuje pliki konfiguracji. Adres bazy (z hasłem) trafia tylko do prywatnego pliku `stonekeep.env` (prawa 0600), nigdy do YAML.
- `start` uruchamia konsolę pod `http://127.0.0.1:8080`. Sekrety (podpisy, rejestr zgód) są tworzone automatycznie i trzymane w plikach tylko do odczytu przez właściciela.
- Przy pierwszym wejściu konsola prosi o utworzenie konta administratora (e-mail i hasło, min. 10 znaków).

Konsola działa także **bez bazy danych**: „Moja firma”, porady i dokumenty są dostępne od razu. Wnioski klientów i naruszenia wymagają `stonekeep-server setup`.

### Zespół i tryb jednoosobowy

W **Ustawieniach** administrator dodaje osoby (administrator, IOD, wsparcie). Domyślnie usunięcie danych musi zatwierdzić inna osoba niż ta, która o nie poprosiła. Jeśli prowadzisz firmę sam, włącz **tryb jednoosobowy**; przy każdym zatwierdzeniu Stonekeep poprosi o potwierdzenie, że masz kopię zapasową.

### Zapomniane hasło

```bash
stonekeep-server users reset-password anna@firma.pl
```

## 3. Docker

```bash
docker build -t stonekeep .
docker run -p 8080:8080 -v stonekeep-data:/data \
  -e STONEKEEP_SERVER_SECRET=$(openssl rand -hex 32) \
  -e STONEKEEP_LEDGER_SECRET=$(openssl rand -hex 32) \
  -v ./deploy:/config:ro stonekeep
```

Przykład z bazą demonstracyjną: `docker compose up --build` (patrz `docker-compose.yml`). Obraz nie był uruchamiany w środowisku, w którym powstał ten dokument; sprawdź go na własnym serwerze.

## 4. HTTPS

Konsola słucha na `127.0.0.1`. Udostępnij ją w sieci wyłącznie za reverse proxy z HTTPS (Caddy, nginx, Traefik). Sesje logowania wygasają po 12 godzinach, po 5 błędnych próbach logowanie jest czasowo blokowane.

## Czego Stonekeep nie robi

Szablony dokumentów to wzory, nie porada prawna. Przed użyciem zleć ich przegląd prawnikowi; patrz [not-covered.md](not-covered.md).
