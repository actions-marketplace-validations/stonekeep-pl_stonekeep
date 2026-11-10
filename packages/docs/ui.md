# Stonekeep Console (Stage 6)

`packages/ui` is a web console for Data Protection Officers and support staff. It's built with
React, Vite, Tailwind v4 and shadcn/ui-style components (Radix primitives with `cva` and `cn`).

It talks **only** to the Stonekeep API (Stage 5) through a same-origin `/api` proxy. It loads no
third-party fonts, uses no CDNs and sends no analytics.

```bash
pnpm dev          # builds the workspace, starts a demo API + the console at http://localhost:5173
pnpm test:e2e     # Playwright (Chromium) against the same stack
```

`pnpm dev` is fully self-contained and doesn't need Docker. `packages/ui/scripts/demo-api.mjs` runs
the **real** Stonekeep server and engine against an in-process Postgres (PGlite) seeded with the
fictional `postgres-shop` fixture. It creates demo keys, two deletions awaiting approval, a
completed export and some consent history, and prints the DPO, Support and Admin keys to the
terminal.

To use your own API, point the proxy at it with `STONEKEEP_API_URL=https://stonekeep.internal pnpm --filter @stonekeep/ui dev:ui`.

## Language

The console opens in **Polish** and can be switched to English in the sidebar or on the sign-in
page; the choice is remembered per browser. Translations live in `src/lib/i18n.tsx`: English is the
source of truth and the compiler rejects a Polish dictionary with missing keys. Text that comes from
the server or your config (retain reasons, hints, errors) is shown as is.

## Screens

| Screen         | What staff can do                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pulpit RODO    | Start page for people without legal knowledge: progress checklist (6 steps), what to do now, data categories found, quick actions and step-by-step guides ("Co zrobić, gdy…")                                          |
| Moja firma     | Plain-language wizard: company details, what the app does, services used, safeguards, DPO, incident contact. Stonekeep builds the record of processing from it (legal bases and retention chosen from common practice) |
| Porady         | Advice ordered by urgency, each with why it matters, what to do, a link to fix it and the legal basis on demand                                                                                                        |
| Dokumenty      | Polish templates filled from "Moja firma": preview with fill-in fields highlighted, copy, download, print or save as PDF                                                                                               |
| Sign in        | Paste an API key (the login stub). The key is kept in `sessionStorage` for that tab only                                                                                                                               |
| Requests       | See counts per status and the queue, filtered by _Needs approval_, _All_, _Deletions_ or _Exports_. Create a request. The view updates live while requests run                                                         |
| Request detail | See the impact: the database plan (delete, detach, retain per table, row counts), retain rules triggered, SaaS connectors and the ledger step, the timeline, and the outcome. Approve or reject, or download an export |
| Consent        | Search a user ID to see current consent per purpose, the hash-chained history, a ledger integrity check, and a download of the verifiable evidence JSON                                                                |
| Incidents      | DPO and admin only. Pick the tables a breach exposed and see records, people and categories affected, a live countdown to the 72-hour deadline, and a draft Art. 33 notification in Polish or English (see breach.md)  |

### Approving a deletion

The approval controls are large and deliberately hard to trigger by accident:

- **Approve** opens a dialog that shows the request id. **Delete permanently** stays disabled until
  you type that exact id. Pasting is blocked in the field.
- The API applies the same rule, `{ confirm: <id> }`, plus the four-eyes check. The key that
  created the request can't approve it.

## Roles (UI logic only)

| Role    | Derived from scopes                                | In the UI                                                                          |
| ------- | -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Support | Has neither `requests:approve` nor `consent:write` | Sees the queue and plans, creates exports, views consent                           |
| DPO     | Has `requests:approve`                             | Everything Support can do, plus creating deletions and approving or rejecting them |
| Admin   | Has `requests:approve` and `consent:write`         | The same as DPO                                                                    |

The UI only hides or disables controls a key can't use. **Enforcement is the API's job:** every
endpoint checks its scope, and a forbidden action returns 403 whatever the UI shows.

## E2E tests (`packages/ui/e2e`)

Playwright starts the demo API on port 8791 and Vite on port 5174, then runs:

1. **Login stub:** an invalid key is rejected; a valid key signs in as Support, and the key never
   appears in the page or the URL.
2. **Support:** sees the queue (counts, filters) and the deletion plan, but gets no approve button.
3. **DPO:** reviews the plan (row counts, the triggered `invoices` retain rule, the ledger step). A
   partially typed id keeps confirmation disabled. The full id approves the deletion, and the page
   follows it live through `running` to `completed`.
4. **DPO** rejects the other deletion.
5. **Consent viewer:** shows status and verification for a user. The user deleted in step 3 shows
   only redacted entries and the erasure event.
6. **Support** creates an export (the deletion option is disabled for Support) and downloads the ZIP.

The run takes about 20 seconds. CI runs it in its own job, with Chromium installed by Playwright.
