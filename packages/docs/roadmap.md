# Roadmap: Poland, small teams and solo developers

**Focus (updated 2026-11-09):** Stonekeep is built for the Polish market only, and for the people
who carry RODO duties without a privacy department: small product teams, small software houses and
individual developers and freelancers who build systems for Polish clients. Large players and
enterprise suites don't serve this group; we do it by being the easiest tool to start with.

Regulatory details and prices below are working hypotheses. Check them against official sources
(UODO, the 2018 Personal Data Protection Act) and customer interviews before using them in sales.

## Who we build for

| Segment                                  | Their situation                                                                             | What they need from Stonekeep                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Solo developers and freelancers**      | Build shops, CRMs and apps for Polish SMEs; clients ask "is this RODO-compliant?"           | One command that maps personal data and produces documents to hand to a client |
| **Small product teams (2–15 people)**    | No IOD on staff, or an external IOD a few hours a month; a DSAR or a breach is an emergency | Requests, deletion and breach response that work without a privacy team        |
| **Small software houses (10–50 people)** | Ship many client projects; need a repeatable privacy checklist per project                  | The same CLI and CI check in every repo, documents per client                  |

What follows from this:

- **Polish first, everywhere.** The console opens in Polish; documents are in Polish; field-name
  rules know `pesel`, `nip`, `imie`, `nazwisko`. English stays available.
- **Zero setup.** `npx stonekeep` must give value in the first five minutes, with no server, no
  account and no config file.
- **No privacy team assumed.** Defaults that are safe for one person: dry runs, clear warnings,
  plain-language explanations of each RODO duty.
- **Local and free to start.** The CLI, CI check and documents are free and run offline. People pay
  for convenience at team scale, not for the right to comply.

## Why Poland

- RODO applies with the national 2018 Personal Data Protection Act; the supervisor is **UODO**.
- A large developer population and many small software houses and freelancers.
- Global vendors sell enterprise-first, in English and in USD; local consultancies sell documents,
  not software that stays current with the code.
- Every Polish business deals with RODO paperwork (records of processing, information clauses,
  breach procedures), so the pain is familiar and the vocabulary is shared.

## Status

| Item                                                                                                        | Status |
| ----------------------------------------------------------------------------------------------------------- | ------ |
| Schema scanner, CI check, datamap, SARIF, GitHub Action                                                     | done   |
| Polish field-name rules and diacritic folding (`imię`, `nazwisko`, `pesel`, `nr_dowodu`)                    | done   |
| DSAR export, deletion and anonymisation with retention rules                                                | done   |
| ROPA (Art. 30) in Polish: `stonekeep ropa`                                                                  | done   |
| Breach impact and Art. 33 draft for UODO: `stonekeep breach` and the console page                           | done   |
| Console: Pulpit RODO, "Moja firma" wizard, advice and documents for non-lawyers                             | done   |
| Console in Polish (default) and English                                                                     | done   |
| `stonekeep init`: one command to scan, write config, datamap, ROPA template and CI workflow                 | done   |
| Solo mode: self-approval of deletions for one-person teams, with explicit warnings                          | next   |
| Polish quick start (`szybki-start.md`)                                                                      | done   |
| `stonekeep dokumenty`: Polish pack (Art. 13 clause, DSAR and breach procedures, letters, Art. 28 checklist) | done   |
| `stonekeep porady`: project-specific advice with GDPR article references and legal sources                  | done   |
| Polish fake data for staging masks (PESEL, NIP, addresses with valid formats)                               | later  |
| Polish payment connectors (Przelewy24, PayU) next to Stripe                                                 | later  |
| DPIA draft (Art. 35)                                                                                        | later  |
| Breach scope by time window or row subset                                                                   | later  |
| PR comment with datamap diff, pre-commit hook, VS Code extension                                            | later  |

Romanian and Hungarian field-name rules already in the rule set stay, but are no longer a market
priority.

## Pricing (hypotheses, PLN)

| Plan                          | Price              | For                    | Includes                                                                                                                     |
| ----------------------------- | ------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Darmowy** (open source)     | 0 zł               | Solo devs, freelancers | CLI, CI check, all rules, ROPA, breach report, information clause                                                            |
| **Zespół** (team)             | 99–199 zł / month  | Teams of 2–15          | Console for the team, solo mode, history, alerts, PR comments                                                                |
| **Software house**            | 299–599 zł / month | Agencies               | Many client projects, documents per client, white-label exports, console installed on the client's server (+~150 zł / month) |
| **Wdrożenie** (setup service) | from 1,500 zł      | Anyone who wants help  | One-day "data map and RODO documents" setup with an IOD partner                                                              |

**Licensing (decided 2026-11-10): open core.** The CLI and its libraries are Apache-2.0 on npm: they
are the free entry point. The server with the console is commercial (Stonekeep Commercial License),
self-hosted on the customer's or their client's infrastructure, so database credentials and personal
data never reach Stonekeep and we are not a processor under Art. 28. This keeps a paid product that
cannot be forked for free, which matters for software-house partners and for a later sale.

Prices are low on purpose: the buyer is a developer or a small-business owner paying from their
own budget. Flat monthly prices, no per-seat pricing, invoices in PLN with VAT.

## Go-to-market

- **Developers:** posts in Polish on concrete stacks ("Jak znaleźć PESEL w schemacie Prisma",
  "Usuwanie danych na wniosek w Postgresie"), talks at local meetups and at 4Developers,
  Infoshare and Devoxx Poland, and the GitHub Marketplace listing.
- **Freelancers and software houses:** a ready "RODO pack" per project (data map, ROPA, information
  clause, breach procedure) they can hand to their client, branded as their own work.
- **External IODs:** a partner programme; they recommend the free tool and run setup services.
- **Design partners:** 5–10 small Polish teams using it for free in exchange for feedback.

## Checkpoints

| When     | Checkpoint                                                                  |
| -------- | --------------------------------------------------------------------------- |
| Week 2   | 10 interviews with solo devs and small teams; at least 5 confirm the pain   |
| Month 3  | 100 active CLI users in Poland; 5 design partners                           |
| Month 6  | **At least 10 paying teams.** If not, change the offer, not the feature set |
| Month 12 | 50 paying teams and 3 IOD partners                                          |

## Risks

| Risk                                    | Mitigation                                                            |
| --------------------------------------- | --------------------------------------------------------------------- |
| Small customers pay little              | Low-cost self-serve, setup services, software-house plan              |
| False positives annoy developers        | Polish rule tuning, `stonekeep-ignore`, configurable rules            |
| A solo user approves a wrong deletion   | Dry run by default, explicit solo mode with warnings, backups advised |
| Users mistake the tool for legal advice | Clear "helps, does not guarantee" wording in Polish everywhere        |
| Name conflict with KeystoneJS           | Check npm, GitHub and trademarks (UPRP, EUIPO) before launch          |
