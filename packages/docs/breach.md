# Breach response (72-hour notice)

When personal data leaks, GDPR Art. 33 gives the controller 72 hours to notify the supervisory
authority (UODO in Poland, ANSPDCP in Romania, NAIH in Hungary), and Art. 34 may require telling
the people affected. The first questions are always the same: _which data, how many people, how
many records?_ Stonekeep answers them from the database in seconds.

Name the affected tables. Stonekeep then:

1. **counts records** in each table;
2. **counts distinct data subjects** by following foreign keys (including soft references declared
   in `stonekeep.connector.yaml`) from every affected row to the subject table, deduplicated across
   tables. Rows in tables that don't link to the subject table are reported separately, so the
   number of people becomes a range;
3. **lists the categories of personal data** from the datamap, rules and connector config;
4. **rates the risk** as indicative only: _high_ when national IDs, financial, health,
   special-category or authentication data are involved, _elevated_ for other personal data, and
   _low_ when no personal data columns were detected;
5. **drafts the Art. 33(3) notification** in English or Polish: (a) nature of the breach with
   approximate numbers, (b) contact point, (c) likely consequences per category, (d) suggested
   measures, with TODOs for the DPO.

It reads counts in one read-only `REPEATABLE READ` snapshot. Reports contain table and column
names and numbers only: no data values and no subject keys.

## CLI

```bash
stonekeep breach --tables users,addresses --tables login_events \
  --discovered 2026-11-08T09:30:00Z --lang pl -o naruszenie.md
stonekeep breach --tables orders --json        # machine-readable impact
```

The DPO and controller contacts for section (b) come from `stonekeep.ropa.yaml` next to the
connector config, if it exists (see [ROPA](ropa.md)), or from `--ropa <file>`.

## API and console

- `GET /incidents/tables`: tables with their personal data columns.
- `POST /incidents/assess` `{ "tables": [...], "discoveredAt": "...", "language": "pl" }` returns
  `{ impact, markdown }`.

Both require the `incidents:assess` scope, which the DPO and admin roles have. The console's
**Incidents** page shows the table picker, a live countdown to the 72-hour deadline, the impact
summary and the draft (copy or download as Markdown).

## Limits

- Whole tables only. Breaches limited to a time window or a subset of rows aren't supported yet.
- Free-text columns (`notes`, `body`) can hold personal data that schema names don't reveal.
- The risk rating is a starting point. The controller assesses risk and decides on notification.
